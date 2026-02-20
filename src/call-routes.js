const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pool = require('./db');
const { ICE_SERVERS, notifyIncomingCall, notifyCallEnded, userSockets } = require('./call-signaling');

const router = express.Router();

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TUNNEL_LOG = path.join(__dirname, '..', 'tunnel.log');

// Returns the live tunnel URL if available, else falls back to BASE_URL
function getBaseUrl() {
  try {
    const log = fs.readFileSync(TUNNEL_LOG, 'utf8');
    const matches = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (matches) return matches[matches.length - 1];
  } catch (_) {}
  return BASE_URL;
}

// Store io instance
let ioInstance = null;
function setIoInstance(io) {
  ioInstance = io;
}

function generateCallId() {
  return crypto.randomBytes(16).toString('hex');
}

async function sendMatrixCallEvent(accessToken, roomId, eventType, content) {
  const txnId = Date.now();
  await axios.put(
    `${SYNAPSE_URL}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${txnId}`,
    content,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
}

// POST /api/calls/initiate - Start a call
router.post('/initiate', async (req, res) => {
  const { roomId, callType, accessToken, userId } = req.body;

  if (!roomId || !callType || !accessToken || !userId) {
    return res.status(400).json({ error: 'roomId, callType, accessToken, and userId required' });
  }

  if (!['voice', 'video'].includes(callType)) {
    return res.status(400).json({ error: 'callType must be voice or video' });
  }

  const client = await pool.connect();
  let clientReleased = false;
  try {
    await client.query('BEGIN');

    const callId = generateCallId();

    await client.query(
      `INSERT INTO call_sessions (call_id, room_id, call_type, status, initiator_id)
       VALUES ($1, $2, $3, 'ringing', $4)`,
      [callId, roomId, callType, userId]
    );

    await client.query(
      `INSERT INTO call_participants (call_id, matrix_user_id, status) VALUES ($1, $2, 'joined')`,
      [callId, userId]
    );

    await client.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'call_initiated')`,
      [callId, userId]
    );

    try {
      await sendMatrixCallEvent(accessToken, roomId, 'm.call.invite', {
        call_id: callId,
        version: '1',
        lifetime: 60000,
        offer: { type: callType }
      });
    } catch (err) {
      console.log('[CALL] Matrix event failed (non-critical):', err.message);
    }

    // Get caller display name from Matrix profile
    let callerDisplayName = userId;
    try {
      const profileRes = await axios.get(
        `${SYNAPSE_URL}/_matrix/client/r0/profile/${encodeURIComponent(userId)}/displayname`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      callerDisplayName = profileRes.data.displayname || userId;
    } catch (err) {
      console.log('[CALL] Could not fetch display name:', err.message);
    }

    // COMMIT before notifying — callee's pending-call DB check must see 'ringing' status
    await client.query('COMMIT');
    clientReleased = true;
    client.release();

    res.status(201).json({
      callId,
      roomId,
      callType,
      status: 'ringing',
      iceServers: ICE_SERVERS
    });

    // Notify AFTER commit: queries Matrix for room members, stores each as 'invited'
    // participant in DB, then emits incoming-call to their sockets (or queues as pending)
    if (ioInstance) {
      try {
        await notifyIncomingCall(ioInstance, {
          roomId,
          callId,
          callType,
          initiatorId: userId,
          callerDisplayName,
          accessToken
        });
      } catch (err) {
        console.error('[CALL] notifyIncomingCall error:', err);
      }
    }
  } catch (error) {
    if (!clientReleased) {
      await client.query('ROLLBACK');
    }
    console.error('[CALL] Initiate error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to initiate call' });
    }
  } finally {
    if (!clientReleased) {
      client.release();
    }
  }
});

// POST /api/calls/:callId/answer - Answer incoming call
router.post('/:callId/answer', async (req, res) => {
  const { callId } = req.params;
  const { userId, accessToken } = req.body;

  if (!userId || !accessToken) {
    return res.status(400).json({ error: 'userId and accessToken required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT room_id, status, initiator_id FROM call_sessions WHERE call_id = $1`,
      [callId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Call not found' });
    }

    const { room_id, status, initiator_id } = result.rows[0];

    if (status !== 'ringing') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Call is not in ringing state' });
    }

    await client.query(
      `UPDATE call_sessions SET status = 'active', started_at = NOW() WHERE call_id = $1`,
      [callId]
    );

    // Upsert participant: update to 'joined' if already 'invited', otherwise insert fresh
    await client.query(
      `UPDATE call_participants SET status = 'joined', joined_at = NOW()
       WHERE call_id = $1 AND matrix_user_id = $2`,
      [callId, userId]
    );
    await client.query(
      `INSERT INTO call_participants (call_id, matrix_user_id, status, joined_at)
       SELECT $1, $2, 'joined', NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM call_participants WHERE call_id = $1 AND matrix_user_id = $2
       )`,
      [callId, userId]
    );

    await client.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'call_answered')`,
      [callId, userId]
    );

    try {
      await sendMatrixCallEvent(accessToken, room_id, 'm.call.answer', {
        call_id: callId,
        version: '1'
      });
    } catch (err) {
      console.log('[CALL] Matrix event failed (non-critical):', err.message);
    }

    await client.query('COMMIT');

    // Notify the initiator that the call was answered via socket
    if (ioInstance && initiator_id) {
      const initiatorSockets = userSockets.get(initiator_id);
      if (initiatorSockets) {
        initiatorSockets.forEach(socketId => {
          ioInstance.to(socketId).emit('call-answered', { callId, answeredBy: userId });
        });
      }
    }

    res.json({ callId, status: 'active', iceServers: ICE_SERVERS });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[CALL] Answer error:', error);
    res.status(500).json({ error: 'Failed to answer call' });
  } finally {
    client.release();
  }
});

// POST /api/calls/:callId/reject - Reject incoming call
router.post('/:callId/reject', async (req, res) => {
  const { callId } = req.params;
  const { userId, accessToken } = req.body;

  if (!userId || !accessToken) {
    return res.status(400).json({ error: 'userId and accessToken required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT room_id, initiator_id FROM call_sessions WHERE call_id = $1`,
      [callId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Call not found' });
    }

    const { room_id, initiator_id } = result.rows[0];

    await client.query(
      `UPDATE call_sessions SET status = 'rejected', ended_at = NOW() WHERE call_id = $1`,
      [callId]
    );

    await client.query(
      `UPDATE call_participants SET status = 'rejected' WHERE call_id = $1 AND matrix_user_id = $2`,
      [callId, userId]
    );

    await client.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'call_rejected')`,
      [callId, userId]
    );

    try {
      await sendMatrixCallEvent(accessToken, room_id, 'm.call.hangup', {
        call_id: callId,
        version: '1',
        reason: 'user_hangup'
      });
    } catch (err) {
      console.log('[CALL] Matrix event failed (non-critical):', err.message);
    }

    await client.query('COMMIT');

    // Notify the caller that the call was rejected via WebSocket
    if (ioInstance && initiator_id) {
      const initiatorSockets = userSockets.get(initiator_id);
      if (initiatorSockets) {
        initiatorSockets.forEach(socketId => {
          ioInstance.to(socketId).emit('call-rejected', {
            callId,
            rejectedBy: userId
          });
        });
        console.log(`[CALL] Notified ${initiator_id} that call ${callId} was rejected by ${userId}`);
      }
    }

    res.json({ callId, status: 'rejected' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[CALL] Reject error:', error);
    res.status(500).json({ error: 'Failed to reject call' });
  } finally {
    client.release();
  }
});

// POST /api/calls/:callId/end - End active call
router.post('/:callId/end', async (req, res) => {
  const { callId } = req.params;
  const { userId, accessToken } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT room_id FROM call_sessions WHERE call_id = $1`,
      [callId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Call not found' });
    }

    const { room_id } = result.rows[0];

    await client.query(
      `UPDATE call_sessions SET status = 'ended', ended_at = NOW() WHERE call_id = $1`,
      [callId]
    );

    await client.query(
      `UPDATE call_participants SET status = 'left', left_at = NOW()
       WHERE call_id = $1 AND status = 'joined'`,
      [callId]
    );

    await client.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'call_ended')`,
      [callId, userId]
    );

    if (accessToken) {
      try {
        await sendMatrixCallEvent(accessToken, room_id, 'm.call.hangup', {
          call_id: callId,
          version: '1',
          reason: 'user_hangup'
        });
      } catch (err) {
        console.log('[CALL] Matrix event failed (non-critical):', err.message);
      }
    }

    await client.query('COMMIT');

    // Notify all other call participants via socket that the call has ended
    if (ioInstance) {
      notifyCallEnded(ioInstance, callId, userId);
      console.log(`[CALL] Notified call ${callId} ended by ${userId}`);
    }

    res.json({ callId, status: 'ended' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[CALL] End error:', error);
    res.status(500).json({ error: 'Failed to end call' });
  } finally {
    client.release();
  }
});

// POST /api/calls/:callId/offer - Send WebRTC offer
router.post('/:callId/offer', async (req, res) => {
  const { callId } = req.params;
  const { userId, offer } = req.body;

  if (!userId || !offer) {
    return res.status(400).json({ error: 'userId and offer required' });
  }

  try {
    await pool.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata)
       VALUES ($1, $2, 'webrtc_offer', $3)`,
      [callId, userId, JSON.stringify({ offer })]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[CALL] Offer error:', error);
    res.status(500).json({ error: 'Failed to process offer' });
  }
});

// POST /api/calls/:callId/answer-sdp - Send WebRTC answer
router.post('/:callId/answer-sdp', async (req, res) => {
  const { callId } = req.params;
  const { userId, answer } = req.body;

  if (!userId || !answer) {
    return res.status(400).json({ error: 'userId and answer required' });
  }

  try {
    await pool.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata)
       VALUES ($1, $2, 'webrtc_answer', $3)`,
      [callId, userId, JSON.stringify({ answer })]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[CALL] Answer SDP error:', error);
    res.status(500).json({ error: 'Failed to process answer' });
  }
});

// POST /api/calls/:callId/ice-candidate - Exchange ICE candidates
router.post('/:callId/ice-candidate', async (req, res) => {
  const { callId } = req.params;
  const { userId, candidate } = req.body;

  if (!userId || !candidate) {
    return res.status(400).json({ error: 'userId and candidate required' });
  }

  try {
    await pool.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata)
       VALUES ($1, $2, 'ice_candidate', $3)`,
      [callId, userId, JSON.stringify({ candidate })]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[CALL] ICE candidate error:', error);
    res.status(500).json({ error: 'Failed to process ICE candidate' });
  }
});

// GET /api/calls/active - Get user's ringing incoming calls (for polling on reconnect)
// MUST be defined before /:callId/status to avoid route shadowing
router.get('/active', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  try {
    // Only return ringing calls where this user is listed as an 'invited' participant
    // (i.e., they are a room member but not the initiator).
    // call_participants is populated by notifyIncomingCall when the call is created.
    const result = await pool.query(
      `SELECT cs.call_id, cs.room_id, cs.call_type, cs.initiator_id, cs.status, cs.created_at
       FROM call_sessions cs
       JOIN call_participants cp ON cp.call_id = cs.call_id
       WHERE cs.status = 'ringing'
       AND cs.initiator_id != $1
       AND cp.matrix_user_id = $1
       AND cp.status = 'invited'
       AND cs.created_at > NOW() - INTERVAL '90 seconds'
       ORDER BY cs.created_at DESC`,
      [userId]
    );

    res.json({ calls: result.rows, iceServers: ICE_SERVERS });
  } catch (error) {
    console.error('[CALL] Active calls error:', error);
    res.status(500).json({ error: 'Failed to get active calls' });
  }
});

// GET /api/calls/:callId/status - Get call status
router.get('/:callId/status', async (req, res) => {
  const { callId } = req.params;

  try {
    const sessionResult = await pool.query(
      `SELECT * FROM call_sessions WHERE call_id = $1`,
      [callId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const participantsResult = await pool.query(
      `SELECT matrix_user_id, status, audio_enabled, video_enabled, joined_at, left_at
       FROM call_participants WHERE call_id = $1`,
      [callId]
    );

    res.json({
      session: sessionResult.rows[0],
      participants: participantsResult.rows
    });
  } catch (error) {
    console.error('[CALL] Status error:', error);
    res.status(500).json({ error: 'Failed to get call status' });
  }
});

// POST /api/calls/:callId/toggle-audio - Mute/unmute
router.post('/:callId/toggle-audio', async (req, res) => {
  const { callId } = req.params;
  const { userId, enabled } = req.body;

  if (!userId || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'userId and enabled (boolean) required' });
  }

  try {
    await pool.query(
      `UPDATE call_participants SET audio_enabled = $1
       WHERE call_id = $2 AND matrix_user_id = $3`,
      [enabled, callId, userId]
    );

    await pool.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata)
       VALUES ($1, $2, 'audio_toggled', $3)`,
      [callId, userId, JSON.stringify({ enabled })]
    );

    res.json({ success: true, audioEnabled: enabled });
  } catch (error) {
    console.error('[CALL] Toggle audio error:', error);
    res.status(500).json({ error: 'Failed to toggle audio' });
  }
});

// POST /api/calls/:callId/toggle-video - Video on/off
router.post('/:callId/toggle-video', async (req, res) => {
  const { callId } = req.params;
  const { userId, enabled } = req.body;

  if (!userId || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'userId and enabled (boolean) required' });
  }

  try {
    await pool.query(
      `UPDATE call_participants SET video_enabled = $1
       WHERE call_id = $2 AND matrix_user_id = $3`,
      [enabled, callId, userId]
    );

    await pool.query(
      `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata)
       VALUES ($1, $2, 'video_toggled', $3)`,
      [callId, userId, JSON.stringify({ enabled })]
    );

    res.json({ success: true, videoEnabled: enabled });
  } catch (error) {
    console.error('[CALL] Toggle video error:', error);
    res.status(500).json({ error: 'Failed to toggle video' });
  }
});

module.exports = { router, setIoInstance };
