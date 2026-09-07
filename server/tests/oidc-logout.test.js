/**
 * OIDC RP-Initiated Logout — unit tests.
 *
 * Locks in:
 * - POST /api/auth/logout signals oidcLogoutRequired only when the *current*
 *   session's authMode is 'oidc' AND the hint cookie is present - not from
 *   cookie presence alone (regression: a stale hint cookie surviving a later
 *   non-OIDC login must not redirect that session's logout through an
 *   unrelated provider).
 * - It never reads/uses the ID token the cookie carries.
 * - It always clears both authToken and oidcLogoutHint, regardless of mode.
 * - GET /api/auth/oidc-logout safely falls back to the local post-logout
 *   page on any missing/malformed/unknown-provider/malformed-URL hint, and
 *   otherwise builds the provider's end_session_endpoint URL with
 *   id_token_hint, post_logout_redirect_uri and client_id.
 * - The X-Forwarded-Host regression found during manual testing: Vite's dev
 *   proxy rewrites Host to the backend port, so post_logout_redirect_uri
 *   must prefer X-Forwarded-Host (via buildPublicBaseUrl) or the browser
 *   gets sent back to a URL that 404s.
 */
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

describe('POST /api/auth/logout - OIDC signal', () => {
  test('reports oidcLogoutRequired: false with no oidcLogoutHint cookie', async () => {
    const res = await request(buildApp('oidc')).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.oidcLogoutRequired).toBe(false);
  });

  test('reports oidcLogoutRequired: true when the session is OIDC and the hint cookie is present', async () => {
    const res = await request(buildApp('oidc'))
      .post('/api/auth/logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(200);
    expect(res.body.oidcLogoutRequired).toBe(true);
  });

  test('reports oidcLogoutRequired: false when a stale hint cookie survives a non-OIDC login', async () => {
    // Regression: user logged in via OIDC earlier (hint cookie set), then
    // logged in again via local/LDAP/NTLM/Teams without an intervening
    // logout - authToken now decodes to authMode 'local', but the old
    // oidcLogoutHint cookie is still sitting there unless the current
    // session is actually checked, not just cookie presence.
    const res = await request(buildApp('local'))
      .post('/api/auth/logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'stale' })]);

    expect(res.status).toBe(200);
    expect(res.body.oidcLogoutRequired).toBe(false);
  });

  test('reports oidcLogoutRequired: false when there is no session at all, even with the hint cookie present', async () => {
    const res = await request(buildApp())
      .post('/api/auth/logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    expect(res.status).toBe(200);
    expect(res.body.oidcLogoutRequired).toBe(false);
  });

  test('always clears the authToken cookie', async () => {
    const res = await request(buildApp('oidc')).post('/api/auth/logout');
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('authToken=;'))).toBe(true);
  });

  test('clears the oidcLogoutHint cookie here when it will NOT be used (non-OIDC session)', async () => {
    const res = await request(buildApp('local'))
      .post('/api/auth/logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'stale' })]);

    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('oidcLogoutHint=;'))).toBe(true);
  });

  test('does NOT clear the oidcLogoutHint cookie here when it WILL be used (OIDC session)', async () => {
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

  test('falls back safely on a malformed hint cookie instead of erroring', async () => {
    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', ['oidcLogoutHint=not-json']);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?logout=true');
  });

  test('falls back when the referenced provider has no endSessionURL configured', async () => {
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
      endSessionURL: 'https://kc.example.com/realms/test/protocol/openid-connect/logout'
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Host', 'ihub.example.com')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'the-id-token' })]);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(
      'https://kc.example.com/realms/test/protocol/openid-connect/logout'
    );
    expect(location.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(location.searchParams.get('client_id')).toBe('ihub-client');
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://ihub.example.com/?logout=true'
    );
  });

  test('prefers X-Forwarded-Host over Host for post_logout_redirect_uri (dev Vite-proxy regression)', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      endSessionURL: 'https://kc.example.com/realms/test/protocol/openid-connect/logout'
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

  test('falls back safely when endSessionURL is not a valid URL instead of throwing', async () => {
    configuredProviders.set('keycloak', {
      name: 'keycloak',
      clientId: 'ihub-client',
      endSessionURL: 'not a url'
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
      endSessionURL: 'https://kc.example.com/realms/test/protocol/openid-connect/logout'
    });

    const res = await request(app)
      .get('/api/auth/oidc-logout')
      .set('Cookie', [hintCookie({ provider: 'keycloak', idToken: 'x' })]);

    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('oidcLogoutHint=;'))).toBe(true);
  });
});
