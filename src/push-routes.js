/**
 * FCM Push Notification Routes
 *
 * Implements the Matrix Push Gateway spec so Synapse can deliver push
 * notifications to Android/iOS clients via Firebase Cloud Messaging.
 *
 * Endpoints:
 *   POST   /api/push/register               — Client registers/updates its FCM token
 *   DELETE /api/push/register               — Client unregisters its FCM token on logout
 *   POST   /api/push/gateway/_matrix/push/v1/notify — Matrix Push Gateway (called by Synapse)
 *
 * Setup:
 *   1. npm install firebase-admin
 *   2. Set FIREBASE_SERVICE_ACCOUNT env var to the contents of your
 *      Firebase service-account JSON (or path to the file).
 */

const express = require('express');
const pool = require('./db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Firebase Admin SDK — lazy initialised on first use
// ---------------------------------------------------------------------------
function getFirebaseMessaging() {
  const admin = require('firebase-admin');

  // Reuse existing app if already initialised (push-trigger.js may have done it)
  if (admin.apps.length > 0) {
    return admin.apps[0].messaging();
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT env var is not set. ' +
      'Set it to the JSON contents of your Firebase service-account key.'
    );
  }

  let credential;
  if (raw.trim().startsWith('{')) {
    credential = admin.credential.cert(JSON.parse(raw));
  } else {
    credential = admin.credential.cert(require(raw));
  }

  admin.initializeApp({ credential });
  return admin.apps[0].messaging();
}

// ---------------------------------------------------------------------------
// Helper: remove a stale / invalid FCM token from the DB
// ---------------------------------------------------------------------------
async function removeStaleToken(fcmToken) {
  try {
    await pool.query('DELETE FROM push_tokens WHERE fcm_token = $1', [fcmToken]);
    console.log(`[PUSH] Removed stale token: ${fcmToken.substring(0, 20)}…`);
  } catch (err) {
    console.error('[PUSH] Failed to remove stale token:', err.message);
  }
}

// ---------------------------------------------------------------------------
// POST /api/push/register
// Body: { user_id, fcm_token, platform? }
//
// Upserts the token for (user_id, platform). Called by the Flutter client
// immediately after it obtains a fresh FCM token.
// ---------------------------------------------------------------------------
router.post('/register', async (req, res) => {
  const { user_id, fcm_token, platform = 'android' } = req.body;

  if (!user_id || !fcm_token) {
    return res.status(400).json({ error: 'user_id and fcm_token are required' });
  }

  if (!['android', 'ios'].includes(platform)) {
    return res.status(400).json({ error: "platform must be 'android' or 'ios'" });
  }

  try {
    await pool.query(
      `INSERT INTO push_tokens (user_id, platform, fcm_token, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, platform)
       DO UPDATE SET fcm_token = EXCLUDED.fcm_token, updated_at = NOW()`,
      [user_id, platform, fcm_token]
    );

    console.log(`[PUSH] Registered token for ${user_id} (${platform})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH] register error:', err.message);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/push/register
// Body: { user_id, platform? }
//
// Removes the token for this user/platform. Call this on logout so Synapse
// stops trying to push to a signed-out session.
// ---------------------------------------------------------------------------
router.delete('/register', async (req, res) => {
  const { user_id, platform = 'android' } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    await pool.query(
      'DELETE FROM push_tokens WHERE user_id = $1 AND platform = $2',
      [user_id, platform]
    );

    console.log(`[PUSH] Unregistered token for ${user_id} (${platform})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH] unregister error:', err.message);
    res.status(500).json({ error: 'Failed to unregister push token' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/push/gateway/_matrix/push/v1/notify
//
// Matrix Push Gateway endpoint. Synapse calls this whenever a push rule fires.
// Spec: https://spec.matrix.org/v1.9/push-gateway-api/
//
// We look up the target user's FCM token and send a data-only message so the
// Flutter app can handle it in the background (same approach as Element/FluffyChat).
// ---------------------------------------------------------------------------
// Exported so index.js can also mount it at /_matrix/push/v1/notify
// (Synapse requires the gateway URL path to be exactly /_matrix/push/v1/notify)
async function handlePushGateway(req, res) {
  const notification = req.body?.notification;

  if (!notification) {
    // Spec requires us to return { rejected: [] } even on bad input
    return res.json({ rejected: [] });
  }

  const {
    devices = [],
    room_id,
    event_id,
    sender,
    sender_display_name,
    room_name,
    content,
    counts,
    type,
    prio,
  } = notification;

  const eventType = type ?? 'm.room.message';
  const isCall = eventType === 'm.call.invite';

  // The spec sends one notification per pusher device.
  // Each device has a push_key which is the FCM token when using our pusher.
  const rejected = [];

  for (const device of devices) {
    const fcmToken = device.pushkey;
    if (!fcmToken) continue;

    let messaging;
    try {
      messaging = getFirebaseMessaging();
    } catch (initErr) {
      console.error('[PUSH] Firebase not initialised:', initErr.message);
      // Don't reject the device — the error is on our side
      break;
    }

    try {
      // Build FCM data payload — ALL values must be strings
      const data = {
        room_id:             room_id ?? '',
        event_id:            event_id ?? '',
        type:                eventType,  // REQUIRED for call fast-path
        sender:              sender ?? '',
        sender_display_name: sender_display_name ?? '',
        room_name:           room_name ?? '',
        unread:              String(counts?.unread ?? 0),
        prio:                prio ?? 'high',
        body:                content?.body ?? '',
      };

      const androidConfig = {
        priority: 'high',  // REQUIRED: bypasses Doze mode
        data,
        ...(isCall && {
          notification: {
            android_channel_id: 'cqr_incoming_call',
          },
        }),
      };

      const message = {
        token: fcmToken,
        android: androidConfig,
        data,  // top-level data for background handler
      };

      await messaging.send(message);
      console.log(
        `[PUSH] Sent FCM data-only ${isCall ? '(CALL)' : ''} to ${fcmToken.substring(0, 20)}… ` +
        `(room=${room_id}, event=${event_id}, type=${eventType})`
      );
    } catch (fcmErr) {
      const code = fcmErr.code ?? '';

      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        // Token is stale — tell Synapse to remove this pusher and clean up our DB
        console.warn(`[PUSH] Stale token detected: ${fcmToken.substring(0, 20)}…`);
        rejected.push(fcmToken);
        await removeStaleToken(fcmToken);
      } else {
        // Transient error — don't reject, Synapse will retry
        console.error('[PUSH] FCM send error:', fcmErr.message, code);
      }
    }
  }

  // Spec: respond with the list of push keys that should be removed from Synapse
  res.json({ rejected });
}

router.post('/gateway/_matrix/push/v1/notify', handlePushGateway);

module.exports = { router, handlePushGateway };
