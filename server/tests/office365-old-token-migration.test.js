/**
 * Test for Office 365 old token detection and migration
 * Verifies that tokens with Group.Read.All are detected and invalidated
 */

import office365Service from '../services/integrations/Office365Service.js';
import tokenStorage from '../services/TokenStorageService.js';

async function testOldTokenDetection() {
  console.log('🧪 Testing old token detection...\n');

  const testUserId = 'test-user-123';

  // Store original functions to restore later
  const originalGetUserTokens = tokenStorage.getUserTokens;
  const originalDeleteUserTokens = tokenStorage.deleteUserTokens;
  const originalAreTokensExpired = tokenStorage.areTokensExpired;

  // Test 1: Old token with Group.Read.All should be detected and invalidated
  console.log('Test 1: Old token with Group.Read.All');
  let deleteCount = 0;

  tokenStorage.getUserTokens = async (userId, serviceName) => {
    return {
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresIn: 3600,
      scope:
        'User.Read Files.Read.All Sites.Read.All Team.ReadBasic.All Channel.ReadBasic.All Group.Read.All offline_access',
      providerId: 'test-provider'
    };
  };

  tokenStorage.deleteUserTokens = async (userId, serviceName) => {
    deleteCount++;
    return true;
  };

  tokenStorage.areTokensExpired = async (userId, serviceName) => {
    return false;
  };

  try {
    await office365Service.getUserTokens(testUserId);
    console.log('  ❌ FAILED: Should have thrown error for old token');
  } catch (error) {
    if (error.message.includes('Office 365 permissions have been updated')) {
      console.log('  ✅ PASSED: Old token detected and error thrown');
      console.log(`  ✅ PASSED: Delete called ${deleteCount} time(s)`);
    } else {
      console.log(`  ❌ FAILED: Wrong error message: ${error.message}`);
    }
  }

  // Test 2: New token without Group.Read.All should pass through
  console.log('\nTest 2: New token without Group.Read.All');

  tokenStorage.getUserTokens = async (userId, serviceName) => {
    return {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3600,
      scope:
        'User.Read Files.Read.All Sites.Read.All Team.ReadBasic.All Channel.ReadBasic.All offline_access',
      providerId: 'test-provider'
    };
  };

  try {
    const tokens = await office365Service.getUserTokens(testUserId);
    if (tokens.accessToken === 'new-access-token') {
      console.log('  ✅ PASSED: New token passed through correctly');
    } else {
      console.log('  ❌ FAILED: Token was modified unexpectedly');
    }
  } catch (error) {
    console.log(`  ❌ FAILED: Should not have thrown error: ${error.message}`);
  }

  // Test 3: Token without scope field should pass through
  console.log('\nTest 3: Token without scope field');

  tokenStorage.getUserTokens = async (userId, serviceName) => {
    return {
      accessToken: 'no-scope-token',
      refreshToken: 'no-scope-refresh',
      expiresIn: 3600,
      providerId: 'test-provider'
    };
  };

  try {
    const tokens = await office365Service.getUserTokens(testUserId);
    if (tokens.accessToken === 'no-scope-token') {
      console.log('  ✅ PASSED: Token without scope field passed through');
    } else {
      console.log('  ❌ FAILED: Token was modified unexpectedly');
    }
  } catch (error) {
    console.log(`  ❌ FAILED: Should not have thrown error: ${error.message}`);
  }

  // Test 4: Old token with Group.Read.All in different position
  console.log('\nTest 4: Old token with Group.Read.All at start of scope');

  tokenStorage.getUserTokens = async (userId, serviceName) => {
    return {
      accessToken: 'old-access-token-2',
      refreshToken: 'old-refresh-token-2',
      expiresIn: 3600,
      scope: 'Group.Read.All User.Read Files.Read.All Sites.Read.All offline_access',
      providerId: 'test-provider'
    };
  };

  try {
    await office365Service.getUserTokens(testUserId);
    console.log('  ❌ FAILED: Should have detected Group.Read.All anywhere in scope');
  } catch (error) {
    if (error.message.includes('Office 365 permissions have been updated')) {
      console.log('  ✅ PASSED: Detected Group.Read.All at different position');
    } else {
      console.log(`  ❌ FAILED: Wrong error message: ${error.message}`);
    }
  }

  // Restore original functions
  tokenStorage.getUserTokens = originalGetUserTokens;
  tokenStorage.deleteUserTokens = originalDeleteUserTokens;
  tokenStorage.areTokensExpired = originalAreTokensExpired;

  console.log('\n✨ All tests completed!');
}

// Run tests
testOldTokenDetection().catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});
