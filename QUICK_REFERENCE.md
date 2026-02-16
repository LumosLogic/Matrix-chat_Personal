# Voice/Video Call System - Quick Reference

## Installation (3 Steps)

```bash
# 1. Install dependencies
npm install

# 2. Run database migration
psql -U enterprise_user -d enterprise_db -f migrations/004_voice_video_calls.sql

# 3. Start server
npm start
```

## Test the System

Open in browser: `http://localhost:3000/call-test.html`

## API Quick Reference

### Initiate Call
```bash
POST /api/calls/initiate
Body: { roomId, callType, accessToken, userId }
Returns: { callId, iceServers, status }
```

### Answer Call
```bash
POST /api/calls/:callId/answer
Body: { userId, accessToken }
```

### End Call
```bash
POST /api/calls/:callId/end
Body: { userId, accessToken }
```

### Get Active Calls
```bash
GET /api/calls/active?userId=@user:localhost
```

## WebSocket Events

### Connect to WebSocket
```javascript
const socket = io('http://localhost:3000');
```

### Join Call
```javascript
socket.emit('join-call', { callId, userId });
```

### Send WebRTC Offer
```javascript
socket.emit('webrtc-offer', { callId, offer, targetUserId });
```

### Send WebRTC Answer
```javascript
socket.emit('webrtc-answer', { callId, answer, targetUserId });
```

### Send ICE Candidate
```javascript
socket.emit('ice-candidate', { callId, candidate, targetUserId });
```

### Listen for Events
```javascript
socket.on('user-joined', ({ userId }) => { /* ... */ });
socket.on('webrtc-offer', ({ offer, fromUserId }) => { /* ... */ });
socket.on('webrtc-answer', ({ answer, fromUserId }) => { /* ... */ });
socket.on('ice-candidate', ({ candidate, fromUserId }) => { /* ... */ });
socket.on('user-left', ({ userId }) => { /* ... */ });
```

## Database Tables

- **call_sessions** - Call metadata (call_id, room_id, status, type)
- **call_participants** - Participants (user_id, audio/video state)
- **call_events** - Audit log (event_type, metadata, timestamp)

## ICE Servers (Default)

```javascript
[
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
]
```

## Call Flow

1. User A → `POST /api/calls/initiate` → Get callId
2. User A → Connect WebSocket → `join-call`
3. User B → Receives Matrix `m.call.invite` event
4. User B → `POST /api/calls/:callId/answer`
5. User B → Connect WebSocket → `join-call`
6. Both → Exchange WebRTC offer/answer/ICE via WebSocket
7. Both → Direct P2P media connection established
8. Either → `POST /api/calls/:callId/end`

## Files Structure

```
src/
├── call-routes.js       # REST API endpoints
├── call-signaling.js    # WebSocket signaling
└── index.js             # Main server (integrated)

migrations/
└── 004_voice_video_calls.sql  # Database schema

public/
└── call-test.html       # Test client

examples/
└── call-api-examples.md # Detailed examples
```

## Environment Variables (Optional)

```env
TURN_SERVER_URL=turn:your-turn-server.com:3478
TURN_USERNAME=your_turn_username
TURN_CREDENTIAL=your_turn_password
```

## Troubleshooting

**WebSocket not connecting?**
- Check server is running: `http://localhost:3000/health`
- Verify port 3000 is not blocked

**Calls not connecting?**
- Check browser console for WebRTC errors
- Verify STUN servers are reachable
- Test with call-test.html first

**Database errors?**
- Verify migration ran: `\dt call_*` in psql
- Check .env database credentials

## Documentation

- **Setup Guide**: `CALL_SYSTEM_SETUP.md`
- **API Examples**: `examples/call-api-examples.md`
- **Implementation Summary**: `IMPLEMENTATION_SUMMARY.md`

## Support

For issues or questions, check the documentation files or review the implementation code in `src/call-routes.js` and `src/call-signaling.js`.
