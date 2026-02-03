#!/usr/bin/env node
/**
 * Integration Test: JWT User Validation via HTTP
 * 
 * Tests JWT validation by making actual HTTP requests to the server.
 * This test requires the server to be running.
 * 
 * Usage:
 * 1. Start the server: npm run dev
 * 2. Run this test: node server/tests/integration-test-jwt-validation.js
 */

import jwt from 'jsonwebtoken';
import { loadUsers, saveUsers } from '../utils/userManager.js';
import configCache from '../configCache.js';
import fetch from 'node-fetch';

const SERVER_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

console.log('🧪 JWT User Validation Integration Test\n');
console.log('=' .repeat(60));
console.log('Server URL:', SERVER_URL);
console.log('=' .repeat(60));

async function testEndpoint(description, token, expectedStatus, expectedErrorType) {
  console.log(`\n📋 ${description}`);
  
  try {
    const response = await fetch(`${SERVER_URL}/api/auth/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (response.status === expectedStatus) {
      console.log(`  ✓ Status: ${response.status} (expected: ${expectedStatus})`);
      
      if (expectedErrorType && data.error === expectedErrorType) {
        console.log(`  ✓ Error type: ${data.error} (expected: ${expectedErrorType})`);
        console.log(`  ✓ Error message: ${data.error_description || data.message}`);
      } else if (expectedStatus === 200 && data.success) {
        console.log(`  ✓ User authenticated: ${data.user?.username || data.user?.id}`);
      }
    } else {
      console.log(`  ✗ Status: ${response.status} (expected: ${expectedStatus})`);
      console.log(`  Response:`, JSON.stringify(data, null, 2));
    }
    
    return { success: response.status === expectedStatus, data };
  } catch (error) {
    console.log(`  ✗ Request failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runTests() {
  // Check if server is running
  console.log('\n📋 Checking server availability...');
  try {
    const healthCheck = await fetch(`${SERVER_URL}/api/health`);
    if (healthCheck.ok) {
      console.log('  ✓ Server is running');
    } else {
      console.log('  ⚠ Server returned unexpected status:', healthCheck.status);
    }
  } catch (error) {
    console.log('  ✗ Server is not available. Please start the server first.');
    console.log('    Run: npm run dev');
    process.exit(1);
  }
  
  // Load users
  const platform = configCache.getPlatform();
  const usersFilePath = platform?.localAuth?.usersFile || 'contents/config/users.json';
  const usersConfig = loadUsers(usersFilePath);
  
  // Test 1: Active user should work
  const activeUser = Object.values(usersConfig.users || {}).find(u => u.active !== false);
  if (activeUser) {
    const activeUserToken = jwt.sign(
      {
        sub: activeUser.id,
        username: activeUser.username,
        name: activeUser.name,
        email: activeUser.email,
        groups: activeUser.internalGroups || [],
        authMode: 'local'
      },
      JWT_SECRET,
      {
        expiresIn: '7d',
        issuer: 'ihub-apps'
      }
    );
    
    await testEndpoint(
      'Test 1: Active user with valid JWT',
      activeUserToken,
      200,
      null
    );
  }
  
  // Test 2: Deleted user should fail with 401
  const deletedUserToken = jwt.sign(
    {
      sub: 'user_deleted_nonexistent_12345',
      username: 'deleteduser',
      name: 'Deleted User',
      email: 'deleted@example.com',
      groups: ['users'],
      authMode: 'local'
    },
    JWT_SECRET,
    {
      expiresIn: '7d',
      issuer: 'ihub-apps'
    }
  );
  
  await testEndpoint(
    'Test 2: Deleted user (non-existent) with valid JWT',
    deletedUserToken,
    401,
    'invalid_token'
  );
  
  // Test 3: Create a disabled user and test
  console.log('\n📋 Test 3: Create disabled user and test JWT validation');
  
  // Create a test disabled user
  const testDisabledUserId = `user_test_disabled_${Date.now()}`;
  const testDisabledUser = {
    id: testDisabledUserId,
    username: `testdisabled_${Date.now()}`,
    email: 'testdisabled@example.com',
    name: 'Test Disabled User',
    active: false,
    passwordHash: '$2b$12$testHash',
    internalGroups: ['users'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  // Add user to config and save
  usersConfig.users[testDisabledUserId] = testDisabledUser;
  try {
    await saveUsers(usersConfig, usersFilePath);
    console.log(`  ✓ Created disabled test user: ${testDisabledUser.username}`);
    
    // Generate JWT for disabled user
    const disabledUserToken = jwt.sign(
      {
        sub: testDisabledUserId,
        username: testDisabledUser.username,
        name: testDisabledUser.name,
        email: testDisabledUser.email,
        groups: testDisabledUser.internalGroups,
        authMode: 'local'
      },
      JWT_SECRET,
      {
        expiresIn: '7d',
        issuer: 'ihub-apps'
      }
    );
    
    await testEndpoint(
      'Test 3: Disabled user with valid JWT',
      disabledUserToken,
      403,
      'access_denied'
    );
    
    // Cleanup: Remove test user
    delete usersConfig.users[testDisabledUserId];
    await saveUsers(usersConfig, usersFilePath);
    console.log(`  ✓ Cleaned up test user`);
  } catch (error) {
    console.log(`  ✗ Failed to create/cleanup test user: ${error.message}`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('\n✅ Integration test completed!\n');
}

runTests().catch(error => {
  console.error('\n❌ Test failed with error:', error);
  process.exit(1);
});
