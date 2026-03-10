#!/usr/bin/env node

/**
 * Test script to verify Matrix push notification setup
 * 
 * This script tests:
 * 1. Firebase Admin SDK initialization
 * 2. Push gateway endpoint response
 * 3. Database connection for push tokens
 */

require('dotenv').config();
const axios = require('axios');

async function testFirebaseInit() {
  console.log('🔥 Testing Firebase Admin SDK initialization...');
  
  try {
    const admin = require('firebase-admin');
    
    // Check if already initialized
    if (admin.apps.length > 0) {
      console.log('✅ Firebase Admin SDK already initialized');
      return true;
    }
    
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountPath) {
      console.log('❌ FIREBASE_SERVICE_ACCOUNT env var not set');
      return false;
    }
    
    let credential;
    if (serviceAccountPath.trim().startsWith('{')) {
      credential = admin.credential.cert(JSON.parse(serviceAccountPath));
    } else {
      credential = admin.credential.cert(require(serviceAccountPath));
    }
    
    admin.initializeApp({ credential });
    console.log('✅ Firebase Admin SDK initialized successfully');
    return true;
  } catch (error) {
    console.log('❌ Firebase initialization failed:', error.message);
    return false;
  }
}

async function testPushGateway() {
  console.log('\n📡 Testing push gateway endpoint...');
  
  try {
    const response = await axios.post('http://localhost:3000/_matrix/push/v1/notify', {
      notification: {
        event_id: '$test',
        room_id: '!test:localhost',
        type: 'm.room.message',
        sender: '@testuser:localhost',
        sender_display_name: 'Test User',
        devices: [{
          app_id: 'com.cqr.app',
          pushkey: 'FAKE_TEST_TOKEN',
          pushkey_ts: 0,
          data: {}
        }]
      }
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    
    if (response.status === 200 && response.data.rejected !== undefined) {
      console.log('✅ Push gateway responding correctly');
      console.log('   Response:', JSON.stringify(response.data));
      return true;
    } else {
      console.log('❌ Unexpected response from push gateway');
      return false;
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log('❌ Cannot connect to server on port 3000. Is the server running?');
    } else {
      console.log('❌ Push gateway test failed:', error.message);
    }
    return false;
  }
}

async function testDatabase() {
  console.log('\n🗄️  Testing database connection...');
  
  try {
    const pool = require('./src/db');
    const result = await pool.query('SELECT 1 as test');
    console.log('✅ Database connection successful');
    
    // Check if push_tokens table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'push_tokens'
      );
    `);
    
    if (tableCheck.rows[0].exists) {
      console.log('✅ push_tokens table exists');
    } else {
      console.log('⚠️  push_tokens table not found - run migrations');
    }
    
    return true;
  } catch (error) {
    console.log('❌ Database test failed:', error.message);
    return false;
  }
}

async function main() {
  console.log('🧪 Matrix Push Notification Setup Test\n');
  
  const tests = [
    testFirebaseInit,
    testPushGateway,
    testDatabase
  ];
  
  let passed = 0;
  for (const test of tests) {
    if (await test()) {
      passed++;
    }
  }
  
  console.log(`\n📊 Results: ${passed}/${tests.length} tests passed`);
  
  if (passed === tests.length) {
    console.log('🎉 All tests passed! Your push notification setup is ready.');
    console.log('\nNext steps:');
    console.log('1. Restart Synapse to pick up the push configuration');
    console.log('2. Test with your Flutter app by registering a push token');
    console.log('3. Send a message to trigger a push notification');
  } else {
    console.log('❌ Some tests failed. Please fix the issues above.');
    process.exit(1);
  }
}

main().catch(console.error);