require('dotenv').config();

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Bots run as separate PM2 processes (see ecosystem.config.js)
const { createProxyMiddleware } = require('http-proxy-middleware');
const pool = require('./db');
const synapsePool = require('./synapse-db');
const locationRoutes = require('./location-routes');
const fluffychatLocationRoutes = require('./fluffychat-location');
const { router: statusRoutes, cleanupExpiredStatuses } = require('./status-routes');
const { sendBeaconInfoStop } = require('./location-helpers');
const { purgeExpiredMessages, ensureTable: ensureDisappearingTable } = require('./disappearing-messages');

const app = express();
const server = http.createServer(app);

const SYNAPSE_URL_FOR_PROXY = process.env.SYNAPSE_URL || 'http://localhost:8008';

// ===== MATRIX API REVERSE PROXY (must be before express.json() and static) =====
// Proxy all /_matrix/* and /_synapse/* requests to Synapse homeserver
// This allows FluffyChat and other Matrix clients to connect via the Cloudflare tunnel
app.use('/_matrix', createProxyMiddleware({
  target: SYNAPSE_URL_FOR_PROXY,
  changeOrigin: true,
  ws: true,
  // Matrix sync uses ?timeout=30000 (30s long-poll). Proxy timeout must be
  // higher than that to avoid a race condition where the proxy cuts off a
  // still-running sync request and returns a 502 to the client.
  timeout: 60000,
  proxyTimeout: 60000,
  pathRewrite: { '^/': '/_matrix/' }, // Express strips /_matrix prefix — restore it
  onError: (err, req, res) => {
    console.error('[PROXY] Matrix API proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Bad Gateway', message: 'Matrix server unavailable' });
    }
  },
}));

app.use('/_synapse', createProxyMiddleware({
  target: SYNAPSE_URL_FOR_PROXY,
  changeOrigin: true,
  timeout: 30000,
  proxyTimeout: 30000,
  pathRewrite: { '^/': '/_synapse/' }, // Express strips /_synapse prefix — restore it
  onError: (err, req, res) => {
    console.error('[PROXY] Synapse admin proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Bad Gateway', message: 'Matrix server unavailable' });
    }
  },
}));

// Proxy OpenStreetMap tiles to fix "white box" issue on frontend
app.use('/tiles', createProxyMiddleware({
  target: 'https://a.tile.openstreetmap.org',
  changeOrigin: true,
  pathRewrite: {
    '^/tiles': '', // Remove /tiles prefix
  },
  onProxyRes: (proxyRes, req, res) => {
    // Add CORS header to allow the frontend to render the tiles
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
  },
}));

app.use(express.json());

// Add CORS headers for web browsers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 8008;

// Auto-detect the primary local network IP (changes when Wi-Fi network changes)
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Reads the live Cloudflare tunnel URL from tunnel.log (written by cloudflared).
// Falls back to dynamically detected local IP so no hardcoded IPs are needed.
const TUNNEL_LOG = path.join(__dirname, '..', 'tunnel.log');
function getBaseUrl() {
  try {
    const log = fs.readFileSync(TUNNEL_LOG, 'utf8');
    const matches = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (matches) return matches[matches.length - 1]; // last = most recent tunnel URL
  } catch (_) {}
  return `http://${getLocalIP()}:${PORT}`;
}

// Keep BASE_URL as a computed value for any legacy references
const BASE_URL = getBaseUrl();

// ===== DYNAMIC public_baseurl SYNC =====
// homeserver.yaml's public_baseurl must match whatever URL clients use to reach
// this server. Since the IP changes whenever the machine switches Wi-Fi networks
// (and the Cloudflare tunnel URL changes on every restart), we rewrite the field
// automatically every time Node.js starts — so the NEXT Synapse restart always
// picks up the correct value without any manual edits.
function syncPublicBaseUrl() {
  const baseUrl = getBaseUrl().replace(/\/$/, ''); // strip any trailing slash
  const yamlPath = path.join(__dirname, '..', 'data', 'homeserver.yaml');
  try {
    const content = fs.readFileSync(yamlPath, 'utf8');
    const updated = content.replace(
      /^public_baseurl:.*$/m,
      `public_baseurl: "${baseUrl}/"`,
    );
    if (updated !== content) {
      fs.writeFileSync(yamlPath, updated);
      console.log(`[Config] homeserver.yaml public_baseurl updated → ${baseUrl}/`);
    } else {
      console.log(`[Config] homeserver.yaml public_baseurl already up to date: ${baseUrl}/`);
    }
  } catch (e) {
    console.error('[Config] Failed to sync public_baseurl:', e.message);
  }
}
syncPublicBaseUrl();
// ========================================
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN;
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'localhost';
const BOT_USER_ID = process.env.BOT_USER_ID || '@invitebot:localhost';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// Middleware: Admin authentication
function requireAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid admin API key required',
    });
  }

  next();
}

// Generate secure random token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    console.error('Health check DB error:', error.message);
    res.status(500).json({ status: 'unhealthy', database: 'disconnected', error: error.message });
  }
});

// ===== .WELL-KNOWN ENDPOINTS (for Matrix client/server discovery) =====
// Returns URLs dynamically based on the incoming request host so this works
// correctly on any IP (192.168.1.7, cqr-server.local, Cloudflare tunnel, etc.)
// without hardcoding addresses.
app.get('/.well-known/matrix/client', (req, res) => {
  const proto = req.get('x-forwarded-proto') || 'http';
  // Use the full host header (includes port) so clients reach us on the right port.
  const host = req.get('host') || `${getLocalIP()}:${PORT}`;
  res.json({
    'm.homeserver': {
      'base_url': `${proto}://${host}`,
    },
  });
});

app.get('/.well-known/matrix/server', (req, res) => {
  const proto = req.get('x-forwarded-proto') || 'http';
  const host = req.get('host') || `${getLocalIP()}:${PORT}`;
  res.json({
    'm.server': host,
  });
});

/**
 * Send a Matrix message to a room as the invite bot using Synapse admin
 * user impersonation. Called after successful registration to notify the admin.
 */
async function _notifyRoomOfRegistration(roomId, matrixUserId, email, fullName) {
  try {
    // Step 1: Get a temporary access token for the invite bot via admin API
    const loginResp = await axios.post(
      `${SYNAPSE_URL}/_synapse/admin/v1/users/${encodeURIComponent(BOT_USER_ID)}/login`,
      {},
      { headers: { Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}` } }
    );
    const botToken = loginResp.data.access_token;

    // Step 2: Send message to the room as the bot
    const txnId = `reg_${Date.now()}`;
    await axios.put(
      `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        msgtype: 'm.text',
        body: `New user registered!\n\nName: ${fullName}\nEmail: ${email}\nMatrix ID: ${matrixUserId}\n\nThey can now log in using the FluffyChat app.`,
      },
      { headers: { Authorization: `Bearer ${botToken}` } }
    );
    console.log(`[NOTIFY] Registration notification sent to ${roomId} for ${matrixUserId}`);
  } catch (e) {
    console.error('[NOTIFY] Error sending notification:', e.response?.data || e.message);
  }
}

// POST /invites - Create a new registration invite (ADMIN ONLY)
app.post('/invites', requireAdmin, async (req, res) => {
  const { email, room_id } = req.body;

  if (!email) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Email is required',
    });
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid email format',
    });
  }

  const client = await pool.connect();

  try {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const invitedBy = 'admin'; // Could be extracted from auth context

    const result = await client.query(
      `INSERT INTO registration_invites
       (id, email, token, invited_by, expires_at, used, created_at, room_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, false, NOW(), $5)
       RETURNING id, email, token, expires_at, created_at`,
      [email, token, invitedBy, expiresAt, room_id || null]
    );

    const invite = result.rows[0];
    const inviteLink = `${getBaseUrl()}/register?token=${token}`;

    res.status(201).json({
      success: true,
      invite: {
        id: invite.id,
        email: invite.email,
        expires_at: invite.expires_at,
        created_at: invite.created_at,
        invite_link: inviteLink,
      },
    });
  } catch (error) {
    console.error('Error creating invite:', error);

    if (error.code === '23505') { // Unique violation
      return res.status(409).json({
        error: 'Conflict',
        message: 'An invite with this token already exists',
      });
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create invite',
    });
  } finally {
    client.release();
  }
});

// GET /register - Serve registration page
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

// GET /location - Serve location sharing page
app.get('/location', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'location.html'));
});

// Location sharing API routes (web UI based - works with any client)
app.use('/api/location', locationRoutes);

// FluffyChat direct location API (bypasses web UI)
app.use('/api/fluffychat/location', fluffychatLocationRoutes);

app.use('/api/status', statusRoutes);
const keyBackupRoutes = require('./key-backup-routes');
app.use('/api/keys', keyBackupRoutes);

// GET /api/validate-token - Validate invite token before showing form
app.get('/api/validate-token', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({
      valid: false,
      reason: 'invalid',
      message: 'Invalid invite link.',
    });
  }

  try {
    // Look up the token (include used/expired for specific messaging)
    const result = await pool.query(
      `SELECT id, email, expires_at, used, used_at
       FROM registration_invites
       WHERE token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        valid: false,
        reason: 'invalid',
        message: 'Invalid invite link.',
      });
    }

    const invite = result.rows[0];

    // Check if already used
    if (invite.used) {
      return res.status(410).json({
        valid: false,
        reason: 'used',
        message: 'You already created an account. Please log in using the FluffyChat app.',
      });
    }

    // Check if expired
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({
        valid: false,
        reason: 'expired',
        message: 'This invite link has expired. Please contact the administrator.',
      });
    }

    // Token is valid
    res.json({
      valid: true,
      email: invite.email,
    });
  } catch (error) {
    console.error('Token validation error:', error);
    res.status(500).json({
      valid: false,
      reason: 'error',
      message: 'An error occurred. Please try again.',
    });
  }
});

// POST /register - Register a new user with an invite token
app.post('/register', async (req, res) => {
  const { token, username, password, full_name } = req.body;

  // Validate required fields
  if (!token || !username || !password || !full_name) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'token, username, password, and full_name are required',
    });
  }

  // Validate username format (Matrix localpart rules)
  const usernameRegex = /^[a-z0-9._=\-/]+$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Username must contain only lowercase letters, numbers, and ._=-/',
    });
  }

  // Validate password length
  if (password.length < 8) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Password must be at least 8 characters long',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Validate invite token - fetch full record for specific error messages
    const inviteResult = await client.query(
      `SELECT id, email, invited_by, expires_at, used, room_id
       FROM registration_invites
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );

    if (inviteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Bad Request',
        reason: 'invalid',
        message: 'Invalid invite link.',
      });
    }

    const inviteRecord = inviteResult.rows[0];

    // Check if already used
    if (inviteRecord.used) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        error: 'Gone',
        reason: 'used',
        message: 'You already created an account. Please log in using the FluffyChat app.',
      });
    }

    // Check if expired
    if (new Date(inviteRecord.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        error: 'Gone',
        reason: 'expired',
        message: 'This invite link has expired. Please contact the administrator.',
      });
    }

    const invite = inviteRecord;
    const matrixUserId = `@${username}:${SYNAPSE_SERVER_NAME}`;

    // Create Matrix user via Synapse Admin API
    try {
      await axios.put(
        `${SYNAPSE_URL}/_synapse/admin/v2/users/${encodeURIComponent(matrixUserId)}`,
        {
          password: password,
          displayname: full_name,
          admin: false,
          deactivated: false,
          threepids: [
            {
              medium: 'email',
              address: invite.email,
            },
          ],
        },
        {
          headers: {
            'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (matrixError) {
      await client.query('ROLLBACK');

      console.error('Matrix user creation failed:', matrixError.response?.data || matrixError.message);

      if (matrixError.response?.status === 400) {
        return res.status(400).json({
          error: 'Bad Request',
          message: matrixError.response.data?.error || 'Failed to create Matrix user',
        });
      }

      if (matrixError.response?.status === 409) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A user with this username already exists',
        });
      }

      return res.status(502).json({
        error: 'Bad Gateway',
        message: 'Failed to communicate with Matrix server',
      });
    }

    // Create enterprise user record
    const userResult = await client.query(
      `INSERT INTO enterprise_users
       (id, email, full_name, role, matrix_user_id, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'user', $3, 'active', NOW())
       RETURNING id, email, full_name, role, matrix_user_id, status, created_at`,
      [invite.email, full_name, matrixUserId]
    );

    const user = userResult.rows[0];

    // Mark invite as used
    await client.query(
      `UPDATE registration_invites
       SET used = true, used_at = NOW()
       WHERE id = $1`,
      [invite.id]
    );


    // Insert audit log: INVITE_USED
    await client.query(
      `INSERT INTO audit_logs (id, action, actor, target, created_at)
       VALUES (gen_random_uuid(), 'INVITE_USED', $1, $2, NOW())`,
      [matrixUserId, invite.id]
    );

    // Insert audit log: USER_REGISTERED
    await client.query(
      `INSERT INTO audit_logs (id, action, actor, target, created_at)
       VALUES (gen_random_uuid(), 'USER_REGISTERED', $1, $2, NOW())`,
      [invite.invited_by, matrixUserId]
    );

    await client.query('COMMIT');

    // Send chat notification to the room where !invite was typed (fire-and-forget)
    if (invite.room_id) {
      _notifyRoomOfRegistration(invite.room_id, matrixUserId, invite.email, full_name).catch(e => {
        console.error('[NOTIFY] Failed to send registration notification:', e.message);
      });
    }

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        matrix_user_id: user.matrix_user_id,
        status: user.status,
        created_at: user.created_at,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Registration error:', error);

    if (error.code === '23505') { // Unique violation
      return res.status(409).json({
        error: 'Conflict',
        message: 'A user with this email or Matrix ID already exists',
      });
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to complete registration',
    });
  } finally {
    client.release();
  }
});

// GET /invites/:id - Get invite status (ADMIN ONLY)
app.get('/invites/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, email, invited_by, expires_at, used, used_at, created_at
       FROM registration_invites
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Invite not found',
      });
    }

    res.json({ invite: result.rows[0] });
  } catch (error) {
    console.error('Error fetching invite:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch invite',
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Matrix Enterprise Backend running on port ${PORT}`);
  console.log(`Health check: ${BASE_URL}/health`);
  console.log(`Matrix VoIP enabled (signaling via Synapse sync)`);

  // NOTE: Bots now run as separate PM2 processes instead of child_process.fork()
  // Start them with: pm2 start ecosystem.config.js
  console.log('\nBots should be running as separate PM2 processes (invite-bot, ai-bot)');

  // Location session expiry timer - runs every 60 seconds
  // (handles web-UI based location sessions from /api/location/*)
  async function expireLocationSessions() {
    try {
      const result = await pool.query(
        `SELECT id, matrix_user_id, room_id, matrix_access_token, mode, beacon_event_id
         FROM location_sessions
         WHERE status = 'active' AND expires_at < NOW()`
      );

      for (const session of result.rows) {
        console.log(`[LOCATION] Expiring session ${session.id} for ${session.matrix_user_id}`);

        try {
          // If live mode, send beacon stop event
          if (session.mode === 'live' && session.matrix_access_token) {
            await sendBeaconInfoStop(
              session.matrix_access_token, session.room_id, session.matrix_user_id
            );
          }
        } catch (err) {
          console.error(`[LOCATION] Failed to send beacon stop for session ${session.id}:`, err.message);
        }

        await pool.query(
          `UPDATE location_sessions SET status = 'expired', completed_at = NOW() WHERE id = $1`,
          [session.id]
        );
      }

      if (result.rows.length > 0) {
        console.log(`[LOCATION] Expired ${result.rows.length} session(s)`);
      }
    } catch (error) {
      console.error('[LOCATION] Expiry timer error:', error.message);
    }
  }

  // Run expiry check on startup and then every 60 seconds
  expireLocationSessions();
  setInterval(expireLocationSessions, 60 * 1000);

  // Status cleanup — remove expired items (and optionally purge MXC media) every hour
  cleanupExpiredStatuses();
  setInterval(cleanupExpiredStatuses, 60 * 60 * 1000);

  // Disappearing messages – secure monotonic purge (see src/disappearing-messages.js)
  // Ensures messages cannot be recovered by relaxing or disabling the policy.
  ensureDisappearingTable()
    .then(() => {
      purgeExpiredMessages();
      setInterval(purgeExpiredMessages, 60 * 1000);
    })
    .catch((err) => console.error('[DISAPPEAR] Failed to initialise tracking table:', err.message));

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });
});

module.exports = app;
