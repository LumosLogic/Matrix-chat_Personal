# Voice/Video Call API Examples

## Prerequisites
- Run database migration: `psql -U enterprise_user -d enterprise_db -f migrations/004_voice_video_calls.sql`
- Install dependencies: `npm install`
- Start server: `npm start`

## API Endpoints

### 1. Initiate a Call
```bash
curl -X POST http://localhost:3000/api/calls/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "!abc123:localhost",
    "callType": "video",
    "accessToken": "your_matrix_access_token",
    "userId": "@user1:localhost"
  }'
```

Response:
```json
{
  "callId": "a1b2c3d4e5f6...",
  "roomId": "!abc123:localhost",
  "callType": "video",
  "status": "ringing",
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" }
  ]
}
```

### 2. Answer a Call
```bash
curl -X POST http://localhost:3000/api/calls/{callId}/answer \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "@user2:localhost",
    "accessToken": "your_matrix_access_token"
  }'
```

### 3. Reject a Call
```bash
curl -X POST http://localhost:3000/api/calls/{callId}/reject \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "@user2:localhost",
    "accessToken": "your_matrix_access_token"
  }'
```

### 4. End a Call
```bash
curl -X POST http://localhost:3000/api/calls/{callId}/end \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "@user1:localhost",
    "accessToken": "your_matrix_access_token"
  }'
```

### 5. Get Call Status
```bash
curl http://localhost:3000/api/calls/{callId}/status
```

### 6. Get Active Calls
```bash
curl "http://localhost:3000/api/calls/active?userId=@user1:localhost"
```

### 7. Toggle Audio
```bash
curl -X POST http://localhost:3000/api/calls/{callId}/toggle-audio \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "@user1:localhost",
    "enabled": false
  }'
```

### 8. Toggle Video
```bash
curl -X POST http://localhost:3000/api/calls/{callId}/toggle-video \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "@user1:localhost",
    "enabled": false
  }'
```

## WebSocket Events (Socket.io)

Connect to: `ws://localhost:3000`

### Client -> Server Events

**join-call**
```javascript
socket.emit('join-call', { 
  callId: 'a1b2c3d4...', 
  userId: '@user1:localhost' 
});
```

**webrtc-offer**
```javascript
socket.emit('webrtc-offer', { 
  callId: 'a1b2c3d4...', 
  offer: { type: 'offer', sdp: '...' },
  targetUserId: '@user2:localhost'
});
```

**webrtc-answer**
```javascript
socket.emit('webrtc-answer', { 
  callId: 'a1b2c3d4...', 
  answer: { type: 'answer', sdp: '...' },
  targetUserId: '@user1:localhost'
});
```

**ice-candidate**
```javascript
socket.emit('ice-candidate', { 
  callId: 'a1b2c3d4...', 
  candidate: { candidate: '...', sdpMid: '0', sdpMLineIndex: 0 },
  targetUserId: '@user2:localhost'
});
```

**toggle-audio**
```javascript
socket.emit('toggle-audio', { 
  callId: 'a1b2c3d4...', 
  enabled: false 
});
```

**toggle-video**
```javascript
socket.emit('toggle-video', { 
  callId: 'a1b2c3d4...', 
  enabled: false 
});
```

**leave-call**
```javascript
socket.emit('leave-call', { 
  callId: 'a1b2c3d4...' 
});
```

### Server -> Client Events

**user-joined**
```javascript
socket.on('user-joined', ({ userId }) => {
  console.log(`${userId} joined the call`);
});
```

**webrtc-offer**
```javascript
socket.on('webrtc-offer', ({ offer, fromUserId, targetUserId }) => {
  // Handle incoming offer
});
```

**webrtc-answer**
```javascript
socket.on('webrtc-answer', ({ answer, fromUserId, targetUserId }) => {
  // Handle incoming answer
});
```

**ice-candidate**
```javascript
socket.on('ice-candidate', ({ candidate, fromUserId, targetUserId }) => {
  // Add ICE candidate to peer connection
});
```

**audio-toggled**
```javascript
socket.on('audio-toggled', ({ userId, enabled }) => {
  console.log(`${userId} ${enabled ? 'unmuted' : 'muted'}`);
});
```

**video-toggled**
```javascript
socket.on('video-toggled', ({ userId, enabled }) => {
  console.log(`${userId} turned video ${enabled ? 'on' : 'off'}`);
});
```

**user-left**
```javascript
socket.on('user-left', ({ userId }) => {
  console.log(`${userId} left the call`);
});
```

## Integration with FluffyChat

FluffyChat should:
1. Call `/api/calls/initiate` when user starts a call
2. Connect to WebSocket server
3. Emit `join-call` event
4. Exchange WebRTC offers/answers/ICE candidates via WebSocket
5. Send Matrix events (m.call.invite, m.call.answer, m.call.hangup) for notifications
6. Call `/api/calls/end` when call ends

## Database Tables

- **call_sessions**: Tracks call metadata (call_id, room_id, status, etc.)
- **call_participants**: Tracks who's in each call and their audio/video state
- **call_events**: Audit log of all call events (ring, answer, reject, etc.)
