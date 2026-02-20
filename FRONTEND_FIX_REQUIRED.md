# 🚨 CRITICAL: FluffyChat WebSocket Connection Loop Fix Required

## Problem Summary
FluffyChat is experiencing a **WebSocket connection loop** (repeatedly connecting and disconnecting) because it's trying to fetch `call-config.json` from the wrong server port.

---

## Backend Architecture Explanation

Our system uses a **split architecture** with TWO separate servers:

### Server 1: Call Backend (Port 3000)
- **Purpose**: Handles voice/video calls, WebSocket signaling, custom APIs
- **Technology**: Node.js Express server
- **Endpoints**:
  - `/call-config.json` - Call server configuration
  - `/api/calls/*` - Call lifecycle APIs (initiate, answer, reject, end)
  - WebSocket on `ws://IP:3000` - WebRTC signaling (offer/answer/ICE candidates)
  - `/health` - Health check

### Server 2: Matrix Homeserver (Port 8008)
- **Purpose**: Matrix protocol server (authentication, rooms, messages, federation)
- **Technology**: Synapse (Python-based Matrix homeserver)
- **Endpoints**:
  - `/_matrix/*` - Standard Matrix Client-Server API
  - `/_synapse/*` - Synapse admin APIs

### Why Split Architecture?
We chose a **custom WebRTC implementation** instead of Matrix's built-in VoIP to enable:
- Call recording and analytics
- Advanced screen sharing features
- Custom call UI/UX
- Better control over signaling and media handling

---

## Current Issue: Wrong Port for call-config.json

### What's Happening Now (WRONG ❌)
```dart
// FluffyChat is doing this:
final configUrl = Uri.parse('${client.homeserver}/call-config.json');
// This resolves to: http://192.168.1.22:8008/call-config.json
// Result: 404 Not Found (Synapse doesn't serve this file)
```

### What Should Happen (CORRECT ✅)
```dart
// FluffyChat should fetch from the call backend:
final configUrl = Uri.parse('http://192.168.1.22:3000/call-config.json');
// Result: Returns proper configuration with WebSocket URL
```

---

## Backend call-config.json Response

When you fetch `http://192.168.1.22:3000/call-config.json`, you get:

```json
{
  "baseUrl": "http://192.168.1.22:3000",
  "websocketUrl": "http://192.168.1.22:3000",
  "homeserverUrl": "http://192.168.1.22:8008",
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" },
    { "urls": "stun:stun2.l.google.com:19302" }
  ]
}
```

### Field Explanations:
- **baseUrl**: Call backend base URL (port 3000) - for REST API calls
- **websocketUrl**: WebSocket signaling server (port 3000) - for WebRTC signaling
- **homeserverUrl**: Matrix homeserver (port 8008) - for Matrix protocol
- **iceServers**: STUN servers for NAT traversal in WebRTC

---

## Required Frontend Changes

### File: `lib/widgets/matrix.dart`

**Current Code (Line ~115):**
```dart
Future<void> _fetchCallConfig() async {
  try {
    final configUrl = Uri.parse('${client.homeserver}/call-config.json');
    final response = await http.get(configUrl);
    // ... rest of the code
  } catch (e) {
    Logs.e('Failed to fetch call config: $e');
  }
}
```

**Fixed Code:**
```dart
Future<void> _fetchCallConfig() async {
  try {
    // Extract IP from homeserver URL and use port 3000 for call backend
    final homeserverUri = client.homeserver;
    final callBackendUrl = Uri.parse(
      '${homeserverUri?.scheme ?? 'http'}://${homeserverUri?.host ?? 'localhost'}:3000/call-config.json'
    );
    
    final response = await http.get(callBackendUrl);
    
    if (response.statusCode == 200) {
      final config = json.decode(response.body);
      callConfig = CallConfig.fromJson(config);
      Logs.i('Call config loaded: ${callConfig?.websocketUrl}');
    } else {
      Logs.e('Failed to fetch call config: ${response.statusCode}');
    }
  } catch (e) {
    Logs.e('Failed to fetch call config: $e');
  }
}
```

### Alternative: Add Call Backend URL to App Config

If you want to make it configurable, add a setting:

```dart
// In your config/settings
class AppConfig {
  static const String callBackendPort = '3000';
  
  static Uri getCallConfigUrl(Uri homeserverUrl) {
    return Uri.parse(
      '${homeserverUrl.scheme}://${homeserverUrl.host}:$callBackendPort/call-config.json'
    );
  }
}

// Then use it:
final configUrl = AppConfig.getCallConfigUrl(client.homeserver!);
```

---

## Testing the Fix

### 1. Verify Backend is Running
```bash
curl http://192.168.1.22:3000/health
# Expected: {"status":"healthy","database":"connected"}

curl http://192.168.1.22:3000/call-config.json
# Expected: JSON with baseUrl, websocketUrl, homeserverUrl, iceServers
```

### 2. After Frontend Fix
- FluffyChat should successfully fetch call-config.json on startup
- WebSocket should connect to `ws://192.168.1.22:3000` (check logs)
- No more connection loop in logs
- Incoming call notifications should work

### 3. Check Logs
Look for these success messages:
```
[CallSocketService] Connecting to: ws://192.168.1.22:3000
[CallSocketService] Connected successfully
[CallSocketService] User registered: @username:localhost
```

---

## Why This Fix is Necessary

1. **Port 8008 (Synapse)** only serves Matrix protocol endpoints (`/_matrix/*`)
2. **Port 3000 (Call Backend)** serves custom call functionality
3. The call-config.json **must** come from port 3000 because:
   - It contains the WebSocket URL (port 3000)
   - It's dynamically generated with current IP
   - Synapse doesn't know about our custom call system

---

## Production Deployment Note

When deploying to VPS with domain/SSL:
- Homeserver: `https://matrix.yourdomain.com` (port 8008 behind nginx)
- Call Backend: `https://calls.yourdomain.com` (port 3000 behind nginx)

Update the frontend to use environment-based URLs:
```dart
final callBackendUrl = const String.fromEnvironment(
  'CALL_BACKEND_URL',
  defaultValue: 'http://localhost:3000'
);
```

---

## Questions or Issues?

If you encounter any problems after implementing this fix:

1. **Check backend logs**: `pm2 logs matrix-server`
2. **Verify call-config.json is accessible**: `curl http://IP:3000/call-config.json`
3. **Check FluffyChat logs**: Look for WebSocket connection messages
4. **Network issues**: Ensure port 3000 is not blocked by firewall

---

## Summary

**What to change**: Fetch call-config.json from port 3000 instead of port 8008  
**Why**: Call backend runs on port 3000, Synapse (homeserver) runs on port 8008  
**Impact**: Fixes WebSocket connection loop, enables voice/video calls  
**Files to modify**: `lib/widgets/matrix.dart` (line ~115 in `_fetchCallConfig()`)

---

**Backend Status**: ✅ Ready and working on port 3000  
**Frontend Status**: ⏳ Waiting for this fix  
**Priority**: 🔴 Critical - Blocks all call functionality
