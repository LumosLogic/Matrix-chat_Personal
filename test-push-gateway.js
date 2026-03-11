#!/usr/bin/env node
/**
 * Test script for the Matrix Push Gateway endpoint
 * 
 * Usage:
 *   node test-push-gateway.js
 * 
 * This simulates what Synapse sends to /_matrix/push/v1/notify
 */

const axios = require('axios');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000/_matrix/push/v1/notify';

// Test 1: Regular message notification
async function testRegularMessage() {
  console.log('\n=== Test 1: Regular Message ===');
  
  const payload = {
    notification: {
      event_id: '$test_event_123',
      room_id: '!test_room:localhost',
      type: 'm.room.message',
      sender: '@alice:localhost',
      sender_display_name: 'Alice',
      room_name: 'Test Room',
      content: {
        body: 'Hello, this is a test message!',
        msgtype: 'm.text'
      },
      counts: {
        unread: 5
      },
      devices: [
        {
          app_id: 'com.cqr.app.cqr.data_message',
          pushkey: 'test_fcm_token_abc123',
          pushkey_ts: Date.now(),
          data: {}
        }
      ],
      prio: 'high'
    }
  };

  try {
    const response = await axios.post(GATEWAY_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('✅ Response:', response.data);
    console.log('Expected: { rejected: [] } or { rejected: ["test_fcm_token_abc123"] }');
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// Test 2: Call invite notification
async function testCallInvite() {
  console.log('\n=== Test 2: Call Invite ===');
  
  const payload = {
    notification: {
      event_id: '$call_event_456',
      room_id: '!test_room:localhost',
      type: 'm.call.invite',
      sender: '@bob:localhost',
      sender_display_name: 'Bob',
      room_name: 'Test Room',
      content: {
        call_id: 'test_call_123',
        version: '1'
      },
      counts: {
        unread: 1
      },
      devices: [
        {
          app_id: 'com.cqr.app.cqr.data_message',
          pushkey: 'test_fcm_token_xyz789',
          pushkey_ts: Date.now(),
          data: {}
        }
      ],
      prio: 'high'
    }
  };

  try {
    const response = await axios.post(GATEWAY_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('✅ Response:', response.data);
    console.log('Expected: { rejected: [] } or { rejected: ["test_fcm_token_xyz789"] }');
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// Test 3: Empty notification (edge case)
async function testEmptyNotification() {
  console.log('\n=== Test 3: Empty Notification ===');
  
  const payload = {
    notification: {}
  };

  try {
    const response = await axios.post(GATEWAY_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('✅ Response:', response.data);
    console.log('Expected: { rejected: [] }');
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// Test 4: No notification field (edge case)
async function testNoNotification() {
  console.log('\n=== Test 4: No Notification Field ===');
  
  const payload = {};

  try {
    const response = await axios.post(GATEWAY_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('✅ Response:', response.data);
    console.log('Expected: { rejected: [] }');
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// Run all tests
async function runTests() {
  console.log('Testing Matrix Push Gateway at:', GATEWAY_URL);
  console.log('Note: These tests use fake FCM tokens, so they will likely be rejected.');
  console.log('Check the backend logs to verify the FCM message structure is correct.');
  
  await testRegularMessage();
  await testCallInvite();
  await testEmptyNotification();
  await testNoNotification();
  
  console.log('\n=== All Tests Complete ===');
  console.log('\nNext steps:');
  console.log('1. Check backend logs for: [PUSH] Sent FCM data-only to ...');
  console.log('2. Verify the message structure includes:');
  console.log('   - android.priority = "high"');
  console.log('   - data.type = "m.room.message" or "m.call.invite"');
  console.log('   - NO top-level notification field (data-only)');
  console.log('3. For calls, verify android.notification.android_channel_id = "cqr_incoming_call"');
}

runTests().catch(console.error);
