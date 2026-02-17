# FluffyChat Voice & Video Call Integration - AI Agent Prompt

You are an expert Flutter developer tasked with integrating voice and video calling functionality into FluffyChat using WebRTC, WebSocket signaling, and REST API.

## Context
- FluffyChat is a Matrix client built with Flutter
- Backend API is already running and provides call management endpoints
- You need to add call buttons, handle incoming calls, and create a call screen

## Requirements

### 1. Add Dependencies
Update `pubspec.yaml` with:
```yaml
dependencies:
  flutter_webrtc: ^0.9.36
  socket_io_client: ^2.0.3
  http: ^1.1.0
```

### 2. Add Call Buttons to Chat Room Header
Location: Find the chat room AppBar (likely in `lib/pages/chat/chat.dart` or similar)

Task: Add two IconButtons for voice and video calls in the AppBar actions

Requirements:
- Voice call button: `Icons.phone`
- Video call button: `Icons.videocam`
- Both should call `_initiateCall(callType)` method
- Add necessary imports: `socket_io_client`, `http`, `dart:convert`

### 3. Implement Call Initiation Logic
Create `_initiateCall(String callType)` method that:
- Gets roomId, userId, accessToken from Matrix client
- Derives call backend URL by replacing homeserver port 8008 with 3000
- Makes POST request to `/api/calls/initiate` endpoint
- On success, navigates to CallScreen with call details
- Handles errors with SnackBar

API Endpoint: `POST {baseUrl}/api/calls/initiate`
Request Body:
```json
{
  "roomId": "string",
  "callType": "voice" | "video",
  "accessToken": "string",
  "userId": "string"
}
```

Response (201):
```json
{
  "callId": "string",
  "iceServers": [{"urls": "stun:..."}],
  "status": "ringing"
}
```

### 4. Create CallScreen Widget
Location: Create new file `lib/pages/call/call_screen.dart`

Requirements:
- StatefulWidget with parameters: callId, roomId, userId, accessToken, callType, iceServers, isInitiator, baseUrl
- Initialize WebRTC components: RTCPeerConnection, MediaStream, RTCVideoRenderer (local & remote)
- Connect to WebSocket for signaling
- Handle WebRTC offer/answer exchange
- Display video feeds (remote full screen, local small overlay)
- Show controls: mute, video toggle, end call buttons
- Controls must ALWAYS be visible (use SafeArea and proper positioning)

WebSocket Events to Handle:
- `connect` → emit `join-call` with callId and userId
- `webrtc-offer` → handle incoming offer, create answer
- `webrtc-answer` → set remote description
- `ice-candidate` → add ICE candidate
- `user-left` → end call

WebSocket Events to Emit:
- `join-call` → {callId, userId}
- `webrtc-offer` → {callId, offer, targetUserId}
- `webrtc-answer` → {callId, answer, targetUserId}
- `ice-candidate` → {callId, candidate, targetUserId}
- `leave-call` → {callId}

UI Layout:
- Black background with SafeArea
- Remote video: Full screen with RTCVideoView (objectFit: cover)
- Local video: Top-right corner, 120x160, only for video calls
- Controls: Bottom center, always visible
  - Mute button (white when enabled, red when disabled)
  - Video toggle (only for video calls)
  - End call button (red)
- Loading state: CircularProgressIndicator with "Connecting..." text

### 5. Add Incoming Call Listener
Location: Main chat list widget (likely `lib/pages/chat_list/chat_list.dart`)

Task: Setup WebSocket listener for incoming calls in initState

Requirements:
- Connect to call backend WebSocket
- Emit `register-user` event on connect
- Listen for `incoming-call` event
- Show IncomingCallDialog when call arrives
- Handle accept/reject actions

Accept Call Flow:
1. Close dialog
2. POST to `/api/calls/{callId}/answer` with userId and accessToken
3. Navigate to CallScreen with isInitiator: false

Reject Call Flow:
1. Close dialog
2. POST to `/api/calls/{callId}/reject` with userId and accessToken

### 6. Create IncomingCallDialog Widget
Location: Create new file `lib/widgets/incoming_call_dialog.dart`

Requirements:
- AlertDialog with call type icon (phone or videocam)
- Display caller name
- Two buttons: Reject (red) and Accept (green)
- Non-dismissible (barrierDismissible: false)

## API Endpoints Reference

### Initiate Call
```
POST {baseUrl}/api/calls/initiate
Body: {roomId, callType, accessToken, userId}
Response: {callId, iceServers, status}
```

### Answer Call
```
POST {baseUrl}/api/calls/{callId}/answer
Body: {userId, accessToken}
Response: {callId, status, iceServers}
```

### Reject Call
```
POST {baseUrl}/api/calls/{callId}/reject
Body: {userId, accessToken}
Response: {callId, status}
```

### End Call
```
POST {baseUrl}/api/calls/{callId}/end
Body: {userId, accessToken}
Response: {callId, status}
```

### Toggle Audio
```
POST {baseUrl}/api/calls/{callId}/toggle-audio
Body: {userId, enabled: boolean}
Response: {success, audioEnabled}
```

### Toggle Video
```
POST {baseUrl}/api/calls/{callId}/toggle-video
Body: {userId, enabled: boolean}
Response: {success, videoEnabled}
```

## WebRTC Flow

### Caller (Initiator):
1. Get local media stream (audio + video if video call)
2. Create RTCPeerConnection with ICE servers
3. Add local tracks to peer connection
4. Create offer → set local description
5. Send offer via WebSocket
6. Receive answer → set remote description
7. Exchange ICE candidates
8. Connection established

### Receiver (Non-Initiator):
1. Get local media stream
2. Create RTCPeerConnection
3. Add local tracks
4. Receive offer → set remote description
5. Create answer → set local description
6. Send answer via WebSocket
7. Exchange ICE candidates
8. Connection established

## Important Notes

1. **URL Derivation**: Always derive call backend URL from homeserver URL by replacing port 8008 with 3000
2. **Error Handling**: Wrap all network calls in try-catch and show user-friendly error messages
3. **Cleanup**: Always dispose WebRTC resources (streams, peer connections, renderers) in dispose method
4. **Hero Tags**: Use unique heroTag for each FloatingActionButton to avoid conflicts
5. **Permissions**: Ensure camera and microphone permissions are requested before accessing media
6. **UI Responsiveness**: Controls must always be visible, use SafeArea to avoid notch/navigation bar overlap
7. **WebSocket Lifecycle**: Connect WebSocket in initState, disconnect in dispose
8. **Caller Filtering**: Backend already filters out caller from receiving their own incoming call notification

## Testing Checklist

- [ ] Call buttons appear in chat header
- [ ] Voice call initiates successfully
- [ ] Video call initiates successfully
- [ ] Incoming call dialog appears for receiver
- [ ] Accept call works and opens call screen
- [ ] Reject call works and dismisses dialog
- [ ] Mute button toggles audio
- [ ] Video toggle button works (video calls only)
- [ ] End call button terminates call and returns to chat
- [ ] Controls are always visible (no black screen)
- [ ] Local video shows in corner (video calls)
- [ ] Remote video shows full screen
- [ ] Caller doesn't receive their own incoming call
- [ ] WebSocket reconnects if connection drops
- [ ] Proper cleanup on call end

## Code Quality Requirements

- Follow Flutter best practices and FluffyChat coding style
- Use proper null safety
- Add meaningful comments for complex WebRTC logic
- Handle edge cases (network errors, permission denials, etc.)
- Ensure proper resource cleanup to prevent memory leaks
- Use const constructors where possible
- Follow Material Design guidelines for UI

## Success Criteria

The integration is successful when:
1. Users can initiate voice and video calls from any chat room
2. Receivers get incoming call notifications with accept/reject options
3. WebRTC connection establishes successfully between caller and receiver
4. Audio and video streams work bidirectionally
5. All controls (mute, video toggle, end call) function correctly
6. UI is responsive and user-friendly
7. No memory leaks or resource issues
8. Proper error handling and user feedback

Begin implementation following this specification. Ask clarifying questions if any requirements are unclear.
