#!/usr/bin/env node

/**
 * Manual Authentication Test Script
 *
 * Tests authentication and authorization with actual user accounts
 */

import jwt from 'jsonwebtoken';
import { httpFetch } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';

const API_BASE = 'http://localhost:3000/api';

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
  logger.info(`\n🧪 Testing login for: ${user.name}`);

  try {
    const response = await httpFetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: user.username,
        password: user.password
      })
    });

    const data = await response.json();

    if (data.success && data.token) {
      logger.info('✅ Login successful');

      // Decode token to see what's in it
      const decoded = jwt.decode(data.token);
      logger.info('📝 Token contents:', {
        id: decoded.id,
        groups: decoded.groups,
        exp: new Date(decoded.exp * 1000).toISOString()
      });

      // Test the token with apps endpoint
      return await testAppsAccess(data.token, user);
    } else {
      logger.info('❌ Login failed:', data.error);
      return false;
    }
  } catch (error) {
    logger.info('❌ Login error:', error.message);
    return false;
  }
}

async function testAppsAccess(token, user) {
  logger.info('🔍 Testing apps access with token...');

  try {
    const response = await httpFetch(`${API_BASE}/apps`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      logger.info(`❌ Apps access failed with status ${response.status}`);
      return false;
    }

    const data = await response.json();

    logger.info(`📱 Apps returned: ${data.length}`);
    const appIds = data.map(app => app.id);
    logger.info('🎯 App IDs:', appIds.slice(0, 10).join(', ') + (appIds.length > 10 ? '...' : ''));

    // Check ETag to ensure it's user-specific
    const etag = response.headers.get('etag');
    logger.info('🏷️  ETag:', etag);

    // Check if user is getting expected access
    if (user.expectedApps.includes('*')) {
      logger.info('✅ Admin user - should see all apps');
    } else {
      logger.info('🔍 Expected apps:', user.expectedApps.join(', '));
      const hasUnexpected = appIds.some(id => !user.expectedApps.includes(id));
      if (hasUnexpected) {
        logger.info('⚠️  User seeing apps they should not have access to!');
        logger.info(
          '❗ Unexpected apps:',
          appIds.filter(id => !user.expectedApps.includes(id))
        );
      } else {
        logger.info('✅ User only seeing expected apps');
      }
    }

    return true;
  } catch (error) {
    logger.info('❌ Apps access error:', error.message);
    return false;
  }
}

async function testAnonymousAccess() {
  logger.info('\n🔓 Testing anonymous access (no token)...');

  try {
    const response = await httpFetch(`${API_BASE}/apps`);
    if (response.status === 401) {
      logger.info('✅ Anonymous access properly blocked with 401');
      return;
    }
    const data = await response.json();
    logger.info(`📱 Anonymous apps returned: ${data.length}`);
    if (data.length > 0) {
      logger.info('⚠️  Anonymous users can see apps! Check allowAnonymous setting.');
    } else {
      logger.info('✅ Anonymous access properly blocked');
    }
  } catch (error) {
    logger.info('❌ Unexpected error:', error.message);
  }
}

async function testInvalidToken() {
  logger.info('\n🔒 Testing invalid token...');

  try {
    const response = await httpFetch(`${API_BASE}/apps`, {
      headers: {
        Authorization: 'Bearer invalid-token-here'
      }
    });
    if (response.status === 401) {
      logger.info('✅ Invalid token properly rejected with 401');
    } else {
      logger.info('⚠️  Invalid token was accepted!');
    }
  } catch (error) {
    logger.info('❌ Unexpected error:', error.message);
  }
}

async function testPlatformConfig() {
  logger.info('\n⚙️  Testing platform config access...');

  try {
    const response = await httpFetch(`${API_BASE}/configs/platform`);
    if (!response.ok) {
      logger.info(`❌ Platform config request failed with status ${response.status}`);
      return;
    }
    const data = await response.json();
    logger.info('✅ Platform config accessible');
    logger.info('🔍 Auth mode:', data.auth?.mode);
    logger.info('🔍 Allow anonymous:', data.auth?.allowAnonymous);
  } catch (error) {
    logger.info('❌ Platform config error:', error.message);
  }
}

async function runTests() {
  logger.info('🔐 Starting Authentication Test Suite\n');
  logger.info('='.repeat(60));

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

  logger.info('\n' + '='.repeat(60));
  logger.info('🏁 Authentication tests completed');
  logger.info('\n💡 Check the server logs for permission debugging info');
}

// Handle errors
process.on('unhandledRejection', error => {
  logger.error('\n💥 Unhandled error:', error.message);
  process.exit(1);
});

// Run tests
runTests().catch(error => {
  logger.error('\n💥 Test suite failed:', error.message);
  process.exit(1);
});
