# BACKEND TESTING PROMPT (Matrix Synapse Server)

## Test 1: Token Expiry Issue
```
Check my Matrix Synapse homeserver.yaml configuration for token expiry settings. 
The logs show soft logout with token refresh:
- [Matrix] [MatrixWidget] ! SOFT LOGOUT for "CQR-1772456523886"
- [Matrix] [ClientManager] Token refreshed successfully

Verify these settings and suggest optimal values:
1. access_token_lifetime
2. refresh_token_lifetime  
3. refreshable_access_token_lifetime
4. session_lifetime

Also check if registration_shared_secret is properly configured for token generation.
```

## Test 2: Empty Chat/Message Sync Issue
```
Debug why messages aren't appearing in chat rooms. Logs show:
- [Matrix] [ChatDebug] Room !RjLRCIopJfOCcuszBb:54.197.248.7: encrypted=false, membership=Membership.join, canSendDefault=true
- [Matrix] No more events found in the store. Request from server...

Check:
1. Database sync_state and events tables
2. Synapse event retention settings
3. Room state and timeline sync configuration
4. Check if messages are being stored: SELECT * FROM events WHERE room_id = '!RjLRCIopJfOCcuszBb:54.197.248.7' ORDER BY stream_ordering DESC LIMIT 10;

Provide SQL queries to verify message storage and sync configuration fixes.
```

## Test 3: Well-Known Configuration
```
Verify my Matrix server serves .well-known endpoints correctly.
Current error: Connection timed out to https://54.197.248.7/.well-known/matrix/client

Check:
1. Is serve_server_wellknown: true in homeserver.yaml?
2. Nginx/reverse proxy configuration for .well-known
3. Test command: curl https://54.197.248.7/.well-known/matrix/client

Provide complete nginx config or homeserver.yaml changes needed.
```

---

# FRONTEND TESTING PROMPT (Flutter Matrix Client)

## Test 1: Token Refresh Handling
```
My Flutter Matrix app shows soft logout errors. Logs:
- [Matrix] [MatrixWidget] ! SOFT LOGOUT for "CQR-1772456523886" — token=syt_YWRt...
- [Matrix] [ClientManager] Token refreshed successfully for @admin:54.197.248.7

Check the Matrix SDK token refresh implementation:
1. Is automatic token refresh enabled?
2. Are refresh tokens being stored properly?
3. Check Client initialization for token lifecycle handling

Provide code to:
- Enable automatic token refresh
- Handle soft logout gracefully
- Store and restore refresh tokens properly
```

## Test 2: Empty Chat Room Issue
```
Chat rooms show empty even though messages exist. Logs show:
- [Matrix] [ChatDebug] Timeline loaded for !RjLRCIopJfOCcuszBb:54.197.248.7, requesting keys... canSendDefault=true
- [Matrix] Requesting history...
- [Matrix] No more events found in the store. Request from server...

Debug:
1. Timeline loading logic
2. Event storage and retrieval from local database
3. Sync filter configuration
4. Room.getTimeline() implementation

Check if:
- Initial sync is completing
- Events are being stored in local DB
- Timeline widget is properly rebuilding on new events

Provide code fixes for timeline loading and event display.
```

## Test 3: User Invitation Error
```
When inviting users, the app shows an error (see Screenshot_20260302_193351.jpg context).

Logs show well-known endpoint timeout. Check:
1. Client.checkHomeserver() implementation
2. Homeserver discovery fallback logic
3. Error handling for federation/invitation

Provide code to:
- Handle missing .well-known gracefully
- Add fallback homeserver URL
- Improve invitation error messages
```

## Test 4: Auto-Bootstrap Disabled
```
Logs show: [AutoBootstrap] DISABLED - auto-bootstrap temporarily disabled to prevent sync conflicts.

This may prevent E2EE key setup. Check:
1. Why is auto-bootstrap disabled?
2. Is this causing message decryption issues?
3. How to safely re-enable it?

Provide code to properly initialize encryption bootstrap.
```

---

# CONFIGURATION CHANGES NEEDED

## Backend (homeserver.yaml)
```yaml
# Add/verify these settings:

# Token lifetime settings
access_token_lifetime: 7d
refresh_token_lifetime: 30d
refreshable_access_token_lifetime: 5m
session_lifetime: 30d

# Enable refresh tokens
refresh_token_enabled: true

# Serve well-known
serve_server_wellknown: true

# Event retention (ensure messages aren't deleted)
retention:
  enabled: false

# Sync settings
sync_response_cache_duration: 2s
```

## Frontend (Flutter)
```dart
// Client initialization with token refresh
await client.init(
  waitForFirstSync: true,
  waitUntilLoadCompletedLoaded: false,
);

// Enable automatic token refresh
client.onSoftLogout.stream.listen((event) async {
  await client.refresh();
});

// Timeline loading fix
final timeline = await room.getTimeline(
  onUpdate: () => setState(() {}),
  onChange: (i) => setState(() {}),
);
await timeline.requestHistory(historyCount: 50);
```

---

# TESTING COMMANDS

## Backend Tests
```bash
# Test well-known
curl https://54.197.248.7/.well-known/matrix/client

# Check Synapse logs
tail -f /var/log/matrix-synapse/homeserver.log | grep -i "token\|sync\|event"

# Test token endpoint
curl -X POST https://54.197.248.7:8008/_matrix/client/v3/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token": "YOUR_REFRESH_TOKEN"}'

# Check database for messages
sqlite3 homeserver.db "SELECT event_id, type, room_id FROM events WHERE room_id = '!RjLRCIopJfOCcuszBb:54.197.248.7' LIMIT 10;"
```

## Frontend Tests
```bash
# Flutter logs with filtering
flutter logs | grep -i "matrix\|token\|timeline\|sync"

# Clear app data and test fresh sync
flutter clean
flutter run

# Test with verbose logging
flutter run --verbose
```
