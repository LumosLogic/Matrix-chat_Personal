/**
 * Matrix Location Bot
 *
 * A Matrix bot that handles location sharing commands.
 * Users type !location in chat, bot responds with a web link
 * to share their GPS location.
 *
 * Commands:
 *   !location      - Get a link to share current location
 *   !location live - Get a link to share live location
 *   !location stop - Stop active live location sharing
 *   !location help - Show help message
 */

require('dotenv').config();
const sdk = require('matrix-js-sdk');
const axios = require('axios');

// ==============================================
// Configuration
// ==============================================

const CONFIG = {
  botUser: process.env.BOT_USER,
  botPassword: process.env.BOT_PASSWORD,
  homeserverUrl: process.env.HOMESERVER_URL,
  backendUrl: process.env.BACKEND_URL,
  backendApiKey: process.env.BACKEND_ADMIN_API_KEY,
};

// Validate required config
const requiredConfig = ['botUser', 'botPassword', 'homeserverUrl', 'backendUrl', 'backendApiKey'];
for (const key of requiredConfig) {
  if (!CONFIG[key]) {
    console.error(`[FATAL] Missing required config: ${key}`);
    process.exit(1);
  }
}

// Track when bot started to ignore old messages
let botStartTime = null;
let syncComplete = false;

// ==============================================
// Helper Functions
// ==============================================

/**
 * Create a location session via the backend API
 */
async function createLocationSession(matrixUserId, roomId) {
  const response = await axios.post(
    `${CONFIG.backendUrl}/api/location/session/create`,
    { matrix_user_id: matrixUserId, room_id: roomId },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': CONFIG.backendApiKey,
      },
      timeout: 10000,
    }
  );
  return response.data;
}

/**
 * Send a text message to a room
 */
async function sendMessage(client, roomId, message) {
  console.log(`[SEND] Sending message to ${roomId}`);
  try {
    await client.sendTextMessage(roomId, message);
    console.log(`[SEND] Message sent successfully`);
  } catch (error) {
    console.error(`[SEND] Failed to send message to ${roomId}:`, error.message);
  }
}

// ==============================================
// Command Handlers
// ==============================================

/**
 * Handle !location help
 */
async function handleHelpCommand(client, roomId) {
  const helpText = `Location Bot Help

Commands:
  !location      - Share your current location
  !location live - Share live location (continuous updates)
  !location stop - Stop active live sharing
  !location help - Show this help message

How it works:
1. Type !location in chat
2. Open the link in your browser
3. Allow GPS access
4. Choose current or live mode
5. Your location appears as a map pin in chat`;

  await sendMessage(client, roomId, helpText);
}

/**
 * Handle !location (create session and return link)
 */
async function handleLocationCommand(client, roomId, senderId) {
  console.log(`[CMD] !location from ${senderId} in ${roomId}`);

  try {
    const result = await createLocationSession(senderId, roomId);
    const link = result.session.link;

    const message = `Share your location:\n${link}\n\nOpen this link in your browser to share your GPS location in this chat.`;
    await sendMessage(client, roomId, message);
  } catch (error) {
    console.error('[CMD] Error creating session:', error.response?.data || error.message);

    let errorMsg = 'Failed to create location session. Please try again later.';
    if (error.code === 'ECONNREFUSED') {
      errorMsg = 'Backend service unavailable. Contact system administrator.';
    }

    await sendMessage(client, roomId, `Error: ${errorMsg}`);
  }
}

/**
 * Handle !location stop
 */
async function handleStopCommand(client, roomId, senderId) {
  console.log(`[CMD] !location stop from ${senderId}`);
  await sendMessage(client, roomId,
    'To stop live location sharing, use the "Stop Sharing" button on the location sharing page in your browser.'
  );
}

/**
 * Process a room message event
 */
async function processMessage(client, event, room) {
  const roomId = room.roomId;
  const senderId = event.getSender();
  const eventTime = event.getTs();

  // Ignore messages from bot itself
  if (senderId === CONFIG.botUser) {
    return;
  }

  // Ignore messages from before bot started
  if (eventTime < botStartTime) {
    return;
  }

  // Only handle text messages
  const content = event.getContent();
  if (content.msgtype !== 'm.text') {
    return;
  }

  const body = (content.body || '').trim();
  if (!body) {
    return;
  }

  console.log(`[MSG] ${senderId} in ${roomId}: "${body}"`);

  // Route commands
  if (body === '!location help') {
    await handleHelpCommand(client, roomId);
  } else if (body === '!location stop') {
    await handleStopCommand(client, roomId, senderId);
  } else if (body === '!location' || body === '!location live') {
    await handleLocationCommand(client, roomId, senderId);
  }
}

/**
 * Auto-join a room
 */
async function autoJoinRoom(client, roomId) {
  console.log(`[JOIN] Attempting to join room: ${roomId}`);
  try {
    await client.joinRoom(roomId);
    console.log(`[JOIN] Successfully joined: ${roomId}`);

    setTimeout(async () => {
      await sendMessage(client, roomId,
        `Hello! I'm the Location Bot.\n\nI help you share your GPS location in chat.\n\nType !location help to see available commands.`
      );
    }, 1000);

    return true;
  } catch (error) {
    console.error(`[JOIN] Failed to join ${roomId}:`, error.message);
    return false;
  }
}

/**
 * Process pending invites
 */
async function processPendingInvites(client) {
  console.log('[INIT] Checking for pending room invites...');

  const rooms = client.getRooms();
  for (const room of rooms) {
    const membership = room.getMyMembership();
    if (membership === 'invite') {
      console.log(`[INIT] Found pending invite for room: ${room.roomId}`);
      await autoJoinRoom(client, room.roomId);
    }
  }
}

// ==============================================
// Bot Initialization
// ==============================================

async function startBot() {
  console.log('==========================================');
  console.log('  Matrix Location Bot');
  console.log('==========================================');
  console.log(`Bot User:   ${CONFIG.botUser}`);
  console.log(`Homeserver: ${CONFIG.homeserverUrl}`);
  console.log(`Backend:    ${CONFIG.backendUrl}`);
  console.log('==========================================\n');

  botStartTime = Date.now();
  console.log(`[INIT] Bot start time: ${new Date(botStartTime).toISOString()}`);

  try {
    // Login
    console.log('[AUTH] Logging in...');
    const tempClient = sdk.createClient({ baseUrl: CONFIG.homeserverUrl });
    const loginResponse = await tempClient.login('m.login.password', {
      user: CONFIG.botUser,
      password: CONFIG.botPassword,
    });

    console.log(`[AUTH] Login successful`);
    console.log(`[AUTH] User ID:   ${loginResponse.user_id}`);
    console.log(`[AUTH] Device ID: ${loginResponse.device_id}`);

    // Create client with credentials
    const client = sdk.createClient({
      baseUrl: CONFIG.homeserverUrl,
      accessToken: loginResponse.access_token,
      userId: loginResponse.user_id,
      deviceId: loginResponse.device_id,
    });

    // Sync listener
    client.on('sync', async (state, prevState, data) => {
      console.log(`[SYNC] State changed: ${prevState} -> ${state}`);

      if (state === 'PREPARED' && !syncComplete) {
        syncComplete = true;
        console.log('[SYNC] Initial sync complete!');
        await processPendingInvites(client);
        console.log('\n[READY] Bot is now listening for commands!');
        console.log('[READY] Invite the bot to a room and type: !location\n');
      }

      if (state === 'ERROR') {
        console.error('[SYNC] Sync error:', data);
      }
    });

    // Room membership listener (auto-join)
    client.on('RoomMember.membership', async (event, member, oldMembership) => {
      if (member.userId !== CONFIG.botUser) return;

      console.log(`[MEMBER] Membership change: ${oldMembership} -> ${member.membership} in ${member.roomId}`);

      if (member.membership === 'invite') {
        await autoJoinRoom(client, member.roomId);
      }
    });

    // Message listener
    client.on('Room.timeline', async (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) return;
      if (!syncComplete) return;
      if (event.getType() !== 'm.room.message') return;

      try {
        await processMessage(client, event, room);
      } catch (error) {
        console.error('[MSG] Error processing message:', error.message);
      }
    });

    // Start syncing
    console.log('[SYNC] Starting client sync...');
    await client.startClient({ initialSyncLimit: 10 });

  } catch (error) {
    console.error('[FATAL] Failed to start bot:', error.message);

    if (error.errcode === 'M_FORBIDDEN') {
      console.error('[FATAL] Invalid credentials. Check BOT_USER and BOT_PASSWORD.');
    } else if (error.errcode === 'M_USER_DEACTIVATED') {
      console.error('[FATAL] Bot user account is deactivated.');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('[FATAL] Cannot connect to homeserver. Is Synapse running?');
    }

    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Received SIGINT, exiting...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM, exiting...');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled rejection:', reason);
});

// Start the bot
startBot();
