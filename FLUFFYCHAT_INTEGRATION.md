# FluffyChat Voice/Video Call Integration Prompt

## Objective
Add voice and video call buttons in the chat header. When clicked, initiate a WebRTC call using the backend API.

## Backend API Details
- **Base URL**: Auto-detected from homeserver (port 8008 → 3000)
- **WebSocket URL**: Same as Base URL
- **Homeserver URL**: Your current laptop IP on port 8008

**Example URLs (will change automatically):**
- Homeserver: `http://192.168.1.17:8008`
- Call Backend: `http://192.168.1.17:3000`

## Step 1: Add Call Buttons to Chat Header

In your chat header widget (usually in `lib/pages/chat/chat.dart` or similar), add two icon buttons:

```dart
// Add these imports
import 'package:socket_io_client/socket_io_client.dart' as IO;

// In your AppBar actions:
IconButton(
  icon: Icon(Icons.phone),
  tooltip: 'Voice Call',
  onPressed: () => _initiateCall('voice'),
),
IconButton(
  icon: Icon(Icons.videocam),
  tooltip: 'Video Call',
  onPressed: () => _initiateCall('video'),
),
```

## Step 2: Initiate Call Function

```dart
Future<void> _initiateCall(String callType) async {
  final roomId = widget.room.id;
  final userId = Matrix.of(context).client.userID!;
  final accessToken = Matrix.of(context).client.accessToken!;

  try {
    // Get the homeserver URL and derive call backend URL
    final homeserverUrl = Matrix.of(context).client.homeserver?.toString() ?? 'http://192.168.1.17:8008';
    
    // Convert homeserver URL (port 8008) to call backend URL (port 3000)
    String baseUrl = homeserverUrl.replaceAll(':8008', ':3000');
    
    // Try to fetch call config for any overrides
    try {
      final configResponse = await http.get(Uri.parse('$baseUrl/call-config.json'));
      if (configResponse.statusCode == 200) {
        final config = jsonDecode(configResponse.body);
        baseUrl = config['baseUrl'] ?? baseUrl;
      }
    } catch (e) {
      // Use derived URL as fallback
    }

    // Call backend API to initiate call
    final response = await http.post(
      Uri.parse('$baseUrl/api/calls/initiate'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'roomId': roomId,
        'callType': callType,
        'accessToken': accessToken,
        'userId': userId,
      }),
    );

    if (response.statusCode == 201) {
      final data = jsonDecode(response.body);
      final callId = data['callId'];
      final iceServers = data['iceServers'];

      // Navigate to call screen
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (context) => CallScreen(
            callId: callId,
            roomId: roomId,
            userId: userId,
            accessToken: accessToken,
            callType: callType,
            iceServers: iceServers,
            isInitiator: true,
            baseUrl: baseUrl,
          ),
        ),
      );
    }
  } catch (e) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Failed to initiate call: $e')),
    );
  }
}
```

## Step 3: Create Call Screen Widget

Create a new file `lib/pages/call/call_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:http/http.dart' as http;
import 'dart:convert';

class CallScreen extends StatefulWidget {
  final String callId;
  final String roomId;
  final String userId;
  final String accessToken;
  final String callType;
  final List<dynamic> iceServers;
  final bool isInitiator;
  final String baseUrl;

  const CallScreen({
    required this.callId,
    required this.roomId,
    required this.userId,
    required this.accessToken,
    required this.callType,
    required this.iceServers,
    required this.isInitiator,
    required this.baseUrl,
  });

  @override
  _CallScreenState createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  RTCPeerConnection? _peerConnection;
  MediaStream? _localStream;
  RTCVideoRenderer _localRenderer = RTCVideoRenderer();
  RTCVideoRenderer _remoteRenderer = RTCVideoRenderer();
  IO.Socket? _socket;
  bool _audioEnabled = true;
  bool _videoEnabled = true;

  @override
  void initState() {
    super.initState();
    _initRenderers();
    _connectWebSocket();
    _startCall();
  }

  Future<void> _initRenderers() async {
    await _localRenderer.initialize();
    await _remoteRenderer.initialize();
  }

  void _connectWebSocket() {
    _socket = IO.io(widget.baseUrl, <String, dynamic>{
      'transports': ['websocket'],
      'autoConnect': true,
    });

    _socket!.on('connect', (_) {
      print('WebSocket connected');
      _socket!.emit('join-call', {
        'callId': widget.callId,
        'userId': widget.userId,
      });
    });

    _socket!.on('webrtc-offer', (data) async {
      await _handleOffer(data['offer'], data['fromUserId']);
    });

    _socket!.on('webrtc-answer', (data) async {
      await _peerConnection!.setRemoteDescription(
        RTCSessionDescription(data['answer']['sdp'], data['answer']['type']),
      );
    });

    _socket!.on('ice-candidate', (data) async {
      if (data['candidate'] != null) {
        await _peerConnection!.addCandidate(
          RTCIceCandidate(
            data['candidate']['candidate'],
            data['candidate']['sdpMid'],
            data['candidate']['sdpMLineIndex'],
          ),
        );
      }
    });

    _socket!.on('user-left', (_) {
      _endCall();
    });
  }

  Future<void> _startCall() async {
    // Get local media stream
    final constraints = {
      'audio': true,
      'video': widget.callType == 'video' ? {'facingMode': 'user'} : false,
    };

    _localStream = await navigator.mediaDevices.getUserMedia(constraints);
    _localRenderer.srcObject = _localStream;

    // Create peer connection
    final configuration = {
      'iceServers': widget.iceServers,
    };

    _peerConnection = await createPeerConnection(configuration);

    // Add local stream tracks
    _localStream!.getTracks().forEach((track) {
      _peerConnection!.addTrack(track, _localStream!);
    });

    // Handle ICE candidates
    _peerConnection!.onIceCandidate = (candidate) {
      _socket!.emit('ice-candidate', {
        'callId': widget.callId,
        'candidate': {
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        },
        'targetUserId': 'all',
      });
    };

    // Handle remote stream
    _peerConnection!.onTrack = (event) {
      if (event.streams.isNotEmpty) {
        setState(() {
          _remoteRenderer.srcObject = event.streams[0];
        });
      }
    };

    // Create offer if initiator
    if (widget.isInitiator) {
      final offer = await _peerConnection!.createOffer();
      await _peerConnection!.setLocalDescription(offer);

      _socket!.emit('webrtc-offer', {
        'callId': widget.callId,
        'offer': {'sdp': offer.sdp, 'type': offer.type},
        'targetUserId': 'all',
      });
    }

    setState(() {});
  }

  Future<void> _handleOffer(dynamic offer, String fromUserId) async {
    await _peerConnection!.setRemoteDescription(
      RTCSessionDescription(offer['sdp'], offer['type']),
    );

    final answer = await _peerConnection!.createAnswer();
    await _peerConnection!.setLocalDescription(answer);

    _socket!.emit('webrtc-answer', {
      'callId': widget.callId,
      'answer': {'sdp': answer.sdp, 'type': answer.type},
      'targetUserId': fromUserId,
    });
  }

  Future<void> _toggleAudio() async {
    _audioEnabled = !_audioEnabled;
    _localStream?.getAudioTracks()[0].enabled = _audioEnabled;

    await http.post(
      Uri.parse('${widget.baseUrl}/api/calls/${widget.callId}/toggle-audio'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'userId': widget.userId, 'enabled': _audioEnabled}),
    );

    setState(() {});
  }

  Future<void> _toggleVideo() async {
    _videoEnabled = !_videoEnabled;
    _localStream?.getVideoTracks()[0].enabled = _videoEnabled;

    await http.post(
      Uri.parse('${widget.baseUrl}/api/calls/${widget.callId}/toggle-video'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'userId': widget.userId, 'enabled': _videoEnabled}),
    );

    setState(() {});
  }

  Future<void> _endCall() async {
    await http.post(
      Uri.parse('${widget.baseUrl}/api/calls/${widget.callId}/end'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'userId': widget.userId,
        'accessToken': widget.accessToken,
      }),
    );

    _socket?.emit('leave-call', {'callId': widget.callId});
    _cleanup();
    Navigator.of(context).pop();
  }

  void _cleanup() {
    _localStream?.dispose();
    _peerConnection?.close();
    _localRenderer.dispose();
    _remoteRenderer.dispose();
    _socket?.disconnect();
  }

## Step 4: Add Incoming Call Listener

Add this to your main chat list or app initialization:

```dart
class _ChatListState extends State<ChatList> {
  IO.Socket? _callSocket;
  
  @override
  void initState() {
    super.initState();
    _setupIncomingCallListener();
  }
  
  void _setupIncomingCallListener() {
    final homeserverUrl = Matrix.of(context).client.homeserver?.toString() ?? 'http://192.168.1.17:8008';
    final baseUrl = homeserverUrl.replaceAll(':8008', ':3000');
    
    _callSocket = IO.io(baseUrl, <String, dynamic>{
      'transports': ['websocket'],
      'autoConnect': true,
    });
    
    _callSocket!.on('connect', (_) {
      _callSocket!.emit('register-user', {
        'userId': Matrix.of(context).client.userID!,
      });
    });
    
    // Listen for incoming calls
    _callSocket!.on('incoming-call', (data) {
      _showIncomingCallDialog(data);
    });
  }
  
  void _showIncomingCallDialog(dynamic callData) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => IncomingCallDialog(
        callId: callData['callId'],
        callType: callData['callType'],
        callerName: callData['callerName'] ?? 'Unknown',
        baseUrl: callData['baseUrl'],
        onAccept: () => _acceptCall(callData),
        onReject: () => _rejectCall(callData),
      ),
    );
  }
  
  void _acceptCall(dynamic callData) async {
    Navigator.of(context).pop(); // Close dialog
    
    final response = await http.post(
      Uri.parse('${callData['baseUrl']}/api/calls/${callData['callId']}/answer'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'userId': Matrix.of(context).client.userID!,
        'accessToken': Matrix.of(context).client.accessToken!,
      }),
    );
    
    if (response.statusCode == 200) {
      final data = jsonDecode(response.body);
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (context) => CallScreen(
            callId: callData['callId'],
            roomId: callData['roomId'],
            userId: Matrix.of(context).client.userID!,
            accessToken: Matrix.of(context).client.accessToken!,
            callType: callData['callType'],
            iceServers: data['iceServers'],
            isInitiator: false,
            baseUrl: callData['baseUrl'],
          ),
        ),
      );
    }
  }
  
  void _rejectCall(dynamic callData) async {
    Navigator.of(context).pop(); // Close dialog
    
    await http.post(
      Uri.parse('${callData['baseUrl']}/api/calls/${callData['callId']}/reject'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'userId': Matrix.of(context).client.userID!,
        'accessToken': Matrix.of(context).client.accessToken!,
      }),
    );
  }
}
```

## Step 5: Create Incoming Call Dialog

```dart
class IncomingCallDialog extends StatelessWidget {
  final String callId;
  final String callType;
  final String callerName;
  final String baseUrl;
  final VoidCallback onAccept;
  final VoidCallback onReject;
  
  const IncomingCallDialog({
    required this.callId,
    required this.callType,
    required this.callerName,
    required this.baseUrl,
    required this.onAccept,
    required this.onReject,
  });
  
  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Incoming ${callType == 'video' ? 'Video' : 'Voice'} Call'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            callType == 'video' ? Icons.videocam : Icons.phone,
            size: 64,
            color: Colors.green,
          ),
          SizedBox(height: 16),
          Text('$callerName is calling...'),
        ],
      ),
      actions: [
        TextButton(
          onPressed: onReject,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.call_end, color: Colors.red),
              SizedBox(width: 8),
              Text('Reject'),
            ],
          ),
        ),
        ElevatedButton(
          onPressed: onAccept,
          style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.call, color: Colors.white),
              SizedBox(width: 8),
              Text('Accept'),
            ],
          ),
        ),
      ],
    );
  }
}
```nup();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Stack(
          children: [
            // Remote video (full screen)
            if (_remoteRenderer.srcObject != null)
              Positioned.fill(
                child: RTCVideoView(_remoteRenderer, mirror: false, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
              )
            else
              Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    CircularProgressIndicator(color: Colors.white),
                    SizedBox(height: 16),
                    Text('Connecting...', style: TextStyle(color: Colors.white, fontSize: 20)),
                  ],
                ),
              ),

            // Local video (small overlay) - only for video calls
            if (widget.callType == 'video' && _localRenderer.srcObject != null)
              Positioned(
                top: 50,
                right: 20,
                child: Container(
                  width: 120,
                  height: 160,
                  decoration: BoxDecoration(
                    border: Border.all(color: Colors.white, width: 2),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: RTCVideoView(_localRenderer, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover),
                  ),
                ),
              ),

            // Controls - ALWAYS visible
            Positioned(
              bottom: 40,
              left: 0,
              right: 0,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  FloatingActionButton(
                    heroTag: 'audio',
                    backgroundColor: _audioEnabled ? Colors.white : Colors.red,
                    onPressed: _toggleAudio,
                    child: Icon(
                      _audioEnabled ? Icons.mic : Icons.mic_off,
                      color: _audioEnabled ? Colors.black : Colors.white,
                    ),
                  ),
                  if (widget.callType == 'video')
                    FloatingActionButton(
                      heroTag: 'video',
                      backgroundColor: _videoEnabled ? Colors.white : Colors.red,
                      onPressed: _toggleVideo,
                      child: Icon(
                        _videoEnabled ? Icons.videocam : Icons.videocam_off,
                        color: _videoEnabled ? Colors.black : Colors.white,
                      ),
                    ),
                  FloatingActionButton(
                    heroTag: 'end',
                    backgroundColor: Colors.red,
                    onPressed: _endCall,
                    child: Icon(Icons.call_end, color: Colors.white),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
                  child: Icon(Icons.call_end, color: Colors.white),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
```

## Step 4: Add Dependencies to pubspec.yaml

```yaml
dependencies:
  flutter_webrtc: ^0.9.48
  socket_io_client: ^2.0.3+1
  http: ^1.1.0
```

## Step 5: Handle Incoming Calls

In your Matrix event listener (usually in `lib/utils/matrix_sdk_extensions.dart`), add:

```dart
// Listen for m.call.invite events
client.onEvent.stream.listen((event) {
  if (event.type == 'm.call.invite') {
    final callId = event.content['call_id'];
    final roomId = event.roomID;
    
    // Show incoming call dialog
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Incoming Call'),
        content: Text('${event.sender} is calling...'),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              _rejectCall(callId);
            },
            child: Text('Reject'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              _answerCall(callId, roomId);
            },
            child: Text('Answer'),
          ),
        ],
      ),
    );
  }
});

Future<void> _answerCall(String callId, String roomId) async {
  final userId = Matrix.of(context).client.userID!;
  final accessToken = Matrix.of(context).client.accessToken!;

  final response = await http.post(
    Uri.parse('http://localhost:3000/api/calls/$callId/answer'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'userId': userId, 'accessToken': accessToken}),
  );

  if (response.statusCode == 200) {
    final data = jsonDecode(response.body);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => CallScreen(
          callId: callId,
          roomId: roomId,
          userId: userId,
          accessToken: accessToken,
          callType: 'video', // Get from call metadata
          iceServers: data['iceServers'],
          isInitiator: false,
        ),
      ),
    );
  }
}
```

## Backend API Endpoints Used

1. **POST /api/calls/initiate** - Start call
2. **POST /api/calls/:callId/answer** - Answer call
3. **POST /api/calls/:callId/end** - End call
4. **POST /api/calls/:callId/toggle-audio** - Mute/unmute
5. **POST /api/calls/:callId/toggle-video** - Video on/off
6. **WebSocket** - Real-time signaling

## Testing

1. Open FluffyChat on two devices/accounts
2. Click phone/video icon in chat header
3. Other user receives incoming call notification
4. Click "Answer" to connect
5. WebRTC establishes peer-to-peer connection

## Notes

- Replace `http://localhost:3000` with your actual server URL
- For production, use HTTPS and WSS (secure WebSocket)
- Add error handling and loading states
- Consider adding call history and missed call notifications
