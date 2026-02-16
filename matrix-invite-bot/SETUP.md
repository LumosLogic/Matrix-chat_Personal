# Matrix Invite Bot - Setup Guide

## Project Structure

```
matrix-invite-bot/
├── .env              # Bot configuration (edit this!)
├── .env.example      # Template for reference
├── package.json      # Dependencies
├── index.js          # Bot code
└── SETUP.md          # This file
```

---

## Step 1: Create the Bot User in Matrix

The bot needs a Matrix account. Create it using the Synapse Admin API.

### Option A: Using curl (Windows CMD)

```cmd
curl -X PUT "http://localhost:8008/_synapse/admin/v2/users/@invitebot:localhost" ^
  -H "Authorization: Bearer syt_YWRtaW4_emdUFqgyhUnzdqhpgKoC_3BieYt" ^
  -H "Content-Type: application/json" ^
  -d "{\"password\": \"InviteBot123!\", \"displayname\": \"Invite Bot\", \"admin\": false}"
```

### Option B: Using PowerShell

```powershell
$headers = @{
    "Authorization" = "Bearer syt_YWRtaW4_emdUFqgyhUnzdqhpgKoC_3BieYt"
    "Content-Type" = "application/json"
}
$body = @{
    password = "InviteBot123!"
    displayname = "Invite Bot"
    admin = $false
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8008/_synapse/admin/v2/users/@invitebot:localhost" `
    -Method PUT -Headers $headers -Body $body
```

### Expected Response

```json
{
  "name": "@invitebot:localhost",
  "displayname": "Invite Bot",
  "admin": 0,
  ...
}
```

---

## Step 2: Configure the Bot

Edit `.env` file:

```env
# Matrix Bot Credentials
BOT_USER=@invitebot:localhost
BOT_PASSWORD=InviteBot123!
HOMESERVER_URL=http://localhost:8008

# Backend API Configuration
BACKEND_URL=http://localhost:3000
BACKEND_ADMIN_API_KEY=9f3a7c1e-3d44-4b29-bf9d-5d0e9b8f3c21

# Authorized Admin Users (comma-separated)
ALLOWED_ADMINS=@admin:localhost
```

**Important:**
- `BACKEND_ADMIN_API_KEY` must match the key in your backend's `.env`
- `ALLOWED_ADMINS` should list Matrix users who can generate invites

---

## Step 3: Install Dependencies

```cmd
cd C:\matrix-server\matrix-invite-bot
npm install
```

---

## Step 4: Start the Bot

Make sure your backend is running first:
```cmd
cd C:\matrix-server
npm start
```

Then start the bot in a new terminal:
```cmd
cd C:\matrix-server\matrix-invite-bot
npm start
```

### Expected Output

```
==========================================
  Matrix Invite Bot Starting...
==========================================
Bot User: @invitebot:localhost
Homeserver: http://localhost:8008
Backend: http://localhost:3000
Allowed Admins: @admin:localhost
==========================================

[AUTH] Logging in...
[AUTH] Logged in successfully. Access token obtained.
[AUTH] Device ID: XXXXXXXXXX
[SYNC] Starting sync...
[READY] Bot is now running and listening for commands!
```

---

## Step 5: Using the Bot in FluffyChat

### 5.1 Start a DM with the Bot

1. Open FluffyChat
2. Login as `@admin:localhost` (or another authorized admin)
3. Tap **"+"** button → **"New chat"**
4. Search for `@invitebot:localhost`
5. Start the conversation

### 5.2 Generate an Invite

Type in the chat:
```
!invite newuser@example.com
```

### 5.3 Bot Response

The bot will reply with:

```
✅ Invite Created Successfully

📧 Email: newuser@example.com
🔗 Invite Link: http://localhost:3000/register?token=abc123...
⏰ Expires: 2/5/2026, 12:00:00 PM (24 hours)

Send this link to the user to complete registration.
```

---

## Example Chat Session (FluffyChat)

```
┌─────────────────────────────────────────────┐
│  Invite Bot                            [DM] │
├─────────────────────────────────────────────┤
│                                             │
│  👋 Hello! I'm the Invite Bot.              │
│                                             │
│  I can help admins generate invite links    │
│  for new users.                             │
│                                             │
│  Type !help to see available commands.      │
│                                             │
│                          ┌────────────────┐ │
│                          │ !help          │ │
│                          └────────────────┘ │
│                                             │
│  Invite Bot Help                            │
│                                             │
│  Commands:                                  │
│  • !invite user@example.com                 │
│  • !help                                    │
│                                             │
│                          ┌────────────────┐ │
│                          │ !invite        │ │
│                          │ john@acme.com  │ │
│                          └────────────────┘ │
│                                             │
│  ✅ Invite Created Successfully             │
│                                             │
│  📧 Email: john@acme.com                    │
│  🔗 Invite Link:                            │
│     http://localhost:3000/register?token=   │
│     a1b2c3d4e5f6g7h8...                     │
│  ⏰ Expires: 2/5/2026, 3:45:00 PM           │
│                                             │
│  Send this link to the user to complete     │
│  registration.                              │
│                                             │
└─────────────────────────────────────────────┘
```

---

## Error Scenarios

### Unauthorized User

If a non-admin tries to use the command:

```
User: !invite test@example.com
Bot:  ❌ Error: Unauthorized. Only admins can generate invite links.
```

### Invalid Email

```
User: !invite not-an-email
Bot:  ❌ Error: Invalid email format: not-an-email
```

### Backend Unavailable

```
User: !invite test@example.com
Bot:  ❌ Error: Backend service is unavailable. Please contact system administrator.
```

---

## Adding More Admins

Edit `.env` and add more Matrix user IDs:

```env
ALLOWED_ADMINS=@admin:localhost,@manager:localhost,@hr:localhost
```

Restart the bot after changing `.env`.

---

## Troubleshooting

### Bot won't login
- Verify `BOT_USER` and `BOT_PASSWORD` are correct
- Ensure the bot user was created in Synapse

### Bot doesn't respond
- Check the bot console for errors
- Ensure the user sending commands is in `ALLOWED_ADMINS`
- Verify the bot has joined the room

### Invite creation fails
- Check backend is running on port 3000
- Verify `BACKEND_ADMIN_API_KEY` matches backend's `.env`
- Check backend console for errors

### Check bot logs
The bot logs all activity to console:
- `[COMMAND]` - Command received
- `[API]` - Backend API calls
- `[ERROR]` - Errors
- `[UNAUTHORIZED]` - Rejected requests
