// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Office add-in and the browser extension send tokens to the iHub address
 * from their runtime configuration. That address must be an absolute http(s)
 * URL, and only well-formed tokens are written to localStorage.
 */

jest.mock('../../../client/src/features/office/utilities/officeRemote', () => ({
  getOfficeRemote: () => null
}));

import {
  OFFICE_REFRESH_TOKEN_KEY,
  OFFICE_TOKEN_KEY,
  exchangeAuthCodeForToken,
  fetchUserInfo,
  getAuthorizeUrl,
  getTokenUrl,
  storeTokenResponse
} from '../../../client/src/features/office/api/officeAuth';

const config = {
  baseUrl: 'https://ihub.example.com/ihub/',
  clientId: 'office-client',
  redirectUri: 'https://ihub.example.com/ihub/office/callback'
};

describe('officeAuth endpoints', () => {
  afterEach(() => {
    delete global.fetch;
  });

  it('builds the token and authorize URLs below the normalised base URL', () => {
    expect(getTokenUrl(config)).toBe('https://ihub.example.com/ihub/api/oauth/token');
    const authorize = new URL(getAuthorizeUrl(config, { codeChallenge: 'c', state: 's' }));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://ihub.example.com/ihub/api/oauth/authorize'
    );
    expect(authorize.searchParams.get('client_id')).toBe('office-client');
    expect(authorize.searchParams.get('state')).toBe('s');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/plain,x',
    'chrome-extension://abc',
    '/api',
    'https://user:pw@ihub.example.com',
    '',
    undefined
  ])('refuses to build an endpoint for the base URL %p', baseUrl => {
    const bad = { ...config, baseUrl };
    expect(() => getTokenUrl(bad)).toThrow('not a valid http(s) URL');
    expect(() => getAuthorizeUrl(bad, { codeChallenge: 'c', state: 's' })).toThrow(
      'not a valid http(s) URL'
    );
  });

  it('does not send a request when the base URL is not http(s)', async () => {
    global.fetch = jest.fn();
    await expect(
      exchangeAuthCodeForToken(
        { ...config, baseUrl: 'javascript:alert(1)' },
        { code: 'c', codeVerifier: 'v' }
      )
    ).rejects.toThrow('not a valid http(s) URL');
    await expect(fetchUserInfo({ ...config, baseUrl: 'data:text/plain,x' })).rejects.toThrow(
      'not a valid http(s) URL'
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requests the token endpoint of a valid base URL', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 't' }) });
    await exchangeAuthCodeForToken(config, { code: 'c', codeVerifier: 'v' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://ihub.example.com/ihub/api/oauth/token',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('storeTokenResponse', () => {
  beforeEach(() => localStorage.clear());

  it('stores access and refresh tokens in either response shape', () => {
    storeTokenResponse({ access_token: 'eyJhbGciOi.payload.sig-_', refresh_token: 'abc123' });
    expect(localStorage.getItem(OFFICE_TOKEN_KEY)).toBe('eyJhbGciOi.payload.sig-_');
    expect(localStorage.getItem(OFFICE_REFRESH_TOKEN_KEY)).toBe('abc123');

    localStorage.clear();
    storeTokenResponse({ token: 'tok', refreshToken: 'ref' });
    expect(localStorage.getItem(OFFICE_TOKEN_KEY)).toBe('tok');
    expect(localStorage.getItem(OFFICE_REFRESH_TOKEN_KEY)).toBe('ref');
  });

  it.each([
    [{ access_token: { nested: true } }],
    [{ access_token: ['a'] }],
    [{ access_token: 'has space' }],
    [{ access_token: 'new\nline' }],
    [{ access_token: '<script>alert(1)</script> x' }],
    [{ access_token: 'x'.repeat(9000) }],
    [{ access_token: 12345 }],
    [{ access_token: '' }],
    [{}],
    [null]
  ])('does not store an unusable access token from %p', data => {
    storeTokenResponse(data);
    expect(localStorage.getItem(OFFICE_TOKEN_KEY)).toBeNull();
  });

  it('does not store a malformed refresh token but keeps a valid access token', () => {
    storeTokenResponse({ access_token: 'good', refresh_token: 'bad token' });
    expect(localStorage.getItem(OFFICE_TOKEN_KEY)).toBe('good');
    expect(localStorage.getItem(OFFICE_REFRESH_TOKEN_KEY)).toBeNull();
  });
});
