/**
 * Location Sharing - Matrix API Helpers
 *
 * Handles:
 * - Getting short-lived user access tokens via Synapse Admin API
 * - Sending m.location events (current location)
 * - Sending beacon_info state events (live location start/stop)
 * - Sending beacon update events (live location updates)
 */

const axios = require('axios');

const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const SYNAPSE_ADMIN_TOKEN = process.env.SYNAPSE_ADMIN_TOKEN;

/**
 * Get a short-lived access token for a Matrix user via Synapse Admin API.
 * Uses POST /_synapse/admin/v1/users/{userId}/login
 */
async function getUserAccessToken(matrixUserId) {
  const response = await axios.post(
    `${SYNAPSE_URL}/_synapse/admin/v1/users/${encodeURIComponent(matrixUserId)}/login`,
    {},
    {
      headers: {
        'Authorization': `Bearer ${SYNAPSE_ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
  return response.data.access_token;
}

/**
 * Send a current location message (m.location msgtype) as the user.
 */
async function sendLocationMessage(accessToken, roomId, lat, lng, accuracy) {
  const geoUri = `geo:${lat},${lng}` + (accuracy ? `;u=${Math.round(accuracy)}` : '');
  const now = Date.now();
  const txnId = `loc_${now}_${Math.random().toString(36).slice(2, 10)}`;

  const event = {
    msgtype: 'm.location',
    body: `Location: ${geoUri}`,
    geo_uri: geoUri,
    'org.matrix.msc3488.location': {
      uri: geoUri,
    },
    'org.matrix.msc3488.ts': now,
  };

  const response = await axios.put(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
    event,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  return response.data.event_id;
}

/**
 * Start live location sharing by sending a beacon_info state event.
 * Uses PUT /rooms/{roomId}/state/org.matrix.msc3672.beacon_info/{userId}
 */
async function sendBeaconInfoStart(accessToken, roomId, matrixUserId, durationMs) {
  const event = {
    live: true,
    timeout: durationMs,
    'org.matrix.msc3488.ts': Date.now(),
    'org.matrix.msc3488.asset': {
      type: 'm.self',
    },
  };

  const response = await axios.put(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc3672.beacon_info/${encodeURIComponent(matrixUserId)}`,
    event,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  return response.data.event_id;
}

/**
 * Send a beacon location update event.
 * Uses PUT /rooms/{roomId}/send/org.matrix.msc3672.beacon/{txnId}
 */
async function sendBeaconUpdate(accessToken, roomId, beaconEventId, lat, lng, accuracy) {
  const geoUri = `geo:${lat},${lng}` + (accuracy ? `;u=${Math.round(accuracy)}` : '');
  const txnId = `beacon_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const event = {
    'm.relates_to': {
      rel_type: 'm.reference',
      event_id: beaconEventId,
    },
    'org.matrix.msc3488.location': {
      uri: geoUri,
    },
    'org.matrix.msc3488.ts': Date.now(),
  };

  const response = await axios.put(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/org.matrix.msc3672.beacon/${encodeURIComponent(txnId)}`,
    event,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  return response.data.event_id;
}

/**
 * Stop live location sharing by sending beacon_info with live: false.
 */
async function sendBeaconInfoStop(accessToken, roomId, matrixUserId) {
  const event = {
    live: false,
    'org.matrix.msc3488.ts': Date.now(),
    'org.matrix.msc3488.asset': {
      type: 'm.self',
    },
  };

  const response = await axios.put(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc3672.beacon_info/${encodeURIComponent(matrixUserId)}`,
    event,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  return response.data.event_id;
}

module.exports = {
  getUserAccessToken,
  sendLocationMessage,
  sendBeaconInfoStart,
  sendBeaconUpdate,
  sendBeaconInfoStop,
};
