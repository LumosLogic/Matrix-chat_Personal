const axios = require('axios');
require('dotenv').config();

// Test local first, then tunnel
const LOCAL_URL = 'http://localhost:3000';
const TUNNEL_URL = process.env.BASE_URL || 'http://localhost:3000';

async function testEndpoint(url, path = '') {
  try {
    const response = await axios.get(`${url}${path}`, { timeout: 5000 });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function verifyBackend() {
  console.log('🔍 Verifying Voice/Video Call Backend...\n');

  // Test which URL works
  console.log('🌐 Testing connectivity...');
  const localTest = await testEndpoint(LOCAL_URL, '/health');
  const tunnelTest = await testEndpoint(TUNNEL_URL, '/health');

  let BASE_URL;
  if (localTest.success) {
    BASE_URL = LOCAL_URL;
    console.log('✅ Using local server:', BASE_URL);
  } else if (tunnelTest.success) {
    BASE_URL = TUNNEL_URL;
    console.log('✅ Using tunnel server:', BASE_URL);
  } else {
    console.error('❌ Neither local nor tunnel server is accessible');
    console.error('Local error:', localTest.error);
    console.error('Tunnel error:', tunnelTest.error);
    process.exit(1);
  }

  try {
    // 1. Health check
    console.log('1. Testing health endpoint...');
    const health = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Health:', health.data);

    // 2. Test call initiation
    console.log('\n2. Testing call initiation...');
    const initResponse = await axios.post(`${BASE_URL}/api/calls/initiate`, {
      roomId: '!test:localhost',
      callType: 'video',
      accessToken: 'test_token',
      userId: '@test:localhost'
    });
    console.log('✅ Call initiated:', {
      callId: initResponse.data.callId,
      status: initResponse.data.status,
      iceServers: initResponse.data.iceServers.length + ' servers'
    });

    const callId = initResponse.data.callId;

    // 3. Test call status
    console.log('\n3. Testing call status...');
    const status = await axios.get(`${BASE_URL}/api/calls/${callId}/status`);
    console.log('✅ Call status:', {
      status: status.data.session.status,
      participants: status.data.participants.length
    });

    // 4. Test toggle audio
    console.log('\n4. Testing toggle audio...');
    await axios.post(`${BASE_URL}/api/calls/${callId}/toggle-audio`, {
      userId: '@test:localhost',
      enabled: false
    });
    console.log('✅ Audio toggled');

    // 5. Test end call
    console.log('\n5. Testing end call...');
    await axios.post(`${BASE_URL}/api/calls/${callId}/end`, {
      userId: '@test:localhost',
      accessToken: 'test_token'
    });
    console.log('✅ Call ended');

    // 6. Verify call ended
    console.log('\n6. Verifying call ended...');
    const finalStatus = await axios.get(`${BASE_URL}/api/calls/${callId}/status`);
    console.log('✅ Final status:', finalStatus.data.session.status);

    console.log('\n🎉 All backend tests passed!');
    console.log('\n📋 Backend is ready for FluffyChat integration');
    console.log('📄 See FLUFFYCHAT_INTEGRATION.md for frontend code');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

verifyBackend();
