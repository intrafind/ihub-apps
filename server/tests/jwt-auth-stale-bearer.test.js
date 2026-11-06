// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A stale token in the Authorization header must not cost the browser its
 * session cookie.
 *
 * Before the OIDC callback stopped putting the token in the redirect URL, the
 * web client stored that token in localStorage, and it still sends whatever is
 * stored there as `Authorization: Bearer` on every request. `jwtAuth` reads the
 * header before the cookie. So once that old token had expired - or its user,
 * its sign-in method or the signing key was gone - a person signed in at the
 * identity provider, got a fresh `authToken` cookie, and the next status check
 * still answered "not signed in": the login screen came back on every click
 * until the browser's site data was cleared. Some of those dead tokens even
 * made the middleware delete the fresh cookie.
 *
 * Locked in here:
 * - a dead session token in the header hands over to the session cookie,
 * - a header token never drops the cookie, unless the cookie holds that very
 *   token,
 * - the request is marked, so /api/auth/status can tell the client to forget
 *   the token it sent,
 * - a valid header token still wins over the cookie, and an OAuth token
 *   (add-in, extension, API clients) never falls back to it.
 *
 * Native-ESM jest; run through scripts/run-server-tests.js.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';

const SECRET = 'jwt-auth-stale-bearer-secret';
process.env.JWT_SECRET = SECRET;

const USERS_KEY = 'config/users.json';

const state = { platform: {}, users: null };

const clone = value => (value === null || value === undefined ? value : structuredClone(value));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    get: key => (key === USERS_KEY ? { data: state.users } : null),
    setCacheEntry: (key, data) => {
      if (key === USERS_KEY) state.users = clone(data);
    },
    getGroups: () => ({ data: { groups: {} } })
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: () => Promise.resolve(clone(state.users)),
    readJsonStrict: () => Promise.resolve(clone(state.users)),
    writeJson: (_relPath, data) => {
      state.users = clone(data);
      return Promise.resolve();
    }
  }
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { getJwtSecret: () => SECRET, getRSAPrivateKey: () => null, getRSAPublicKey: () => null }
}));

const { default: jwtAuth } = await import('../middleware/jwtAuth.js');

/** A token signed the way iHub signs its session tokens (HS256 in these tests). */
function sign(claims, { secret = SECRET, expiresInSeconds = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { name: 'Jane Doe', groups: ['authenticated'], iat: now - 60, ...claims },
    secret,
    {
      algorithm: 'HS256',
      issuer: 'ihub-apps',
      audience: 'ihub-apps',
      expiresIn: expiresInSeconds
    }
  );
}

const session = (sub, options) => sign({ sub, username: sub, authMode: 'oidc' }, options);

function makeRes() {
  const res = { statusCode: 200, body: undefined, clearedCookies: [], ended: false };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    res.body = body;
    res.ended = true;
    return res;
  };
  res.clearCookie = name => {
    res.clearedCookies.push(name);
  };
  return res;
}

/** One request through the real middleware, with a header token and/or a cookie. */
async function request({ header, cookie, path = '/api/apps' }) {
  const req = {
    headers: header ? { authorization: `Bearer ${header}` } : {},
    cookies: cookie ? { authToken: cookie } : {},
    path,
    method: 'GET',
    protocol: 'https',
    get: () => undefined
  };
  const res = makeRes();
  let nextCalled = false;
  await jwtAuth(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

function addUser(id, overrides = {}) {
  state.users.users[id] = {
    id,
    username: id,
    name: id,
    email: `${id}@example.com`,
    active: true,
    authMethods: ['oidc'],
    oidcData: { subject: id },
    internalGroups: [],
    ...overrides
  };
}

beforeEach(() => {
  state.platform = {
    jwt: { algorithm: 'HS256' },
    auth: { mode: 'oidc' },
    localAuth: { enabled: false },
    oidcAuth: { enabled: true },
    oauth: { enabled: { authz: true, clients: true } }
  };
  state.users = { users: {}, metadata: { version: '2.0.0' } };
  addUser('jane');
  addUser('john');
});

describe('a dead session token in the Authorization header', () => {
  const deadTokens = {
    'an expired token': () => session('jane', { expiresInSeconds: -60 }),
    "another installation's token": () => session('jane', { secret: 'some-other-secret' }),
    'a token whose user was deleted': () => session('user-that-was-deleted'),
    'a local token while local sign-in is off': () =>
      sign({ sub: 'admin', username: 'admin', authMode: 'local' }),
    'something that is not a token at all': () => 'not-a-jwt'
  };

  it.each(Object.keys(deadTokens))('hands over to the session cookie: %s', async kind => {
    const { req, res, nextCalled } = await request({
      header: deadTokens[kind](),
      cookie: session('jane')
    });

    expect(nextCalled).toBe(true);
    expect(res.ended).toBe(false);
    expect(req.user.id).toBe('jane');
    expect(req.bearerTokenRejected).toBe(true);
    // The fresh session survives the stale header.
    expect(res.clearedCookies).toEqual([]);
  });

  it.each(Object.keys(deadTokens))(
    'without a cookie, leaves the status endpoint anonymous and flags the token: %s',
    async kind => {
      const { req, res, nextCalled } = await request({
        header: deadTokens[kind](),
        path: '/api/auth/status'
      });

      expect(nextCalled).toBe(true);
      expect(res.ended).toBe(false);
      expect(req.user).toBeUndefined();
      expect(req.bearerTokenRejected).toBe(true);
      expect(res.clearedCookies).toEqual([]);
    }
  );

  it('is still refused with 401 on an API route when there is no cookie to use', async () => {
    const { res, nextCalled } = await request({ header: session('user-that-was-deleted') });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error_description).toBe('User account no longer exists');
    expect(res.clearedCookies).toEqual([]);
  });

  it('does not save a dead cookie either: both dead means signed out', async () => {
    const { req, res, nextCalled } = await request({
      header: session('jane', { expiresInSeconds: -60 }),
      cookie: session('user-that-was-deleted'),
      path: '/api/auth/status'
    });

    expect(nextCalled).toBe(true);
    expect(req.user).toBeUndefined();
    expect(req.bearerTokenRejected).toBe(true);
    // This time it is the cookie's own token that is dead, so it goes.
    expect(res.clearedCookies).toEqual(['authToken']);
  });

  it('drops the cookie when the cookie holds that same dead token', async () => {
    // The old OIDC callback put the one token in both places.
    const token = session('user-that-was-deleted');

    const { res } = await request({ header: token, cookie: token, path: '/api/auth/status' });

    expect(res.clearedCookies).toEqual(['authToken']);
  });
});

describe('a usable token in the Authorization header', () => {
  it('still wins over the session cookie', async () => {
    const { req } = await request({ header: session('john'), cookie: session('jane') });

    expect(req.user.id).toBe('john');
    expect(req.bearerTokenRejected).toBeUndefined();
  });
});

describe('an OAuth token in the Authorization header', () => {
  it('does not fall back to the cookie when it has expired, so its client refreshes it', async () => {
    const oauthToken = sign(
      { sub: 'jane', authMode: 'oauth_authorization_code', client_id: 'browser-extension' },
      { expiresInSeconds: -60 }
    );

    const { req, nextCalled } = await request({ header: oauthToken, cookie: session('jane') });

    expect(nextCalled).toBe(true);
    expect(req.user).toBeUndefined();
  });
});

describe('the session cookie alone', () => {
  it('is dropped when its user is gone, as before', async () => {
    const { res } = await request({
      cookie: session('user-that-was-deleted'),
      path: '/api/auth/status'
    });

    expect(res.clearedCookies).toEqual(['authToken']);
  });

  it('is not flagged as a rejected bearer token', async () => {
    const { req } = await request({
      cookie: session('jane', { expiresInSeconds: -60 }),
      path: '/api/auth/status'
    });

    expect(req.user).toBeUndefined();
    expect(req.bearerTokenRejected).toBeUndefined();
  });
});
