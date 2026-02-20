# 🚨 URGENT: Why Receiver Isn't Getting Call Accept/Reject UI

## The Problem

**Symptom**: When you initiate a call, the receiver doesn't see the accept/reject UI.

**Root Cause**: The receiver's FluffyChat app **cannot fetch call-config.json** because it's trying to get it from the wrong port.

---

## What's Happening (Technical Flow)

### ✅ Backend (Your Side - WORKING)

1. Caller initiates call → POST /api/calls/initiate
2. Backend creates call session in database
3. Backend fetches room members from Synapse
4. Backend emits `incoming-call` event via WebSocket
5. **Event is successfully sent to receiver's socket**

**Proof from logs**:
```
[CALL] Notified @admin:localhost on device PNYspUNRXWh5Cio7AAAD 
       of incoming call 97e6895cd99b4621f190fc785e8e1385 
       from @user2:localhost
```

### ❌ Frontend (Receiver Side - BROKEN)

1. FluffyChat tries to fetch: `http://192.168.1.22:8008/call-config.json`
2. **404 Error** (Synapse doesn't serve this file)
3. callConfig remains null
4. WebSocket connection URL is unknown
5. CallSocketService can't connect properly
6. `incoming-call` event is sent but **not received**
7. **No accept/reject UI is shown**

---

## The Fix (Frontend Must Implement)

**File**: `lib/widgets/matrix.dart` (line ~115 in `_fetchCallConfig()`)

**Current Code (WRONG)**:
```dart
final configUrl = Uri.parse('${client.homeserver}/call-config.json');
// Fetches from: http://192.168.1.22:8008/call-config.json ❌
```

**Fixed Code (CORRECT)**:
```dart
final homeserverUri = client.homeserver;
final callBackendUrl = Uri.parse(
  '${homeserverUri?.scheme ?? 'http'}://${homeserverUri?.host}:3000/call-config.json'
);
final response = await http.get(callBackendUrl);
// Fetches from: http://192.168.1.22:3000/call-config.json ✅
```

---

## Why Port 3000?

Your architecture uses **TWO separate servers**:

| Server | Port | Purpose |
|--------|------|---------|
| **Call Backend** | 3000 | WebRTC calls, WebSocket signaling, call-config.json |
| **Synapse Homeserver** | 8008 | Matrix protocol (auth, rooms, messages) |

The call-config.json **MUST** come from port 3000 because:
- It contains the WebSocket URL (ws://IP:3000)
- It's dynamically generated with current IP
- Synapse (port 8008) doesn't know about your custom call system

---

## Current Status

### Backend (Port 3000) ✅
```bash
$ curl http://192.168.1.22:3000/health
{"status":"healthy","database":"connected"}

$ curl http://192.168.1.22:3000/call-config.json
{
  "baseUrl": "http://192.168.1.22:3000",
  "websocketUrl": "http://192.168.1.22:3000",
  "homeserverUrl": "http://192.168.1.22:8008",
  "iceServers": [...]
}
```

### Frontend ❌
- Still fetching from port 8008
- Getting 404 errors
- WebSocket not connecting
- No incoming call notifications

---

## What You Need to Do

### Option 1: Send to Frontend Team (Recommended)
Share these files with your frontend developer:
1. **FRONTEND_FIX_REQUIRED.md** - Detailed explanation
2. **CLAUDE_PROMPT_FOR_FRONTEND.txt** - Ready for Claude CLI
3. **QUICK_REFERENCE.txt** - Visual quick guide

### Option 2: Fix It Yourself
If you have access to the FluffyChat code:

1. Open `lib/widgets/matrix.dart`
2. Find the `_fetchCallConfig()` method (around line 115)
3. Replace the configUrl line with the fixed code above
4. Rebuild and test

---

## Testing After Fix

Once frontend implements the fix, test:

1. **Fetch call-config.json**:
   - Should succeed with 200 OK
   - Should return JSON with baseUrl, websocketUrl, homeserverUrl

2. **WebSocket connection**:
   - Check logs for: `[CallSocketService] Connected successfully`
   - Should connect to ws://192.168.1.22:3000

3. **Incoming call**:
   - Initiate call from one device
   - Receiver should see accept/reject UI within 1-2 seconds
   - Check logs for: `[CallSocketService] Received incoming-call event`

---

## Why This Happened

You have a **split architecture** (call backend on 3000, homeserver on 8008), but the frontend was written assuming a **unified architecture** (everything on 8008).

This is a common issue when:
- Using custom WebRTC instead of Matrix's built-in VoIP
- Running multiple services on different ports
- Frontend assumes homeserver serves all endpoints

---

## Summary

**Problem**: Receiver not seeing accept/reject UI  
**Cause**: Frontend fetching call-config.json from wrong port (8008 instead of 3000)  
**Solution**: Frontend must change one line in matrix.dart  
**Backend Status**: ✅ Fully working, ready for calls  
**Frontend Status**: ❌ Blocked until fix is implemented  
**Priority**: 🔴 Critical - Blocks all incoming call functionality

---

## Files Created for Frontend Team

1. ✅ **FRONTEND_FIX_REQUIRED.md** - Complete documentation
2. ✅ **CLAUDE_PROMPT_FOR_FRONTEND.txt** - Claude CLI prompt
3. ✅ **QUICK_REFERENCE.txt** - Visual quick guide
4. ✅ **BACKEND_WORKING_STATUS.md** - Proof backend is working

**All files are in**: `/Users/nipampranav/Downloads/LUMOS LOGIC/matrix-server/`

---

**Next Step**: Send FRONTEND_FIX_REQUIRED.md to your frontend developer and ask them to implement the fix in matrix.dart.
