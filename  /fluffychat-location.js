/**
 * FluffyChat Direct Location API
 * 
 * Enables FluffyChat's built-in "Share location" button to work
 * by providing direct endpoints for location sharing without web UI.
 */

const express = require('express');
const router = express.Router();
const {
  sendLocationMessage,
  sendBeaconInfoStart,
  sendBeaconUpdate,
  sendBeaconInfoStop,
} = require('./location-helpers');

/**
 * POST /api/fluffychat/location/current
 * Send current location (one-time)
 * 
 * Body: {
 *   access_token: string,
 *   room_id: string,
 *   latitude: number,
 *   longitude: number,
 *   accuracy?: number
 * }
 */
router.post('/current', async (req, res) => {
  const { access_token, room_id, latitude, longitude, accuracy } = req.body;

  if (!access_token || !room_id || latitude == null || longitude == null) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'access_token, room_id, latitude, and longitude are required',
    });
  }

  try {
    const eventId = await sendLocationMessage(
      access_token,
      room_id,
      latitude,
      longitude,
      accuracy
    );

    res.json({
      success: true,
      event_id: eventId,
      message: 'Current location sent successfully',
    });
  } catch (error) {
    console.error('[FLUFFYCHAT] Error sending current location:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to send location',
      details: error.response?.data || error.message,
    });
  }
});

/**
 * POST /api/fluffychat/location/live/start
 * Start live location sharing
 * 
 * Body: {
 *   access_token: string,
 *   room_id: string,
 *   user_id: string,
 *   latitude: number,
 *   longitude: number,
 *   accuracy?: number,
 *   duration_ms: number (900000=15min, 3600000=1h, 28800000=8h)
 * }
 */
router.post('/live/start', async (req, res) => {
  const { access_token, room_id, user_id, latitude, longitude, accuracy, duration_ms } = req.body;

  if (!access_token || !room_id || !user_id || latitude == null || longitude == null || !duration_ms) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'access_token, room_id, user_id, latitude, longitude, and duration_ms are required',
    });
  }

  // Validate duration (15 min, 1 hour, 8 hours)
  const allowedDurations = [900000, 3600000, 28800000];
  if (!allowedDurations.includes(duration_ms)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid duration. Allowed: 900000 (15min), 3600000 (1h), 28800000 (8h)',
    });
  }

  try {
    // Start beacon
    const beaconEventId = await sendBeaconInfoStart(
      access_token,
      room_id,
      user_id,
      duration_ms
    );

    // Send first location update
    await sendBeaconUpdate(
      access_token,
      room_id,
      beaconEventId,
      latitude,
      longitude,
      accuracy
    );

    const expiresAt = new Date(Date.now() + duration_ms);

    res.json({
      success: true,
      beacon_event_id: beaconEventId,
      expires_at: expiresAt.toISOString(),
      message: 'Live location sharing started',
    });
  } catch (error) {
    console.error('[FLUFFYCHAT] Error starting live location:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to start live location',
      details: error.response?.data || error.message,
    });
  }
});

/**
 * POST /api/fluffychat/location/live/update
 * Update live location position
 * 
 * Body: {
 *   access_token: string,
 *   room_id: string,
 *   beacon_event_id: string,
 *   latitude: number,
 *   longitude: number,
 *   accuracy?: number
 * }
 */
router.post('/live/update', async (req, res) => {
  const { access_token, room_id, beacon_event_id, latitude, longitude, accuracy } = req.body;

  if (!access_token || !room_id || !beacon_event_id || latitude == null || longitude == null) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'access_token, room_id, beacon_event_id, latitude, and longitude are required',
    });
  }

  try {
    await sendBeaconUpdate(
      access_token,
      room_id,
      beacon_event_id,
      latitude,
      longitude,
      accuracy
    );

    res.json({
      success: true,
      message: 'Location updated',
    });
  } catch (error) {
    console.error('[FLUFFYCHAT] Error updating live location:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update location',
      details: error.response?.data || error.message,
    });
  }
});

/**
 * POST /api/fluffychat/location/live/stop
 * Stop live location sharing
 * 
 * Body: {
 *   access_token: string,
 *   room_id: string,
 *   user_id: string
 * }
 */
router.post('/live/stop', async (req, res) => {
  const { access_token, room_id, user_id } = req.body;

  if (!access_token || !room_id || !user_id) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'access_token, room_id, and user_id are required',
    });
  }

  try {
    await sendBeaconInfoStop(access_token, room_id, user_id);

    res.json({
      success: true,
      message: 'Live location sharing stopped',
    });
  } catch (error) {
    console.error('[FLUFFYCHAT] Error stopping live location:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to stop live location',
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;
