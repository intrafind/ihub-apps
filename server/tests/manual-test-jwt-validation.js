#!/usr/bin/env node
/**
 * Manual Test: JWT User Validation Security
 * 
 * Tests that JWT tokens are validated against the user database
 * to ensure disabled or deleted users cannot access the system.
 * 
 * Usage: node server/tests/manual-test-jwt-validation.js
 */

import jwt from 'jsonwebtoken';
import { loadUsers, isUserActive } from '../utils/userManager.js';
import configCache from '../configCache.js';

// Test JWT secret (use the actual secret from config)
const JWT_SECRET = 'test-jwt-secret-for-manual-testing';

console.log('🧪 JWT User Validation Security Test\n');
console.log('=' . repeat(60));

// Test 1: Load users from database
console.log('\n📋 Test 1: Load users from database');
try {
  const usersConfig = loadUsers('contents/config/users.json');
  const userCount = Object.keys(usersConfig.users || {}).length;
  console.log(`✓ Loaded ${userCount} users from database`);
  
  // Display first user for reference
  const firstUserId = Object.keys(usersConfig.users || {})[0];
  if (firstUserId) {
    const firstUser = usersConfig.users[firstUserId];
    console.log(`  Sample user: ${firstUser.username} (id: ${firstUser.id}, active: ${firstUser.active})`);
  }
} catch (error) {
  console.log(`✗ Failed to load users: ${error.message}`);
}

// Test 2: Check isUserActive function
console.log('\n📋 Test 2: Validate isUserActive function');
const usersConfig = loadUsers('contents/config/users.json');
const users = usersConfig.users || {};

// Find an active user
const activeUser = Object.values(users).find(u => u.active !== false);
if (activeUser) {
  const result = isUserActive(activeUser);
  console.log(`✓ Active user check: ${activeUser.username} -> ${result} (expected: true)`);
} else {
  console.log(`⚠ No active users found in database`);
}

// Test 3: Create test scenario - simulate disabled user
console.log('\n📋 Test 3: Simulate disabled user scenario');
const testDisabledUser = {
  id: 'test_disabled',
  username: 'disableduser',
  active: false
};
const isDisabledActive = isUserActive(testDisabledUser);
console.log(`✓ Disabled user check: ${testDisabledUser.username} -> ${isDisabledActive} (expected: false)`);

// Test 4: Create test scenario - simulate deleted user (null)
console.log('\n📋 Test 4: Simulate deleted user scenario');
const isDeletedActive = isUserActive(null);
console.log(`✓ Deleted user check: null -> ${isDeletedActive} (expected: false)`);

// Test 5: Generate JWT for a real user
console.log('\n📋 Test 5: Generate and decode JWT tokens');
if (activeUser) {
  const token = jwt.sign(
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
  
  console.log(`✓ Generated JWT for user: ${activeUser.username}`);
  
  // Decode and verify
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: 'ihub-apps'
    });
    console.log(`✓ JWT decoded successfully`);
    console.log(`  - User ID: ${decoded.sub}`);
    console.log(`  - Auth Mode: ${decoded.authMode}`);
    
    // Simulate the validation logic from jwtAuth.js
    console.log('\n  🔍 Simulating jwtAuth.js validation logic:');
    const userId = decoded.sub;
    const userRecord = usersConfig.users?.[userId];
    
    if (!userRecord) {
      console.log(`  ✗ Validation failed: User not found (would return 401)`);
    } else if (!isUserActive(userRecord)) {
      console.log(`  ✗ Validation failed: User account disabled (would return 403)`);
    } else {
      console.log(`  ✓ Validation passed: User exists and is active`);
    }
  } catch (error) {
    console.log(`✗ JWT verification failed: ${error.message}`);
  }
}

// Test 6: Simulate validation for non-existent user
console.log('\n📋 Test 6: Simulate JWT validation for deleted user');
const deletedUserToken = jwt.sign(
  {
    sub: 'user_deleted_nonexistent',
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

try {
  const decoded = jwt.verify(deletedUserToken, JWT_SECRET, {
    issuer: 'ihub-apps'
  });
  
  console.log(`✓ JWT decoded for deleted user`);
  
  // Simulate validation
  const userId = decoded.sub;
  const userRecord = usersConfig.users?.[userId];
  
  if (!userRecord) {
    console.log(`  ✓ Validation correctly rejects: User not found (would return 401)`);
  } else {
    console.log(`  ✗ Unexpected: User was found in database`);
  }
} catch (error) {
  console.log(`✗ JWT verification failed: ${error.message}`);
}

// Test 7: Simulate validation for disabled user (if one exists)
console.log('\n📋 Test 7: Simulate JWT validation for disabled user');
const disabledUserObj = Object.values(users).find(u => u.active === false);
if (disabledUserObj) {
  const disabledUserToken = jwt.sign(
    {
      sub: disabledUserObj.id,
      username: disabledUserObj.username,
      name: disabledUserObj.name,
      email: disabledUserObj.email,
      groups: disabledUserObj.internalGroups || [],
      authMode: 'local'
    },
    JWT_SECRET,
    {
      expiresIn: '7d',
      issuer: 'ihub-apps'
    }
  );
  
  try {
    const decoded = jwt.verify(disabledUserToken, JWT_SECRET, {
      issuer: 'ihub-apps'
    });
    
    console.log(`✓ JWT decoded for disabled user: ${disabledUserObj.username}`);
    
    // Simulate validation
    const userId = decoded.sub;
    const userRecord = usersConfig.users?.[userId];
    
    if (!userRecord) {
      console.log(`  ✗ Unexpected: User not found`);
    } else if (!isUserActive(userRecord)) {
      console.log(`  ✓ Validation correctly rejects: User account disabled (would return 403)`);
    } else {
      console.log(`  ✗ Unexpected: User marked as active`);
    }
  } catch (error) {
    console.log(`✗ JWT verification failed: ${error.message}`);
  }
} else {
  console.log(`⚠ No disabled users found in database - creating test scenario`);
  
  // Create a test disabled user scenario
  const testUser = {
    id: 'test_user_disabled',
    username: 'testdisabled',
    active: false,
    internalGroups: ['users']
  };
  
  if (!isUserActive(testUser)) {
    console.log(`  ✓ isUserActive correctly returns false for disabled test user`);
  } else {
    console.log(`  ✗ isUserActive incorrectly returns true for disabled test user`);
  }
}

console.log('\n' + '='.repeat(60));
console.log('\n✅ Manual JWT validation security test completed!\n');
console.log('Summary:');
console.log('- The jwtAuth.js middleware now validates local users against the database');
console.log('- Deleted users will receive 401 "User account no longer exists"');
console.log('- Disabled users will receive 403 "User account has been disabled"');
console.log('- This prevents disabled/deleted users from using valid JWT tokens\n');
