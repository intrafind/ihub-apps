// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sign-in for iHub in a frame of another site (`routes/embedAuth.js`,
 * `utils/embedAuth.js`).
 *
 * Locked in here:
 * - the popup page sends a signed-out visitor to the normal login and back,
 * - the code is issued only to a signed-in, same-origin request, bound to the PKCE
 *   challenge, and works once,
 * - redeeming it sets a `HttpOnly; Secure; SameSite=None; Partitioned` cookie and
 *   puts no token into the body,
 * - a wrong verifier, a replay, an expired session and an OAuth code are all refused.
 *
 * Native-ESM jest; run through scripts/run-server-tests.js.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { parseCookies } from './helpers/parseCookies.js';

const SECRET = 'embed-auth-test-secret';
process.env.JWT_SECRET = SECRET;

const state = { platform: {} };

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.platform, get: () => ({ data: null, etag: null }) }
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { getJwtSecret: () => SECRET, getRSAPrivateKey: () => null, getRSAPublicKey: () => null }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../telemetry/metrics.js', () => ({
  recordAuthEvent: () => {},
  recordRateLimitHit: () => {}
}));

const { default: registerEmbedAuthRoutes } = await import('../routes/embedAuth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { generateCode, storeCode } = await import('../utils/authorizationCodeStore.js');
const { generateCodeChallenge, generateCodeVerifier } = await import('../utils/pkceUtils.js');
const embedAuth = await import('../utils/embedAuth.js');

const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const ISSUE = '/api/auth/embed-codes/_issue';
const REDEEM = '/api/auth/embed-codes/_redeem';
const HOST_ORIGIN = 'https://ifinder.example.com';

function sessionToken({ expiresInSeconds = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: 'jane', username: 'jane', name: 'Jane', groups: ['users'], authMode: 'oidc', iat: now },
    SECRET,
    { algorithm: 'HS256', issuer: 'ihub-apps', audience: 'ihub-apps', expiresIn: expiresInSeconds }
  );
}

/** An app with the real routes. `x-test-user` stands in for what `jwtAuth` would set. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(parseCookies);
  app.use((req, res, next) => {
    const user = req.get('x-test-user');
    if (user) req.user = { id: user };
    next();
  });
  registerEmbedAuthRoutes(app);
  app.use(errorHandler);
  return app;
}

/** Signed in as jane, with the session cookie the login set. */
const signedIn = (app, method, url, token = sessionToken()) =>
  request(app)[method](url).set('x-test-user', 'jane').set('Cookie', `authToken=${token}`);

beforeEach(() => {
  state.platform = {
    jwt: { algorithm: 'HS256' },
    embedAuth: { allowedHostOrigins: [HOST_ORIGIN] }
  };
});

describe('embed auth helpers', () => {
  it('reads only http(s) origins from the configuration', () => {
    const origins = embedAuth.getEmbedAuthOrigins({
      embedAuth: {
        allowedHostOrigins: [
          'https://a.example.com/some/path',
          'http://localhost:3000',
          'https://a.example.com',
          'ftp://nope.example.com',
          'not a url',
          42,
          null
        ]
      }
    });
    expect(origins).toEqual(['https://a.example.com', 'http://localhost:3000']);
  });

  it('is off without allowed origins', () => {
    expect(embedAuth.isEmbedAuthEnabled({})).toBe(false);
    expect(embedAuth.isEmbedAuthEnabled({ embedAuth: { allowedHostOrigins: [] } })).toBe(false);
    expect(embedAuth.isEmbedAuthEnabled({ embedAuth: { allowedHostOrigins: [HOST_ORIGIN] } })).toBe(
      true
    );
  });

  it('writes a partitioned, HttpOnly, Secure, SameSite=None cookie', () => {
    const header = embedAuth.serializeEmbedSessionCookie('a.b.c', 120.9);
    expect(header).toBe(
      'authTokenEmbed=a.b.c; Max-Age=120; Path=/; HttpOnly; Secure; SameSite=None; Partitioned'
    );
  });

  it('refuses a token that is not cookie safe', () => {
    expect(() => embedAuth.serializeEmbedSessionCookie('a;b', 60)).toThrow();
    expect(() => embedAuth.serializeEmbedSessionCookie('a b', 60)).toThrow();
  });

  it('clears the cookie with the same attributes, partitioned included', () => {
    const header = embedAuth.serializeClearEmbedSessionCookie();
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('SameSite=None');
    expect(header).toContain('Partitioned');
  });

  it('checks the shape of a challenge and a verifier', () => {
    const verifier = generateCodeVerifier();
    expect(embedAuth.isValidCodeVerifier(verifier)).toBe(true);
    expect(embedAuth.isValidCodeChallenge(generateCodeChallenge(verifier))).toBe(true);
    expect(embedAuth.isValidCodeChallenge('short')).toBe(false);
    expect(embedAuth.isValidCodeChallenge(`${'a'.repeat(42)}!`)).toBe(false);
    expect(embedAuth.isValidCodeVerifier('x'.repeat(42))).toBe(false);
    expect(embedAuth.isValidCodeVerifier('x'.repeat(129))).toBe(false);
    expect(embedAuth.isValidCodeVerifier(undefined)).toBe(false);
  });

  describe('isSameOriginRequest', () => {
    const req = ({ method = 'POST', headers = {} } = {}) => ({
      method,
      protocol: 'https',
      host: 'ihub.example.com',
      get: name => headers[name.toLowerCase()]
    });

    it('trusts Sec-Fetch-Site', () => {
      expect(
        embedAuth.isSameOriginRequest(req({ headers: { 'sec-fetch-site': 'same-origin' } }))
      ).toBe(true);
      for (const site of ['cross-site', 'same-site', 'none']) {
        expect(embedAuth.isSameOriginRequest(req({ headers: { 'sec-fetch-site': site } }))).toBe(
          false
        );
      }
    });

    it('lets a typed address through for a safe method only', () => {
      const headers = { 'sec-fetch-site': 'none' };
      expect(embedAuth.isSameOriginRequest(req({ method: 'GET', headers }))).toBe(true);
      expect(embedAuth.isSameOriginRequest(req({ method: 'POST', headers }))).toBe(false);
    });

    it('falls back to Origin when the browser sends no fetch metadata', () => {
      expect(
        embedAuth.isSameOriginRequest(req({ headers: { origin: 'https://ihub.example.com' } }))
      ).toBe(true);
      expect(
        embedAuth.isSameOriginRequest(req({ headers: { origin: 'https://evil.example.com' } }))
      ).toBe(false);
      expect(embedAuth.isSameOriginRequest(req({ headers: { origin: 'null' } }))).toBe(false);
    });

    it('needs proof for an unsafe method, not for a safe one, when nothing is sent', () => {
      expect(embedAuth.isSameOriginRequest(req({ method: 'POST' }))).toBe(false);
      expect(embedAuth.isSameOriginRequest(req({ method: 'GET' }))).toBe(true);
    });
  });
});

describe('GET /embed-auth/complete', () => {
  const challenge = generateCodeChallenge(generateCodeVerifier());

  it('is off without allowed origins', async () => {
    state.platform.embedAuth = { allowedHostOrigins: [] };
    const res = await request(buildApp()).get(`/embed-auth/complete?challenge=${challenge}`);
    expect(res.status).toBe(404);
  });

  it('refuses a malformed challenge', async () => {
    const res = await request(buildApp()).get('/embed-auth/complete?challenge=nope');
    expect(res.status).toBe(400);
  });

  it('sends a signed-out visitor to the login and back', async () => {
    const res = await request(buildApp()).get(`/embed-auth/complete?challenge=${challenge}`);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.location, 'https://ihub.example.com');
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('returnUrl')).toBe(
      `/embed-auth/complete?challenge=${challenge}`
    );
  });

  it('sends a signed-out visitor straight to the provider they picked', async () => {
    const res = await request(buildApp()).get(
      `/embed-auth/complete?challenge=${challenge}&provider=microsoft`
    );
    expect(res.status).toBe(302);
    const target = new URL(res.headers.location, 'https://ihub.example.com');
    expect(target.pathname).toBe('/api/auth/oidc/microsoft');
    expect(target.searchParams.get('returnUrl')).toBe(
      `/embed-auth/complete?challenge=${challenge}`
    );
  });

  it('ignores a provider that is not a plain id', async () => {
    for (const provider of ['../../evil', 'a/b', 'x'.repeat(200), 'a b']) {
      const res = await request(buildApp())
        .get('/embed-auth/complete')
        .query({ challenge, provider });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.location, 'https://ihub.example.com').pathname).toBe('/login');
    }
  });

  it('shows the page that asks for the code to a signed-in visitor, and cannot be framed', async () => {
    const res = await request(buildApp())
      .get(`/embed-auth/complete?challenge=${challenge}`)
      .set('x-test-user', 'jane');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(res.text).toContain(`data-challenge="${challenge}"`);
    expect(res.text).toContain('data-issue-url="/api/auth/embed-codes/_issue"');
    // The code goes to the opener's origin only, never to '*'.
    expect(res.text).toContain('window.location.origin');
    expect(res.text).not.toMatch(/postMessage\([^)]*['"]\*['"]/);
  });
});

describe(`POST ${ISSUE}`, () => {
  const challenge = generateCodeChallenge(generateCodeVerifier());
  const issue = (app, body = { codeChallenge: challenge }) =>
    signedIn(app, 'post', ISSUE).set(SAME_ORIGIN).send(body);

  it('issues a code to a signed-in, same-origin request', async () => {
    const res = await issue(buildApp());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(typeof res.body.code).toBe('string');
    expect(res.body.expiresInSeconds).toBe(60);
  });

  it('is refused while the feature is off', async () => {
    state.platform.embedAuth = {};
    const res = await issue(buildApp());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMBED_SIGN_IN_DISABLED');
  });

  it('is refused for a request another site made', async () => {
    const res = await signedIn(buildApp(), 'post', ISSUE)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ codeChallenge: challenge });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('answers 401 when nobody is signed in', async () => {
    const res = await request(buildApp())
      .post(ISSUE)
      .set(SAME_ORIGIN)
      .send({ codeChallenge: challenge });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('answers 400 for a malformed challenge', async () => {
    const res = await issue(buildApp(), { codeChallenge: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('answers 400 when the sign-in has no iHub session token to hand over', async () => {
    const res = await request(buildApp())
      .post(ISSUE)
      .set('x-test-user', 'jane')
      .set(SAME_ORIGIN)
      .send({ codeChallenge: challenge });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('answers 400 for a session token that does not verify', async () => {
    const res = await signedIn(buildApp(), 'post', ISSUE, 'not-a-token')
      .set(SAME_ORIGIN)
      .send({ codeChallenge: challenge });
    expect(res.status).toBe(400);
  });
});

describe(`POST ${REDEEM}`, () => {
  /** The popup's half: a code for a challenge. */
  async function issueCode(app, verifier, token) {
    const res = await signedIn(app, 'post', ISSUE, token)
      .set(SAME_ORIGIN)
      .send({ codeChallenge: generateCodeChallenge(verifier) });
    expect(res.status).toBe(200);
    return res.body.code;
  }

  const redeem = (app, body) => request(app).post(REDEEM).set(SAME_ORIGIN).send(body);

  it('sets the framed session cookie and puts no token in the body', async () => {
    const app = buildApp();
    const verifier = generateCodeVerifier();
    const token = sessionToken({ expiresInSeconds: 1800 });
    const code = await issueCode(app, verifier, token);

    const res = await redeem(app, { code, codeVerifier: verifier });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const [cookie] = res.headers['set-cookie'];
    expect(cookie).toMatch(/^authTokenEmbed=/);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).toContain(`authTokenEmbed=${token};`);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)[1]);
    expect(maxAge).toBeGreaterThan(1700);
    expect(maxAge).toBeLessThanOrEqual(1800);
    expect(Object.keys(res.body)).toEqual(['expiresInSeconds']);
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('works once', async () => {
    const app = buildApp();
    const verifier = generateCodeVerifier();
    const code = await issueCode(app, verifier);

    expect((await redeem(app, { code, codeVerifier: verifier })).status).toBe(200);
    const replay = await redeem(app, { code, codeVerifier: verifier });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('EMBED_CODE_INVALID');
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a wrong verifier, and the code is gone afterwards', async () => {
    const app = buildApp();
    const verifier = generateCodeVerifier();
    const code = await issueCode(app, verifier);

    const wrong = await redeem(app, { code, codeVerifier: generateCodeVerifier() });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('EMBED_CODE_INVALID');
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const right = await redeem(app, { code, codeVerifier: verifier });
    expect(right.body.code).toBe('EMBED_CODE_INVALID');
  });

  it('refuses a code that was never issued', async () => {
    const res = await redeem(buildApp(), {
      code: generateCode(),
      codeVerifier: generateCodeVerifier()
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMBED_CODE_INVALID');
  });

  it('refuses an OAuth authorization code', async () => {
    const verifier = generateCodeVerifier();
    const code = generateCode();
    storeCode(code, {
      clientId: 'some-client',
      userId: 'jane',
      codeChallenge: generateCodeChallenge(verifier),
      codeChallengeMethod: 'S256'
    });
    const res = await redeem(buildApp(), { code, codeVerifier: verifier });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMBED_CODE_INVALID');
  });

  it('refuses a session that ended between the popup and the frame', async () => {
    const app = buildApp();
    const verifier = generateCodeVerifier();
    const code = generateCode();
    storeCode(code, {
      purpose: embedAuth.EMBED_CODE_PURPOSE,
      userId: 'jane',
      sessionToken: sessionToken({ expiresInSeconds: -30 }),
      codeChallenge: generateCodeChallenge(verifier)
    });
    const res = await redeem(app, { code, codeVerifier: verifier });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMBED_CODE_INVALID');
  });

  it('is refused for a request another site made, without using up the code', async () => {
    const app = buildApp();
    const verifier = generateCodeVerifier();
    const code = await issueCode(app, verifier);

    const forged = await request(app)
      .post(REDEEM)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ code, codeVerifier: verifier });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('FORBIDDEN');

    expect((await redeem(app, { code, codeVerifier: verifier })).status).toBe(200);
  });

  it('is refused while the feature is off', async () => {
    state.platform.embedAuth = {};
    const res = await redeem(buildApp(), {
      code: generateCode(),
      codeVerifier: generateCodeVerifier()
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMBED_SIGN_IN_DISABLED');
  });

  it('answers 400 for a missing code or a malformed verifier', async () => {
    const app = buildApp();
    expect((await redeem(app, { codeVerifier: generateCodeVerifier() })).status).toBe(400);
    expect((await redeem(app, { code: 'x.y', codeVerifier: 'short' })).status).toBe(400);
    expect((await redeem(app, undefined)).status).toBe(400);
  });
});

describe('rate limiting of the sign-in in a frame', () => {
  const challenge = generateCodeChallenge(generateCodeVerifier());
  // The cheapest answers of the three routes: a refusal that does no other work.
  const requests = [
    app => request(app).get('/embed-auth/complete?challenge=nope'),
    app => request(app).post(ISSUE).set(SAME_ORIGIN).send({ codeChallenge: challenge }),
    app => request(app).post(REDEEM).set(SAME_ORIGIN).send({})
  ];

  it('answers 429 once an address has used its budget, with the code RATE_LIMITED', async () => {
    const app = buildApp();
    for (let i = 0; i < 300; i++) await requests[i % 3](app);

    const res = await requests[0](app);

    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.details).toEqual({ limiter: 'embedAuth' });
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('counts the three routes against one budget', async () => {
    const app = buildApp();
    for (let i = 0; i < 300; i++) await requests[0](app);

    // The page used the whole budget; the two code endpoints are refused as well.
    expect((await requests[1](app)).status).toBe(429);
    expect((await requests[2](app)).status).toBe(429);
  });

  it('is not spent by a sign-in that is a few requests', async () => {
    const app = buildApp();
    for (let i = 0; i < 20; i++) await requests[i % 3](app);

    expect((await requests[0](app)).status).not.toBe(429);
  });
});
