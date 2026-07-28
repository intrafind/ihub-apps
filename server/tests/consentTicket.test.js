// Plain-node test (node server/tests/consentTicket.test.js).
//
// The consent ticket replaced a session-backed CSRF token plus session-stored
// PKCE parameters, so it now carries security properties that used to be the
// session's job: it must be unforgeable, tamper-evident, expiring, and bound to
// the user it was issued for.

import assert from 'assert';
import crypto from 'node:crypto';
import process from 'node:process';

// The signing key resolves through TokenStorageService, which reads this env
// var. Initialise it the way server.js does so the test exercises the real
// resolution chain rather than a stub.
const SECRET = 'test-secret-for-consent-tickets';
process.env.JWT_SECRET = SECRET;

const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
await tokenStorageService.initializeEncryptionKey();
await tokenStorageService.initializeJwtSecret();

const { issueConsentTicket, verifyConsentTicket } = await import('../utils/consentTicket.js');

const CONTEXT = {
  clientId: 'mcp_client',
  redirectUri: 'http://localhost:57321/callback',
  scope: 'openid mcp:tools:call',
  state: 'client-state',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  codeChallengeMethod: 'S256',
  nonce: 'n-0S6_WzA2Mj',
  userId: 'user_123'
};

let failed = false;
const check = (label, fn) => {
  try {
    fn();
    console.log(`✅ ${label}`);
  } catch (error) {
    failed = true;
    console.error(`❌ ${label}\n   ${error.message}`);
  }
};

// ---- round trip -----------------------------------------------------------
// Everything the decision handler needs must survive the hop, above all the
// PKCE challenge: losing it silently mints a code with no client binding.
check('a freshly issued ticket verifies and returns every field', () => {
  const payload = verifyConsentTicket(issueConsentTicket(CONTEXT));
  assert.ok(payload, 'ticket should verify');
  for (const [key, value] of Object.entries(CONTEXT)) {
    assert.strictEqual(payload[key], value, `field ${key} did not survive the round trip`);
  }
});

// ---- tamper detection -----------------------------------------------------
// The whole point of signing: the POST body can no longer widen scope or
// redirect the code somewhere else.
check('a tampered payload is rejected', () => {
  const ticket = issueConsentTicket(CONTEXT);
  const [encoded, signature] = ticket.split('.');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  decoded.redirectUri = 'https://attacker.example/callback';
  decoded.scope = 'openid mcp:tools:call mcp:apps:invoke';
  const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
  assert.strictEqual(verifyConsentTicket(`${forged}.${signature}`), null);
});

check('a tampered signature is rejected', () => {
  const ticket = issueConsentTicket(CONTEXT);
  const [encoded] = ticket.split('.');
  assert.strictEqual(verifyConsentTicket(`${encoded}.not-the-signature`), null);
});

check('a ticket signed with a different key is rejected', () => {
  // Simulates an attacker minting their own ticket without the platform secret.
  const encoded = Buffer.from(
    JSON.stringify({ ...CONTEXT, exp: Date.now() + 60_000 }),
    'utf8'
  ).toString('base64url');
  const forgedSig = crypto.createHmac('sha256', 'wrong-secret').update(encoded).digest('base64url');
  assert.strictEqual(verifyConsentTicket(`${encoded}.${forgedSig}`), null);
});

// ---- expiry ---------------------------------------------------------------
check('an expired ticket is rejected', () => {
  const encoded = Buffer.from(
    JSON.stringify({ ...CONTEXT, exp: Date.now() - 1000 }),
    'utf8'
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  assert.strictEqual(verifyConsentTicket(`${encoded}.${signature}`), null);
});

// ---- malformed input ------------------------------------------------------
check('malformed tickets are rejected without throwing', () => {
  for (const bad of [null, undefined, '', 'no-separator', '.', 'payload.', '.signature', {}, 42]) {
    assert.strictEqual(verifyConsentTicket(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

check('a ticket missing required fields is rejected', () => {
  // A signed but incomplete ticket must not reach the code-minting path.
  assert.strictEqual(verifyConsentTicket(issueConsentTicket({ userId: 'u' })), null);
});

// ---- fail closed with no signing key ---------------------------------------
// An empty HMAC key would still produce a signature everyone could reproduce,
// making tickets forgeable. Signing must refuse, and verification must reject
// cleanly rather than throwing a 500 into the consent flow.
check('with no signing key, issuing throws and verification rejects', () => {
  const good = issueConsentTicket(CONTEXT);
  const restore = tokenStorageService.jwtSecret;
  tokenStorageService.jwtSecret = null;
  try {
    assert.throws(() => issueConsentTicket(CONTEXT), /no JWT secret/i);
    assert.strictEqual(verifyConsentTicket(good), null, 'must reject, not throw');
  } finally {
    tokenStorageService.jwtSecret = restore;
  }
  assert.ok(verifyConsentTicket(good), 'verification recovers once the key is back');
});

if (failed) {
  console.error('\nconsentTicket: FAILED');
  process.exit(1);
}
console.log('\nconsentTicket: all checks passed');
