#!/usr/bin/env node

/**
 * Manual test to verify authorization debug logs only appear in development mode
 * Usage: 
 *   NODE_ENV=development node tests/manual-verify-debug-logs.js
 *   NODE_ENV=production node tests/manual-verify-debug-logs.js
 */

import { mapExternalGroups, getPermissionsForUser, enhanceUserWithPermissions } from '../server/utils/authorization.js';

console.log('\n=== Testing Authorization Debug Log Behavior ===');
console.log(`NODE_ENV: ${process.env.NODE_ENV || 'undefined'}`);
console.log('Expected behavior:');
console.log('  - Development mode: Should see [Authorization] debug logs');
console.log('  - Production mode: Should NOT see [Authorization] debug logs');
console.log('  - Undefined NODE_ENV: Should NOT see [Authorization] debug logs\n');

console.log('--- Test 1: mapExternalGroups ---');
const result1 = mapExternalGroups(['TestGroup']);
console.log('Result:', result1);

console.log('\n--- Test 2: getPermissionsForUser ---');
const result2 = getPermissionsForUser(['anonymous']);
console.log('Result:', {
  apps: Array.from(result2.apps),
  prompts: Array.from(result2.prompts),
  models: Array.from(result2.models),
  adminAccess: result2.adminAccess
});

console.log('\n--- Test 3: enhanceUserWithPermissions ---');
const testUser = {
  id: 'test-user',
  name: 'Test User',
  groups: ['anonymous']
};
const result3 = enhanceUserWithPermissions(testUser, {}, { anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] } });
console.log('Result user groups:', result3.groups);
console.log('Result user isAdmin:', result3.isAdmin);

console.log('\n=== Test Complete ===');
console.log(`If NODE_ENV=${process.env.NODE_ENV || 'undefined'}:`);
if (process.env.NODE_ENV === 'development') {
  console.log('✓ You SHOULD have seen [Authorization] debug messages above');
} else {
  console.log('✓ You should NOT have seen [Authorization] debug messages above');
}
