// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `jwtAuth` and the session cookie of a framed iHub (`authTokenEmbed`).
 *
 * The cookie is `SameSite=None`, so the browser does not keep another site from
 * making a request carry it. The middleware does: the cookie counts only for a
 * request the iHub page itself made (`isSameOriginRequest`).
 *
 * Locked in here:
 * - a same-origin request is signed in by the cookie,
 * - a cross-site request, or a forged POST, is answered as if the cookie were not there,
 * - the cookie wins over `authToken` where it counts, and never where it does not,
 * - a dead cookie is dropped with a header that names `Partitioned`.
 *
 * Native-ESM jest; run through scripts/run-server-tests.js.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import express from 'express';
import supertest from 'supertest';
import { parseCookies } from './helpers/parseCookies.js';

const SECRET = 'embed-session-cookie-secret';
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

jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../telemetry/metrics.js', () => ({
  recordAuthEvent: () => {},
  recordRateLimitHit: () => {}
}));

const { default: jwtAuth } = await import('../middleware/jwtAuth.js');
const { default: registerEmbedAuthRoutes } = await import('../routes/embedAuth.js');

function sign(claims, { expiresInSeconds = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { name: 'Jane Doe', groups: ['authenticated'], iat: now - 60, ...claims },
    SECRET,
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
  const res = { statusCode: 200, body: undefined, clearedCookies: [], appended: [], ended: false };
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
  res.append = (name, value) => {
    res.appended.push([name, value]);
  };
  return res;
}

/** One request through the real middleware. `headers` are the ones a browser sends. */
async function request({ embed, authToken, method = 'GET', headers = {}, path = '/api/apps' }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const cookies = {};
  if (embed) cookies.authTokenEmbed = embed;
  if (authToken) cookies.authToken = authToken;
  const req = {
    headers: {},
    cookies,
    path,
    method,
    protocol: 'https',
    host: 'ihub.example.com',
    get: name => lower[name.toLowerCase()]
  };
  const res = makeRes();
  let nextCalled = false;
  await jwtAuth(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const CROSS_SITE = { 'Sec-Fetch-Site': 'cross-site' };

function addUser(id) {
  state.users.users[id] = {
    id,
    username: id,
    name: id,
    email: `${id}@example.com`,
    active: true,
    authMethods: ['oidc'],
    oidcData: { subject: id },
    internalGroups: []
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

describe('the session cookie of a framed iHub', () => {
  it('signs in a request the iHub page itself made', async () => {
    const { req, nextCalled } = await request({ embed: session('jane'), headers: SAME_ORIGIN });
    expect(nextCalled).toBe(true);
    expect(req.user.id).toBe('jane');
  });

  it('signs in a request with no fetch metadata when the method is safe', async () => {
    const { req } = await request({ embed: session('jane') });
    expect(req.user?.id).toBe('jane');
  });

  it('ignores the cookie on a request another site made', async () => {
    const { req, nextCalled, res } = await request({ embed: session('jane'), headers: CROSS_SITE });
    expect(nextCalled).toBe(true);
    expect(req.user?.id).not.toBe('jane');
    // Not a dead token: the cookie stays, it just does not count here.
    expect(res.appended).toEqual([]);
  });

  it('ignores the cookie on a forged POST', async () => {
    const forged = await request({
      embed: session('jane'),
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example.com' }
    });
    expect(forged.req.user?.id).not.toBe('jane');

    const noProof = await request({ embed: session('jane'), method: 'POST' });
    expect(noProof.req.user?.id).not.toBe('jane');
  });

  it('signs in a POST that proves it came from the iHub page', async () => {
    const byFetchMetadata = await request({
      embed: session('jane'),
      method: 'POST',
      headers: SAME_ORIGIN
    });
    expect(byFetchMetadata.req.user.id).toBe('jane');

    const byOrigin = await request({
      embed: session('jane'),
      method: 'POST',
      headers: { Origin: 'https://ihub.example.com' }
    });
    expect(byOrigin.req.user.id).toBe('jane');
  });

  it('wins over authToken where it counts', async () => {
    const { req } = await request({
      embed: session('jane'),
      authToken: session('john'),
      headers: SAME_ORIGIN
    });
    expect(req.user.id).toBe('jane');
  });

  it('leaves authToken in charge where it does not count', async () => {
    const { req } = await request({
      embed: session('jane'),
      authToken: session('john'),
      headers: CROSS_SITE
    });
    expect(req.user.id).toBe('john');
  });

  it('does not sign in with an expired cookie', async () => {
    // The cookie lives as long as its token, so a browser rarely sends one that is past it.
    const { req, nextCalled } = await request({
      embed: session('jane', { expiresInSeconds: -60 }),
      headers: SAME_ORIGIN
    });
    expect(nextCalled).toBe(true);
    expect(req.user?.id).not.toBe('jane');
  });

  it('drops the cookie of a user that was deleted, with a header that names Partitioned', async () => {
    const { res } = await request({
      embed: session('user-that-was-deleted'),
      headers: SAME_ORIGIN
    });
    // A partitioned cookie is only replaced by a header that names Partitioned, so Express's own
    // clearCookie would leave it in place.
    expect(res.clearedCookies).toEqual([]);
    expect(res.appended).toHaveLength(1);
    const [name, value] = res.appended[0];
    expect(name).toBe('Set-Cookie');
    expect(value).toMatch(/^authTokenEmbed=;/);
    expect(value).toContain('Max-Age=0');
    expect(value).toContain('Partitioned');
  });
});

describe('the popup page of the sign-in in a frame, as the server really serves it', () => {
  // The auth chain of middleware/setup.js skips every path without a file extension that is not
  // under /api (the pages of the single-page app), so nothing authenticates /embed-auth/complete
  // for it. This app is built the same way: cookies are parsed, no authentication runs first.
  const challenge = 'A'.repeat(43);
  const page = () => {
    const app = express();
    app.use(parseCookies);
    app.use(express.json());
    registerEmbedAuthRoutes(app);
    return supertest(app).get(`/embed-auth/complete?challenge=${challenge}`);
  };

  beforeEach(() => {
    state.platform.embedAuth = { allowedHostOrigins: ['https://ifinder.example.com'] };
  });

  it('shows the page that asks for the code to a visitor with a valid session cookie', async () => {
    const res = await page()
      .set('Cookie', `authToken=${session('jane')}`)
      .redirects(0);

    // Before it authenticated itself, this was a redirect to the login, and from there back here, for ever.
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain(`data-challenge="${challenge}"`);
  });

  it('sends a visitor without a session to the login and back', async () => {
    const res = await page().redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?returnUrl=/);
  });

  it('sends a visitor whose account was deleted to the login, not to a JSON answer', async () => {
    const res = await page()
      .set('Cookie', `authToken=${session('user-that-was-deleted')}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?returnUrl=/);
    // The dead session is dropped on the way, so the login is not met by it again.
    expect(res.headers['set-cookie'].join(';')).toMatch(/authToken=;/);
  });
});
