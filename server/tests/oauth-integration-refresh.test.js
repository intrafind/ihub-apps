import { jest, describe, it, expect, beforeEach } from '@jest/globals';

/**
 * What a failed token refresh does to a user's stored tokens, for the real
 * Google Drive, Office 365 and Nextcloud services.
 *
 * The tokens are deleted only when the refresh token is rejected (`invalid_grant`)
 * or missing, so the user has to reconnect. A network error, a 5xx, a 429, an
 * expired client secret or a provider config problem keeps them and reads as
 * "temporarily unavailable". Both refresh paths are covered: the expiry path
 * (getUserTokens) and the 401-retry path (the shared API request wrapper;
 * Nextcloud has none).
 *
 * Only the network, the token store and the platform config are faked.
 */

const httpFetch = jest.fn();
jest.unstable_mockModule('../utils/httpConfig.js', () => ({ httpFetch }));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../utils/logger.js', () => ({ default: logger }));

const platformConfig = {
  cloudStorage: {
    enabled: true,
    providers: [
      { id: 'g1', type: 'googledrive', clientId: 'cid', clientSecretRef: 'sec' },
      { id: 'o1', type: 'office365', clientId: 'cid', tenantIdRef: 'ten', clientSecretRef: 'sec' },
      {
        id: 'n1',
        type: 'nextcloud',
        serverUrl: 'https://nc.example.com/',
        clientId: 'cid',
        clientSecretRef: 'sec'
      }
    ]
  }
};
jest.unstable_mockModule('../configCache.js', () => ({
  default: { get: () => undefined, getPlatform: () => platformConfig }
}));
jest.unstable_mockModule('../services/CredentialService.js', () => ({
  default: { resolveSecret: ref => `resolved-${ref}` }
}));

// In-memory stand-in for TokenStorageService: one token set per test.
const store = { tokens: null, expired: false };
const tokenStorage = {
  getUserTokens: jest.fn(async () => {
    if (!store.tokens) throw new Error('User not authenticated with this service');
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

const { default: GoogleDriveService } =
  await import('../services/integrations/GoogleDriveService.js');
const { default: Office365Service } = await import('../services/integrations/Office365Service.js');
const { default: NextcloudService } = await import('../services/integrations/NextcloudService.js');
const { OAuthRefreshError, REFRESH_ERROR_CODES, isUnavailableError } =
  await import('../services/integrations/oauthRefreshError.js');

const USER = 'user-1';

const providers = [
  {
    name: 'Google Drive',
    service: GoogleDriveService,
    providerId: 'g1',
    hasRetryWrapper: true,
    callApi: () => GoogleDriveService.makeApiRequest('/files', 'GET', null, USER, 'g1')
  },
  {
    name: 'Office 365',
    service: Office365Service,
    providerId: 'o1',
    hasRetryWrapper: true,
    callApi: () => Office365Service.makeApiRequest('/me', 'GET', null, USER, 'o1')
  },
  {
    name: 'Nextcloud',
    service: NextcloudService,
    providerId: 'n1',
    hasRetryWrapper: false
  }
];

/** Minimal fetch Response stand-in. */
function response(status, body, { statusText = '', jsonThrows = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: () => null },
    json: async () => {
      if (jsonThrows) throw new Error('not json');
      return body;
    }
  };
}

const isTokenEndpoint = url => new URL(url).pathname.endsWith('/token');

/** Route fetches: the token endpoint answers with `tokenAnswer`, the API with `apiAnswer`. */
function fakeNetwork({ tokenAnswer, apiAnswer }) {
  httpFetch.mockImplementation(async url => {
    const answer = isTokenEndpoint(url) ? tokenAnswer : apiAnswer;
    return typeof answer === 'function' ? answer() : answer;
  });
}

const goodToken = () =>
  response(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });

// How the token endpoint can fail, and what that means for the stored tokens.
const rejectedGrant = [
  'the refresh token is rejected (invalid_grant)',
  () => response(400, { error: 'invalid_grant' })
];
const temporaryFailures = [
  ['a network error', () => Promise.reject(new Error('socket hang up'))],
  ['a 500', () => response(500, {}, { statusText: 'Internal Server Error', jsonThrows: true })],
  [
    'a 503 error page',
    () => response(503, {}, { statusText: 'Service Unavailable', jsonThrows: true })
  ],
  ['a 429', () => response(429, {}, { statusText: 'Too Many Requests', jsonThrows: true })],
  ['an expired client secret (invalid_client)', () => response(401, { error: 'invalid_client' })],
  [
    'another provider error (invalid_request)',
    () => response(400, { error: 'invalid_request', error_description: 'Bad request' })
  ]
];

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

const expectExpired = (error, name) => {
  expect(error.message).toBe(`${name} authentication expired. Please reconnect your account.`);
};

const expectUnavailable = (error, name) => {
  expect(error.message).toBe(`${name} is temporarily unavailable. Please try again in a moment.`);
  expect(error.message).not.toMatch(/reconnect/i);
  expect(isUnavailableError(error)).toBe(true);
};

beforeEach(() => {
  jest.clearAllMocks();
  httpFetch.mockReset();
  store.expired = false;
});

describe.each(providers)('$name', ({ name, service, providerId, hasRetryWrapper, callApi }) => {
  const seedTokens = (overrides = {}) => {
    store.tokens = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      providerId,
      ...overrides
    };
  };

  beforeEach(() => seedTokens());

  describe('refreshAccessToken', () => {
    it('returns the new tokens, keeping the old refresh token when none is issued', async () => {
      fakeNetwork({ tokenAnswer: response(200, { access_token: 'a2', expires_in: 60 }) });

      const tokens = await service.refreshAccessToken(providerId, 'old-refresh');

      expect(tokens).toMatchObject({ accessToken: 'a2', refreshToken: 'old-refresh', providerId });
    });

    it('types a rejected refresh token as invalid_grant', async () => {
      fakeNetwork({ tokenAnswer: response(400, { error: 'invalid_grant' }) });

      const error = await rejection(service.refreshAccessToken(providerId, 'old-refresh'));

      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect(error.code).toBe(REFRESH_ERROR_CODES.INVALID_GRANT);
      expect(error.message).toBe('Refresh token expired or invalid - user needs to reconnect');
    });

    it('keeps the provider error code of other failed responses', async () => {
      fakeNetwork({
        tokenAnswer: response(401, { error: 'invalid_client' }, { statusText: 'Unauthorized' })
      });

      const error = await rejection(service.refreshAccessToken(providerId, 'old-refresh'));

      expect(error.code).toBe('invalid_client');
      expect(error.message).toBe('Failed to refresh access token: Unauthorized');
    });

    it('keeps the description of a 400 that is not invalid_grant', async () => {
      fakeNetwork({
        tokenAnswer: response(400, {
          error: 'invalid_scope',
          error_description: 'Scope not allowed'
        })
      });

      const error = await rejection(service.refreshAccessToken(providerId, 'old-refresh'));

      expect(error.code).toBe('invalid_scope');
      expect(error.message).toBe('Token refresh failed: Scope not allowed');
    });

    it.each([
      ['a 5xx', () => response(502, {}, { statusText: 'Bad Gateway', jsonThrows: true })],
      ['a 429', () => response(429, {}, { statusText: 'Too Many Requests', jsonThrows: true })]
    ])('types %s without a provider error as temporary', async (_label, failed) => {
      fakeNetwork({ tokenAnswer: failed });

      const error = await rejection(service.refreshAccessToken(providerId, 'old-refresh'));

      expect(error.code).toBe(REFRESH_ERROR_CODES.TEMPORARY);
      expect(error.message).toMatch(/^Failed to refresh access token: /);
    });

    it('types a network error as temporary and keeps it as the cause', async () => {
      const networkError = new Error('socket hang up');
      fakeNetwork({ tokenAnswer: () => Promise.reject(networkError) });

      const error = await rejection(service.refreshAccessToken(providerId, 'old-refresh'));

      expect(error.code).toBe(REFRESH_ERROR_CODES.TEMPORARY);
      expect(error.message).toBe('Failed to refresh access token: socket hang up');
      expect(error.cause).toBe(networkError);
    });

    it('types a provider config problem as temporary', async () => {
      const error = await rejection(service.refreshAccessToken('removed-provider', 'old-refresh'));

      expect(error.code).toBe(REFRESH_ERROR_CODES.TEMPORARY);
      expect(error.message).toContain("provider 'removed-provider' not found or not enabled");
      expect(httpFetch).not.toHaveBeenCalled();
    });
  });

  describe('expiry path (getUserTokens)', () => {
    beforeEach(() => {
      store.expired = true;
    });

    it('refreshes expired tokens and stores the new ones', async () => {
      fakeNetwork({ tokenAnswer: goodToken });

      const tokens = await service.getUserTokens(USER, providerId);

      expect(tokens.accessToken).toBe('new-access');
      expect(store.tokens.refreshToken).toBe('new-refresh');
      expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
    });

    it(`deletes the tokens when ${rejectedGrant[0]}`, async () => {
      fakeNetwork({ tokenAnswer: rejectedGrant[1] });

      const error = await rejection(service.getUserTokens(USER, providerId));

      expectExpired(error, name);
      expect(tokenStorage.deleteUserTokens).toHaveBeenCalledWith(
        USER,
        expect.any(String),
        providerId
      );
      expect(store.tokens).toBeNull();
    });

    it('deletes the tokens when there is no refresh token', async () => {
      seedTokens({ refreshToken: undefined });

      const error = await rejection(service.getUserTokens(USER, providerId));

      expectExpired(error, name);
      expect(tokenStorage.deleteUserTokens).toHaveBeenCalledTimes(1);
      expect(httpFetch).not.toHaveBeenCalled();
    });

    it.each(temporaryFailures)(
      'keeps the tokens and still throws on %s',
      async (_label, failed) => {
        fakeNetwork({ tokenAnswer: failed });

        const error = await rejection(service.getUserTokens(USER, providerId));

        expectUnavailable(error, name);
        expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
        expect(store.tokens.refreshToken).toBe('old-refresh');
      }
    );

    it('keeps the tokens when the provider is no longer configured', async () => {
      seedTokens({ providerId: 'removed-provider' });

      const error = await rejection(service.getUserTokens(USER, 'removed-provider'));

      expectUnavailable(error, name);
      expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
    });

    it('lets isUserAuthenticated report a temporary failure instead of "not connected"', async () => {
      fakeNetwork({ tokenAnswer: temporaryFailures[1][1] });

      const error = await rejection(service.isUserAuthenticated(USER, providerId));

      expectUnavailable(error, name);
    });

    it('reports a rejected refresh token as not connected from isUserAuthenticated', async () => {
      fakeNetwork({ tokenAnswer: rejectedGrant[1] });

      expect(await service.isUserAuthenticated(USER, providerId)).toBe(false);
    });
  });

  if (hasRetryWrapper) {
    describe('401-retry path (makeApiRequest)', () => {
      const unauthorized = () => response(401, {});

      it('refreshes after a 401 and retries once', async () => {
        let apiCalls = 0;
        fakeNetwork({
          tokenAnswer: goodToken,
          apiAnswer: () => (++apiCalls === 1 ? unauthorized() : response(200, { ok: true }))
        });

        expect(await callApi()).toEqual({ ok: true });
        expect(apiCalls).toBe(2);
        expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
      });

      it(`deletes the tokens when ${rejectedGrant[0]}`, async () => {
        fakeNetwork({ tokenAnswer: rejectedGrant[1], apiAnswer: unauthorized });

        const error = await rejection(callApi());

        expectExpired(error, name);
        expect(store.tokens).toBeNull();
      });

      it('deletes the tokens when there is no refresh token', async () => {
        seedTokens({ refreshToken: undefined });
        fakeNetwork({ apiAnswer: unauthorized });

        const error = await rejection(callApi());

        expectExpired(error, name);
        expect(store.tokens).toBeNull();
      });

      it.each(temporaryFailures)(
        'keeps the tokens and still throws on %s',
        async (_label, failed) => {
          fakeNetwork({ tokenAnswer: failed, apiAnswer: unauthorized });

          const error = await rejection(callApi());

          expectUnavailable(error, name);
          expect(tokenStorage.deleteUserTokens).not.toHaveBeenCalled();
          expect(store.tokens.refreshToken).toBe('old-refresh');
        }
      );

      it('lets isUserAuthenticated report a temporary failure instead of "not connected"', async () => {
        fakeNetwork({ tokenAnswer: temporaryFailures[1][1], apiAnswer: unauthorized });

        const error = await rejection(service.isUserAuthenticated(USER, providerId));

        expectUnavailable(error, name);
      });
    });
  }
});
