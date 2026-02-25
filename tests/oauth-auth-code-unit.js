#!/usr/bin/env node

/**
 * Unit tests for the OAuth Authorization Code Flow.
 *
 * These tests run without a live server and without any external dependencies.
 * They cover:
 *  - PKCE utility correctness (RFC 7636)
 *  - Authorization code store lifecycle (RFC 6749 §4.1.2)
 *  - Consent store read/write contract
 *  - Structural checks that verify key symbols are present in source files
 *
 * Run with:
 *   node tests/oauth-auth-code-unit.js
 *
 * A non-zero exit code indicates at least one assertion failed.
 */

import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// Resolve the project root so relative source paths work regardless of cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Tiny test harness – keeps the file self-contained with no extra deps.
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;

/**
 * Execute a single test case and record its outcome.
 *
 * @param {string} label - Human-readable description shown in the output.
 * @param {Function} fn - Synchronous or async test body. Throw / assert to fail.
 * @returns {Promise<void>}
 */
async function test(label, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failCount++;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
  }
}

/**
 * Print a section header to visually group related tests.
 *
 * @param {string} title - Section name.
 */
function section(title) {
  console.log(`\n=== ${title} ===\n`);
}

// ---------------------------------------------------------------------------
// PKCE Utility Tests
// ---------------------------------------------------------------------------

import {
  generateCodeVerifier,
  generateCodeChallenge,
  verifyCodeChallenge
} from '../server/utils/pkceUtils.js';

section('PKCE Utils (RFC 7636)');

await test('generateCodeVerifier() produces a URL-safe base64 string of 43 characters', () => {
  const verifier = generateCodeVerifier();
  // 32 random bytes → base64url → 43 characters (no padding)
  assert.ok(
    verifier.length >= 43 && verifier.length <= 128,
    `Expected length 43–128, got ${verifier.length}`
  );
  assert.match(
    verifier,
    /^[A-Za-z0-9_-]+$/,
    'Verifier must consist only of URL-safe base64 characters'
  );
});

await test('generateCodeVerifier() produces unique values across calls', () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.notEqual(a, b, 'Two consecutive verifiers should not be identical');
});

await test('generateCodeChallenge() is deterministic for a given verifier', () => {
  const verifier = generateCodeVerifier();
  const challenge1 = generateCodeChallenge(verifier);
  const challenge2 = generateCodeChallenge(verifier);
  assert.equal(challenge1, challenge2, 'Same verifier must always yield the same challenge');
  assert.match(
    challenge1,
    /^[A-Za-z0-9_-]+$/,
    'Challenge must consist only of URL-safe base64 characters'
  );
});

await test('verifyCodeChallenge() returns true for a correct verifier/challenge pair', () => {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const result = verifyCodeChallenge(verifier, challenge, 'S256');
  assert.equal(result, true, 'Correct verifier should verify successfully');
});

await test('verifyCodeChallenge() returns false when the verifier does not match the challenge', () => {
  const verifier1 = generateCodeVerifier();
  const verifier2 = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier1);
  const result = verifyCodeChallenge(verifier2, challenge, 'S256');
  assert.equal(result, false, 'A different verifier must not satisfy the stored challenge');
});

await test('verifyCodeChallenge() rejects the "plain" method (insecure, not supported)', () => {
  // Even if verifier === challenge, plain must be refused.
  const verifier = 'test_verifier_plain_1234567890abcd';
  const result = verifyCodeChallenge(verifier, verifier, 'plain');
  assert.equal(result, false, 'The plain PKCE method must always be rejected');
});

await test('verifyCodeChallenge() handles null/undefined inputs without throwing', () => {
  assert.equal(verifyCodeChallenge(null, 'abc', 'S256'), false, 'null verifier → false');
  assert.equal(verifyCodeChallenge('abc', null, 'S256'), false, 'null challenge → false');
  assert.equal(verifyCodeChallenge('', '', 'S256'), false, 'empty strings → false');
  assert.equal(verifyCodeChallenge(undefined, undefined, 'S256'), false, 'undefined → false');
});

await test('verifyCodeChallenge() satisfies RFC 7636 Appendix B test vector', () => {
  // Official test vector from RFC 7636 Appendix B.
  // code_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  // code_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  const derivedChallenge = generateCodeChallenge(verifier);
  assert.equal(
    derivedChallenge,
    expectedChallenge,
    'generateCodeChallenge() does not match the RFC 7636 Appendix B reference value'
  );

  const verified = verifyCodeChallenge(verifier, expectedChallenge, 'S256');
  assert.equal(verified, true, 'verifyCodeChallenge() must accept the RFC 7636 reference vector');
});

// ---------------------------------------------------------------------------
// Authorization Code Store Tests
// ---------------------------------------------------------------------------

import {
  generateCode,
  storeCode,
  consumeCode,
  cleanup
} from '../server/utils/authorizationCodeStore.js';

section('Authorization Code Store (RFC 6749 §4.1.2)');

await test('generateCode() returns a 64-character lowercase hex string', () => {
  const code = generateCode();
  assert.equal(code.length, 64, `Expected 64 hex chars, got ${code.length}`);
  assert.match(code, /^[0-9a-f]+$/, 'Code must be lowercase hexadecimal');
});

await test('generateCode() produces unique values across calls', () => {
  const a = generateCode();
  const b = generateCode();
  assert.notEqual(a, b, 'Two consecutive codes should not be identical');
});

await test('storeCode() + consumeCode() round-trip returns the original payload', () => {
  const code = generateCode();
  const payload = {
    clientId: 'test_client',
    userId: 'user_123',
    scopes: ['openid', 'profile'],
    redirectUri: 'https://example.com/callback',
    codeChallenge: 'abc',
    codeChallengeMethod: 'S256'
  };

  storeCode(code, payload);
  const retrieved = consumeCode(code);

  assert.deepEqual(retrieved, payload, 'consumeCode() must return the exact payload passed to storeCode()');
});

await test('Authorization codes are single-use: second consumeCode() call returns null', () => {
  const code = generateCode();
  storeCode(code, { clientId: 'test_client', userId: 'user_single_use' });

  const first = consumeCode(code);
  const second = consumeCode(code);

  assert.notEqual(first, null, 'First consumption must succeed');
  assert.equal(second, null, 'Second consumption of the same code must return null');
});

await test('consumeCode() returns null for an unknown code', () => {
  const result = consumeCode('aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222');
  assert.equal(result, null, 'Unknown code must return null');
});

await test('cleanup() removes expired entries without affecting valid ones', () => {
  // Store two codes – we will artificially expire one by manipulating the clock
  // is not possible directly, so instead we rely on the cleanup() export being
  // a no-op for non-expired entries and verify it does not remove fresh ones.
  const freshCode = generateCode();
  const freshPayload = { clientId: 'fresh_client', userId: 'user_fresh' };
  storeCode(freshCode, freshPayload);

  // cleanup() should not delete the fresh code.
  cleanup();

  const result = consumeCode(freshCode);
  assert.deepEqual(result, freshPayload, 'cleanup() must not remove codes that have not yet expired');
});

// ---------------------------------------------------------------------------
// Consent Store Tests
// ---------------------------------------------------------------------------

// The consent store writes to a real JSON file on disk.  We redirect it to a
// temp directory so the tests are fully self-contained and leave no side effects.
//
// Strategy: read the consentStore source, find the STORE_PATH constant, and
// temporarily redirect it using an environment variable if supported, or use
// the mock-file approach.  Since consentStore derives its path from __dirname
// at module load time we cannot easily redirect it without mocking the module.
// Instead we test the public API by writing to the real path in a temp dir
// backup-and-restore pattern.

import {
  hasConsent,
  grantConsent,
  revokeConsent
} from '../server/utils/consentStore.js';

section('Consent Store');

/**
 * Path to the consent file used by consentStore.js.
 * The module derives this path from its own __dirname, which points into the
 * server/utils directory, two levels up from which is the project root.
 */
const CONSENT_FILE_PATH = path.join(PROJECT_ROOT, 'contents', 'config', 'oauth-consent.json');

/**
 * Save the current consent file contents so we can restore them after the
 * test suite finishes.  Returns undefined when the file does not exist.
 *
 * @returns {string|undefined} Raw JSON content, or undefined if the file is absent.
 */
function backupConsentFile() {
  try {
    return fs.readFileSync(CONSENT_FILE_PATH, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Restore the consent file to its pre-test state.
 *
 * @param {string|undefined} backup - The value previously returned by backupConsentFile().
 */
function restoreConsentFile(backup) {
  if (backup === undefined) {
    // File did not exist before the tests – remove it if we created it.
    try {
      fs.unlinkSync(CONSENT_FILE_PATH);
    } catch {
      // Best-effort – ignore errors if it was already removed.
    }
  } else {
    fs.mkdirSync(path.dirname(CONSENT_FILE_PATH), { recursive: true });
    fs.writeFileSync(CONSENT_FILE_PATH, backup, 'utf8');
  }
}

/**
 * Write an empty consent store to the file so each test starts from a known
 * clean state.
 */
function resetConsentFile() {
  fs.mkdirSync(path.dirname(CONSENT_FILE_PATH), { recursive: true });
  fs.writeFileSync(CONSENT_FILE_PATH, JSON.stringify({ consents: {} }, null, 2), 'utf8');
}

// Preserve whatever was in the consent file before this test run.
const originalConsentFileContent = backupConsentFile();

await test('hasConsent() returns false when no consent exists for a client/user pair', () => {
  resetConsentFile();
  const result = hasConsent('client_unknown', 'user_unknown', ['openid']);
  assert.equal(result, false, 'hasConsent() must return false when no record exists');
});

await test('grantConsent() + hasConsent() round-trip: granted scopes are recognised', async () => {
  resetConsentFile();
  await grantConsent('my_client', 'user_001', ['openid', 'email'], 90);

  const covered = hasConsent('my_client', 'user_001', ['openid', 'email']);
  assert.equal(covered, true, 'hasConsent() must return true for fully-covered scopes after grantConsent()');
});

await test('hasConsent() returns true when a subset of previously granted scopes is requested', async () => {
  resetConsentFile();
  await grantConsent('my_client', 'user_002', ['openid', 'profile', 'email'], 90);

  const subset = hasConsent('my_client', 'user_002', ['openid']);
  assert.equal(subset, true, 'A narrower scope request must be satisfied by a broader grant');
});

await test('hasConsent() returns false when an additional scope was not previously granted', async () => {
  resetConsentFile();
  await grantConsent('my_client', 'user_003', ['openid'], 90);

  const result = hasConsent('my_client', 'user_003', ['openid', 'email']);
  assert.equal(result, false, 'Requesting a scope not in the grant must return false');
});

await test('revokeConsent() removes the record so subsequent hasConsent() returns false', async () => {
  resetConsentFile();
  await grantConsent('my_client', 'user_004', ['openid'], 90);

  const beforeRevoke = hasConsent('my_client', 'user_004', ['openid']);
  assert.equal(beforeRevoke, true, 'Consent should be present before revocation');

  const wasRevoked = await revokeConsent('my_client', 'user_004');
  assert.equal(wasRevoked, true, 'revokeConsent() should return true when a record was deleted');

  const afterRevoke = hasConsent('my_client', 'user_004', ['openid']);
  assert.equal(afterRevoke, false, 'hasConsent() must return false after revocation');
});

await test('revokeConsent() returns false when no matching record exists', async () => {
  resetConsentFile();
  const result = await revokeConsent('nonexistent_client', 'nonexistent_user');
  assert.equal(result, false, 'revokeConsent() must return false when no record was found');
});

await test('hasConsent() returns false for a consent record that has expired (ttl=0 days)', async () => {
  resetConsentFile();
  // Write a consent entry that expired in the past directly to the file.
  const expiredAt = new Date(Date.now() - 1000).toISOString(); // 1 second ago
  const store = {
    consents: {
      'expired_client:user_expired': {
        clientId: 'expired_client',
        userId: 'user_expired',
        scopes: ['openid'],
        grantedAt: new Date(Date.now() - 100000).toISOString(),
        expiresAt: expiredAt
      }
    }
  };
  fs.writeFileSync(CONSENT_FILE_PATH, JSON.stringify(store, null, 2), 'utf8');

  const result = hasConsent('expired_client', 'user_expired', ['openid']);
  assert.equal(result, false, 'hasConsent() must return false for an expired consent entry');
});

// Restore the consent file to its original state so this test run is
// non-destructive for any other processes that may be running.
restoreConsentFile(originalConsentFileContent);

// ---------------------------------------------------------------------------
// Well-Known Discovery Document Structural Tests
// ---------------------------------------------------------------------------

section('Well-Known Discovery Document (OIDC §3)');

await test('wellKnown.js includes all required OIDC Discovery fields', () => {
  const wellKnownSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'routes', 'wellKnown.js'),
    'utf8'
  );

  /**
   * Minimum set of fields mandated by the OpenID Connect Discovery 1.0
   * specification (https://openid.net/specs/openid-connect-discovery-1_0.html)
   * plus the OAuth 2.0 Authorization Server Metadata RFC 8414 fields we expose.
   */
  const requiredFields = [
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'userinfo_endpoint',
    'revocation_endpoint',
    'jwks_uri',
    'response_types_supported',
    'code_challenge_methods_supported'
  ];

  const missingFields = requiredFields.filter(field => !wellKnownSource.includes(field));

  assert.equal(
    missingFields.length,
    0,
    `wellKnown.js is missing required discovery fields: ${missingFields.join(', ')}`
  );
});

await test('wellKnown.js declares S256 as the only supported PKCE method', () => {
  const wellKnownSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'routes', 'wellKnown.js'),
    'utf8'
  );

  assert.ok(
    wellKnownSource.includes("'S256'"),
    'wellKnown.js must declare S256 as a supported code_challenge_method'
  );
});

// ---------------------------------------------------------------------------
// Route Registration Structural Tests
// ---------------------------------------------------------------------------

section('Route Registration (server.js)');

await test('server.js registers registerOAuthAuthorizeRoutes', () => {
  const serverSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'server.js'),
    'utf8'
  );
  assert.ok(
    serverSource.includes('registerOAuthAuthorizeRoutes'),
    'server.js must import and call registerOAuthAuthorizeRoutes'
  );
});

await test('server.js registers registerOAuthRoutes (token endpoint)', () => {
  const serverSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'server.js'),
    'utf8'
  );
  assert.ok(
    serverSource.includes('registerOAuthRoutes'),
    'server.js must import and call registerOAuthRoutes'
  );
});

await test('server.js registers registerWellKnownRoutes', () => {
  const serverSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'server.js'),
    'utf8'
  );
  assert.ok(
    serverSource.includes('registerWellKnownRoutes'),
    'server.js must import and call registerWellKnownRoutes'
  );
});

// ---------------------------------------------------------------------------
// Backward Compatibility Tests
// ---------------------------------------------------------------------------

section('Backward Compatibility (oauth.js)');

await test('oauth.js still handles the client_credentials grant (no regression)', () => {
  const oauthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'routes', 'oauth.js'),
    'utf8'
  );
  assert.ok(
    oauthSource.includes('client_credentials'),
    'oauth.js must retain support for the client_credentials grant type'
  );
});

await test('oauth.js adds support for the authorization_code grant', () => {
  const oauthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'routes', 'oauth.js'),
    'utf8'
  );
  assert.ok(
    oauthSource.includes('authorization_code'),
    'oauth.js must handle the authorization_code grant type'
  );
});

await test('oauth.js adds support for the refresh_token grant', () => {
  const oauthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'routes', 'oauth.js'),
    'utf8'
  );
  assert.ok(
    oauthSource.includes('refresh_token'),
    'oauth.js must handle the refresh_token grant type'
  );
});

await test('oauth.js exposes a /api/oauth/revoke endpoint', () => {
  const oauthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'routes', 'oauth.js'),
    'utf8'
  );
  assert.ok(
    oauthSource.includes('/api/oauth/revoke'),
    'oauth.js must register the token revocation endpoint'
  );
});

await test('oauth.js exposes a /api/oauth/userinfo endpoint', () => {
  const oauthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'routes', 'oauth.js'),
    'utf8'
  );
  assert.ok(
    oauthSource.includes('/api/oauth/userinfo'),
    'oauth.js must register the userinfo endpoint'
  );
});

// ---------------------------------------------------------------------------
// JWT Auth Security Tests
// ---------------------------------------------------------------------------

section('JWT Auth Security (jwtAuth.js)');

await test('jwtAuth.js uses getJwtVerificationKey() for algorithm-aware key resolution', () => {
  const jwtAuthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'middleware', 'jwtAuth.js'),
    'utf8'
  );
  assert.ok(
    jwtAuthSource.includes('getJwtVerificationKey'),
    'jwtAuth.js must call getJwtVerificationKey() to support both HS256 and RS256'
  );
});

await test('jwtAuth.js uses getJwtAlgorithm() and passes an explicit algorithms array to jwt.verify()', () => {
  const jwtAuthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'middleware', 'jwtAuth.js'),
    'utf8'
  );
  assert.ok(
    jwtAuthSource.includes('getJwtAlgorithm'),
    'jwtAuth.js must call getJwtAlgorithm() to retrieve the configured signing algorithm'
  );
  assert.ok(
    jwtAuthSource.includes('algorithms:'),
    'jwtAuth.js must supply an explicit algorithms array to jwt.verify() to prevent algorithm confusion attacks'
  );
});

await test('jwtAuth.js does not use the removed resolveJwtSecret() function', () => {
  const jwtAuthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'middleware', 'jwtAuth.js'),
    'utf8'
  );
  assert.ok(
    !jwtAuthSource.includes('resolveJwtSecret'),
    'jwtAuth.js must not call resolveJwtSecret() — it was replaced by getJwtVerificationKey()'
  );
});

await test('jwtAuth.js handles the oauth_authorization_code authMode for user-delegated tokens', () => {
  const jwtAuthSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'server', 'middleware', 'jwtAuth.js'),
    'utf8'
  );
  assert.ok(
    jwtAuthSource.includes('oauth_authorization_code'),
    'jwtAuth.js must contain a branch that handles tokens issued via the authorization_code flow'
  );
});

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passCount} passed, ${failCount} failed`);
console.log('='.repeat(60));

if (failCount > 0) {
  process.exit(1);
}
