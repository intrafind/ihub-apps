/**
 * Teams Auth Middleware Tests
 *
 * Verifies that Teams SSO login (silent middleware + token-exchange endpoint) routes
 * users through validateAndPersistExternalUser() like every other external provider,
 * so an administrator can disable a Teams user (see issue #1692).
 */

import { jest } from '@jest/globals';

const teamsConfig = {
  enabled: true,
  tenantId: 'test-tenant',
  clientId: 'test-client',
  domain: 'test-domain'
};

const mockPlatformConfig = {
  auth: { authenticatedGroup: 'authenticated' },
  teamsAuth: teamsConfig
};

const teamsIdTokenPayload = {
  oid: 'teams-user-oid',
  email: 'teamsuser@test.com',
  name: 'Teams User',
  tid: 'test-tenant'
};

const jwtMock = {
  decode: jest.fn(),
  verify: jest.fn()
};

jest.unstable_mockModule('jsonwebtoken', () => ({
  default: jwtMock
}));

jest.unstable_mockModule('jwks-rsa', () => ({
  default: jest.fn(() => ({
    getSigningKey: (kid, cb) => cb(null, { publicKey: 'test-public-key' })
  }))
}));

const configCacheMock = {
  getPlatform: jest.fn(() => mockPlatformConfig),
  getLocalizations: jest.fn(() => undefined)
};
jest.unstable_mockModule('../configCache.js', () => ({
  default: configCacheMock
}));

// Groups configuration lives under contents/, which isn't present in this
// checkout — stub the group-mapping helpers so the middleware under test
// doesn't hit disk.
jest.unstable_mockModule('../utils/authorization.js', () => ({
  mapExternalGroups: jest.fn(() => ['anonymous']),
  enhanceUserGroups: jest.fn(user => user)
}));

const validateAndPersistExternalUser = jest.fn();
jest.unstable_mockModule('../utils/userManager.js', () => ({
  validateAndPersistExternalUser
}));

const generateJwt = jest.fn(() => ({ token: 'signed-jwt', expiresIn: 3600 }));
jest.unstable_mockModule('../utils/tokenService.js', () => ({
  generateJwt
}));

jest.unstable_mockModule('../utils/cookieSettings.js', () => ({
  getAuthCookieOptions: jest.fn(() => ({}))
}));

const { teamsAuthMiddleware, teamsTokenExchange } = await import('../middleware/teamsAuth.js');

function createResMock() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    cookie: jest.fn().mockReturnThis()
  };
}

describe('Teams Auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configCacheMock.getPlatform.mockReturnValue(mockPlatformConfig);
    configCacheMock.getLocalizations.mockReturnValue(undefined);
    generateJwt.mockReturnValue({ token: 'signed-jwt', expiresIn: 3600 });

    // jwt.decode: the plain decode() call (isTeamsToken check) returns the raw
    // claims; the complete decode() inside verifyTeamsToken returns header+payload.
    jwtMock.decode.mockImplementation((token, options) => {
      if (options?.complete) {
        return {
          header: { kid: 'test-kid' },
          payload: teamsIdTokenPayload
        };
      }
      return { iss: 'https://login.microsoftonline.com/test-tenant/v2.0', ...teamsIdTokenPayload };
    });
    jwtMock.verify.mockReturnValue(teamsIdTokenPayload);
  });

  describe('teamsAuthMiddleware', () => {
    it('rejects with 403 when the persisted Teams user is disabled', async () => {
      validateAndPersistExternalUser.mockRejectedValue(
        new Error(
          'User account is disabled. User ID: teams-user-oid, Email: teamsuser@test.com. Please contact your administrator.'
        )
      );

      const req = { headers: { authorization: 'Bearer teams-sso-token' } };
      const res = createResMock();
      const next = jest.fn();

      await teamsAuthMiddleware(req, res, next);

      expect(validateAndPersistExternalUser).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'access_denied' }));
      expect(next).not.toHaveBeenCalled();
      expect(generateJwt).not.toHaveBeenCalled();
    });

    it('persists the user and issues a JWT for an active Teams user', async () => {
      const persistedUser = {
        id: 'persisted-teams-user',
        email: 'teamsuser@test.com',
        groups: ['authenticated'],
        provider: 'teams',
        teamsData: { tenantId: 'test-tenant' }
      };
      validateAndPersistExternalUser.mockResolvedValue(persistedUser);

      const req = { headers: { authorization: 'Bearer teams-sso-token' } };
      const res = createResMock();
      const next = jest.fn();

      await teamsAuthMiddleware(req, res, next);

      expect(validateAndPersistExternalUser).toHaveBeenCalled();
      expect(req.user).toBe(persistedUser);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('teamsTokenExchange', () => {
    it('returns 403 TEAMS_ACCOUNT_DISABLED when the persisted Teams user is disabled', async () => {
      validateAndPersistExternalUser.mockRejectedValue(
        new Error(
          'User account is disabled. User ID: teams-user-oid, Email: teamsuser@test.com. Please contact your administrator.'
        )
      );

      const req = { body: { ssoToken: 'teams-sso-token' }, headers: {} };
      const res = createResMock();

      await teamsTokenExchange(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorKey: 'TEAMS_ACCOUNT_DISABLED' })
      );
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('sets the auth cookie and returns the persisted user on success', async () => {
      const persistedUser = {
        id: 'persisted-teams-user',
        name: 'Teams User',
        email: 'teamsuser@test.com',
        groups: ['authenticated'],
        provider: 'teams',
        authMethod: 'teams',
        teamsData: { tenantId: 'test-tenant' }
      };
      validateAndPersistExternalUser.mockResolvedValue(persistedUser);

      const req = { body: { ssoToken: 'teams-sso-token' }, headers: {} };
      const res = createResMock();

      await teamsTokenExchange(req, res);

      expect(res.cookie).toHaveBeenCalledWith('authToken', 'signed-jwt', expect.any(Object));
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          user: expect.objectContaining({ id: 'persisted-teams-user' })
        })
      );
    });
  });
});
