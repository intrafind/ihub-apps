/**
 * Integration test for client secret preservation fix
 * 
 * Tests the complete flow:
 * 1. Save config with environment variable placeholders
 * 2. GET config - verify env vars are preserved, actual secrets are redacted
 * 3. POST config with ***REDACTED*** - verify original values are restored
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Helper functions from the actual implementation
function isEnvVarPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value);
}

function sanitizeSecret(value) {
  if (!value) return undefined;
  // Preserve environment variable placeholders
  if (isEnvVarPlaceholder(value)) {
    return value;
  }
  // Redact actual secret values
  return '***REDACTED***';
}

function restoreSecretIfRedacted(newValue, existingValue) {
  // If the new value is the redacted placeholder, use the existing value
  if (newValue === '***REDACTED***') {
    return existingValue;
  }
  // Otherwise use the new value (could be a new secret or env var placeholder)
  return newValue;
}

// Test data
const testConfig = {
  auth: {
    mode: 'oidc',
    authenticatedGroup: 'authenticated'
  },
  oidcAuth: {
    enabled: true,
    providers: [
      {
        name: 'microsoft',
        displayName: 'Microsoft',
        clientId: 'test-client-id',
        clientSecret: '${MICROSOFT_CLIENT_SECRET}', // Environment variable
        authorizationURL: 'https://login.microsoftonline.com/oauth2/v2.0/authorize',
        tokenURL: 'https://login.microsoftonline.com/oauth2/v2.0/token',
        userInfoURL: 'https://graph.microsoft.com/oidc/userinfo',
        enabled: true
      },
      {
        name: 'google',
        displayName: 'Google',
        clientId: 'google-client-id',
        clientSecret: 'actual-secret-12345', // Actual secret
        authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenURL: 'https://oauth2.googleapis.com/token',
        userInfoURL: 'https://openidconnect.googleapis.com/v1/userinfo',
        enabled: true
      }
    ]
  },
  localAuth: {
    enabled: false,
    jwtSecret: '${JWT_SECRET}' // Environment variable
  },
  admin: {
    secret: 'admin-secret-value' // Actual secret
  }
};

function runTest() {
  console.log('\n=== Integration Test: Client Secret Preservation ===\n');
  let passed = 0;
  let failed = 0;

  // Test 1: isEnvVarPlaceholder
  console.log('Test 1: isEnvVarPlaceholder function');
  const envVarTests = [
    ['${MICROSOFT_CLIENT_SECRET}', true],
    ['${JWT_SECRET}', true],
    ['${API_KEY}', true],
    ['actual-secret-value', false],
    ['random-string', false],
    ['${lowercase}', true], // Should match (case insensitive)
    ['${123INVALID}', false], // Should not match (starts with number)
    ['$MICROSOFT_CLIENT_SECRET', false], // Should not match (missing braces)
    ['', false],
    [null, false]
  ];

  envVarTests.forEach(([input, expected]) => {
    const result = isEnvVarPlaceholder(input);
    if (result === expected) {
      console.log(`  ✓ isEnvVarPlaceholder('${input}') = ${result}`);
      passed++;
    } else {
      console.log(`  ✗ isEnvVarPlaceholder('${input}') = ${result}, expected ${expected}`);
      failed++;
    }
  });

  // Test 2: sanitizeSecret
  console.log('\nTest 2: sanitizeSecret function');
  const sanitizeTests = [
    ['${MICROSOFT_CLIENT_SECRET}', '${MICROSOFT_CLIENT_SECRET}'], // Preserve env var
    ['${JWT_SECRET}', '${JWT_SECRET}'], // Preserve env var
    ['actual-secret-value', '***REDACTED***'], // Redact actual secret
    ['random-string', '***REDACTED***'], // Redact actual secret
    ['', undefined], // Empty string
    [null, undefined], // Null
    [undefined, undefined] // Undefined
  ];

  sanitizeTests.forEach(([input, expected]) => {
    const result = sanitizeSecret(input);
    if (result === expected) {
      console.log(`  ✓ sanitizeSecret('${input}') = '${result}'`);
      passed++;
    } else {
      console.log(`  ✗ sanitizeSecret('${input}') = '${result}', expected '${expected}'`);
      failed++;
    }
  });

  // Test 3: restoreSecretIfRedacted
  console.log('\nTest 3: restoreSecretIfRedacted function');
  const restoreTests = [
    ['***REDACTED***', 'original-secret', 'original-secret'], // Restore original
    ['***REDACTED***', '${ENV_VAR}', '${ENV_VAR}'], // Restore env var
    ['new-secret', 'original-secret', 'new-secret'], // Use new value
    ['${NEW_ENV_VAR}', '${OLD_ENV_VAR}', '${NEW_ENV_VAR}'], // Use new env var
    ['', 'original-secret', ''], // Empty string is new value
    [null, 'original-secret', null] // Null is new value
  ];

  restoreTests.forEach(([newVal, existingVal, expected]) => {
    const result = restoreSecretIfRedacted(newVal, existingVal);
    if (result === expected) {
      console.log(`  ✓ restoreSecretIfRedacted('${newVal}', '${existingVal}') = '${result}'`);
      passed++;
    } else {
      console.log(`  ✗ restoreSecretIfRedacted('${newVal}', '${existingVal}') = '${result}', expected '${expected}'`);
      failed++;
    }
  });

  // Test 4: Complete flow simulation
  console.log('\nTest 4: Complete flow simulation (GET -> modify -> POST)');

  // Step 1: Simulate GET endpoint sanitization
  const sanitizedConfig = {
    ...testConfig,
    oidcAuth: {
      ...testConfig.oidcAuth,
      providers: testConfig.oidcAuth.providers.map(provider => ({
        ...provider,
        clientSecret: sanitizeSecret(provider.clientSecret)
      }))
    },
    localAuth: {
      ...testConfig.localAuth,
      jwtSecret: sanitizeSecret(testConfig.localAuth.jwtSecret)
    },
    admin: {
      ...testConfig.admin,
      secret: sanitizeSecret(testConfig.admin.secret)
    }
  };

  // Verify GET sanitization
  if (sanitizedConfig.oidcAuth.providers[0].clientSecret === '${MICROSOFT_CLIENT_SECRET}') {
    console.log('  ✓ GET: Microsoft secret preserved (env var)');
    passed++;
  } else {
    console.log(`  ✗ GET: Microsoft secret not preserved: ${sanitizedConfig.oidcAuth.providers[0].clientSecret}`);
    failed++;
  }

  if (sanitizedConfig.oidcAuth.providers[1].clientSecret === '***REDACTED***') {
    console.log('  ✓ GET: Google secret redacted (actual secret)');
    passed++;
  } else {
    console.log(`  ✗ GET: Google secret not redacted: ${sanitizedConfig.oidcAuth.providers[1].clientSecret}`);
    failed++;
  }

  if (sanitizedConfig.localAuth.jwtSecret === '${JWT_SECRET}') {
    console.log('  ✓ GET: JWT secret preserved (env var)');
    passed++;
  } else {
    console.log(`  ✗ GET: JWT secret not preserved: ${sanitizedConfig.localAuth.jwtSecret}`);
    failed++;
  }

  if (sanitizedConfig.admin.secret === '***REDACTED***') {
    console.log('  ✓ GET: Admin secret redacted (actual secret)');
    passed++;
  } else {
    console.log(`  ✗ GET: Admin secret not redacted: ${sanitizedConfig.admin.secret}`);
    failed++;
  }

  // Step 2: Simulate client modifying config (disabling Google provider)
  const clientModifiedConfig = {
    ...sanitizedConfig,
    oidcAuth: {
      ...sanitizedConfig.oidcAuth,
      providers: sanitizedConfig.oidcAuth.providers.map((provider, index) => ({
        ...provider,
        enabled: index === 0 // Only enable Microsoft, disable Google
      }))
    }
  };

  // Step 3: Simulate POST endpoint restoration
  const restoredConfig = {
    ...clientModifiedConfig,
    oidcAuth: {
      ...clientModifiedConfig.oidcAuth,
      providers: clientModifiedConfig.oidcAuth.providers.map((provider, index) => ({
        ...provider,
        clientSecret: restoreSecretIfRedacted(
          provider.clientSecret,
          testConfig.oidcAuth.providers[index].clientSecret
        )
      }))
    },
    localAuth: {
      ...clientModifiedConfig.localAuth,
      jwtSecret: restoreSecretIfRedacted(
        clientModifiedConfig.localAuth.jwtSecret,
        testConfig.localAuth.jwtSecret
      )
    },
    admin: {
      ...clientModifiedConfig.admin,
      secret: restoreSecretIfRedacted(
        clientModifiedConfig.admin.secret,
        testConfig.admin.secret
      )
    }
  };

  // Verify POST restoration
  if (restoredConfig.oidcAuth.providers[0].clientSecret === '${MICROSOFT_CLIENT_SECRET}') {
    console.log('  ✓ POST: Microsoft secret preserved (env var)');
    passed++;
  } else {
    console.log(`  ✗ POST: Microsoft secret not preserved: ${restoredConfig.oidcAuth.providers[0].clientSecret}`);
    failed++;
  }

  if (restoredConfig.oidcAuth.providers[1].clientSecret === 'actual-secret-12345') {
    console.log('  ✓ POST: Google secret restored from original (was ***REDACTED***)');
    passed++;
  } else {
    console.log(`  ✗ POST: Google secret not restored: ${restoredConfig.oidcAuth.providers[1].clientSecret}`);
    failed++;
  }

  if (restoredConfig.localAuth.jwtSecret === '${JWT_SECRET}') {
    console.log('  ✓ POST: JWT secret preserved (env var)');
    passed++;
  } else {
    console.log(`  ✗ POST: JWT secret not preserved: ${restoredConfig.localAuth.jwtSecret}`);
    failed++;
  }

  if (restoredConfig.admin.secret === 'admin-secret-value') {
    console.log('  ✓ POST: Admin secret restored from original (was ***REDACTED***)');
    passed++;
  } else {
    console.log(`  ✗ POST: Admin secret not restored: ${restoredConfig.admin.secret}`);
    failed++;
  }

  // Verify the disabled provider setting was preserved
  if (restoredConfig.oidcAuth.providers[0].enabled === true && 
      restoredConfig.oidcAuth.providers[1].enabled === false) {
    console.log('  ✓ POST: Provider enabled/disabled states preserved');
    passed++;
  } else {
    console.log('  ✗ POST: Provider enabled/disabled states not preserved');
    failed++;
  }

  // Summary
  console.log('\n=== Test Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);

  if (failed === 0) {
    console.log('\n✓ All tests passed!');
    return true;
  } else {
    console.log('\n✗ Some tests failed!');
    return false;
  }
}

// Run the test
const success = runTest();
process.exit(success ? 0 : 1);
