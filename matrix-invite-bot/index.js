/**
 * Matrix Invite Bot
 *
 * A Matrix bot that allows authorized admins to generate
 * enterprise invite links directly from chat.
 *
 * Usage: !invite user@example.com
 */

require('dotenv').config();
const sdk = require('matrix-js-sdk');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// ==============================================
// Configuration
// ==============================================

const CONFIG = {
  botUser: process.env.BOT_USER,
  botPassword: process.env.BOT_PASSWORD,
  homeserverUrl: process.env.HOMESERVER_URL,
  backendUrl: process.env.BACKEND_URL,
  backendApiKey: process.env.BACKEND_ADMIN_API_KEY,
  allowedAdmins: process.env.ALLOWED_ADMINS?.split(',').map(s => s.trim()) || [],
  synapseAdminToken: process.env.SYNAPSE_ADMIN_TOKEN,
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
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Check if a Matrix user is an authorized admin
 */
async function isAuthorizedAdmin(userId) {
  // Check against allowed admins list
  if (CONFIG.allowedAdmins.length > 0) {
    const isAllowed = CONFIG.allowedAdmins.includes(userId);
    console.log(`[AUTH] Checking ${userId} against allowed list: ${isAllowed}`);
    return isAllowed;
  }

  // Check via Synapse Admin API (if token provided)
  if (CONFIG.synapseAdminToken) {
    try {
      const response = await axios.get(
        `${CONFIG.homeserverUrl}/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
        {
          headers: { 'Authorization': `Bearer ${CONFIG.synapseAdminToken}` },
        }
      );
      return response.data.admin === true;
    } catch (error) {
      console.error(`[AUTH] Failed to check admin status for ${userId}:`, error.message);
      return false;
    }
  }

  console.warn('[AUTH] No authorization method configured. Denying all requests.');
  return false;
}

/**
 * Call backend API to generate invite
 */
async function generateInvite(email) {
  const response = await axios.post(
    `${CONFIG.backendUrl}/invites`,
    { email },
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
 * Format success message
 */
function formatSuccessMessage(email, inviteData) {
  const expiresAt = new Date(inviteData.invite.expires_at);
  const expiresFormatted = expiresAt.toLocaleString();

  return `Invite Created Successfully

Email: ${email}
Invite Link: ${inviteData.invite.invite_link}
Expires: ${expiresFormatted} (24 hours)

Send this link to the user to complete registration.`;
}

/**
 * Format error message
 */
function formatErrorMessage(error) {
  return `Error: ${error}`;
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
 * Handle !help command
 */
async function handleHelpCommand(client, roomId) {
  const helpText = `Invite Bot Help

Commands:
- !invite user@example.com - Generate an invite link
- !help - Show this help message

Requirements:
- You must be an authorized admin to use !invite
- Email must be in valid format

Note: This bot only works in unencrypted rooms. Please disable encryption in bot rooms.`;

  await sendMessage(client, roomId, helpText);
}

/**
 * Handle !invite command
 */
async function handleInviteCommand(client, roomId, senderId, email) {
  console.log(`[CMD] !invite from ${senderId} for: ${email}`);

  // Validate email provided
  if (!email) {
    await sendMessage(client, roomId, formatErrorMessage(
      'Please provide an email address.\nUsage: !invite user@example.com'
    ));
    return;
  }

  // Validate email format
  if (!isValidEmail(email)) {
    await sendMessage(client, roomId, formatErrorMessage(`Invalid email format: ${email}`));
    return;
  }

  // Check admin authorization
  const isAdmin = await isAuthorizedAdmin(senderId);
  if (!isAdmin) {
    console.log(`[CMD] UNAUTHORIZED: ${senderId}`);
    await sendMessage(client, roomId, formatErrorMessage(
      'Unauthorized. Only admins can generate invite links.'
    ));
    return;
  }

  // Generate invite via backend
  try {
    console.log(`[API] Calling backend to generate invite for ${email}...`);
    const result = await generateInvite(email);
    console.log(`[API] Invite created: ${result.invite.id}`);
    await sendMessage(client, roomId, formatSuccessMessage(email, result));
  } catch (error) {
    console.error(`[API] Error:`, error.response?.data || error.message);

    let errorMsg = 'Failed to generate invite. Please try again later.';
    if (error.response?.data?.message) {
      errorMsg = error.response.data.message;
    } else if (error.code === 'ECONNREFUSED') {
      errorMsg = 'Backend service unavailable. Contact system administrator.';
    }

    await sendMessage(client, roomId, formatErrorMessage(errorMsg));
  }
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

  // Ignore messages from before bot started (prevents replaying history)
  if (eventTime < botStartTime) {
    console.log(`[MSG] Ignoring old message from ${senderId} (ts: ${eventTime})`);
    return;
  }

  const eventType = event.getType();

  // Handle encrypted messages - notify user that encryption is not supported
  if (eventType === 'm.room.encrypted') {
    console.log(`[MSG] Encrypted message detected in ${roomId} from ${senderId}`);
    try {
      await sendMessage(client, roomId,
        'I cannot read encrypted messages. Please use an unencrypted room to interact with me.\n\n' +
        'To create an unencrypted room: Create a new room and disable "Enable encryption" in room settings.'
      );
    } catch (err) {
      console.error(`[MSG] Failed to send encryption notice:`, err.message);
    }
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
  if (body === '!help') {
    await handleHelpCommand(client, roomId);
  } else if (body === '!invite') {
    await sendMessage(client, roomId, formatErrorMessage(
      'Please provide an email address.\nUsage: !invite user@example.com'
    ));
  } else if (body.startsWith('!invite ')) {
    const email = body.substring(8).trim();
    await handleInviteCommand(client, roomId, senderId, email);
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

    // Send welcome message after a brief delay
    setTimeout(async () => {
      await sendMessage(client, roomId,
        `Hello! I'm the Invite Bot.

I help admins generate invite links for new users.

Type !help to see available commands.

Note: I only work in unencrypted rooms.`
      );
    }, 1000);

    return true;
  } catch (error) {
    console.error(`[JOIN] Failed to join ${roomId}:`, error.message);
    return false;
  }
}

/**
 * Process pending invites (rooms where bot is invited but hasn't joined)
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
// Bot Initialization with Retry Logic
// ==============================================

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startBot(attempt = 1) {
  console.log('==========================================');
  console.log('  Matrix Invite Bot (No Encryption)');
  console.log('==========================================');
  console.log(`Bot User:       ${CONFIG.botUser}`);
  console.log(`Homeserver:     ${CONFIG.homeserverUrl}`);
  console.log(`Backend:        ${CONFIG.backendUrl}`);
  console.log(`Allowed Admins: ${CONFIG.allowedAdmins.join(', ') || '(none - using Synapse API)'}`);
  console.log(`Encryption:     Disabled (unencrypted rooms only)`);
  console.log('==========================================\n');

  // Record start time to filter old messages
  botStartTime = Date.now();
  console.log(`[INIT] Bot start time: ${new Date(botStartTime).toISOString()}`);

  try {
    // Step 1: Login to get access token
    console.log('[AUTH] Logging in...');

    const tempClient = sdk.createClient({ baseUrl: CONFIG.homeserverUrl });
    const loginResponse = await tempClient.login('m.login.password', {
      user: CONFIG.botUser,
      password: CONFIG.botPassword,
    });

    console.log(`[AUTH] Login successful`);
    console.log(`[AUTH] User ID:   ${loginResponse.user_id}`);
    console.log(`[AUTH] Device ID: ${loginResponse.device_id}`);

    // Step 2: Create the client WITHOUT encryption
    const client = sdk.createClient({
      baseUrl: CONFIG.homeserverUrl,
      accessToken: loginResponse.access_token,
      userId: loginResponse.user_id,
      deviceId: loginResponse.device_id,
    });

    // Step 3: Set up sync state listener
    client.on('sync', async (state, prevState, data) => {
      console.log(`[SYNC] State changed: ${prevState} -> ${state}`);

      if (state === 'PREPARED' && !syncComplete) {
        syncComplete = true;
        console.log('[SYNC] Initial sync complete!');

        // Process any pending invites from before bot started
        await processPendingInvites(client);

        console.log('\n[READY] Bot is now listening for commands!');
        console.log('[READY] Invite the bot to an unencrypted room and type: !invite user@example.com\n');
      }

      if (state === 'ERROR') {
        console.error('[SYNC] Sync error:', data);
      }
    });

    // Step 4: Set up room membership listener (for new invites)
    client.on('RoomMember.membership', async (event, member, oldMembership) => {
      // Only handle invites to the bot
      if (member.userId !== CONFIG.botUser) {
        return;
      }

      console.log(`[MEMBER] Membership change for bot: ${oldMembership} -> ${member.membership} in ${member.roomId}`);

      if (member.membership === 'invite') {
        // Auto-join when invited
        await autoJoinRoom(client, member.roomId);
      }
    });

    // Step 5: Set up message listener (listen to ALL event types to catch encrypted ones)
    client.on('Room.timeline', async (event, room, toStartOfTimeline) => {
      // Only process live events (not historical)
      if (toStartOfTimeline) {
        return;
      }

      // Only process after initial sync
      if (!syncComplete) {
        return;
      }

      const eventType = event.getType();

      // Handle both regular messages and encrypted messages
      if (eventType !== 'm.room.message' && eventType !== 'm.room.encrypted') {
        return;
      }

      try {
        await processMessage(client, event, room);
      } catch (error) {
        console.error('[MSG] Error processing message:', error.message);
      }
    });

    // Step 6: Start syncing
    console.log('[SYNC] Starting client sync...');
    await client.startClient({
      initialSyncLimit: 10,  // Fetch some history to detect pending invites
    });

  } catch (error) {
    console.error(`[ERROR] Failed to start bot (attempt ${attempt}/${MAX_RETRIES}):`, error.message);

    if (error.errcode === 'M_FORBIDDEN') {
      console.error('[FATAL] Invalid credentials. Check BOT_USER and BOT_PASSWORD.');
      process.exit(1);
    } else if (error.errcode === 'M_USER_DEACTIVATED') {
      console.error('[FATAL] Bot user account is deactivated.');
      process.exit(1);
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.min(attempt, 6);
      console.log(`[RETRY] Retrying in ${delay / 1000}s...`);
      await sleep(delay);
      return startBot(attempt + 1);
    }

    console.error(`[FATAL] All ${MAX_RETRIES} connection attempts failed. Giving up.`);
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

// Unhandled rejection handler (don't crash on transient errors)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled rejection:', reason);
});

// Uncaught exception handler (don't crash on transient errors)
process.on('uncaughtException', (error) => {
  console.error('[ERROR] Uncaught exception:', error.message);
  // Don't exit - let the bot continue running
});

// Start the bot
startBot();
