/**
 * Status / Stories API
 *
 * Every route validates the caller's Matrix access token against Synapse
 * (GET /_matrix/client/v3/account/whoami) and uses the returned user_id
 * as the authenticated principal.
 *
 * Routes:
 *   POST   /api/status                    – publish a new status item
 *   GET    /api/status/feed               – feed for self + DM contacts
 *   GET    /api/status/my                 – caller's own items only
 *   POST   /api/status/:itemId/view       – record a view (idempotent)
 *   GET    /api/status/:itemId/viewers    – list viewers (owner only)
 *   DELETE /api/status/:itemId            – delete own item
 */

const express = require('express');
const axios   = require('axios');
const pool    = require('./db');

const router = express.Router();

const SYNAPSE_URL        = process.env.SYNAPSE_URL        || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN || '';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'localhost';

// ─── Simple in-process caches ────────────────────────────────────────────────

// contact list cache:  userId → { contacts: string[], ts: number }
const contactCache  = new Map();
const CONTACT_TTL   = 60_000; // 60 s

// profile cache: userId → { displayName, avatarUrl, ts }
const profileCache  = new Map();
const PROFILE_TTL   = 300_000; // 5 min

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate the Bearer token and return the caller's Matrix user_id.
 * Throws on invalid / missing token.
 */
async function whoami(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or malformed Authorization header');
    err.status = 401;
    throw err;
  }
  const token = authHeader.slice(7);
  try {
    const { data } = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/v3/account/whoami`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { userId: data.user_id, token };
  } catch (e) {
    const err = new Error('Invalid or expired Matrix access token');
    err.status = 401;
    throw err;
  }
}

/**
 * Fetch Matrix profile for a given userId.
 * Returns { displayName, avatarUrl } — both may be null.
 */
async function getProfile(userId, callerToken) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.ts < PROFILE_TTL) {
    return { displayName: cached.displayName, avatarUrl: cached.avatarUrl };
  }

  try {
    const { data } = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${callerToken}` } }
    );
    const profile = {
      displayName: data.displayname || null,
      avatarUrl:   data.avatar_url  || null,
      ts: Date.now(),
    };
    profileCache.set(userId, profile);
    return profile;
  } catch (_) {
    return { displayName: null, avatarUrl: null };
  }
}

/**
 * Discover DM contacts for the caller.
 * Returns an array of Matrix user IDs (excluding the caller).
 *
 * Strategy:
 *   1. GET joined_rooms with caller's token.
 *   2. For each room with exactly 2 members, treat the other user as a DM contact.
 */
async function getDmContacts(userId, token) {
  const cached = contactCache.get(userId);
  if (cached && Date.now() - cached.ts < CONTACT_TTL) {
    return cached.contacts;
  }

  let roomIds = [];
  try {
    const { data } = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/v3/joined_rooms`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    roomIds = data.joined_rooms || [];
  } catch (_) {
    return [];
  }

  const contacts = new Set();

  await Promise.allSettled(
    roomIds.map(async (roomId) => {
      try {
        const { data } = await axios.get(
          `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const members = Object.keys(data.joined || {});
        // Only 2-member rooms are treated as DMs
        if (members.length === 2) {
          const other = members.find((m) => m !== userId);
          if (other) contacts.add(other);
        }
      } catch (_) {
        // skip inaccessible rooms
      }
    })
  );

  const result = [...contacts];
  contactCache.set(userId, { contacts: result, ts: Date.now() });
  return result;
}

/**
 * Convert a DB row from status_items into the API StatusItem shape.
 */
function rowToItem(row) {
  return {
    id:               row.id,
    userId:           row.user_id,
    mxcUrl:           row.mxc_url,
    mimeType:         row.mime_type,
    caption:          row.caption      || null,
    createdAt:        row.created_at,
    expiresAt:        row.expires_at,
    videoDurationMs:  row.video_duration_ms || null,
    width:            row.width             || null,
    height:           row.height            || null,
    backgroundColor:  row.background_color  || null,
    textColor:        row.text_color        || null,
    viewers:          [],
  };
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  try {
    const { userId, token } = await whoami(req.headers.authorization);
    req.matrixUserId = userId;
    req.matrixToken  = token;
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

// ─── POST /api/status ────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const {
    mxcUrl = '',
    mimeType,
    caption,
    videoDurationMs,
    width,
    height,
    backgroundColor,
    textColor,
  } = req.body;

  if (!mimeType) {
    return res.status(400).json({ error: 'mimeType is required' });
  }

  const userId = req.matrixUserId;

  // Rate-limit: max 30 active status items per user per 24 h
  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM status_items
     WHERE user_id = $1 AND expires_at > NOW()`,
    [userId]
  );
  if (parseInt(countRes.rows[0].cnt, 10) >= 30) {
    return res.status(429).json({ error: 'Rate limit: max 30 status items per 24 hours' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO status_items
         (user_id, mxc_url, mime_type, caption, expires_at,
          video_duration_ms, width, height, background_color, text_color)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours',
               $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        userId,
        mxcUrl || '',
        mimeType,
        caption      || null,
        videoDurationMs  || null,
        width            || null,
        height           || null,
        backgroundColor  || null,
        textColor        || null,
      ]
    );

    const item = rowToItem(result.rows[0]);
    res.status(201).json(item);
  } catch (err) {
    console.error('[Status] POST /api/status error:', err);
    res.status(500).json({ error: 'Failed to create status item' });
  }
});

// ─── GET /api/status/feed ────────────────────────────────────────────────────

router.get('/feed', requireAuth, async (req, res) => {
  const userId = req.matrixUserId;
  const token  = req.matrixToken;

  try {
    const contacts = await getDmContacts(userId, token);
    const allUserIds = [userId, ...contacts];

    // Build parameterised IN clause
    const placeholders = allUserIds.map((_, i) => `$${i + 1}`).join(', ');
    const itemsRes = await pool.query(
      `SELECT * FROM status_items
       WHERE user_id IN (${placeholders}) AND expires_at > NOW()
       ORDER BY created_at ASC`,
      allUserIds
    );

    // Fetch viewed item IDs for the caller
    const viewedRes = await pool.query(
      `SELECT item_id FROM status_views WHERE viewer_id = $1`,
      [userId]
    );
    const viewedSet = new Set(viewedRes.rows.map((r) => r.item_id));

    // Group items by user_id
    const byUser = new Map();
    for (const row of itemsRes.rows) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(rowToItem(row));
    }

    // Build response with profiles
    const statuses = await Promise.all(
      [...byUser.entries()].map(async ([uid, items]) => {
        const profile = await getProfile(uid, token);
        const viewedItemIds = items
          .filter((it) => viewedSet.has(it.id))
          .map((it) => it.id);
        return {
          userId:      uid,
          displayName: profile.displayName,
          avatarUrl:   profile.avatarUrl,
          items,
          viewedItemIds,
        };
      })
    );

    res.json({ statuses });
  } catch (err) {
    console.error('[Status] GET /api/status/feed error:', err);
    res.status(500).json({ error: 'Failed to fetch status feed' });
  }
});

// ─── GET /api/status/my ──────────────────────────────────────────────────────

router.get('/my', requireAuth, async (req, res) => {
  const userId = req.matrixUserId;
  const token  = req.matrixToken;

  try {
    const itemsRes = await pool.query(
      `SELECT * FROM status_items
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY created_at ASC`,
      [userId]
    );

    if (itemsRes.rows.length === 0) {
      return res.status(404).json({ error: 'No active status items' });
    }

    const items = itemsRes.rows.map(rowToItem);

    // Fetch viewer IDs for each item
    const itemIds = items.map((it) => it.id);
    const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(', ');
    const viewersRes = await pool.query(
      `SELECT item_id, viewer_id FROM status_views WHERE item_id IN (${placeholders})`,
      itemIds
    );

    const viewersByItem = new Map();
    for (const row of viewersRes.rows) {
      if (!viewersByItem.has(row.item_id)) viewersByItem.set(row.item_id, []);
      viewersByItem.get(row.item_id).push(row.viewer_id);
    }
    for (const item of items) {
      item.viewers = viewersByItem.get(item.id) || [];
    }

    const profile = await getProfile(userId, token);
    res.json({
      userId:      userId,
      displayName: profile.displayName,
      avatarUrl:   profile.avatarUrl,
      items,
      viewedItemIds: [],
    });
  } catch (err) {
    console.error('[Status] GET /api/status/my error:', err);
    res.status(500).json({ error: 'Failed to fetch your statuses' });
  }
});

// ─── POST /api/status/:itemId/view ───────────────────────────────────────────

router.post('/:itemId/view', requireAuth, async (req, res) => {
  const { itemId } = req.params;
  const viewerId   = req.matrixUserId;

  try {
    // Verify item exists and is not expired
    const itemRes = await pool.query(
      `SELECT id FROM status_items WHERE id = $1 AND expires_at > NOW()`,
      [itemId]
    );
    if (itemRes.rows.length === 0) {
      return res.status(404).json({ error: 'Status item not found or expired' });
    }

    // Idempotent insert — ignore duplicates via ON CONFLICT DO NOTHING
    await pool.query(
      `INSERT INTO status_views (item_id, viewer_id)
       VALUES ($1, $2)
       ON CONFLICT (item_id, viewer_id) DO NOTHING`,
      [itemId, viewerId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[Status] POST /api/status/:itemId/view error:', err);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

// ─── GET /api/status/:itemId/viewers ─────────────────────────────────────────

router.get('/:itemId/viewers', requireAuth, async (req, res) => {
  const { itemId } = req.params;
  const userId     = req.matrixUserId;
  const token      = req.matrixToken;

  try {
    // Check ownership
    const itemRes = await pool.query(
      `SELECT user_id FROM status_items WHERE id = $1`,
      [itemId]
    );
    if (itemRes.rows.length === 0) {
      return res.status(404).json({ error: 'Status item not found' });
    }
    if (itemRes.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: you do not own this status item' });
    }

    // Fetch viewers
    const viewsRes = await pool.query(
      `SELECT viewer_id, viewed_at FROM status_views WHERE item_id = $1 ORDER BY viewed_at ASC`,
      [itemId]
    );

    const viewers = await Promise.all(
      viewsRes.rows.map(async (row) => {
        const profile = await getProfile(row.viewer_id, token);
        return {
          userId:      row.viewer_id,
          displayName: profile.displayName,
          avatarUrl:   profile.avatarUrl,
          viewedAt:    row.viewed_at,
        };
      })
    );

    res.json({ viewers });
  } catch (err) {
    console.error('[Status] GET /api/status/:itemId/viewers error:', err);
    res.status(500).json({ error: 'Failed to fetch viewers' });
  }
});

// ─── DELETE /api/status/:itemId ──────────────────────────────────────────────

router.delete('/:itemId', requireAuth, async (req, res) => {
  const { itemId } = req.params;
  const userId     = req.matrixUserId;

  try {
    const itemRes = await pool.query(
      `SELECT user_id FROM status_items WHERE id = $1`,
      [itemId]
    );
    if (itemRes.rows.length === 0) {
      return res.status(404).json({ error: 'Status item not found' });
    }
    if (itemRes.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: you do not own this status item' });
    }

    await pool.query(`DELETE FROM status_items WHERE id = $1`, [itemId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[Status] DELETE /api/status/:itemId error:', err);
    res.status(500).json({ error: 'Failed to delete status item' });
  }
});

// ─── Cleanup helper (called from index.js on interval) ───────────────────────

/**
 * Delete all expired status_items (views cascade automatically).
 * Optionally purges MXC media from Synapse if SYNAPSE_ADMIN_TOKEN is set.
 */
async function cleanupExpiredStatuses() {
  try {
    // Collect MXC URLs before deleting (for optional media purge)
    const expiredRes = await pool.query(
      `SELECT id, mxc_url FROM status_items WHERE expires_at < NOW() AND mxc_url != ''`
    );

    if (expiredRes.rows.length === 0) return;

    await pool.query(`DELETE FROM status_items WHERE expires_at < NOW()`);
    console.log(`[Status] Cleaned up ${expiredRes.rows.length} expired status item(s)`);

    // Optional: purge MXC media from Synapse
    if (SYNAPSE_ADMIN_TOKEN) {
      for (const row of expiredRes.rows) {
        const mxcUrl = row.mxc_url; // mxc://serverName/mediaId
        const match  = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
        if (!match) continue;
        const [, serverName, mediaId] = match;
        try {
          await axios.delete(
            `${SYNAPSE_URL}/_synapse/admin/v1/media/${serverName}/${mediaId}`,
            { headers: { Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}` } }
          );
        } catch (_) {
          // Non-fatal — media may already be gone or server doesn't support it
        }
      }
    }
  } catch (err) {
    console.error('[Status] Cleanup error:', err.message);
  }
}

module.exports = { router, cleanupExpiredStatuses };