/**
 * OIDC RP-Initiated Logout — unit tests.
 *
 * Runs under the server's own native-ESM jest (see the `test:auth-routes` npm
 * script, which `test:quick` — and therefore CI — chains in). It cannot live
 * under tests/unit/server/: the root jest config transforms `.js` to CJS, and
 * routes/auth.js reaches middleware/localAuth.js, which uses `import.meta.url`.
 *
 * Locks in:
 * - POST /api/auth/logout signals oidcLogoutRequired from the presence of the
 *   hint cookie alone, and never reads the ID token the cookie carries.
 *   Presence is authoritative because the hint is written on every OIDC login
 *   and cleared on every other login; it deliberately does NOT depend on the
 *   current authToken still being valid, since the provider's SSO session
 *   routinely outlives iHub's JWT.
 * - It clears the hint only when the follow-up redirect will NOT consume it
 *   (regression: clearing it here as well deleted it one request too early and
 *   silently downgraded every OIDC logout to a local-only one).
 * - GET /api/auth/oidc-logout safely falls back to the local post-logout page on
 *   any missing/malformed/unknown-provider/malformed-URL hint, and otherwise
 *   builds the provider's end_session_endpoint URL with id_token_hint,
 *   post_logout_redirect_uri and client_id.
 * - It proceeds with client_id alone when the hint carries no ID token (the
 *   oversized-token path), and only gives up when neither is available.
 * - Non-http(s) and unresolved-${VAR} logout URLs fall back instead of sending
 *   the browser somewhere useless.
 * - postLogoutRedirectURL overrides the auto-detected redirect target.
 * - The X-Forwarded-Host regression found during manual testing: Vite's dev
 *   proxy rewrites Host to the backend port, so post_logout_redirect_uri must
 *   prefer X-Forwarded-Host (via buildPublicBaseUrl) or the browser gets sent
 *   back to a URL that 404s.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import registerAuthRoutes from '../routes/auth.js';
import { configuredProviders } from '../middleware/oidcAuth.js';

// authMode is undefined by default (no session) - pass e.g. 'oidc' or 'local'
// to simulate a request carrying a decoded, valid authToken JWT of that mode
// (in production this is set by jwtAuth.js's global optional-auth middleware,
// which isn't mounted in this focused route test).
function buildApp(authMode) {
  const app = express();
  app.use(cookieParser());
  if (authMode) {
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', authMode };
      next();
    });
  }
  registerAuthRoutes(app);
  return app;
}

function hintCookie(value) {
  return 'oidcLogoutHint=' + encodeURIComponent(JSON.stringify(value));
}

const KEYCLOAK_LOGOUT = 'https://kc.example.com/realms/test/protocol/openid-connect/logout';

describe('POST /api/auth/logout - OIDC signal', () => {
  test('reports oidcLogoutRequired: false with no oidcLogoutHint cookie', async () => {
    const res = await request(buildApp('oidc')).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.oidcLogoutRequired).toBe(false);
  });

  test('reports oidcLogoutRequired: true when the hint cookie is present', async () => {
    const res = await request(buildApp('oidc'))
      .post('/api/auth/logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(200);
    expect(res.body.oidcLogoutRequired).toBe(true);
  });

  test('reports oidcLogoutRequired: true even when the iHub JWT has already expired', async () => {
    // The provider's SSO session outlives iHub's JWT, so a logout arriving with
    // no (or an anonymous) session must still end the provider session -
    // otherwise the next person on a shared device is silently signed in as the
    // previous user, which is the whole point of this feature.
    const res = await request(buildApp())
      .post('/api/auth/logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(200);
    expect(res.body.oidcLogoutRequired).toBe(true);
  });

  test('always clears the authToken cookie', async () => {
    const res = await request(buildApp('oidc')).post('/api/auth/logout');
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('authToken=;'))).toBe(true);
  });

  test('clears the oidcLogoutHint cookie here when there is nothing to consume it', async () => {
    const res = await request(buildApp('local')).post('/api/auth/logout');

    expect(res.body.oidcLogoutRequired).toBe(false);
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('oidcLogoutHint=;'))).toBe(true);
  });

  test('does NOT clear the oidcLogoutHint cookie here when it WILL be used', async () => {
    // Regression: this endpoint must leave the hint cookie alone whenever
    // oidcLogoutRequired is true, since GET /api/auth/oidc-logout is the one
    // responsible for reading *and* clearing it next. Clearing it here too
    // deletes it before that follow-up request ever sees it, silently
    // downgrading every OIDC logout to a local-only one - exactly the bug
    // found via manual testing (Network tab showed the cookie correctly sent
    // on this request, but "no hint cookie" was logged on the next one).
    const res = await request(buildApp('oidc'))
      .post('/api/auth/logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.body.oidcLogoutRequired).toBe(true);
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('oidcLogoutHint=;'))).toBe(false);
  });
});

describe('GET /api/auth/oidc-logout', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    configuredProviders.clear();
  });

  afterEach(() => {
    configuredProviders.clear();
  });

  test('falls back to the local logout page with no hint cookie', async () => {
    const res = await request(app).get('/api/auth/oidc-logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('does not clear authToken without a hint cookie', async () => {
    // A cross-site navigation never carries the SameSite=Strict hint, so this
    // branch must not double as a cross-site forced logout for iHub itself.
    const res = await request(app).get('/api/auth/oidc-logout');
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('authToken=;'))).toBe(false);
  });

  test('clears authToken once a hint has been presented', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: KEYCLOAK_LOGOUT
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('authToken=;'))).toBe(true);
  });

  test('falls back safely on a malformed hint cookie instead of erroring', async () => {
    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', ['oidcLogoutHint=not-json']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('falls back when the referenced provider has no logoutURL configured', async () => {
    configuredProviders.set('keycloak', { name: 'keycloak', clientId: 'ihub-client' });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('falls back when the referenced provider is unknown', async () => {
    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'does-not-exist', idToken: 'x' })]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('redirects to the provider end_session_endpoint with id_token_hint, post_logout_redirect_uri and client_id', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: KEYCLOAK_LOGOUT
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Host', 'ihub.example.com')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'the-id-token' })]);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(KEYCLOAK_LOGOUT);
    expect(location.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(location.searchParams.get('client_id')).toBe('ihub-client');
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://ihub.example.com/?logout=true'
    );
  });

  test('proceeds with client_id alone when the hint carries no ID token', async () => {
    // The oversized-ID-token path: setOidcLogoutHint() stores the provider name
    // on its own rather than writing a cookie the browser would drop. client_id
    // is enough to identify the client per the RP-Initiated Logout spec, so the
    // provider session still ends.
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: KEYCLOAK_LOGOUT
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak' })]);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(KEYCLOAK_LOGOUT);
    expect(location.searchParams.has('id_token_hint')).toBe(false);
    expect(location.searchParams.get('client_id')).toBe('ihub-client');
  });

  test('falls back when the hint has neither an ID token nor a client_id', async () => {
    configuredProviders.set('keycloak', { name: 'keycloak', logoutURL: KEYCLOAK_LOGOUT });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak' })]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('honours an explicit postLogoutRedirectURL over the detected host', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: KEYCLOAK_LOGOUT,
      postLogoutRedirectURL: 'https://canonical.example.com/ihub/?logout=true'
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Host', 'internal.example.com')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    const location = new URL(res.headers.location);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://canonical.example.com/ihub/?logout=true'
    );
  });

  test('prefers X-Forwarded-Host over Host for post_logout_redirect_uri (dev Vite-proxy regression)', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: KEYCLOAK_LOGOUT
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Host', 'localhost:3000')
      .set('X-Forwarded-Host', 'localhost:5173')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    const location = new URL(res.headers.location);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:5173/?logout=true'
    );
  });

  test('falls back safely when logoutURL is not a valid URL instead of throwing', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: 'not a url'
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('falls back when logoutURL is not an http(s) URL', async () => {
    // new URL() parses `javascript:` happily; res.redirect() must not carry it.
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: 'javascript:alert(1)'
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('falls back when logoutURL still holds an unresolved ${VAR} placeholder', async () => {
    // configCache keeps `${VAR}` verbatim (and only warns) when the environment
    // variable is missing, and `${KEYCLOAK_SERVER}` is a legal URL host - so
    // this would otherwise redirect the browser to a nonexistent server.
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: 'https://${KEYCLOAK_SERVER}/realms/test/protocol/openid-connect/logout'
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('clears the oidcLogoutHint cookie on every outcome', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      logoutURL: KEYCLOAK_LOGOUT
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('oidcLogoutHint=;'))).toBe(true);
  });
});
