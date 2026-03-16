const axios = require('axios');

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';

async function whoami(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or malformed Authorization header');
    err.status = 401;
    throw err;
  }
  const token = authHeader.slice(7);
  const { data } = await axios.get(
    `${SYNAPSE_URL}/_matrix/client/v3/account/whoami`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
  );
  return { userId: data.user_id, token };
}

async function requireAuth(req, res, next) {
  try {
    const { userId, token } = await whoami(req.headers.authorization);
    req.matrixUserId = userId;
    req.matrixToken  = token;
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

module.exports = { requireAuth, whoami };
