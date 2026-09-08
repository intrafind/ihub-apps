/**
 * The oidcLogoutHint cookie's own invariants.
 *
 * These are the properties the RP-Initiated Logout flow leans on, and the ones
 * a future refactor is most likely to break silently: nothing here fails loudly
 * in production - the flow just quietly degrades back to a local-only logout,
 * or quietly leaves a bearer-grade ID token in the browser.
 */
import { describe, test, expect, jest } from '@jest/globals';

// cookieSettings reads the platform config for the `secure` flag; the real
// configCache drags in the whole config/authorization stack (and import.meta,
// which babel-jest's CJS transform cannot evaluate).
jest.mock('../../../server/configCache.js', () => ({
  __esModule: true,
  default: { getPlatform: () => ({}) }
}));

import {
  setOidcLogoutHint,
  clearOidcLogoutHint,
  readOidcLogoutHint,
  MAX_HINT_COOKIE_BYTES,
  OIDC_LOGOUT_HINT_COOKIE
} from '../../../server/utils/oidcLogoutHint.js';

function fakeRes() {
  return {
    cookies: [],
    cleared: [],
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
    },
    clearCookie(name, options) {
      this.cleared.push({ name, options });
    }
  };
}

const req = { get: () => undefined, protocol: 'https' };

describe('setOidcLogoutHint', () => {
  test('stores the provider and ID token when the provider supports logout', () => {
    const res = fakeRes();
    const wrote = setOidcLogoutHint(res, req, {
      provider: 'keycloak',
      idToken: 'the-id-token',
      logoutURL: 'https://kc.example.com/logout',
      maxAge: 1000
    });

    expect(wrote).toBe(true);
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0].name).toBe(OIDC_LOGOUT_HINT_COOKIE);
    expect(JSON.parse(res.cookies[0].value)).toEqual({
      provider: 'keycloak',
      idToken: 'the-id-token'
    });
  });

  test('CLEARS any stale hint when the provider has no logoutURL', () => {
    // A user who logs in via provider A (with a logoutURL) and then via
    // provider B (without one), with no logout in between, must not keep A's
    // hint: their logout would be sent to A's end_session_endpoint carrying
    // A's long-dead ID token, and B's session would never be terminated.
    const res = fakeRes();
    const wrote = setOidcLogoutHint(res, req, {
      provider: 'google',
      idToken: 'the-id-token',
      logoutURL: undefined,
      maxAge: 1000
    });

    expect(wrote).toBe(false);
    expect(res.cookies).toHaveLength(0);
    expect(res.cleared.map(c => c.name)).toEqual([OIDC_LOGOUT_HINT_COOKIE]);
  });

  test('drops an oversized ID token rather than writing a cookie the browser discards', () => {
    // Over ~4096 bytes the browser silently discards the whole cookie, which
    // would turn every logout back into a local-only one with no signal at all.
    const res = fakeRes();
    setOidcLogoutHint(res, req, {
      provider: 'entra',
      idToken: 'x'.repeat(MAX_HINT_COOKIE_BYTES + 1),
      logoutURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/logout',
      maxAge: 1000
    });

    expect(res.cookies).toHaveLength(1);
    expect(JSON.parse(res.cookies[0].value)).toEqual({ provider: 'entra' });
    expect(Buffer.byteLength(encodeURIComponent(res.cookies[0].value), 'utf8')).toBeLessThanOrEqual(
      MAX_HINT_COOKIE_BYTES
    );
  });

  test('accounts for URL encoding when measuring the cookie', () => {
    // res.cookie() URL-encodes the value, and every JSON quote becomes %22 -
    // so a token measured raw can still be over the limit on the wire.
    const res = fakeRes();
    setOidcLogoutHint(res, req, {
      provider: 'entra',
      idToken: 'x'.repeat(MAX_HINT_COOKIE_BYTES - 40),
      logoutURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/logout',
      maxAge: 1000
    });

    expect(JSON.parse(res.cookies[0].value)).toEqual({ provider: 'entra' });
  });
});

describe('cookie attributes', () => {
  test('the hint is httpOnly and SameSite=Strict, and scoped to /api/auth', () => {
    // Strict is what stops a third-party page from navigating a logged-in user
    // to /api/auth/oidc-logout to force a global SSO logout at their IdP, or to
    // burn the hint so this session's real logout degrades to local-only.
    // The path keeps the ID token off every other request in the session.
    const res = fakeRes();
    setOidcLogoutHint(res, req, {
      provider: 'keycloak',
      idToken: 'x',
      logoutURL: 'https://kc.example.com/logout',
      maxAge: 1000
    });

    expect(res.cookies[0].options).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 1000
    });
  });

  test('clearing uses the same path and sameSite it was set with', () => {
    // A mismatch here leaves the original cookie - and its ID token - in place.
    const setRes = fakeRes();
    setOidcLogoutHint(setRes, req, {
      provider: 'keycloak',
      idToken: 'x',
      logoutURL: 'https://kc.example.com/logout',
      maxAge: 1000
    });

    const clearRes = fakeRes();
    clearOidcLogoutHint(clearRes, req);

    expect(clearRes.cleared[0].options.path).toBe(setRes.cookies[0].options.path);
    expect(clearRes.cleared[0].options.sameSite).toBe(setRes.cookies[0].options.sameSite);
  });
});

describe('readOidcLogoutHint', () => {
  test('reports absence without a parse error', () => {
    expect(readOidcLogoutHint({ cookies: {} })).toEqual({
      present: false,
      parseError: false,
      hint: null
    });
  });

  test('distinguishes a malformed cookie from a missing one', () => {
    expect(readOidcLogoutHint({ cookies: { oidcLogoutHint: 'not-json' } })).toEqual({
      present: true,
      parseError: true,
      hint: null
    });
  });

  test('parses a well-formed hint', () => {
    const raw = JSON.stringify({ provider: 'keycloak', idToken: 'x' });
    expect(readOidcLogoutHint({ cookies: { oidcLogoutHint: raw } })).toEqual({
      present: true,
      parseError: false,
      hint: { provider: 'keycloak', idToken: 'x' }
    });
  });
});
