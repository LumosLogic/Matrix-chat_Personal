/**
 * E2EE Key Backup API
 *
 * Every route validates the caller's Matrix access token against Synapse
 * (GET /_matrix/client/v3/account/whoami) and uses the returned user_id
 * as the authenticated principal.
 *
 * Routes:
 *   POST  /api/keys/backup            – upload (upsert) encrypted key dump
 *   GET   /api/keys/backup/:userId    – fetch encrypted key dump (own only)
 */

const express = require('express');
const axios   = require('axios');
const pool    = require('./db');

const router = express.Router();

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function whoami(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or malformed Authorization header');
    err.status = 401;
    throw err;
  }
  const token = authHeader.slice(7);
  try {
    const resp = await axios.get(
      `${SYNAPSE_URL}/_matrix/client/v3/account/whoami`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return resp.data.user_id;
  } catch (e) {
    const err = new Error('Invalid or expired Matrix access token');
    err.status = 401;
    throw err;
  }
}

// ─── POST /api/keys/backup ───────────────────────────────────────────────────
// Body: { encryptedKeys: string }
// Upserts a row in key_backups for the authenticated user.

router.post('/backup', async (req, res) => {
  try {
    const matrixUserId = await whoami(req.headers.authorization);
    const { encryptedKeys } = req.body;

    if (!encryptedKeys || typeof encryptedKeys !== 'string') {
      return res.status(400).json({ error: 'encryptedKeys is required and must be a string' });
    }

    await pool.query(
      `INSERT INTO key_backups (user_id, encrypted_keys)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET encrypted_keys = EXCLUDED.encrypted_keys,
             updated_at     = NOW()`,
      [matrixUserId, encryptedKeys],
    );

    return res.status(200).json({ success: true });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: e.message });
    console.error('[key-backup] POST /backup error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/keys/backup/:userId ────────────────────────────────────────────
// Returns { encryptedKeys } for the authenticated user.
// The :userId in the URL is validated against the auth token — you can only
// fetch your own backup.

router.get('/backup/:userId', async (req, res) => {
  try {
    const matrixUserId = await whoami(req.headers.authorization);
    const requestedId  = decodeURIComponent(req.params.userId);

    if (requestedId !== matrixUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await pool.query(
      'SELECT encrypted_keys FROM key_backups WHERE user_id = $1',
      [matrixUserId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No backup found' });
    }

    return res.status(200).json({ encryptedKeys: result.rows[0].encrypted_keys });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: e.message });
    console.error('[key-backup] GET /backup/:userId error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
