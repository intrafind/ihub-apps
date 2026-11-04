// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * #3238: the one JWT signer (`signAppJwt`) and the one session-cookie setter
 * (`setAuthCookie`). Every token the app issues (session, OAuth client, static
 * and personal API key) and every sign-in path's cookie goes through them.
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const { default: configCache } = await import('../configCache.js');
const { default: tokenStorage } = await import('../services/TokenStorageService.js');
const { signAppJwt, generateJwt, verifyJwt } = await import('../utils/tokenService.js');
const { generateOAuthToken, generateStaticApiKey, generatePersonalApiKey } =
  await import('../utils/oauthTokenService.js');
const { setAuthCookie } = await import('../utils/cookieSettings.js');

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256-signing';
const saved = new Map();
let platform;

beforeAll(() => {
  saved.set('config/platform.json', configCache.cache.get('config/platform.json'));
});
afterAll(() => {
  const prev = saved.get('config/platform.json');
  if (prev === undefined) configCache.cache.delete('config/platform.json');
  else configCache.cache.set('config/platform.json', prev);
});
beforeEach(() => {
  platform = {
    jwt: { algorithm: 'HS256' },
    auth: { sessionTimeoutMinutes: 60, jwtSecret: SECRET }
  };
  configCache.cache.set('config/platform.json', { data: platform });
});

describe('signAppJwt', () => {
  it('signs with the configured algorithm, issuer ihub-apps and the default audience', () => {
    const token = signAppJwt({ sub: 'u1' }, { expiresInSeconds: 120 });
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'], audience: 'ihub-apps' });
    expect(decoded.sub).toBe('u1');
    expect(decoded.iss).toBe('ihub-apps');
    expect(decoded.exp - decoded.iat).toBe(120);
  });

  it('takes a custom audience', () => {
    const token = signAppJwt({ sub: 'u1' }, { expiresInSeconds: 60, audience: 'other' });
    expect(jwt.decode(token).aud).toBe('other');
  });

  it('names the caller when no signing key is configured', () => {
    platform.jwt.algorithm = 'RS256';
    const spy = jest.spyOn(tokenStorage, 'getRSAPrivateKey').mockReturnValue(null);
    expect(() =>
      signAppJwt({ sub: 'u' }, { expiresInSeconds: 1, purpose: 'ldap authentication' })
    ).toThrow('JWT signing key not configured for ldap authentication with RS256');
    spy.mockRestore();
  });
});

describe('every issued token goes through it', () => {
  it('session token: issuer, audience override, lifetime from the platform timeout', () => {
    const { token, expiresIn } = generateJwt(
      { id: 'u1', groups: ['users'] },
      { authMode: 'local', additionalClaims: { aud: 'custom-aud' } }
    );
    expect(expiresIn).toBe(3600);
    const decoded = jwt.decode(token);
    expect(decoded.iss).toBe('ihub-apps');
    expect(decoded.aud).toBe('custom-aud');
    expect(verifyJwt(token, { audience: 'custom-aud' })?.sub).toBe('u1');
  });

  it('missing key keeps the per-mode error message of the session token', () => {
    platform.jwt.algorithm = 'RS256';
    const spy = jest.spyOn(tokenStorage, 'getRSAPrivateKey').mockReturnValue(null);
    expect(() => generateJwt({ id: 'u1' }, { authMode: 'ntlm' })).toThrow(
      'JWT signing key not configured for ntlm authentication with RS256'
    );
    expect(() => generateOAuthToken({ clientId: 'c', name: 'C', scopes: [] })).toThrow(
      'JWT signing key not configured for OAuth authentication with RS256'
    );
    expect(() => generateStaticApiKey({ clientId: 'c', name: 'C', scopes: [] }, 1)).toThrow(
      'JWT signing key not configured for API key generation with RS256'
    );
    spy.mockRestore();
  });

  it('OAuth client token, static key and personal key: issuer + audience ihub-apps', () => {
    const client = {
      clientId: 'c1',
      name: 'C',
      scopes: ['chat'],
      ownerUserId: 'u1',
      personal: true
    };
    const oauth = generateOAuthToken({ ...client, personal: false });
    const staticKey = generateStaticApiKey({ ...client, personal: false }, 1);
    const personal = generatePersonalApiKey(client, 1);
    for (const token of [oauth.access_token, staticKey.api_key, personal.api_key]) {
      const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'], audience: 'ihub-apps' });
      expect(decoded.iss).toBe('ihub-apps');
    }
  });
});

describe('setAuthCookie', () => {
  const makeRes = () => ({ cookie: jest.fn() });
  const makeReq = headers => ({ get: name => headers[name.toLowerCase()], protocol: 'http' });

  it('sets the authToken cookie httpOnly, lax, with the token lifetime', () => {
    const res = makeRes();
    setAuthCookie(makeReq({}), res, 'tok', 3600);
    expect(res.cookie).toHaveBeenCalledWith(
      'authToken',
      'tok',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 3600000 })
    );
  });

  it('derives Secure from the request: https behind a proxy is Secure, plain http is not', () => {
    const https = makeRes();
    setAuthCookie(makeReq({ 'x-forwarded-proto': 'https' }), https, 't', 60);
    expect(https.cookie.mock.calls[0][2].secure).toBe(true);
    const http = makeRes();
    setAuthCookie(makeReq({}), http, 't', 60);
    expect(http.cookie.mock.calls[0][2].secure).toBe(false);
  });
});
