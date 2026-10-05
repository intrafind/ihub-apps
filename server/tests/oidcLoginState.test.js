// Plain-node test (node server/tests/oidcLoginState.test.js).
//
// The OIDC login state replaced passport's session-backed state store, so it
// now carries what the session used to guarantee: the callback must find the
// PKCE verifier and return URL with no server memory (the cross-worker case),
// and a callback must only complete in the browser that started the login.
//
// Drives the real passport-oauth2 strategy: the start and the callback get
// separate request objects that share nothing but the cookie a browser would
// send back, like two requests landing on two cluster workers.

import assert from 'assert';
import crypto from 'node:crypto';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';
import tokenStorageService from '../services/TokenStorageService.js';
import {
  OIDC_LOGIN_COOKIE,
  OIDC_LOGIN_STATE_TTL_MS,
  createOidcStateStore,
  issueOidcLoginState,
  verifyOidcLoginState
} from '../utils/oidcLoginState.js';

// In-memory key material; nothing touches disk. resolveJwtSecret() falls back
// to the token store's secret when the platform config (not loaded here) has
// none; a JWT_SECRET environment variable only reaches it through
// initializeJwtSecret(), which this test never calls.
const SECRET = 'oidc-login-state-test-secret';
tokenStorageService.encryptionKey = 'd'.repeat(64);
tokenStorageService.jwtSecret = SECRET;

let failed = false;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`✅ ${label}`);
  } catch (error) {
    failed = true;
    console.error(`❌ ${label}\n   ${error.message}`);
  }
};

function makeStrategy(providerName, { pkce = true } = {}) {
  const strategy = new OAuth2Strategy(
    {
      authorizationURL: 'https://idp.example.com/authorize',
      tokenURL: 'https://idp.example.com/token',
      clientID: 'ihub',
      clientSecret: 'secret',
      callbackURL: `https://ihub.example.com/api/auth/oidc/${providerName}/callback`,
      store: createOidcStateStore(providerName),
      pkce,
      skipUserProfile: true
    },
    (accessToken, _refreshToken, _params, _profile, done) => done(null, { id: 'alice' })
  );
  return strategy;
}

/** A request/response pair with nothing in it but what the browser sends. */
function makeExchange({ query = {}, cookies = {} } = {}) {
  const res = {
    cookies: {},
    cleared: [],
    cookie(name, value, options) {
      this.cookies[name] = { value, options };
    },
    clearCookie(name) {
      this.cleared.push(name);
    }
  };
  const req = {
    query,
    cookies,
    headers: { host: 'ihub.example.com' },
    get: name => (name.toLowerCase() === 'host' ? 'ihub.example.com' : undefined),
    url: '/',
    res
  };
  return { req, res };
}

/** Run one passport authenticate() step and report how it ended. */
function runStep(strategy, req, options = {}) {
  return new Promise(resolve => {
    const step = Object.create(strategy);
    step.redirect = location => resolve({ type: 'redirect', location });
    step.success = (user, info) => resolve({ type: 'success', user, info });
    step.fail = (info, status) => resolve({ type: 'fail', info, status });
    step.error = error => resolve({ type: 'error', error });
    step.authenticate(req, options);
  });
}

/** Start a login and return what the browser ends up holding. */
async function startLogin(strategy, options = {}) {
  const { req, res } = makeExchange();
  const outcome = await runStep(strategy, req, options);
  assert.strictEqual(outcome.type, 'redirect', `start ended with ${outcome.type}`);
  const location = new URL(outcome.location);
  return {
    state: location.searchParams.get('state'),
    codeChallenge: location.searchParams.get('code_challenge'),
    cookie: res.cookies[OIDC_LOGIN_COOKIE]
  };
}

/** Complete a login on a "different worker": a fresh strategy instance and request. */
async function finishLogin(providerName, { state, nonce, pkce = true }) {
  const strategy = makeStrategy(providerName, { pkce });
  let tokenParams = null;
  strategy._oauth2.getOAuthAccessToken = (code, params, callback) => {
    tokenParams = params;
    callback(null, 'access-token', 'refresh-token', {});
  };
  const cookies = nonce ? { [OIDC_LOGIN_COOKIE]: nonce } : {};
  const { req, res } = makeExchange({ query: { code: 'auth-code', state }, cookies });
  const outcome = await runStep(strategy, req);
  return { outcome, tokenParams, res };
}

const pkceChallenge = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');

// ---- the cross-worker round trip ------------------------------------------

await check('start sets an httpOnly, lax, path=/ binding cookie', async () => {
  const { cookie } = await startLogin(makeStrategy('keycloak'));
  assert.ok(cookie?.value, 'no binding cookie set');
  assert.strictEqual(cookie.options.httpOnly, true);
  assert.strictEqual(cookie.options.sameSite, 'lax');
  assert.strictEqual(cookie.options.path, '/');
  assert.strictEqual(cookie.options.maxAge, OIDC_LOGIN_STATE_TTL_MS);
});

await check('callback on another worker completes, with PKCE verifier and return URL', async () => {
  const start = await startLogin(makeStrategy('keycloak'), {
    state: { returnUrl: '/apps/chat?x=1' }
  });
  const { outcome, tokenParams, res } = await finishLogin('keycloak', {
    state: start.state,
    nonce: start.cookie.value
  });
  assert.strictEqual(outcome.type, 'success', `callback ended with ${outcome.type}`);
  assert.strictEqual(outcome.user.id, 'alice');
  assert.strictEqual(outcome.info.state.returnUrl, '/apps/chat?x=1');
  assert.ok(tokenParams.code_verifier, 'no code_verifier sent to the token endpoint');
  assert.strictEqual(pkceChallenge(tokenParams.code_verifier), start.codeChallenge);
  assert.ok(res.cleared.includes(OIDC_LOGIN_COOKIE), 'binding cookie not cleared');
});

await check('the PKCE verifier never appears in clear text in the state', async () => {
  const start = await startLogin(makeStrategy('keycloak'));
  const { tokenParams } = await finishLogin('keycloak', {
    state: start.state,
    nonce: start.cookie.value
  });
  const verifier = tokenParams.code_verifier;
  const payload = Buffer.from(start.state.split('.')[0], 'base64url').toString('utf8');
  assert.ok(!payload.includes(verifier), 'verifier readable in the state');
  assert.ok(!payload.includes(start.cookie.value), 'binding nonce readable in the state');
});

await check('no return URL given: callback succeeds without one', async () => {
  const start = await startLogin(makeStrategy('keycloak'));
  const { outcome } = await finishLogin('keycloak', {
    state: start.state,
    nonce: start.cookie.value
  });
  assert.strictEqual(outcome.type, 'success');
  assert.strictEqual(outcome.info.state.returnUrl, undefined);
});

await check('provider with PKCE disabled still verifies (no code_verifier sent)', async () => {
  const start = await startLogin(makeStrategy('legacy', { pkce: false }));
  assert.strictEqual(start.codeChallenge, null);
  const { outcome, tokenParams } = await finishLogin('legacy', {
    state: start.state,
    nonce: start.cookie.value,
    pkce: false
  });
  assert.strictEqual(outcome.type, 'success');
  assert.strictEqual(tokenParams.code_verifier, undefined);
});

// ---- what the session used to guarantee -----------------------------------

await check('callback without the binding cookie (another browser) is refused', async () => {
  const start = await startLogin(makeStrategy('keycloak'));
  const { outcome, tokenParams } = await finishLogin('keycloak', { state: start.state });
  assert.strictEqual(outcome.type, 'fail');
  assert.strictEqual(outcome.status, 403);
  assert.strictEqual(outcome.info.message, 'Unable to verify authorization request state.');
  assert.strictEqual(tokenParams, null, 'code was exchanged despite a refused state');
});

await check('callback with another login’s cookie is refused', async () => {
  const mine = await startLogin(makeStrategy('keycloak'));
  const theirs = await startLogin(makeStrategy('keycloak'));
  const { outcome } = await finishLogin('keycloak', {
    state: theirs.state,
    nonce: mine.cookie.value
  });
  assert.strictEqual(outcome.type, 'fail');
});

await check('state issued for one provider cannot complete another', async () => {
  const start = await startLogin(makeStrategy('keycloak'));
  const { outcome } = await finishLogin('entra', {
    state: start.state,
    nonce: start.cookie.value
  });
  assert.strictEqual(outcome.type, 'fail');
});

await check('tampered state is refused', async () => {
  const start = await startLogin(makeStrategy('keycloak'), { state: { returnUrl: '/safe' } });
  const [encoded, signature] = start.state.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  payload.returnUrl = 'https://evil.example.com/';
  const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
  const { outcome } = await finishLogin('keycloak', { state: forged, nonce: start.cookie.value });
  assert.strictEqual(outcome.type, 'fail');
});

await check('missing state is refused', async () => {
  const { outcome } = await finishLogin('keycloak', { state: undefined, nonce: 'x' });
  assert.strictEqual(outcome.type, 'fail');
});

// ---- the ticket itself ----------------------------------------------------

await check('expired state is refused', () => {
  const nonce = 'n'.repeat(43);
  const issuedAt = Date.now() - OIDC_LOGIN_STATE_TTL_MS - 1000;
  const state = issueOidcLoginState({ provider: 'keycloak', nonce, now: issuedAt });
  const result = verifyOidcLoginState({ state, nonce, provider: 'keycloak' });
  assert.deepStrictEqual(result, { ok: false, reason: 'expired' });
});

await check('state signed with another secret is refused', () => {
  const nonce = 'n'.repeat(43);
  const [encoded] = issueOidcLoginState({ provider: 'keycloak', nonce }).split('.');
  const otherSignature = crypto
    .createHmac('sha256', 'a-different-secret')
    .update(`oidc-login:${encoded}`)
    .digest('base64url');
  const result = verifyOidcLoginState({
    state: `${encoded}.${otherSignature}`,
    nonce,
    provider: 'keycloak'
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'bad_signature' });
});

await check('the same state signed with the configured secret verifies', () => {
  // Guards the test above: it must fail on the signature, not the format.
  const nonce = 'n'.repeat(43);
  const [encoded] = issueOidcLoginState({ provider: 'keycloak', nonce }).split('.');
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`oidc-login:${encoded}`)
    .digest('base64url');
  const result = verifyOidcLoginState({
    state: `${encoded}.${signature}`,
    nonce,
    provider: 'keycloak'
  });
  assert.strictEqual(result.ok, true);
});

await check('a fresh ticket round-trips its fields', () => {
  const nonce = 'n'.repeat(43);
  const state = issueOidcLoginState({
    provider: 'keycloak',
    nonce,
    returnUrl: '/x',
    codeVerifier: 'verifier-123'
  });
  assert.deepStrictEqual(verifyOidcLoginState({ state, nonce, provider: 'keycloak' }), {
    ok: true,
    returnUrl: '/x',
    codeVerifier: 'verifier-123'
  });
});

if (failed) {
  console.error('\n❌ OIDC login state tests failed');
  process.exit(1);
}
console.log('\n✅ All OIDC login state tests passed');
