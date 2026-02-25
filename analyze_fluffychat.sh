#!/bin/bash

# FluffyChat Auto-Logout Fix Analyzer
# This script analyzes the FluffyChat project and suggests fixes

FLUTTER_PROJECT="/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat"
OUTPUT_FILE="/Users/priyanshupatel/Downloads/matrix-server/FLUFFYCHAT_FIX_SUGGESTIONS.md"

echo "🔍 Analyzing FluffyChat project for auto-logout issues..."
echo ""

# Check if project exists
if [ ! -d "$FLUTTER_PROJECT" ]; then
    echo "❌ Error: FluffyChat project not found at: $FLUTTER_PROJECT"
    exit 1
fi

# Create output file
cat > "$OUTPUT_FILE" << 'EOF'
# FluffyChat Auto-Logout Fix Suggestions
Generated: $(date)

## 🎯 Issues Found and Required Fixes

---

EOF

echo "## 📁 Files to Modify" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# Find chat page files
echo "### 1. Chat Page Files" >> "$OUTPUT_FILE"
find "$FLUTTER_PROJECT" -name "chat.dart" -o -name "chat_page.dart" -o -name "chat_view.dart" 2>/dev/null | while read file; do
    echo "- \`$file\`" >> "$OUTPUT_FILE"
    
    # Check for room.requestKeys()
    if grep -q "room\.requestKeys()" "$file" 2>/dev/null; then
        echo "  - ⚠️ **FOUND**: \`room.requestKeys()\` - needs guarding" >> "$OUTPUT_FILE"
    fi
    
    # Check for timeline loading
    if grep -q "getTimeline\|loadTimeline\|_timeline" "$file" 2>/dev/null; then
        echo "  - ⚠️ **FOUND**: Timeline loading - needs debouncing" >> "$OUTPUT_FILE"
    fi
    
    # Check for dispose method
    if grep -q "void dispose()" "$file" 2>/dev/null; then
        echo "  - ✓ Has dispose() method" >> "$OUTPUT_FILE"
    else
        echo "  - ⚠️ **MISSING**: dispose() method" >> "$OUTPUT_FILE"
    fi
done

echo "" >> "$OUTPUT_FILE"

# Find auto_bootstrap.dart
echo "### 2. Auto Bootstrap File" >> "$OUTPUT_FILE"
BOOTSTRAP_FILE=$(find "$FLUTTER_PROJECT" -name "auto_bootstrap.dart" 2>/dev/null | head -1)
if [ -n "$BOOTSTRAP_FILE" ]; then
    echo "- \`$BOOTSTRAP_FILE\`" >> "$OUTPUT_FILE"
    
    # Check if fixes are already applied
    if grep -q "static bool _running = false" "$BOOTSTRAP_FILE" 2>/dev/null; then
        echo "  - ✓ **FIXED**: _running guard already present" >> "$OUTPUT_FILE"
    else
        echo "  - ❌ **NEEDS FIX**: Missing _running guard" >> "$OUTPUT_FILE"
    fi
    
    if grep -q "wipeCrossSigning(false)" "$BOOTSTRAP_FILE" 2>/dev/null; then
        echo "  - ✓ **FIXED**: wipeCrossSigning(false) already set" >> "$OUTPUT_FILE"
    else
        echo "  - ❌ **NEEDS FIX**: wipeCrossSigning still destructive" >> "$OUTPUT_FILE"
    fi
    
    if grep -q "wipeOnlineKeyBackup(false)" "$BOOTSTRAP_FILE" 2>/dev/null; then
        echo "  - ✓ **FIXED**: wipeOnlineKeyBackup(false) already set" >> "$OUTPUT_FILE"
    else
        echo "  - ❌ **NEEDS FIX**: wipeOnlineKeyBackup still destructive" >> "$OUTPUT_FILE"
    fi
else
    echo "- ⚠️ **NOT FOUND**: auto_bootstrap.dart" >> "$OUTPUT_FILE"
fi

echo "" >> "$OUTPUT_FILE"

# Find login/auth files
echo "### 3. Login/Auth Files" >> "$OUTPUT_FILE"
find "$FLUTTER_PROJECT" -name "*login*.dart" -o -name "*auth*.dart" 2>/dev/null | head -5 | while read file; do
    echo "- \`$file\`" >> "$OUTPUT_FILE"
    
    # Check for exportDump
    if grep -q "exportDump()" "$file" 2>/dev/null; then
        echo "  - ⚠️ **FOUND**: \`exportDump()\` - should be removed from login flow" >> "$OUTPUT_FILE"
    fi
done

echo "" >> "$OUTPUT_FILE"
echo "---" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# Generate detailed fix instructions
cat >> "$OUTPUT_FILE" << 'FIXES'
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

FIXES

echo "" >> "$OUTPUT_FILE"
echo "✅ Analysis complete! Report saved to: $OUTPUT_FILE"
echo ""
echo "📄 Opening report..."

# Display the report
cat "$OUTPUT_FILE"

echo ""
echo "---"
echo ""
echo "🎯 Next Steps:"
echo "1. Review the report above"
echo "2. Apply the suggested fixes to your FluffyChat project"
echo "3. Run: cd '/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat' && flutter build apk --release"
echo "4. Test the navigation flow"
echo ""
