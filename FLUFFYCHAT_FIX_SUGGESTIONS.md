# FluffyChat Auto-Logout Fix Suggestions
Generated: $(date)

## 🎯 Issues Found and Required Fixes

---

## 📁 Files to Modify

### 1. Chat Page Files
- `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/pages/chat/chat_view.dart`
  - ⚠️ **FOUND**: Timeline loading - needs debouncing
  - ⚠️ **MISSING**: dispose() method
- `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/pages/chat/chat.dart`
  - ⚠️ **FOUND**: Timeline loading - needs debouncing
  - ✓ Has dispose() method

### 2. Auto Bootstrap File
- `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/utils/auto_bootstrap.dart`
  - ✓ **FIXED**: _running guard already present
  - ✓ **FIXED**: wipeCrossSigning(false) already set
  - ✓ **FIXED**: wipeOnlineKeyBackup(false) already set

### 3. Login/Auth Files
- `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/pages/sign_in/view_model/flows/sso_login.dart`
- `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/pages/login/login_view.dart`
- `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/pages/login/login.dart`
- `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat/lib/widgets/layouts/login_scaffold.dart`

---

## 🔧 Required Code Changes

### Fix 1: Guard room.requestKeys() in Chat Page

**Location**: Any file with `room.requestKeys()`

**Add at class level**:
```dart
// Add this static guard at the top of your Chat widget class
static final Set<String> _roomsRequestingKeys = {};
```

**Replace**:
```dart
room.requestKeys();
```

**With**:
```dart
if (!_roomsRequestingKeys.contains(room.id)) {
  _roomsRequestingKeys.add(room.id);
  try {
    await room.requestKeys();
  } catch (e) {
    print('[ChatPage] Error requesting keys: $e');
  } finally {
    _roomsRequestingKeys.remove(room.id);
  }
}
```

---

### Fix 2: Add Debouncing to Timeline Loading

**Location**: Chat page file with timeline loading

**Add at class level**:
```dart
Timer? _timelineLoadTimer;
```

**Wrap timeline loading**:
```dart
Future<void> _loadTimeline() async {
  // Cancel previous load if still pending
  _timelineLoadTimer?.cancel();
  
  // Debounce: wait 300ms before actually loading
  _timelineLoadTimer = Timer(const Duration(milliseconds: 300), () async {
    if (!mounted || !client.isLogged()) return;
    
    // Your existing timeline loading code here...
  });
}
```

**Add to dispose()**:
```dart
@override
void dispose() {
  _timelineLoadTimer?.cancel();
  _roomsRequestingKeys.remove(widget.room.id);
  super.dispose();
}
```

---

### Fix 3: Add Login State Checks After Every Await

**Location**: Throughout chat page

**Pattern to add after every async operation**:
```dart
await someAsyncOperation();

// Add this check immediately after
if (!mounted || !client.isLogged()) {
  print('[ChatPage] Client logged out during operation, aborting');
  return;
}

// Continue with next operation...
```

---

### Fix 4: Add Comprehensive Logging

**Location**: Chat page initState() and dispose()

```dart
@override
void initState() {
  super.initState();
  print('[ChatPage] initState - room: ${widget.room.id}, user: ${client.userID}, logged: ${client.isLogged()}');
}

@override
void dispose() {
  print('[ChatPage] dispose - room: ${widget.room.id}, logged: ${client.isLogged()}');
  _timelineLoadTimer?.cancel();
  _roomsRequestingKeys.remove(widget.room.id);
  super.dispose();
}
```

---

### Fix 5: Verify Auto Bootstrap Fixes

**Location**: `lib/utils/auto_bootstrap.dart`

Ensure these are present:

1. **Running guard**:
```dart
static bool _running = false;
```

2. **In run() method**:
```dart
if (_running) {
  print('[AutoBootstrap] Already running, skipping duplicate call.');
  return;
}
_running = true;
```

3. **Non-destructive wipe settings**:
```dart
case BootstrapState.askWipeCrossSigning:
  bootstrap.wipeCrossSigning(false);  // Must be false
  break;

case BootstrapState.askWipeOnlineKeyBackup:
  bootstrap.wipeOnlineKeyBackup(false);  // Must be false
  break;
```

4. **Finally block**:
```dart
} finally {
  _running = false;
}
```

---

## 🧪 Testing Steps

After applying fixes:

1. **Rebuild APK**:
   ```bash
   cd "/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat"
   flutter clean
   flutter pub get
   flutter build apk --release
   ```

2. **Test Navigation Flow**:
   - Login
   - Open a chat
   - Go back to homepage
   - Open same chat again
   - Repeat 5-10 times
   - Should NOT logout

3. **Check Logs**:
   ```bash
   adb logcat | grep -E "ChatPage|AutoBootstrap|isLogged"
   ```

4. **Test Edge Cases**:
   - Rapidly switch between chats
   - Open chat, minimize app, reopen
   - Open chat, lock screen, unlock

---

## 📊 Expected Behavior After Fixes

✅ **Should Work**:
- Navigate chat → home → chat repeatedly
- Switch between multiple chats rapidly
- Background app and return
- Lock/unlock device while in chat

❌ **Should NOT Happen**:
- Auto-logout during navigation
- Auto-logout when opening chats
- Auto-logout after background/foreground

🔒 **Logout Only When**:
- User taps Logout button
- Server revokes session (admin action)
- Session expires on server (after configured lifetime)

---

## 🚨 If Issues Persist

If auto-logout still happens after applying all fixes:

1. **Capture full logs**:
   ```bash
   adb logcat > logout_debug.log
   # Reproduce the issue
   # Then check logout_debug.log
   ```

2. **Check server logs**:
   ```bash
   cd /Users/priyanshupatel/Downloads/matrix-server
   docker-compose logs synapse | grep -i "logout\|session\|token"
   ```

3. **Verify session lifetime** in Synapse config:
   ```yaml
   # homeserver.yaml
   session_lifetime: 24h
   refresh_token_lifetime: 7d
   ```

---

## 📝 Summary Checklist

- [ ] Add `_roomsRequestingKeys` guard to chat page
- [ ] Add `_timelineLoadTimer` debouncing to chat page
- [ ] Add `if (!mounted || !client.isLogged()) return;` after all awaits
- [ ] Add logging to initState() and dispose()
- [ ] Verify auto_bootstrap.dart has all fixes
- [ ] Rebuild APK with `flutter clean && flutter build apk --release`
- [ ] Test navigation flow 10+ times
- [ ] Check logs for any errors
- [ ] Test edge cases (background, lock screen, etc.)


