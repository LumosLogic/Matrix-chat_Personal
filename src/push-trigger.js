/**
 * Push Trigger — fires FCM when a Matrix message is sent.
 *
 * Called by the /_matrix message-send interceptor in index.js AFTER Synapse
 * confirms the event. Runs fully async so it never blocks the client response.
 *
 * Flow:
 *   1. Resolve sender's Matrix user ID (via whoami)
 *   2. Fetch joined room members (via Synapse admin API)
 *   3. Look up FCM tokens for every recipient (excluding sender)
 *   4. Send FCM data messages via Firebase Admin SDK
 *   5. Clean up stale / unregistered tokens
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const pool  = require('./db');

const SYNAPSE_URL        = process.env.SYNAPSE_URL         || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN || '';

// ---------------------------------------------------------------------------
// Firebase Admin SDK — lazy init, shared with push-routes.js if loaded first
// ---------------------------------------------------------------------------
function getMessaging() {
  const admin = require('firebase-admin');

  // Reuse existing app if already initialised (push-routes.js may have done it)
  if (admin.apps.length > 0) {
    return admin.apps[0].messaging();
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn('[PUSH-TRIGGER] FIREBASE_SERVICE_ACCOUNT not set — FCM disabled');
    return null;
  }

  let credential;
  if (raw.trim().startsWith('{')) {
    credential = admin.credential.cert(JSON.parse(raw));
  } else {
    // Resolve path relative to project root (process.cwd()), not this file's directory
    const absPath = path.resolve(process.cwd(), raw);
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(absPath, 'utf8')));
  }
  admin.initializeApp({ credential });
  return admin.apps[0].messaging();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the display name for a Matrix user, or null on failure. */
async function getSenderDisplayName(userId) {
  if (!userId) return null;
  try {
    const res = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
      { timeout: 5000 }
    );
    return res.data.displayname ?? null;
  } catch {
    return null;
  }
}

/** Returns the Matrix user_id for the given Bearer access token. */
async function getSenderUserId(authHeader) {
  if (!authHeader) return null;
  try {
    const res = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/v3/account/whoami`,
      { headers: { Authorization: authHeader }, timeout: 5000 }
    );
    return res.data.user_id ?? null;
  } catch {
    return null;
  }
}

/** Returns array of Matrix user IDs currently joined to the room. */
async function getJoinedMembers(roomId) {
  try {
    const res = await axios.get(
      `${SYNAPSE_URL}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`,
      {
        headers: { Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}` },
        timeout: 8000,
      }
    );
    // Admin API returns { members: ["@user:server", ...] }
    return (res.data.members ?? []);
  } catch (e) {
    console.error('[PUSH-TRIGGER] Failed to fetch room members:', e.message);
    return [];
  }
}

/** Removes stale FCM tokens from our DB. */
async function removeStaleTokens(tokens) {
  if (!tokens.length) return;
  try {
    await pool.query(
      'DELETE FROM push_tokens WHERE fcm_token = ANY($1)',
      [tokens]
    );
    console.log(`[PUSH-TRIGGER] Removed ${tokens.length} stale token(s)`);
  } catch (e) {
    console.error('[PUSH-TRIGGER] Stale-token cleanup error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Sends FCM data messages to all room members (except the sender).
 *
 * @param {object} opts
 * @param {string} opts.roomId     - e.g. "!abc:server.com"
 * @param {string} opts.eventId    - e.g. "$eventid:server.com"
 * @param {string} opts.eventType  - e.g. "m.room.message" or "m.room.encrypted"
 * @param {string} opts.authHeader - raw Authorization header from the sender's request
 */
async function sendPushForNewMessage({ roomId, eventId, eventType, messageBody, authHeader }) {
  let messaging;
  try {
    messaging = getMessaging();
  } catch (e) {
    console.error('[PUSH-TRIGGER] Firebase init error:', e.message);
    return;
  }
  if (!messaging) return;

  // Resolve sender, display name, and members in parallel
  const [senderUserId, members] = await Promise.all([
    getSenderUserId(authHeader),
    getJoinedMembers(roomId),
  ]);
  const senderDisplayName = await getSenderDisplayName(senderUserId);
  const notifTitle = senderDisplayName || senderUserId || 'New Message';
  // Use actual message body if available (unencrypted messages),
  // otherwise fall back to generic string (E2EE — ciphertext not readable)
  const notifBody = (eventType !== 'm.room.encrypted' && messageBody)
    ? messageBody
    : 'New message';

  // Exclude the sender from recipients
  const recipients = senderUserId
    ? members.filter((m) => m !== senderUserId)
    : members;

  if (recipients.length === 0) return;

  // Look up FCM tokens for all recipients in one query
  const { rows } = await pool.query(
    `SELECT user_id, fcm_token FROM push_tokens WHERE user_id = ANY($1)`,
    [recipients]
  );

  if (rows.length === 0) {
    console.log(`[PUSH-TRIGGER] No FCM tokens found for recipients of ${eventId}`);
    return;
  }

  console.log(
    `[PUSH-TRIGGER] Sending FCM to ${rows.length} device(s) for ${eventId} in ${roomId}`
  );

  const staleTokens = [];

  await Promise.allSettled(
    rows.map(async ({ user_id, fcm_token }) => {
      try {
        await messaging.send({
          token: fcm_token,
          // Top-level notification: OS uses this directly when app is killed
          notification: {
            title: notifTitle,
            body: notifBody,
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'cqr_push',
              sound: 'default',
              clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            },
          },
          apns: {
            headers: { 'apns-priority': '10' },
            payload: {
              aps: {
                alert: { title: notifTitle, body: notifBody },
                sound: 'default',
                'content-available': 1,
              },
            },
          },
          data: {
            room_id:     roomId,
            event_id:    eventId,
            sender:      senderUserId ?? '',
            sender_name: notifTitle,
            room_name:   '',
            body:        notifBody,
            unread:      '1',
            type:        eventType,
          },
        });
        console.log(`[PUSH-TRIGGER] FCM sent OK → ${user_id}`);
      } catch (err) {
        const code = err.code ?? '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          console.warn(`[PUSH-TRIGGER] Stale token for ${user_id}, queuing removal`);
          staleTokens.push(fcm_token);
        } else {
          console.error(`[PUSH-TRIGGER] FCM error for ${user_id}:`, err.message, code);
        }
      }
    })
  );

  await removeStaleTokens(staleTokens);
}

module.exports = { sendPushForNewMessage };
