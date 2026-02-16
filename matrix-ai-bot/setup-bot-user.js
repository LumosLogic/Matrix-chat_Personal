/**
 * Setup script for the AI Bot Matrix user account.
 *
 * Creates the @ai-bot:localhost user via the Synapse Admin API.
 * Run once before starting the bot for the first time.
 *
 * Usage: node setup-bot-user.js
 */

require('dotenv').config();
const http = require('http');
const https = require('https');

const HOMESERVER_URL = process.env.HOMESERVER_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN;
const BOT_USER = process.env.BOT_USER || '@ai-bot:localhost';
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'AiBot2025!Secure';
const BOT_DISPLAY_NAME = process.env.BOT_DISPLAY_NAME || 'AI Assistant';

if (!SYNAPSE_ADMIN_TOKEN) {
  console.error('ERROR: SYNAPSE_ADMIN_TOKEN is required in .env');
  process.exit(1);
}

/**
 * Make an HTTP request (no external dependencies needed)
 */
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function setup() {
  console.log('==========================================');
  console.log('  AI Bot User Setup');
  console.log('==========================================');
  console.log(`Homeserver: ${HOMESERVER_URL}`);
  console.log(`Bot User:   ${BOT_USER}`);
  console.log('==========================================\n');

  const encodedUserId = encodeURIComponent(BOT_USER);

  // Step 1: Create or update the bot user
  console.log('[1/2] Creating bot user account...');

  const createResult = await request(
    'PUT',
    `${HOMESERVER_URL}/_synapse/admin/v2/users/${encodedUserId}`,
    {
      password: BOT_PASSWORD,
      displayname: BOT_DISPLAY_NAME,
      admin: false,
      deactivated: false,
    }
  );

  if (createResult.status === 200 || createResult.status === 201) {
    console.log(`      User ${BOT_USER} created/updated successfully.`);
  } else {
    console.error(`      Failed to create user:`, createResult.data);
    process.exit(1);
  }

  // Step 2: Verify the user exists
  console.log('[2/2] Verifying user...');

  const verifyResult = await request(
    'GET',
    `${HOMESERVER_URL}/_synapse/admin/v2/users/${encodedUserId}`
  );

  if (verifyResult.status === 200) {
    console.log(`      Verified: ${verifyResult.data.name}`);
    console.log(`      Display:  ${verifyResult.data.displayname}`);
    console.log(`      Admin:    ${verifyResult.data.admin}`);
  } else {
    console.error(`      Verification failed:`, verifyResult.data);
    process.exit(1);
  }

  console.log('\n==========================================');
  console.log('  Setup Complete!');
  console.log('==========================================');
  console.log(`Bot user ${BOT_USER} is ready.`);
  console.log(`You can now start the bot with: npm start`);
  console.log('==========================================');
}

setup().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
