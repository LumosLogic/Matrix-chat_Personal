const pool = require('./db');
const axios = require('axios');

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

// Store user socket mappings - supports multiple devices per user
// Map<userId, Set<socketId>>
const userSockets = new Map();

// Store callId -> Set<userId> for broadcasting to all participants in a call
const callParticipants = new Map();

// Store pending incoming-call notifications for users who aren't connected yet
// Map<userId, Array<callData>> - cleared after 90 seconds
const pendingCallNotifications = new Map();

function setupCallSignaling(io) {
  io.on('connection', (socket) => {
    console.log(`[CALL] Client connected: ${socket.id}`);

    // Register user for incoming calls (supports multiple devices per user)
    socket.on('register-user', async ({ userId }) => {
      socket.userId = userId;
      if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
      }
      userSockets.get(userId).add(socket.id);
      console.log(`[CALL] User ${userId} registered on device ${socket.id} (${userSockets.get(userId).size} device(s))`);

      // Deliver any pending incoming-call notifications stored while user was offline
      const pending = pendingCallNotifications.get(userId);
      if (pending && pending.length > 0) {
        for (const callEvent of pending) {
          // Only deliver if call is still ringing (check in DB)
          try {
            const result = await pool.query(
              `SELECT status FROM call_sessions WHERE call_id = $1`,
              [callEvent.callId]
            );
            if (result.rows.length > 0 && result.rows[0].status === 'ringing') {
              io.to(socket.id).emit('incoming-call', callEvent);
              console.log(`[CALL] Delivered pending incoming-call ${callEvent.callId} to user ${userId} on reconnect`);
            }
          } catch (err) {
            console.error('[CALL] Error checking pending call status:', err.message);
          }
        }
        pendingCallNotifications.delete(userId);
      }
    });

    socket.on('join-call', async ({ callId, userId }) => {
      socket.join(callId);
      socket.callId = callId;
      socket.userId = userId;

      // Track participants in this call
      if (!callParticipants.has(callId)) {
        callParticipants.set(callId, new Set());
      }
      callParticipants.get(callId).add(userId);

      try {
        await pool.query(
          `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'socket_connected')`,
          [callId, userId]
        );
      } catch (err) {
        console.error('[CALL] DB error on join-call:', err.message);
      }

      socket.to(callId).emit('user-joined', { userId });
      console.log(`[CALL] ${userId} joined call ${callId}`);
    });

    // Helper: send to a specific user or broadcast to all call participants (excluding sender)
    function sendToTarget(eventName, callId, senderId, targetUserId, payload) {
      if (targetUserId && targetUserId !== 'all') {
        // Send to specific user
        const targetSockets = userSockets.get(targetUserId);
        if (targetSockets) {
          targetSockets.forEach(targetSocketId => {
            io.to(targetSocketId).emit(eventName, { ...payload, fromUserId: senderId });
          });
        }
      } else {
        // Broadcast to all participants in the call except sender
        const participants = callParticipants.get(callId);
        if (participants) {
          participants.forEach(participantId => {
            if (participantId !== senderId) {
              const sockets = userSockets.get(participantId);
              if (sockets) {
                sockets.forEach(socketId => {
                  io.to(socketId).emit(eventName, { ...payload, fromUserId: senderId });
                });
              }
            }
          });
        }
      }
    }

    socket.on('webrtc-offer', async ({ callId, offer, targetUserId }) => {
      try {
        await pool.query(
          `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata) VALUES ($1, $2, 'offer_sent', $3)`,
          [callId, socket.userId, JSON.stringify({ targetUserId })]
        );
      } catch (err) {
        console.error('[CALL] DB error on webrtc-offer:', err.message);
      }

      sendToTarget('webrtc-offer', callId, socket.userId, targetUserId, { offer, targetUserId });
      console.log(`[CALL] Offer sent in ${callId} from ${socket.userId} to ${targetUserId}`);
    });

    socket.on('webrtc-answer', async ({ callId, answer, targetUserId }) => {
      try {
        await pool.query(
          `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata) VALUES ($1, $2, 'answer_sent', $3)`,
          [callId, socket.userId, JSON.stringify({ targetUserId })]
        );
      } catch (err) {
        console.error('[CALL] DB error on webrtc-answer:', err.message);
      }

      sendToTarget('webrtc-answer', callId, socket.userId, targetUserId, { answer, targetUserId });
      console.log(`[CALL] Answer sent in ${callId} from ${socket.userId} to ${targetUserId}`);
    });

    socket.on('ice-candidate', ({ callId, candidate, targetUserId }) => {
      sendToTarget('ice-candidate', callId, socket.userId, targetUserId, { candidate, targetUserId });
    });

    socket.on('toggle-audio', async ({ callId, enabled }) => {
      try {
        await pool.query(
          `UPDATE call_participants SET audio_enabled = $1 WHERE call_id = $2 AND matrix_user_id = $3`,
          [enabled, callId, socket.userId]
        );
      } catch (err) {
        console.error('[CALL] DB error on toggle-audio:', err.message);
      }
      socket.to(callId).emit('audio-toggled', { userId: socket.userId, enabled });
    });

    socket.on('toggle-video', async ({ callId, enabled }) => {
      try {
        await pool.query(
          `UPDATE call_participants SET video_enabled = $1 WHERE call_id = $2 AND matrix_user_id = $3`,
          [enabled, callId, socket.userId]
        );
      } catch (err) {
        console.error('[CALL] DB error on toggle-video:', err.message);
      }
      socket.to(callId).emit('video-toggled', { userId: socket.userId, enabled });
    });

    socket.on('leave-call', async ({ callId }) => {
      if (socket.userId && callId) {
        try {
          await pool.query(
            `UPDATE call_participants SET status = 'left', left_at = NOW() WHERE call_id = $1 AND matrix_user_id = $2`,
            [callId, socket.userId]
          );
          await pool.query(
            `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'user_left')`,
            [callId, socket.userId]
          );
        } catch (err) {
          console.error('[CALL] DB error on leave-call:', err.message);
        }

        // Clean up call participants tracking
        const participants = callParticipants.get(callId);
        if (participants) {
          participants.delete(socket.userId);
          if (participants.size === 0) {
            callParticipants.delete(callId);
          }
        }

        socket.to(callId).emit('user-left', { userId: socket.userId });
        socket.leave(callId);
        console.log(`[CALL] ${socket.userId} left call ${callId}`);
      }
    });

    socket.on('disconnect', async () => {
      if (socket.userId) {
        const sockets = userSockets.get(socket.userId);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            userSockets.delete(socket.userId);
          }
        }
      }
      if (socket.callId && socket.userId) {
        try {
          await pool.query(
            `UPDATE call_participants SET status = 'left', left_at = NOW()
             WHERE call_id = $1 AND matrix_user_id = $2 AND status = 'joined'`,
            [socket.callId, socket.userId]
          );
        } catch (err) {
          console.error('[CALL] DB error on disconnect:', err.message);
        }
        socket.to(socket.callId).emit('user-left', { userId: socket.userId });
      }
      console.log(`[CALL] Client disconnected: ${socket.id}`);
    });
  });
}

// Get room members from Matrix/Synapse
async function getRoomMembers(roomId, accessToken) {
  try {
    const response = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/joined_members`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return Object.keys(response.data.joined || {});
  } catch (err) {
    console.error('[CALL] Failed to get room members:', err.message);
    return [];
  }
}

// Function to notify users of incoming calls - only notifies room members
// Also stores pending notifications for users who are offline
async function notifyIncomingCall(io, callData) {
  const { roomId, callId, callType, initiatorId, callerDisplayName, accessToken } = callData;

  // Get actual room members from Matrix
  const roomMembers = await getRoomMembers(roomId, accessToken);

  if (roomMembers.length === 0) {
    console.log('[CALL] No room members found, falling back to room-based notification');
  }

  let notifiedCount = 0;
  let pendingCount = 0;

  const potentialRecipients = roomMembers.filter(memberId => memberId !== initiatorId);

  const callEvent = {
    callId,
    callType,
    roomId,
    callerName: callerDisplayName || initiatorId,
    callerId: initiatorId,
    // NOTE: baseUrl is intentionally not included here - the client will use its own derived URL
    // to avoid issues with local IP vs tunnel URL mismatches
    iceServers: ICE_SERVERS
  };

  potentialRecipients.forEach(recipientId => {
    const sockets = userSockets.get(recipientId);
    if (sockets && sockets.size > 0) {
      sockets.forEach(socketId => {
        io.to(socketId).emit('incoming-call', callEvent);
        notifiedCount++;
        console.log(`[CALL] Notified ${recipientId} on device ${socketId} of incoming call ${callId} from ${initiatorId}`);
      });
    } else {
      // User is offline - store notification for when they come online
      if (!pendingCallNotifications.has(recipientId)) {
        pendingCallNotifications.set(recipientId, []);
      }
      pendingCallNotifications.get(recipientId).push(callEvent);
      pendingCount++;
      console.log(`[CALL] Stored pending call notification for offline user ${recipientId}`);

      // Auto-clean pending notifications after 90 seconds
      setTimeout(() => {
        const pending = pendingCallNotifications.get(recipientId);
        if (pending) {
          const filtered = pending.filter(c => c.callId !== callId);
          if (filtered.length === 0) {
            pendingCallNotifications.delete(recipientId);
          } else {
            pendingCallNotifications.set(recipientId, filtered);
          }
        }
      }, 90000);
    }
  });

  console.log(`[CALL] Call ${callId}: ${notifiedCount} user(s) notified live, ${pendingCount} stored as pending`);
}

// Notify all call participants that a call has ended (called from call-routes.js)
function notifyCallEnded(io, callId, endedBy) {
  const participants = callParticipants.get(callId);
  if (participants) {
    participants.forEach(participantId => {
      if (participantId !== endedBy) {
        const sockets = userSockets.get(participantId);
        if (sockets) {
          sockets.forEach(socketId => {
            io.to(socketId).emit('call-ended', { callId, endedBy });
          });
        }
      }
    });
  }
  // Also broadcast to the Socket.IO room (covers join-call participants)
  io.to(callId).emit('call-ended', { callId, endedBy });
}

module.exports = { setupCallSignaling, ICE_SERVERS, notifyIncomingCall, notifyCallEnded, userSockets };
