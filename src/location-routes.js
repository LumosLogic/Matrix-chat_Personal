/**
 * Location Sharing - API Routes
 *
 * Endpoints:
 *   POST /api/location/session/create  - Bot creates a session (admin-key protected)
 *   GET  /api/location/session/:token  - Web page validates session
 *   POST /api/location/send            - Send current location (one-time)
 *   POST /api/location/live/start      - Start live location sharing
 *   POST /api/location/live/update     - Update live location (every ~15s)
 *   POST /api/location/live/stop       - Stop live location sharing
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('./db');
const {
  getUserAccessToken,
  sendLocationMessage,
  sendBeaconInfoStart,
  sendBeaconUpdate,
  sendBeaconInfoStop,
} = require('./location-helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// Session token expiry for the web link (30 minutes)
const SESSION_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Middleware: require admin API key (for bot-facing endpoints)
 */
function requireAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid admin API key required' });
  }
  next();
}

/**
 * Middleware: validate session token from request body
 */
async function requireSession(req, res, next) {
  const { session_token } = req.body;
  if (!session_token) {
    return res.status(400).json({ error: 'Bad Request', message: 'session_token is required' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM location_sessions WHERE session_token = $1`,
      [session_token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not Found', message: 'Invalid session token' });
    }

    const session = result.rows[0];

    if (session.status === 'expired' || session.status === 'completed') {
      return res.status(410).json({ error: 'Gone', message: 'Session has expired or completed' });
    }

    if (new Date(session.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Gone', message: 'Session has expired' });
    }

    req.locationSession = session;
    next();
  } catch (error) {
    console.error('[LOCATION] Session validation error:', error.message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to validate session' });
  }
}

/**
 * Get or create a cached user access token for this session.
 */
async function getSessionAccessToken(session) {
  if (session.matrix_access_token) {
    return session.matrix_access_token;
  }

  const accessToken = await getUserAccessToken(session.matrix_user_id);

  await pool.query(
    `UPDATE location_sessions SET matrix_access_token = $1 WHERE id = $2`,
    [accessToken, session.id]
  );

  return accessToken;
}

/**
 * Log an action to the audit log
 */
async function auditLog(sessionId, action, matrixUserId, roomId, lat, lng) {
  await pool.query(
    `INSERT INTO location_audit_log (id, session_id, action, matrix_user_id, room_id, latitude, longitude, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
    [sessionId, action, matrixUserId, roomId, lat || null, lng || null]
  );
}

// ============================================================
// POST /api/location/session/create
// Bot calls this to create a session token + link
// ============================================================
router.post('/session/create', requireAdmin, async (req, res) => {
  const { matrix_user_id, room_id } = req.body;

  if (!matrix_user_id || !room_id) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'matrix_user_id and room_id are required',
    });
  }

  try {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

    const result = await pool.query(
      `INSERT INTO location_sessions
       (id, session_token, matrix_user_id, room_id, status, expires_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'pending', $4, NOW())
       RETURNING id, session_token, expires_at`,
      [sessionToken, matrix_user_id, room_id, expiresAt]
    );

    const session = result.rows[0];
    const link = `${BASE_URL}/location?token=${sessionToken}`;

    await auditLog(session.id, 'SESSION_CREATED', matrix_user_id, room_id);

    res.status(201).json({
      success: true,
      session: {
        id: session.id,
        token: session.session_token,
        expires_at: session.expires_at,
        link,
      },
    });
  } catch (error) {
    console.error('[LOCATION] Error creating session:', error.message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create session' });
  }
});

// ============================================================
// GET /api/location/session/:token
// Web page validates session on load
// ============================================================
router.get('/session/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, matrix_user_id, room_id, mode, status, duration_ms, expires_at, started_at
       FROM location_sessions WHERE session_token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ valid: false, reason: 'invalid', message: 'Invalid session link.' });
    }

    const session = result.rows[0];

    if (session.status === 'expired' || session.status === 'completed') {
      return res.status(410).json({ valid: false, reason: 'expired', message: 'This session has ended.' });
    }

    if (new Date(session.expires_at) < new Date()) {
      return res.status(410).json({ valid: false, reason: 'expired', message: 'This session link has expired.' });
    }

    res.json({
      valid: true,
      matrix_user_id: session.matrix_user_id,
      room_id: session.room_id,
      status: session.status,
      mode: session.mode,
    });
  } catch (error) {
    console.error('[LOCATION] Session validation error:', error.message);
    res.status(500).json({ valid: false, reason: 'error', message: 'An error occurred.' });
  }
});

// ============================================================
// POST /api/location/send
// Send current location (one-time static pin)
// ============================================================
router.post('/send', requireSession, async (req, res) => {
  const { latitude, longitude, accuracy } = req.body;
  const session = req.locationSession;

  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Bad Request', message: 'latitude and longitude are required' });
  }

  try {
    const accessToken = await getSessionAccessToken(session);

    const eventId = await sendLocationMessage(
      accessToken, session.room_id, latitude, longitude, accuracy
    );

    // Mark session as completed
    await pool.query(
      `UPDATE location_sessions
       SET status = 'completed', mode = 'static',
           last_lat = $1, last_lng = $2, last_accuracy = $3,
           last_update_at = NOW(), completed_at = NOW()
       WHERE id = $4`,
      [latitude, longitude, accuracy || null, session.id]
    );

    await auditLog(session.id, 'LOCATION_SENT', session.matrix_user_id, session.room_id, latitude, longitude);

    res.json({ success: true, event_id: eventId });
  } catch (error) {
    console.error('[LOCATION] Error sending location:', error.response?.data || error.message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to send location' });
  }
});

// ============================================================
// POST /api/location/live/start
// Start live location sharing with a duration
// ============================================================
router.post('/live/start', requireSession, async (req, res) => {
  const { latitude, longitude, accuracy, duration_ms } = req.body;
  const session = req.locationSession;

  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Bad Request', message: 'latitude and longitude are required' });
  }

  if (!duration_ms) {
    return res.status(400).json({ error: 'Bad Request', message: 'duration_ms is required' });
  }

  // Validate duration (15 min, 1 hour, 8 hours)
  const allowedDurations = [15 * 60 * 1000, 60 * 60 * 1000, 8 * 60 * 60 * 1000];
  if (!allowedDurations.includes(duration_ms)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Invalid duration' });
  }

  try {
    const accessToken = await getSessionAccessToken(session);

    // Send beacon_info state event to start live sharing
    const beaconEventId = await sendBeaconInfoStart(
      accessToken, session.room_id, session.matrix_user_id, duration_ms
    );

    // Send first beacon update with current position
    await sendBeaconUpdate(
      accessToken, session.room_id, beaconEventId, latitude, longitude, accuracy
    );

    const now = new Date();
    const liveExpiresAt = new Date(now.getTime() + duration_ms);

    // Update session to active live mode
    await pool.query(
      `UPDATE location_sessions
       SET status = 'active', mode = 'live',
           duration_ms = $1, beacon_event_id = $2,
           last_lat = $3, last_lng = $4, last_accuracy = $5,
           last_update_at = NOW(), started_at = NOW(),
           expires_at = $6
       WHERE id = $7`,
      [duration_ms, beaconEventId, latitude, longitude, accuracy || null, liveExpiresAt, session.id]
    );

    await auditLog(session.id, 'LIVE_STARTED', session.matrix_user_id, session.room_id, latitude, longitude);

    res.json({
      success: true,
      beacon_event_id: beaconEventId,
      expires_at: liveExpiresAt.toISOString(),
    });
  } catch (error) {
    console.error('[LOCATION] Error starting live:', error.response?.data || error.message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to start live location' });
  }
});

// ============================================================
// POST /api/location/live/update
// GPS update (every ~15s from browser)
// ============================================================
router.post('/live/update', requireSession, async (req, res) => {
  const { latitude, longitude, accuracy } = req.body;
  const session = req.locationSession;

  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Bad Request', message: 'latitude and longitude are required' });
  }

  if (session.status !== 'active' || session.mode !== 'live') {
    return res.status(409).json({ error: 'Conflict', message: 'Session is not in active live mode' });
  }

  if (!session.beacon_event_id) {
    return res.status(409).json({ error: 'Conflict', message: 'No beacon event to update' });
  }

  try {
    const accessToken = await getSessionAccessToken(session);

    await sendBeaconUpdate(
      accessToken, session.room_id, session.beacon_event_id, latitude, longitude, accuracy
    );

    await pool.query(
      `UPDATE location_sessions
       SET last_lat = $1, last_lng = $2, last_accuracy = $3, last_update_at = NOW()
       WHERE id = $4`,
      [latitude, longitude, accuracy || null, session.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[LOCATION] Error updating live:', error.response?.data || error.message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to update location' });
  }
});

// ============================================================
// POST /api/location/live/stop
// Stop live location sharing
// ============================================================
router.post('/live/stop', requireSession, async (req, res) => {
  const session = req.locationSession;

  if (session.status !== 'active') {
    return res.status(409).json({ error: 'Conflict', message: 'Session is not active' });
  }

  try {
    const accessToken = await getSessionAccessToken(session);

    await sendBeaconInfoStop(accessToken, session.room_id, session.matrix_user_id);

    await pool.query(
      `UPDATE location_sessions SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [session.id]
    );

    await auditLog(session.id, 'LIVE_STOPPED', session.matrix_user_id, session.room_id);

    res.json({ success: true });
  } catch (error) {
    console.error('[LOCATION] Error stopping live:', error.response?.data || error.message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to stop live location' });
  }
});

module.exports = router;
