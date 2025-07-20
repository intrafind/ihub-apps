#!/usr/bin/env node

/**
 * Manual Authentication Test Script
 * 
 * Tests authentication and authorization with actual user accounts
 */

import jwt from 'jsonwebtoken';
import axios from 'axios';

const API_BASE = 'http://localhost:3000/api';
const JWT_SECRET = 'magic-secret'; // From platform.json

// Test users from users.json
const testUsers = [
  {
    name: 'Demo User',
    username: 'user',
    password: 'password123',
    expectedGroups: ['user', 'authenticated'],
    expectedApps: ['chat', 'translator', 'summarizer', 'email-composer'] // From group permissions
  },
  {
    name: 'Demo Admin',
    username: 'admin', 
    password: 'password123',
    expectedGroups: ['admin', 'authenticated'],
    expectedApps: ['*'] // Admin should see all
  },
  {
    name: 'Daniel Manzke (intrafind)',
    username: 'daniel.manzke@intrafind.com',
    password: 'password123',
    expectedGroups: ['users', 'user', 'authenticated'], 
    expectedApps: ['chat', 'translator', 'summarizer', 'email-composer', 'file-analysis'] // authenticated + user groups
  },
  {
    name: 'Daniel Manzke (manzked)',
    username: 'manzked',
    password: 'password123',
    expectedGroups: ['admins', 'authenticated'], 
    expectedApps: ['*'] // Admin should see all
  }
];

async function testLogin(user) {
  console.log(`\n🧪 Testing login for: ${user.name}`);
  
  try {
    const response = await axios.post(`${API_BASE}/auth/login`, {
      username: user.username,
      password: user.password
    });
    
    if (response.data.success && response.data.token) {
      console.log('✅ Login successful');
      
      // Decode token to see what's in it
      const decoded = jwt.decode(response.data.token);
      console.log('📝 Token contents:', {
        id: decoded.id,
        groups: decoded.groups,
        exp: new Date(decoded.exp * 1000).toISOString()
      });
      
      // Test the token with apps endpoint
      return await testAppsAccess(response.data.token, user);
    } else {
      console.log('❌ Login failed:', response.data.error);
      return false;
    }
  } catch (error) {
    console.log('❌ Login error:', error.response?.data?.error || error.message);
    return false;
  }
}

async function testAppsAccess(token, user) {
  console.log('🔍 Testing apps access with token...');
  
  try {
    const response = await axios.get(`${API_BASE}/apps`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    
    console.log(`📱 Apps returned: ${response.data.length}`);
    const appIds = response.data.map(app => app.id);
    console.log('🎯 App IDs:', appIds.slice(0, 10).join(', ') + (appIds.length > 10 ? '...' : ''));
    
    // Check ETag to ensure it's user-specific
    const etag = response.headers.etag;
    console.log('🏷️  ETag:', etag);
    
    // Check if user is getting expected access
    if (user.expectedApps.includes('*')) {
      console.log('✅ Admin user - should see all apps');
    } else {
      console.log('🔍 Expected apps:', user.expectedApps.join(', '));
      const hasUnexpected = appIds.some(id => !user.expectedApps.includes(id));
      if (hasUnexpected) {
        console.log('⚠️  User seeing apps they should not have access to!');
        console.log('❗ Unexpected apps:', appIds.filter(id => !user.expectedApps.includes(id)));
      } else {
        console.log('✅ User only seeing expected apps');
      }
    }
    
    return true;
  } catch (error) {
    console.log('❌ Apps access error:', error.response?.data?.error || error.message);
    console.log('📊 Status:', error.response?.status);
    return false;
  }
}

async function testAnonymousAccess() {
  console.log('\n🔓 Testing anonymous access (no token)...');
  
  try {
    const response = await axios.get(`${API_BASE}/apps`);
    console.log(`📱 Anonymous apps returned: ${response.data.length}`);
    if (response.data.length > 0) {
      console.log('⚠️  Anonymous users can see apps! Check allowAnonymous setting.');
    } else {
      console.log('✅ Anonymous access properly blocked');
    }
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ Anonymous access properly blocked with 401');
    } else {
      console.log('❌ Unexpected error:', error.response?.data?.error || error.message);
    }
  }
}

async function testInvalidToken() {
  console.log('\n🔒 Testing invalid token...');
  
  try {
    const response = await axios.get(`${API_BASE}/apps`, {
      headers: {
        Authorization: 'Bearer invalid-token-here'
      }
    });
    console.log('⚠️  Invalid token was accepted!');
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ Invalid token properly rejected with 401');
    } else {
      console.log('❌ Unexpected error:', error.response?.data?.error || error.message);
    }
  }
}

async function testPlatformConfig() {
  console.log('\n⚙️  Testing platform config access...');
  
  try {
    const response = await axios.get(`${API_BASE}/configs/platform`);
    console.log('✅ Platform config accessible');
    console.log('🔍 Auth mode:', response.data.auth?.mode);
    console.log('🔍 Allow anonymous:', response.data.auth?.allowAnonymous);
  } catch (error) {
    console.log('❌ Platform config error:', error.response?.data?.error || error.message);
  }
}

async function runTests() {
  console.log('🔐 Starting Authentication Test Suite\n');
  console.log('=' .repeat(60));
  
  // Test platform config first
  await testPlatformConfig();
  
  // Test anonymous access 
  await testAnonymousAccess();
  
  // Test invalid token
  await testInvalidToken();
  
  // Test each user
  for (const user of testUsers) {
    await testLogin(user);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('🏁 Authentication tests completed');
  console.log('\n💡 Check the server logs for permission debugging info');
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('\n💥 Unhandled error:', error.message);
  process.exit(1);
});

// Run tests
runTests().catch(error => {
  console.error('\n💥 Test suite failed:', error.message);
  process.exit(1);
});