require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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
const { router: callRoutes, setIoInstance } = require('./call-routes');
const { sendBeaconInfoStop } = require('./location-helpers');
const { setupCallSignaling } = require('./call-signaling');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const SYNAPSE_URL_FOR_PROXY = process.env.SYNAPSE_URL || 'http://localhost:8008';

// ===== MATRIX API REVERSE PROXY (must be before express.json() and static) =====
// Proxy all /_matrix/* and /_synapse/* requests to Synapse homeserver
// This allows FluffyChat and other Matrix clients to connect via the Cloudflare tunnel
app.use('/_matrix', createProxyMiddleware({
  target: SYNAPSE_URL_FOR_PROXY,
  changeOrigin: true,
  ws: true,
  timeout: 30000,
  proxyTimeout: 30000,
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
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN;
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'localhost';
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

// ===== CALL SERVER CONFIG ENDPOINT =====
// Returns the correct call server URL dynamically — no hardcoded IPs.
// Uses the incoming request's host so it works on any network/IP/tunnel.
app.get('/call-config.json', (req, res) => {
  const proto = req.get('x-forwarded-proto') || 'http';
  const localIP = getLocalIP();
  const callServerUrl = `${proto}://${localIP}:${PORT}`;
  const homeserverUrl = `${proto}://${localIP}:8008`;

  res.json({
    baseUrl: callServerUrl,
    websocketUrl: callServerUrl,
    homeserverUrl: homeserverUrl,
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  });
});

// ===== .WELL-KNOWN ENDPOINTS (for Matrix client/server discovery) =====
// Uses the request's own host header so it works regardless of IP or tunnel URL
app.get('/.well-known/matrix/client', (req, res) => {
  const proto = req.get('x-forwarded-proto') || 'http';
  const host = req.get('host') || `${getLocalIP()}:${PORT}`;
  res.json({
    'm.homeserver': {
      'base_url': `${proto}://${host}`,
    },
  });
});

app.get('/.well-known/matrix/server', (req, res) => {
  const host = req.get('host') || `${getLocalIP()}:${PORT}`;
  res.json({
    'm.server': host,
  });
});

// POST /invites - Create a new registration invite (ADMIN ONLY)
app.post('/invites', requireAdmin, async (req, res) => {
  const { email } = req.body;

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
       (id, email, token, invited_by, expires_at, used, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, false, NOW())
       RETURNING id, email, token, expires_at, created_at`,
      [email, token, invitedBy, expiresAt]
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

// Voice/Video call API routes
app.use('/api/calls', callRoutes);

// Setup WebSocket signaling for WebRTC
setupCallSignaling(io);

// Connect WebSocket instance to call routes
setIoInstance(io);

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
      `SELECT id, email, invited_by, expires_at, used
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
  console.log(`WebSocket server ready for call signaling`);

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

  // Disappearing messages cleanup - purge expired messages from Synapse
  async function purgeExpiredMessages() {
    try {
      // Query Synapse DB for rooms with m.room.retention state events
      const result = await synapsePool.query(
        `SELECT c.room_id, e.json::jsonb->'content' AS content
         FROM current_state_events c
         JOIN event_json e ON c.event_id = e.event_id
         WHERE c.type = 'm.room.retention'`
      );

      for (const row of result.rows) {
        try {
          const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
          const maxLifetime = content?.max_lifetime;

          if (!maxLifetime || maxLifetime <= 0) {
            continue;
          }

          const cutoffTimestamp = Date.now() - maxLifetime;

          console.log(`[RETENTION] Purging room ${row.room_id} (max_lifetime: ${maxLifetime}ms, cutoff: ${new Date(cutoffTimestamp).toISOString()})`);

          const purgeResponse = await axios.post(
            `${SYNAPSE_URL}/_synapse/admin/v1/purge_history/${encodeURIComponent(row.room_id)}`,
            { purge_up_to_ts: cutoffTimestamp },
            {
              headers: {
                'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );

          console.log(`[RETENTION] Purge started for ${row.room_id}, purge_id: ${purgeResponse.data.purge_id}`);
        } catch (err) {
          console.error(`[RETENTION] Failed to purge room ${row.room_id}:`, err.response?.data || err.message);
        }
      }

      if (result.rows.length > 0) {
        console.log(`[RETENTION] Processed ${result.rows.length} room(s) with retention policies`);
      }
    } catch (error) {
      console.error('[RETENTION] Purge timer error:', error.message);
    }
  }

  // Run retention purge on startup and then every 1 minute
  // (frequent interval needed to support 5-minute disappearing messages)
  purgeExpiredMessages();
  setInterval(purgeExpiredMessages, 1 * 60 * 1000);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });
});

module.exports = app;
