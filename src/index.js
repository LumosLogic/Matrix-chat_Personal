require('dotenv').config();

// Force IPv4 for all DNS lookups — Firebase/Google APIs are IPv6-capable but
// this host has no IPv6 internet access, so always prefer IPv4 addresses.
require('dns').setDefaultResultOrder('ipv4first');

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

const { sendPushForNewMessage } = require('./push-trigger');
const { router: pushRoutes, handlePushGateway } = require('./push-routes');
const { requireAuth }                                       = require('./auth-middleware');
const { requireRole, requirePermission, requireSameTenant } = require('./role-middleware');
const { ROLES }                                             = require('./roles');
const roleRoutes                                            = require('./role-routes');

// ===== MATRIX PUSH GATEWAY (must be BEFORE the /_matrix proxy) =====
// Synapse requires the gateway URL path to be exactly /_matrix/push/v1/notify.
// We intercept it here before the general /_matrix proxy forwards it to Synapse.
app.post('/_matrix/push/v1/notify', express.json(), handlePushGateway);

// ===== MATRIX MESSAGE-SEND INTERCEPTOR (must be BEFORE the /_matrix proxy) =====
// Intercepts PUT /_matrix/client/*/rooms/*/send/* to trigger FCM push after
// Synapse confirms the event. The request is forwarded to Synapse via axios,
// the response is returned to the client immediately, then FCM fires async.
app.put(
  '/_matrix/client/:version/rooms/:roomId/send/:eventType/:txnId',
  express.json(),
  async (req, res) => {
    const { version, roomId, eventType, txnId } = req.params;
    try {
      const synapseRes = await axios({
        method: 'PUT',
        url: `${SYNAPSE_URL_FOR_PROXY}/_matrix/client/${version}/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${txnId}`,
        headers: {
          authorization: req.headers.authorization,
          'content-type': 'application/json',
        },
        data: req.body,
        timeout: 30000,
      });

      // Return Synapse's response to the client immediately
      res.status(synapseRes.status).json(synapseRes.data);

      // NOTE: push-trigger.js is intentionally NOT called here.
      // Synapse fires push notifications via our push gateway (push-routes.js /
      // handlePushGateway) which is the spec-compliant path and handles all
      // event types including call invites. Calling sendPushForNewMessage here
      // as well would cause every message to deliver two notifications to the
      // recipient (one from Synapse gateway + one from the trigger below).
    } catch (err) {
      if (err.response) {
        res.status(err.response.status).json(err.response.data);
      } else {
        console.error('[PUSH-PROXY] Synapse forward error:', err.message);
        res.status(502).json({ errcode: 'M_UNKNOWN', error: 'Bad Gateway' });
      }
    }
  }
);

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
async function _notifyRoomOfRegistration(roomId, matrixUserId, fullName) {
  try {
    const loginResp = await axios.post(
      `${SYNAPSE_URL}/_synapse/admin/v1/users/${encodeURIComponent(BOT_USER_ID)}/login`,
      {},
      { headers: { Authorization: `Bearer ${SYNAPSE_ADMIN_TOKEN}` } }
    );
    const botToken = loginResp.data.access_token;

    const txnId = `reg_${Date.now()}`;
    await axios.put(
      `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        msgtype: 'm.text',
        body: `New user registered!\n\nName: ${fullName}\nMatrix ID: ${matrixUserId}\n\nThey can now log in using the app.`,
      },
      { headers: { Authorization: `Bearer ${botToken}` } }
    );
    console.log(`[NOTIFY] Registration notification sent to ${roomId} for ${matrixUserId}`);
  } catch (e) {
    console.error('[NOTIFY] Error sending notification:', e.response?.data || e.message);
  }
}

// POST /invites - Create a new registration invite (no email required)
// Admin: own company only, roles: agent or user
// Super Admin: any company, any role (except super_admin)
app.post('/invites',
  requireAuth,
  requireRole(ROLES.ADMIN),
  requirePermission('create_invite'),
  async (req, res) => {
    const { label = '', room_id, role = 'user', tenant_id } = req.body;
    const actor = req.enterpriseUser;

    if (!['admin', 'agent', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Bad Request', message: 'role must be admin, agent, or user' });
    }

    if (actor.role === ROLES.ADMIN && role === ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: 'Admin cannot create an invite for super_admin role' });
    }

    // Admin can only invite into their own company
    const targetTenant = actor.role === ROLES.SUPER_ADMIN
      ? (tenant_id || actor.tenant_id)
      : actor.tenant_id;

    if (!targetTenant) {
      return res.status(400).json({ error: 'Bad Request', message: 'tenant_id is required' });
    }

    const client = await pool.connect();
    try {
      const token     = generateToken();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      const result = await client.query(
        `INSERT INTO registration_invites
         (id, token, invited_by, expires_at, used, created_at, room_id, tenant_id, role)
         VALUES (gen_random_uuid(), $1, $2, $3, false, NOW(), $4, $5, $6)
         RETURNING id, token, expires_at, created_at, tenant_id, role`,
        [token, req.matrixUserId, expiresAt, room_id || null, targetTenant, role]
      );

      const invite     = result.rows[0];
      const inviteLink = `${getBaseUrl()}/register?token=${token}`;

      await client.query(
        `INSERT INTO audit_logs (action, actor, target) VALUES ('INVITE_CREATED', $1, $2)`,
        [req.matrixUserId, `${label || 'unlabelled'} (${role}) → ${targetTenant}`]
      );

      res.status(201).json({
        success: true,
        invite: {
          id:          invite.id,
          label:       label || null,
          role:        invite.role,
          tenant_id:   invite.tenant_id,
          expires_at:  invite.expires_at,
          created_at:  invite.created_at,
          invite_link: inviteLink,
        },
      });
    } catch (error) {
      console.error('Error creating invite:', error);
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Conflict', message: 'An invite with this token already exists' });
      }
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create invite' });
    } finally {
      client.release();
    }
  }
);

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

app.use('/api/push', pushRoutes);
app.use('/api/roles', roleRoutes);

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
      `SELECT id, expires_at, used, used_at
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
    res.json({ valid: true });
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
      `SELECT id, invited_by, expires_at, used, room_id, role, tenant_id
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

    // Create enterprise user record — role and tenant_id come from the invite, never from client
    const userResult = await client.query(
      `INSERT INTO enterprise_users
       (id, full_name, role, tenant_id, matrix_user_id, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', NOW())
       RETURNING id, full_name, role, tenant_id, matrix_user_id, status, created_at`,
      [full_name, invite.role || 'user', invite.tenant_id || 'default', matrixUserId]
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
      _notifyRoomOfRegistration(invite.room_id, matrixUserId, full_name).catch(e => {
        console.error('[NOTIFY] Failed to send registration notification:', e.message);
      });
    }

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        full_name: user.full_name,
        role: user.role,
        tenant_id: user.tenant_id,
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
        message: 'A user with this Matrix ID already exists',
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

// GET /invites/:id - Get invite status (Admin or Super Admin)
app.get('/invites/:id', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
  const { id }  = req.params;
  const actor   = req.enterpriseUser;

  try {
    const result = await pool.query(
      `SELECT id, email, invited_by, expires_at, used, used_at, created_at, tenant_id, role
       FROM registration_invites
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not Found', message: 'Invite not found' });
    }

    const invite = result.rows[0];

    // Admin can only view invites within their own company
    if (actor.role !== ROLES.SUPER_ADMIN && invite.tenant_id !== actor.tenant_id) {
      return res.status(403).json({ error: 'Access denied: cross-company action not allowed' });
    }

    res.json({ invite });
  } catch (error) {
    console.error('Error fetching invite:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch invite' });
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

  console.log('\nAI bot should be running as a separate PM2 process (ai-bot)');

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
