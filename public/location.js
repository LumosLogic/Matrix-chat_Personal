/**
 * Location Sharing - Web Page Logic
 *
 * Flow:
 * 1. Validate session token from URL
 * 2. Request GPS permission
 * 3. User picks mode (current or live)
 * 4. Send location to backend API
 * 5. Backend sends Matrix events as the user
 */

// State
let sessionToken = null;
let currentLat = null;
let currentLng = null;
let currentAccuracy = null;
let previewMap = null;
let previewMarker = null;
let liveMap = null;
let liveMarker = null;
let liveWatchId = null;
let liveUpdateInterval = null;
let countdownInterval = null;
let liveExpiresAt = null;

// ============================================================
// Card Management
// ============================================================

function hideAllCards() {
  const cards = ['loading-card', 'invalid-card', 'gps-card', 'mode-card',
                 'duration-card', 'live-card', 'success-card'];
  cards.forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
}

function showCard(id) {
  hideAllCards();
  document.getElementById(id).style.display = 'block';
}

// ============================================================
// Session Validation
// ============================================================

function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
}

async function validateSession(token) {
  try {
    const response = await fetch(`/api/location/session/${encodeURIComponent(token)}`);
    const result = await response.json();

    if (!response.ok || !result.valid) {
      return { valid: false, reason: result.reason || 'invalid', message: result.message };
    }

    return { valid: true, data: result };
  } catch (error) {
    console.error('Session validation error:', error);
    return { valid: false, reason: 'error', message: 'Failed to validate session.' };
  }
}

// ============================================================
// GPS
// ============================================================

function requestGPS() {
  const btn = document.getElementById('gps-btn');
  const btnText = btn.querySelector('.btn-text');
  const btnLoading = btn.querySelector('.btn-loading');
  const gpsError = document.getElementById('gps-error');

  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'inline';
  gpsError.style.display = 'none';

  if (!navigator.geolocation) {
    gpsError.textContent = 'Geolocation is not supported by your browser.';
    gpsError.style.display = 'block';
    btn.disabled = false;
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function (position) {
      currentLat = position.coords.latitude;
      currentLng = position.coords.longitude;
      currentAccuracy = position.coords.accuracy;
      showModeSelection();
    },
    function (error) {
      let msg = 'Unable to get your location.';
      switch (error.code) {
        case error.PERMISSION_DENIED:
          msg = 'Location permission denied. Please allow location access and try again.';
          break;
        case error.POSITION_UNAVAILABLE:
          msg = 'Location information unavailable.';
          break;
        case error.TIMEOUT:
          msg = 'Location request timed out. Please try again.';
          break;
      }
      gpsError.textContent = msg;
      gpsError.style.display = 'block';
      btn.disabled = false;
      btnText.style.display = 'inline';
      btnLoading.style.display = 'none';
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

// ============================================================
// Mode Selection
// ============================================================

function showModeSelection() {
  showCard('mode-card');
  initPreviewMap();
}

function initPreviewMap() {
  if (!previewMap) {
    previewMap = L.map('map-preview').setView([currentLat, currentLng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(previewMap);
    previewMarker = L.marker([currentLat, currentLng]).addTo(previewMap);
  } else {
    previewMap.setView([currentLat, currentLng], 15);
    previewMarker.setLatLng([currentLat, currentLng]);
  }
  // Fix map sizing after card display change
  setTimeout(() => previewMap.invalidateSize(), 100);
}

// ============================================================
// Send Current Location
// ============================================================

async function sendCurrentLocation() {
  const btn = document.querySelector('#mode-card .btn-primary');
  const btnText = btn.querySelector('.btn-text');
  const btnLoading = btn.querySelector('.btn-loading');

  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'inline';

  try {
    const response = await fetch('/api/location/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_token: sessionToken,
        latitude: currentLat,
        longitude: currentLng,
        accuracy: currentAccuracy,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to send location');
    }

    showCard('success-card');
  } catch (error) {
    console.error('Send location error:', error);
    alert('Failed to send location: ' + error.message);
    btn.disabled = false;
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
  }
}

// ============================================================
// Duration Picker
// ============================================================

function showDurationPicker() {
  showCard('duration-card');
}

// ============================================================
// Live Location
// ============================================================

async function startLive(durationMs) {
  // Disable buttons while starting
  const buttons = document.querySelectorAll('#duration-card .duration-btn');
  buttons.forEach(b => b.disabled = true);

  try {
    const response = await fetch('/api/location/live/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_token: sessionToken,
        latitude: currentLat,
        longitude: currentLng,
        accuracy: currentAccuracy,
        duration_ms: durationMs,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to start live location');
    }

    liveExpiresAt = new Date(result.expires_at);
    showLiveView();
  } catch (error) {
    console.error('Start live error:', error);
    alert('Failed to start live location: ' + error.message);
    buttons.forEach(b => b.disabled = false);
  }
}

function showLiveView() {
  showCard('live-card');
  initLiveMap();
  startGPSWatcher();
  startCountdown();
  startLiveUpdates();
}

function initLiveMap() {
  if (!liveMap) {
    liveMap = L.map('live-map').setView([currentLat, currentLng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(liveMap);
    liveMarker = L.marker([currentLat, currentLng]).addTo(liveMap);
  } else {
    liveMap.setView([currentLat, currentLng], 15);
    liveMarker.setLatLng([currentLat, currentLng]);
  }
  updateLiveCoords();
  setTimeout(() => liveMap.invalidateSize(), 100);
}

function updateLiveCoords() {
  const el = document.getElementById('live-coords');
  if (currentLat != null && currentLng != null) {
    el.textContent = `${currentLat.toFixed(5)}, ${currentLng.toFixed(5)}`;
  }
}

function startGPSWatcher() {
  if (liveWatchId != null) {
    navigator.geolocation.clearWatch(liveWatchId);
  }

  liveWatchId = navigator.geolocation.watchPosition(
    function (position) {
      currentLat = position.coords.latitude;
      currentLng = position.coords.longitude;
      currentAccuracy = position.coords.accuracy;

      if (liveMarker) {
        liveMarker.setLatLng([currentLat, currentLng]);
        liveMap.panTo([currentLat, currentLng]);
      }
      updateLiveCoords();
    },
    function (error) {
      console.warn('GPS watch error:', error.message);
    },
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

function startLiveUpdates() {
  // Send updates to backend every 15 seconds
  liveUpdateInterval = setInterval(async () => {
    if (currentLat == null || currentLng == null) return;

    // Check if expired
    if (liveExpiresAt && new Date() >= liveExpiresAt) {
      cleanupLive();
      showCard('success-card');
      return;
    }

    try {
      await fetch('/api/location/live/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_token: sessionToken,
          latitude: currentLat,
          longitude: currentLng,
          accuracy: currentAccuracy,
        }),
      });
    } catch (error) {
      console.warn('Live update error:', error.message);
    }
  }, 15000);
}

function startCountdown() {
  function updateCountdown() {
    if (!liveExpiresAt) return;

    const remaining = liveExpiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      document.getElementById('countdown-timer').textContent = '0:00';
      cleanupLive();
      showCard('success-card');
      return;
    }

    const totalSeconds = Math.floor(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    let display;
    if (hours > 0) {
      display = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      display = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    document.getElementById('countdown-timer').textContent = display;
  }

  updateCountdown();
  countdownInterval = setInterval(updateCountdown, 1000);
}

async function stopLive() {
  const btn = document.querySelector('#live-card .btn-danger');
  const btnText = btn.querySelector('.btn-text');
  const btnLoading = btn.querySelector('.btn-loading');

  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'inline';

  try {
    const response = await fetch('/api/location/live/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_token: sessionToken }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to stop live location');
    }

    cleanupLive();
    showCard('success-card');
  } catch (error) {
    console.error('Stop live error:', error);
    alert('Failed to stop: ' + error.message);
    btn.disabled = false;
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
  }
}

function cleanupLive() {
  if (liveWatchId != null) {
    navigator.geolocation.clearWatch(liveWatchId);
    liveWatchId = null;
  }
  if (liveUpdateInterval) {
    clearInterval(liveUpdateInterval);
    liveUpdateInterval = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ============================================================
// Initialization
// ============================================================

document.addEventListener('DOMContentLoaded', async function () {
  sessionToken = getTokenFromUrl();

  if (!sessionToken) {
    showCard('invalid-card');
    return;
  }

  // Show loading
  showCard('loading-card');

  // Validate session
  const validation = await validateSession(sessionToken);

  if (!validation.valid) {
    const msgEl = document.getElementById('invalid-message');
    if (validation.message) {
      msgEl.textContent = validation.message;
    }
    showCard('invalid-card');
    return;
  }

  // Session valid - show GPS permission card
  const userIdEl = document.getElementById('gps-user-id');
  userIdEl.textContent = validation.data.matrix_user_id;

  // If session is already active (live mode in progress), resume
  if (validation.data.status === 'active' && validation.data.mode === 'live') {
    showCard('gps-card');
    return;
  }

  showCard('gps-card');
});

// Cleanup on page unload
window.addEventListener('beforeunload', function () {
  cleanupLive();
});
