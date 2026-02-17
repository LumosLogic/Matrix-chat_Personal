const pool = require('./db');

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

// Store user socket mappings
const userSockets = new Map();

function setupCallSignaling(io) {
  io.on('connection', (socket) => {
    console.log(`[CALL] Client connected: ${socket.id}`);

    // Register user for incoming calls
    socket.on('register-user', ({ userId }) => {
      socket.userId = userId;
      userSockets.set(userId, socket.id);
      console.log(`[CALL] User ${userId} registered for incoming calls`);
    });

    socket.on('join-call', async ({ callId, userId }) => {
      socket.join(callId);
      socket.callId = callId;
      socket.userId = userId;
      
      await pool.query(
        `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'socket_connected')`,
        [callId, userId]
      );

      socket.to(callId).emit('user-joined', { userId });
      console.log(`[CALL] ${userId} joined call ${callId}`);
    });

    socket.on('webrtc-offer', async ({ callId, offer, targetUserId }) => {
      await pool.query(
        `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata) VALUES ($1, $2, 'offer_sent', $3)`,
        [callId, socket.userId, JSON.stringify({ targetUserId })]
      );

      io.to(callId).emit('webrtc-offer', { offer, fromUserId: socket.userId, targetUserId });
      console.log(`[CALL] Offer sent in ${callId} from ${socket.userId} to ${targetUserId}`);
    });

    socket.on('webrtc-answer', async ({ callId, answer, targetUserId }) => {
      await pool.query(
        `INSERT INTO call_events (call_id, matrix_user_id, event_type, metadata) VALUES ($1, $2, 'answer_sent', $3)`,
        [callId, socket.userId, JSON.stringify({ targetUserId })]
      );

      io.to(callId).emit('webrtc-answer', { answer, fromUserId: socket.userId, targetUserId });
      console.log(`[CALL] Answer sent in ${callId} from ${socket.userId} to ${targetUserId}`);
    });

    socket.on('ice-candidate', async ({ callId, candidate, targetUserId }) => {
      io.to(callId).emit('ice-candidate', { candidate, fromUserId: socket.userId, targetUserId });
    });

    socket.on('toggle-audio', async ({ callId, enabled }) => {
      await pool.query(
        `UPDATE call_participants SET audio_enabled = $1 WHERE call_id = $2 AND matrix_user_id = $3`,
        [enabled, callId, socket.userId]
      );

      io.to(callId).emit('audio-toggled', { userId: socket.userId, enabled });
    });

    socket.on('toggle-video', async ({ callId, enabled }) => {
      await pool.query(
        `UPDATE call_participants SET video_enabled = $1 WHERE call_id = $2 AND matrix_user_id = $3`,
        [enabled, callId, socket.userId]
      );

      io.to(callId).emit('video-toggled', { userId: socket.userId, enabled });
    });

    socket.on('leave-call', async ({ callId }) => {
      if (socket.userId && callId) {
        await pool.query(
          `UPDATE call_participants SET status = 'left', left_at = NOW() WHERE call_id = $1 AND matrix_user_id = $2`,
          [callId, socket.userId]
        );

        await pool.query(
          `INSERT INTO call_events (call_id, matrix_user_id, event_type) VALUES ($1, $2, 'user_left')`,
          [callId, socket.userId]
        );

        socket.to(callId).emit('user-left', { userId: socket.userId });
        socket.leave(callId);
        console.log(`[CALL] ${socket.userId} left call ${callId}`);
      }
    });

    socket.on('disconnect', async () => {
      if (socket.userId) {
        userSockets.delete(socket.userId);
      }
      if (socket.callId && socket.userId) {
        await pool.query(
          `UPDATE call_participants SET status = 'left', left_at = NOW() 
           WHERE call_id = $1 AND matrix_user_id = $2 AND status = 'joined'`,
          [socket.callId, socket.userId]
        );

        socket.to(socket.callId).emit('user-left', { userId: socket.userId });
      }
      console.log(`[CALL] Client disconnected: ${socket.id}`);
    });
  });
}

// Function to notify users of incoming calls
function notifyIncomingCall(io, callData) {
  const { roomId, callId, callType, initiatorId, baseUrl } = callData;
  
  // Notify all connected users EXCEPT the caller
  io.sockets.sockets.forEach((socket) => {
    if (socket.userId && socket.userId !== initiatorId) {
      socket.emit('incoming-call', {
        callId,
        callType,
        roomId,
        callerName: initiatorId,
        baseUrl
      });
      console.log(`[CALL] Notified ${socket.userId} of incoming call ${callId}`);
    }
  });
}

module.exports = { setupCallSignaling, ICE_SERVERS, notifyIncomingCall };
