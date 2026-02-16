# Voice/Video Call System Setup

## Overview
WebRTC-based voice and video calling system for Matrix/FluffyChat with signaling server, session management, and TURN/STUN support.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Database Migration
```bash
psql -U enterprise_user -d enterprise_db -f migrations/004_voice_video_calls.sql
```

### 3. Configure Environment (Optional)
Edit `.env` to add custom TURN servers (defaults to Google's public STUN servers):
```env
TURN_SERVER_URL=turn:your-turn-server.com:3478
TURN_USERNAME=your_turn_username
TURN_CREDENTIAL=your_turn_password
```

### 4. Start Server
```bash
npm start
```

## Architecture

### Components
1. **REST API** (`/api/calls/*`) - Call lifecycle management
2. **WebSocket Server** (Socket.io) - Real-time WebRTC signaling
3. **PostgreSQL** - Call state persistence
4. **Matrix Integration** - Send call events to Matrix rooms

### Database Schema
- `call_sessions` - Active/completed calls
- `call_participants` - Participants and their audio/video state
- `call_events` - Audit log of all call events

### ICE Servers
Default configuration uses Google's free STUN servers:
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`
- `stun:stun2.l.google.com:19302`

For NAT traversal in production, configure a TURN server.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/calls/initiate` | Start a new call |
| POST | `/api/calls/:callId/answer` | Answer incoming call |
| POST | `/api/calls/:callId/reject` | Reject incoming call |
| POST | `/api/calls/:callId/end` | End active call |
| POST | `/api/calls/:callId/offer` | Send WebRTC offer |
| POST | `/api/calls/:callId/answer-sdp` | Send WebRTC answer |
| POST | `/api/calls/:callId/ice-candidate` | Exchange ICE candidates |
| GET | `/api/calls/:callId/status` | Get call status |
| GET | `/api/calls/active` | Get user's active calls |
| POST | `/api/calls/:callId/toggle-audio` | Mute/unmute |
| POST | `/api/calls/:callId/toggle-video` | Video on/off |

## WebSocket Events

### Client -> Server
- `join-call` - Join call room
- `webrtc-offer` - Send WebRTC offer
- `webrtc-answer` - Send WebRTC answer
- `ice-candidate` - Send ICE candidate
- `toggle-audio` - Toggle audio
- `toggle-video` - Toggle video
- `leave-call` - Leave call

### Server -> Client
- `user-joined` - User joined call
- `webrtc-offer` - Receive WebRTC offer
- `webrtc-answer` - Receive WebRTC answer
- `ice-candidate` - Receive ICE candidate
- `audio-toggled` - User toggled audio
- `video-toggled` - User toggled video
- `user-left` - User left call

## FluffyChat Integration

### Call Flow
1. User A initiates call via `/api/calls/initiate`
2. Server creates call session and sends Matrix `m.call.invite` event
3. User B receives notification in FluffyChat
4. User B answers via `/api/calls/:callId/answer`
5. Both users connect to WebSocket server
6. WebRTC negotiation happens via WebSocket (offer/answer/ICE)
7. Direct peer-to-peer media connection established
8. Either user can end call via `/api/calls/:callId/end`

### Required FluffyChat Changes
- Detect `m.call.invite` events and show incoming call UI
- Call REST API endpoints for call lifecycle
- Connect to WebSocket server for signaling
- Implement WebRTC peer connection logic
- Handle audio/video streams

## Testing

See `examples/call-api-examples.md` for curl commands and WebSocket event examples.

### Test 1-to-1 Call
1. User A: POST `/api/calls/initiate` with roomId and userId
2. User A: Connect to WebSocket and emit `join-call`
3. User B: POST `/api/calls/:callId/answer`
4. User B: Connect to WebSocket and emit `join-call`
5. Exchange WebRTC offers/answers/ICE via WebSocket
6. Either user: POST `/api/calls/:callId/end`

## Production Considerations

### TURN Server
For reliable NAT traversal, deploy a TURN server:
- [coturn](https://github.com/coturn/coturn) (open source)
- [Twilio TURN](https://www.twilio.com/stun-turn)
- [Xirsys](https://xirsys.com/)

### Scaling
- Use Redis adapter for Socket.io to scale across multiple servers
- Consider dedicated media server (Jitsi, Janus) for group calls
- Monitor database for call session cleanup

### Security
- Validate Matrix access tokens on all endpoints
- Rate limit call initiation to prevent abuse
- Implement call permissions based on room membership
- Use TLS for WebSocket connections in production

## Troubleshooting

### Calls not connecting
- Check firewall allows UDP traffic for WebRTC
- Verify STUN/TURN servers are reachable
- Check browser console for WebRTC errors

### WebSocket not connecting
- Verify server is running on correct port
- Check CORS configuration in production
- Ensure client uses correct WebSocket URL

### Database errors
- Verify migration ran successfully
- Check PostgreSQL connection in `.env`
- Review server logs for SQL errors

## Files Created
- `migrations/004_voice_video_calls.sql` - Database schema
- `src/call-routes.js` - REST API endpoints
- `src/call-signaling.js` - WebSocket signaling handler
- `examples/call-api-examples.md` - API documentation
