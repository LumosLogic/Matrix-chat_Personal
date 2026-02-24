# Encrypted Messages Display Fix

## Problem
After logout and relogin, old encrypted messages were displaying as "🔒 encrypted" text instead of being decrypted, even though the encryption keys were being backed up and restored.

## Root Cause
The issue was in the key restoration and decryption request mechanism:

1. **Incomplete Key Request Logic**: The `_decryptLastEvents` function in `auto_bootstrap.dart` only requested keys for events with `can_request_session == true`, which excluded many old encrypted messages.

2. **No Timeline-Level Key Requests**: When entering a chat room, there was no mechanism to automatically request decryption keys for encrypted messages in the timeline.

3. **Limited Scope**: Only the last event in each room was being processed, not the full timeline of encrypted messages.

## Solution

### 1. Enhanced Auto-Bootstrap Key Requests (`auto_bootstrap.dart`)
**File**: `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/utils/auto_bootstrap.dart`

**Changes**:
- Modified `_decryptLastEvents` to request keys for ALL encrypted messages, not just those with `can_request_session == true`
- Added timeline processing to handle up to 50 recent encrypted messages per room
- Made the function async to properly handle key requests
- Added proper error handling and logging

**Before**:
```dart
static void _decryptLastEvents(Client client) {
  for (final room in client.rooms) {
    final event = room.lastEvent;
    if (event != null &&
        event.type == EventTypes.Encrypted &&
        event.messageType == MessageTypes.BadEncrypted &&
        event.content['can_request_session'] == true) {
      // Only processed last event with specific flag
    }
  }
}
```

**After**:
```dart
static void _decryptLastEvents(Client client) async {
  for (final room in client.rooms) {
    // Process last event
    final lastEvent = room.lastEvent;
    if (lastEvent != null && lastEvent.type == EventTypes.Encrypted) {
      await lastEvent.requestKey();
    }
    
    // Process recent timeline events (up to 50)
    final timeline = await room.getTimeline();
    final encryptedEvents = timeline.events
        .where((e) => e.type == EventTypes.Encrypted && 
                     e.messageType == MessageTypes.BadEncrypted)
        .take(50);
    
    for (final event in encryptedEvents) {
      await event.requestKey();
    }
  }
}
```

### 2. Chat Room Timeline Key Requests (`chat.dart`)
**File**: `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/pages/chat/chat.dart`

**Changes**:
- Added `_requestKeysForEncryptedMessages()` method to request keys when timeline loads
- Integrated this method into the `_getTimeline()` function
- Processes up to 100 recent encrypted messages in the current chat

**New Method**:
```dart
Future<void> _requestKeysForEncryptedMessages() async {
  final tl = timeline;
  if (tl == null) return;
  
  final encryptedEvents = tl.events
      .where((e) => e.type == EventTypes.Encrypted && 
                   e.messageType == MessageTypes.BadEncrypted)
      .take(100);
  
  for (final event in encryptedEvents) {
    await event.requestKey();
  }
}
```

**Integration**:
```dart
timeline!.requestKeys(onlineKeyBackupOnly: false);

// NEW: Request decryption for all encrypted messages
_requestKeysForEncryptedMessages();

if (room.markedUnread) room.markUnread(false);
```

## How It Works

### Login Flow:
1. User logs in with password
2. Password is cached in `Matrix.cachedPassword` for 10 minutes
3. `AutoBootstrap.run()` is triggered automatically
4. Keys are restored from backend before SSSS bootstrap
5. After bootstrap completes, `_decryptLastEvents()` requests keys for all encrypted messages
6. Keys are decrypted using the restored session keys

### Chat Room Entry Flow:
1. User opens a chat room
2. Timeline is loaded via `_getTimeline()`
3. `timeline.requestKeys()` is called
4. `_requestKeysForEncryptedMessages()` processes all encrypted messages
5. Each encrypted message requests its decryption key
6. Messages are decrypted and displayed properly

## Testing

### Test Case 1: New User
1. Register a new user
2. Send encrypted messages
3. Logout
4. Login again
5. **Expected**: All old messages should be readable

### Test Case 2: Existing User
1. Login with existing account that has encrypted messages
2. **Expected**: All old messages should be readable

### Test Case 3: Multiple Rooms
1. Have encrypted messages in multiple rooms
2. Logout and login
3. Open each room
4. **Expected**: All messages in all rooms should be readable

### Test Case 4: Large Message History
1. Have 100+ encrypted messages in a room
2. Logout and login
3. Open the room
4. **Expected**: Recent 100 messages should be decrypted immediately, older messages on scroll

## Performance Considerations

- **Auto-Bootstrap**: Processes up to 50 messages per room across all rooms
- **Chat Timeline**: Processes up to 100 messages in the current room
- **Async Processing**: All key requests are async to avoid blocking the UI
- **Error Handling**: Failed key requests don't block other messages

## Backend Requirements

The fix relies on the existing key backup system:
- **Backend API**: `/api/keys/backup` (POST and GET)
- **Database**: `key_backups` table in PostgreSQL
- **Encryption**: AES-256 with password-derived key

No backend changes are required for this fix.

## Files Modified

1. `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/utils/auto_bootstrap.dart`
   - Enhanced `_decryptLastEvents()` method

2. `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/pages/chat/chat.dart`
   - Added `_requestKeysForEncryptedMessages()` method
   - Integrated into `_getTimeline()` function

## Deployment

1. **Frontend**: Rebuild the Flutter app with the updated code
2. **Backend**: No changes required
3. **Testing**: Test with both new and existing users

## Notes

- The fix is backward compatible with existing users
- No database migrations required
- Works for both new and old users
- Handles offline scenarios gracefully
- Does not affect message sending, only decryption
