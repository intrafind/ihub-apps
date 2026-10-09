import { jest, describe, it, expect, beforeEach } from '@jest/globals';

/**
 * Characterization tests for the shared OAuth token lifecycle and API request
 * wrapper in OAuthIntegrationBase (`getUserTokens` and
 * `_makeApiRequestWithRetry`, the one method every Google Drive and Office 365
 * call goes through).
 *
 * The network (`httpFetch`) and the token store are faked, so the real request,
 * retry and refresh logic runs. A small subclass stands in for a provider.
 */

const httpFetch = jest.fn();
jest.unstable_mockModule('../utils/httpConfig.js', () => ({ httpFetch }));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../utils/logger.js', () => ({ default: logger }));

jest.unstable_mockModule('../configCache.js', () => ({ default: {} }));
jest.unstable_mockModule('../services/CredentialService.js', () => ({ default: {} }));

// In-memory stand-in for TokenStorageService: one token set per test.
const store = { tokens: null, expired: false, failure: null };
const tokenStorage = {
  getUserTokens: jest.fn(async () => {
    if (store.failure) throw store.failure;
    if (!store.tokens) throw new Error('User not authenticated with testdrive');
    return { ...store.tokens };
  }),
  areTokensExpired: jest.fn(async () => store.expired),
  storeUserTokens: jest.fn(async (_userId, _service, tokens) => {
    store.tokens = { ...tokens };
    store.expired = false;
  }),
  deleteUserTokens: jest.fn(async () => {
    const had = store.tokens !== null;
    store.tokens = null;
    return had;
  })
};
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({ default: tokenStorage }));

const { OAuthRefreshError, REFRESH_ERROR_CODES, isUnavailableError } =
  await import('../services/integrations/oauthRefreshError.js');
const { default: OAuthIntegrationBase } =
  await import('../services/integrations/OAuthIntegrationBase.js');

const BASE_URL = 'https://api.example.com/v1';
const USER = 'user-1';
const PROVIDER = 'prov-1';

class TestService extends OAuthIntegrationBase {
  constructor() {
    super({ serviceName: 'testdrive', displayName: 'Test Drive', componentName: 'TestDrive' });
    this.refreshAccessToken = jest.fn(async (providerId, refreshToken) => ({
      accessToken: 'refreshed-access',
      refreshToken,
      expiresIn: 3600,
      providerId
    }));
  }

  makeApiRequest(endpoint, method = 'GET', data = null, userId, providerId, retryCount = 0) {
    return this._makeApiRequestWithRetry(
      BASE_URL,
      endpoint,
      method,
      data,
      userId,
      providerId,
      retryCount
    );
  }
}

/** A provider that, like Office 365, always sends Content-Type. */
class AlwaysJsonService extends TestService {
  _buildApiRequestHeaders(tokens) {
    return {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };
  }
}

/** Minimal fetch Response stand-in. */
function response(status, body, { headers = {}, statusText = '', jsonThrows = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (jsonThrows) throw new Error('not json');
      return body;
    }
  };
}

const ok = body => response(200, body);
const apiError = (status, message, extra) => response(status, { error: { message } }, extra);

/** The last argument of every logger call at the given level. */
const logged = level => logger[level].mock.calls.map(([message]) => message);

/** Run a promise that is expected to reject and return the error. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

/** A refresh token the provider has rejected (`invalid_grant`). */
const rejectedGrant = () =>
  new OAuthRefreshError('Refresh token expired or invalid', REFRESH_ERROR_CODES.INVALID_GRANT);

/** Refresh failures that say nothing about the grant, so the tokens must stay. */
const temporaryRefreshFailures = [
  [
    'temporary (network, 5xx, 429)',
    () =>
      new OAuthRefreshError('Failed to refresh access token: boom', REFRESH_ERROR_CODES.TEMPORARY)
  ],
  [
    'invalid_client (expired client secret)',
    () => new OAuthRefreshError('Failed to refresh access token: Unauthorized', 'invalid_client')
  ],
  ['unknown error', () => new Error('something nobody classified')]
];

function expectUnavailable(error) {
  expect(error.message).toBe(
    'Test Drive is temporarily unavailable. Please try again in a moment.'
  );
  expect(error.message).not.toMatch(/reconnect/i);
  expect(isUnavailableError(error)).toBe(true);
}

let service;

beforeEach(() => {
  jest.clearAllMocks();
  httpFetch.mockReset();
  store.tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', providerId: PROVIDER };
  store.expired = false;
  store.failure = null;
  service = new TestService();
});

describe('_makeApiRequestWithRetry: building the request', () => {
  it('returns the parsed JSON body of a successful call', async () => {
    httpFetch.mockResolvedValueOnce(ok({ id: 42 }));

    const result = await service.makeApiRequest('/files', 'GET', null, USER, PROVIDER);

    expect(result).toEqual({ id: 42 });
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).toHaveBeenCalledWith(`${BASE_URL}/files`, {
      method: 'GET',
      headers: { Authorization: 'Bearer access-1', Accept: 'application/json' }
    });
  });

  it('returns null for a 204 response', async () => {
    httpFetch.mockResolvedValueOnce(response(204, undefined));

    expect(await service.makeApiRequest('/files/1', 'DELETE', null, USER, PROVIDER)).toBeNull();
  });

  it('passes an absolute endpoint through and prefixes a relative one', async () => {
    httpFetch.mockResolvedValue(ok({}));

    await service.makeApiRequest('https://other.example.com/me', 'GET', null, USER, PROVIDER);
    await service.makeApiRequest('/me', 'GET', null, USER, PROVIDER);

    expect(httpFetch.mock.calls[0][0]).toBe('https://other.example.com/me');
    expect(httpFetch.mock.calls[1][0]).toBe(`${BASE_URL}/me`);
  });

  it.each(['POST', 'PUT', 'PATCH'])('sends a JSON body and Content-Type for %s', async method => {
    httpFetch.mockResolvedValueOnce(ok({}));

    await service.makeApiRequest('/files', method, { name: 'a' }, USER, PROVIDER);

    expect(httpFetch).toHaveBeenCalledWith(`${BASE_URL}/files`, {
      method,
      headers: {
        Authorization: 'Bearer access-1',
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'a' })
    });
  });

  it('sends no body for GET or DELETE even when data is given', async () => {
    httpFetch.mockResolvedValue(ok({}));

    await service.makeApiRequest('/files', 'GET', { ignored: true }, USER, PROVIDER);
    await service.makeApiRequest('/files/1', 'DELETE', { ignored: true }, USER, PROVIDER);

    for (const [, options] of httpFetch.mock.calls) {
      expect(options.body).toBeUndefined();
      expect(options.headers['Content-Type']).toBeUndefined();
    }
  });

  it('sends no body for a write method without data', async () => {
    httpFetch.mockResolvedValueOnce(ok({}));

    await service.makeApiRequest('/files', 'POST', null, USER, PROVIDER);

    const [, options] = httpFetch.mock.calls[0];
    expect(options.body).toBeUndefined();
    expect(options.headers['Content-Type']).toBeUndefined();
  });

  it('respects a _buildApiRequestHeaders override', async () => {
    httpFetch.mockResolvedValueOnce(ok({}));

    await new AlwaysJsonService().makeApiRequest('/me', 'GET', null, USER, PROVIDER);

    const [, options] = httpFetch.mock.calls[0];
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.body).toBeUndefined();
  });
});

describe('_makeApiRequestWithRetry: 401 handling', () => {
  it('refreshes the tokens and retries exactly once, then succeeds', async () => {
    httpFetch
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(ok({ id: 'after-refresh' }));

    const result = await service.makeApiRequest('/files', 'GET', null, USER, PROVIDER);

    expect(result).toEqual({ id: 'after-refresh' });
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(service.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(service.refreshAccessToken).toHaveBeenCalledWith(PROVIDER, 'refresh-1');
    expect(tokenStorage.storeUserTokens).toHaveBeenCalledTimes(1);
    expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
    // The retry carries the refreshed access token.
    expect(httpFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer access-1');
    expect(httpFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer refreshed-access');
    expect(logged('info')).toContain('Received 401, attempting token refresh and retry');
  });

  it('refuses a 401 once the retry is used up, without refreshing again', async () => {
    httpFetch.mockResolvedValueOnce(response(401, {}));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER, 1));

    expect(error.message).toBe(
      'Test Drive authentication required. Please reconnect your account.'
    );
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(service.refreshAccessToken).not.toHaveBeenCalled();
    expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
  });

  it('reports a second 401 as authentication required and keeps the refreshed tokens', async () => {
    httpFetch.mockResolvedValue(response(401, {}));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe(
      'Test Drive authentication required. Please reconnect your account.'
    );
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(service.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
    expect(store.tokens.accessToken).toBe('refreshed-access');
  });

  // The retried request is not part of the refresh: whatever it fails with is
  // reported as itself, and the tokens that were just refreshed stay.
  it.each([
    ['a 404', () => apiError(404, 'File not found'), 'Test Drive API error: File not found'],
    ['a 500', () => apiError(500, 'Backend exploded'), 'Test Drive API error: Backend exploded'],
    [
      'a 429',
      () => response(429, {}),
      'Test Drive API rate limit exceeded. Please try again in a moment.'
    ]
  ])(
    'reports %s on the retried request as itself and keeps the tokens',
    async (_label, failed, message) => {
      httpFetch.mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(failed());

      const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

      expect(error.message).toBe(message);
      expect(httpFetch).toHaveBeenCalledTimes(2);
      expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
    }
  );

  it('reports a network failure on the retried request as itself and keeps the tokens', async () => {
    httpFetch
      .mockResolvedValueOnce(response(401, {}))
      .mockRejectedValueOnce(new Error('socket hang up'));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: socket hang up');
    expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
  });

  it('deletes the tokens and reports an expired session when there is no refresh token', async () => {
    store.tokens = { accessToken: 'access-1', providerId: PROVIDER };
    httpFetch.mockResolvedValueOnce(response(401, {}));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive authentication expired. Please reconnect your account.');
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(service.refreshAccessToken).not.toHaveBeenCalled();
    expect(tokenStorage.deleteUserTokens).toHaveBeenCalledWith(USER, 'testdrive', PROVIDER);
    expect(logged('error')).toContain('Forced token refresh failed');
  });

  it('deletes the tokens and reports an expired session when the refresh token is rejected', async () => {
    service.refreshAccessToken.mockRejectedValueOnce(rejectedGrant());
    httpFetch.mockResolvedValueOnce(response(401, {}));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive authentication expired. Please reconnect your account.');
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(tokenStorage.deleteUserTokens).toHaveBeenCalledWith(USER, 'testdrive', PROVIDER);
    expect(tokenStorage.storeUserTokens).not.toHaveBeenCalled();
    expect(logged('error')).toContain('Forced token refresh failed');
  });

  it.each(temporaryRefreshFailures)(
    'keeps the tokens and reports the service as unavailable when the refresh fails: %s',
    async (_label, makeFailure) => {
      service.refreshAccessToken.mockRejectedValueOnce(makeFailure());
      httpFetch.mockResolvedValueOnce(response(401, {}));

      const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

      expectUnavailable(error);
      expect(httpFetch).toHaveBeenCalledTimes(1);
      expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
      expect(store.tokens.refreshToken).toBe('refresh-1');
      expect(logged('error')).toContain('Forced token refresh failed');
    }
  );

  it('keeps the tokens when storing the refreshed ones fails', async () => {
    tokenStorage.storeUserTokens.mockRejectedValueOnce(new Error('disk full'));
    httpFetch.mockResolvedValueOnce(response(401, {}));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expectUnavailable(error);
    expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
  });
});

describe('_makeApiRequestWithRetry: error responses', () => {
  it('maps a 429 to a rate-limit error and logs the retry-after header', async () => {
    httpFetch.mockResolvedValueOnce(response(429, {}, { headers: { 'retry-after': '30' } }));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API rate limit exceeded. Please try again in a moment.');
    expect(logger.warn).toHaveBeenCalledWith('Rate limit exceeded', {
      component: 'TestDrive',
      retryAfter: '30',
      endpoint: '/files'
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs retry-after as "unknown" when the header is missing', async () => {
    httpFetch.mockResolvedValueOnce(response(429, {}));

    await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(logger.warn.mock.calls[0][1].retryAfter).toBe('unknown');
  });

  it('maps a 404 to an API error with a debug log and no error-level log', async () => {
    httpFetch.mockResolvedValueOnce(apiError(404, 'File not found'));

    const error = await rejection(service.makeApiRequest('/files/9', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: File not found');
    expect(logged('debug')).toContain('Test Drive API returned 404 (not found)');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls back to "Resource not found" for a 404 without a body message', async () => {
    httpFetch.mockResolvedValueOnce(response(404, {}, { jsonThrows: true }));

    const error = await rejection(service.makeApiRequest('/files/9', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: Resource not found');
  });

  it('maps other failures to an API error with the provider message and an error log', async () => {
    httpFetch.mockResolvedValueOnce(apiError(500, 'Backend exploded'));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: Backend exploded');
    expect(logger.error).toHaveBeenCalledWith('Test Drive API request failed', {
      component: 'TestDrive',
      error: { error: { message: 'Backend exploded' } }
    });
  });

  it('falls back to the status text when the error body has no message', async () => {
    httpFetch.mockResolvedValueOnce(
      response(503, {}, { statusText: 'Service Unavailable', jsonThrows: true })
    );

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: Service Unavailable');
    expect(logged('error')).toContain('Test Drive API request failed');
  });

  it('does not retry any status other than 401', async () => {
    httpFetch.mockResolvedValue(apiError(403, 'Forbidden'));

    await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(service.refreshAccessToken).not.toHaveBeenCalled();
  });
});

describe('_makeApiRequestWithRetry: wrapping thrown errors', () => {
  it('wraps a network failure as an API error and logs it', async () => {
    httpFetch.mockRejectedValueOnce(new Error('socket hang up'));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: socket hang up');
    expect(logger.error).toHaveBeenCalledWith('Test Drive API request failed', {
      component: 'TestDrive',
      error: expect.objectContaining({ message: 'socket hang up' })
    });
  });

  it('re-throws an error that already names the service, unwrapped and unlogged', async () => {
    httpFetch.mockRejectedValueOnce(new Error('Test Drive is having a moment'));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive is having a moment');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('re-throws an error that mentions authentication, unwrapped', async () => {
    httpFetch.mockRejectedValueOnce(new Error('bad authentication header'));

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('bad authentication header');
  });

  it('wraps a token store failure as an API error', async () => {
    store.failure = new Error('disk on fire');

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: Failed to retrieve user tokens');
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('wraps "not authenticated" too, since it names neither the service nor "authentication"', async () => {
    store.tokens = null;

    const error = await rejection(service.makeApiRequest('/files', 'GET', null, USER, PROVIDER));

    expect(error.message).toBe('Test Drive API error: User not authenticated with testdrive');
    expect(httpFetch).not.toHaveBeenCalled();
  });
});

describe('getUserTokens', () => {
  const expiredAt = () => {
    store.expired = true;
  };

  it('returns valid tokens without refreshing', async () => {
    const tokens = await service.getUserTokens(USER, PROVIDER);

    expect(tokens.accessToken).toBe('access-1');
    expect(service.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes expired tokens and stores the new ones', async () => {
    expiredAt();

    const tokens = await service.getUserTokens(USER, PROVIDER);

    expect(tokens.accessToken).toBe('refreshed-access');
    expect(service.refreshAccessToken).toHaveBeenCalledWith(PROVIDER, 'refresh-1');
    expect(store.tokens.accessToken).toBe('refreshed-access');
    expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
  });

  it('deletes the tokens and reports an expired session when there is no refresh token', async () => {
    store.tokens = { accessToken: 'access-1', providerId: PROVIDER };
    expiredAt();

    const error = await rejection(service.getUserTokens(USER, PROVIDER));

    expect(error.message).toBe('Test Drive authentication expired. Please reconnect your account.');
    expect(service.refreshAccessToken).not.toHaveBeenCalled();
    expect(tokenStorage.deleteUserTokens).toHaveBeenCalledWith(USER, 'testdrive', PROVIDER);
  });

  it('deletes the tokens and reports an expired session when the refresh token is rejected', async () => {
    service.refreshAccessToken.mockRejectedValueOnce(rejectedGrant());
    expiredAt();

    const error = await rejection(service.getUserTokens(USER, PROVIDER));

    expect(error.message).toBe('Test Drive authentication expired. Please reconnect your account.');
    expect(tokenStorage.deleteUserTokens).toHaveBeenCalledWith(USER, 'testdrive', PROVIDER);
    expect(logged('error')).toContain('Failed to refresh tokens for user');
  });

  it.each(temporaryRefreshFailures)(
    'keeps the tokens and reports the service as unavailable when the refresh fails: %s',
    async (_label, makeFailure) => {
      service.refreshAccessToken.mockRejectedValueOnce(makeFailure());
      expiredAt();

      const error = await rejection(service.getUserTokens(USER, PROVIDER));

      expectUnavailable(error);
      expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
      expect(store.tokens.refreshToken).toBe('refresh-1');
      expect(logged('error')).toContain('Failed to refresh tokens for user');
    }
  );

  it('keeps the tokens when storing the refreshed ones fails', async () => {
    tokenStorage.storeUserTokens.mockRejectedValueOnce(new Error('disk full'));
    expiredAt();

    const error = await rejection(service.getUserTokens(USER, PROVIDER));

    expectUnavailable(error);
    expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
  });

  it('wraps a store failure as "Failed to retrieve user tokens"', async () => {
    store.failure = new Error('disk on fire');

    const error = await rejection(service.getUserTokens(USER, PROVIDER));

    expect(error.message).toBe('Failed to retrieve user tokens');
  });

  it('passes "not authenticated" through when the user never connected', async () => {
    store.tokens = null;

    const error = await rejection(service.getUserTokens(USER, PROVIDER));

    expect(error.message).toBe('User not authenticated with testdrive');
  });
});
