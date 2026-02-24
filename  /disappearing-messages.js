/**
 * disappearing-messages.js
 *
 * Secure, per-room disappearing message engine.
 *
 * WHY TWO STEPS?
 * ─────────────────────────────────────────────────────────────────────────────
 * purge_history (step 2) permanently removes events from Synapse's PostgreSQL
 * database, but it does NOT touch clients' local SQLite caches.  If a user
 * still has the event in their local cache, changing the retention policy to
 * 24 h or "off" makes it reappear in the chat UI.
 *
 * redactEvent (step 1) sends an m.room.redaction event via the Matrix protocol.
 * Every connected client receives it, removes the message content from its
 * local database, and shows nothing (or "Message deleted" if redacted events
 * are shown).  Only after all expired events are redacted do we call
 * purge_history to clean up both the original events AND the redaction shells
 * from the server database.
 *
 * MONOTONIC PURGE CUTOFF
 * ─────────────────────────────────────────────────────────────────────────────
 * We track a last_purge_cutoff per room in our enterprise_db.
 * This value ONLY moves forward (never goes back).  Even after a policy change
 * from 5 min → 24 h or → off, the cutoff keeps advancing at the old (stricter)
 * rate, so messages cannot be recovered by relaxing the policy.
 */

'use strict';

const axios    = require('axios');
const crypto   = require('crypto');
const pool     = require('./db');
const synapsePool = require('./synapse-db');

const SYNAPSE_URL         = process.env.SYNAPSE_URL         || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN;

// How many events to redact per room per cycle (avoid long-running cycles)
const REDACT_BATCH_SIZE = 50;

// Stop tracking a room after its policy has been removed AND all plausible
// messages would have expired even under the strictest lifetime seen.
const MAX_TRACK_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── User-token cache ──────────────────────────────────────────────────────────
// Map<userId, { token: string, expiresAt: number }>
// We cache impersonation tokens for 55 minutes (they last 1 h by default).
const _tokenCache = new Map();
const TOKEN_TTL_MS = 55 * 60 * 1000;

/**
 * Return an access token for `userId` by calling the Synapse admin login
 * endpoint.  Tokens are cached so we don't hit the endpoint on every cycle.
 */
async function getUserToken(userId) {
  const cached = _tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await axios.post(
    `${SYNAPSE_URL}/_synapse/admin/v1/users/${encodeURIComponent(userId)}/login`,
    {},
    {
      headers: { Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}` },
      timeout: 10000,
    },
  );
  const token = response.data.access_token;
  _tokenCache.set(userId, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

// ── Synapse DB helpers ────────────────────────────────────────────────────────

/**
 * Return up to `limit` events in `roomId` that:
 *   • are messages / encrypted events (not state events)
 *   • have origin_server_ts < cutoffTs
 *   • have NOT already been redacted
 */
async function getExpiredEvents(roomId, cutoffTs, limit = REDACT_BATCH_SIZE) {
  // Synapse stores redaction relationships in the 'redactions' table,
  // not as a column on the 'events' table.
  const result = await synapsePool.query(
    `SELECT e.event_id, e.sender
     FROM   events e
     WHERE  e.room_id          = $1
       AND  e.type             IN ('m.room.message', 'm.room.encrypted', 'm.sticker')
       AND  e.origin_server_ts < $2
       AND  NOT EXISTS (
              SELECT 1 FROM redactions r
              WHERE  r.redacts = e.event_id
            )
     ORDER BY e.origin_server_ts ASC
     LIMIT $3`,
    [roomId, cutoffTs, limit],
  );
  return result.rows; // [{ event_id, sender }]
}

/**
 * Query Synapse DB for all rooms that currently have an m.room.retention policy.
 * @returns {Map<string, number>}  room_id → max_lifetime (ms)
 */
async function getSynapseRetentionPolicies() {
  const result = await synapsePool.query(`
    SELECT c.room_id,
           e.json::jsonb -> 'content' AS content
    FROM   current_state_events c
    JOIN   event_json            e ON c.event_id = e.event_id
    WHERE  c.type = 'm.room.retention'
  `);

  const map = new Map();
  for (const row of result.rows) {
    try {
      const content     = typeof row.content === 'string'
        ? JSON.parse(row.content) : row.content;
      const maxLifetime = content?.max_lifetime;
      if (maxLifetime && maxLifetime > 0) map.set(row.room_id, Number(maxLifetime));
    } catch (_) { /* malformed event */ }
  }
  return map;
}

// ── Enterprise-DB helpers ────────────────────────────────────────────────────

async function loadTrackedRooms() {
  const result = await pool.query(
    `SELECT room_id,
            min_max_lifetime::bigint     AS min_max_lifetime,
            current_max_lifetime::bigint AS current_max_lifetime,
            last_purge_cutoff::bigint    AS last_purge_cutoff
     FROM   room_disappearing_config`,
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.room_id, {
      minMaxLifetime:     Number(row.min_max_lifetime),
      currentMaxLifetime: row.current_max_lifetime != null
        ? Number(row.current_max_lifetime) : null,
      lastPurgeCutoff:    Number(row.last_purge_cutoff),
    });
  }
  return map;
}

async function saveTrackedRoom(roomId, { minMaxLifetime, currentMaxLifetime, lastPurgeCutoff }) {
  await pool.query(
    `INSERT INTO room_disappearing_config
       (room_id, min_max_lifetime, current_max_lifetime, last_purge_cutoff, last_purge_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (room_id) DO UPDATE SET
       min_max_lifetime     = LEAST(room_disappearing_config.min_max_lifetime, EXCLUDED.min_max_lifetime),
       current_max_lifetime = EXCLUDED.current_max_lifetime,
       last_purge_cutoff    = GREATEST(room_disappearing_config.last_purge_cutoff, EXCLUDED.last_purge_cutoff),
       last_purge_at        = NOW(),
       updated_at           = NOW()`,
    [roomId, minMaxLifetime, currentMaxLifetime, lastPurgeCutoff],
  );
}

// ── Ensure table ──────────────────────────────────────────────────────────────

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_disappearing_config (
      room_id              TEXT        PRIMARY KEY,
      min_max_lifetime     BIGINT      NOT NULL,
      current_max_lifetime BIGINT,
      last_purge_cutoff    BIGINT      NOT NULL DEFAULT 0,
      last_purge_at        TIMESTAMPTZ,
      first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rdm_last_purge
    ON room_disappearing_config (last_purge_at)
  `);
}

// ── Step 1: Redact expired events ─────────────────────────────────────────────

/**
 * Find all expired, non-redacted events in `roomId` up to `cutoffTs`,
 * then redact each one using the sender's impersonated token.
 * Returns the number of events successfully redacted.
 */
async function redactExpiredEventsInRoom(roomId, cutoffTs) {
  let redacted = 0;

  const events = await getExpiredEvents(roomId, cutoffTs);
  if (events.length === 0) return 0;

  console.log(`[DISAPPEAR] Redacting ${events.length} event(s) in ${roomId} (cutoff: ${new Date(cutoffTs).toISOString()})`);

  for (const { event_id, sender } of events) {
    try {
      const userToken = await getUserToken(sender);
      const txnId     = crypto.randomBytes(8).toString('hex');

      await axios.put(
        `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(event_id)}/${txnId}`,
        { reason: 'Message expired' },
        {
          headers: {
            Authorization:  `Bearer ${userToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );
      redacted++;
    } catch (err) {
      const status = err.response?.status;
      // 404 = event already gone, 400 = already redacted – both are fine
      if (status !== 404 && status !== 400) {
        console.error(`[DISAPPEAR] Could not redact ${event_id} in ${roomId}:`, err.response?.data || err.message);
      }
    }
  }

  return redacted;
}

// ── Step 2: Purge history ─────────────────────────────────────────────────────

async function purgeSynapseRoom(roomId, purgeUpToTs) {
  try {
    const response = await axios.post(
      `${SYNAPSE_URL}/_synapse/admin/v1/purge_history/${encodeURIComponent(roomId)}`,
      { purge_up_to_ts: purgeUpToTs },
      {
        headers: {
          Authorization:  `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
    );
    return response.data?.purge_id || true;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 400) return null; // nothing to purge
    console.error(`[DISAPPEAR] purge_history error for ${roomId}:`, err.response?.data || err.message);
    return null;
  }
}

// ── Main purge loop ───────────────────────────────────────────────────────────

/**
 * Called every 60 seconds.
 *
 * Per-room algorithm
 * ──────────────────
 * 1. effective_lifetime = min(current_policy, stored_min_lifetime)
 *    → uses the STRICTEST lifetime this room has ever had
 * 2. candidate_cutoff   = NOW – effective_lifetime
 * 3. purge_cutoff       = max(last_purge_cutoff, candidate_cutoff)
 *    → MONOTONIC: the cutoff never goes backward
 * 4. Redact individual expired events (propagates to all clients → local cache cleared)
 * 5. purge_history up to purge_cutoff (permanently deletes from Synapse DB,
 *    including the redaction shells)
 * 6. Save new purge_cutoff
 */
async function purgeExpiredMessages() {
  const NOW = Date.now();

  try {
    const synapseMap = await getSynapseRetentionPolicies();
    const trackedMap = await loadTrackedRooms();

    const allRoomIds = new Set([...synapseMap.keys(), ...trackedMap.keys()]);
    let   processedCount = 0;

    for (const roomId of allRoomIds) {
      try {
        const currentPolicy = synapseMap.get(roomId) ?? null;
        const tracked       = trackedMap.get(roomId) ?? null;

        if (currentPolicy === null && tracked === null) continue;

        // Strictest lifetime ever seen (only decreases)
        const prevMin       = tracked?.minMaxLifetime ?? currentPolicy;
        const effectiveMin  = currentPolicy !== null
          ? Math.min(prevMin, currentPolicy)
          : prevMin; // policy disabled – keep enforcing old (stricter) value

        if (!effectiveMin || effectiveMin <= 0) continue;

        // Stop tracking very old disabled rooms
        if (currentPolicy === null && tracked) {
          if (NOW - tracked.lastPurgeCutoff > MAX_TRACK_DURATION_MS + effectiveMin) continue;
        }

        // Monotonic cutoff
        const lastCutoff      = tracked?.lastPurgeCutoff ?? 0;
        const candidateCutoff = NOW - effectiveMin;
        const purgeCutoff     = Math.max(lastCutoff, candidateCutoff);

        if (purgeCutoff <= lastCutoff) continue; // nothing new

        // ── Step 1: Redact expired events ────────────────────────────────
        // This sends m.room.redaction events which all clients receive.
        // Each client removes the message content from its local SQLite cache.
        // Even if a user later changes the policy to 24 h or "off", the
        // message is already gone from every device's local database.
        await redactExpiredEventsInRoom(roomId, purgeCutoff);

        // ── Step 2: Purge from Synapse DB ─────────────────────────────────
        // Permanently removes both original events AND the redaction shells.
        const purgeId = await purgeSynapseRoom(roomId, purgeCutoff);

        if (purgeId !== null) {
          await saveTrackedRoom(roomId, {
            minMaxLifetime:     effectiveMin,
            currentMaxLifetime: currentPolicy,
            lastPurgeCutoff:    purgeCutoff,
          });
          console.log(
            `[DISAPPEAR] ✓ ${roomId} | lifetime: ${effectiveMin}ms | ` +
            `cutoff: ${new Date(purgeCutoff).toISOString()}`,
          );
          processedCount++;
        }
      } catch (roomErr) {
        console.error(`[DISAPPEAR] Error processing room ${roomId}:`, roomErr.message);
      }
    }

    if (processedCount > 0) {
      console.log(`[DISAPPEAR] Cycle complete – ${processedCount} room(s) processed`);
    }
  } catch (err) {
    console.error('[DISAPPEAR] Cycle failed:', err.message);
  }
}

module.exports = { purgeExpiredMessages, ensureTable };
