/**
 * JWT User Validation Security Test Suite
 *
 * Tests to verify that JWT tokens are validated against the user database
 * to ensure disabled or deleted users cannot access the system with valid JWTs,
 * and that group/permission changes made via the admin UI are not frozen in an
 * already-issued token until it expires.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock JWT secret
const TEST_JWT_SECRET = 'test-jwt-secret-key-12345';

// Mock platform configuration
const mockPlatformConfig = {
  auth: {
    mode: 'local',
    jwtSecret: TEST_JWT_SECRET
  },
  // Tokens below are signed with jsonwebtoken's default (HS256) algorithm using a plain
  // shared secret; without this, getJwtAlgorithm() defaults to RS256 and verifyJwt()
  // rejects every token in this suite as a signature mismatch.
  jwt: {
    algorithm: 'HS256'
  },
  localAuth: {
    enabled: true,
    usersFile: 'contents/config/users-test.json',
    sessionTimeoutMinutes: 480
  },
  anonymousAuth: {
    enabled: false,
    defaultGroups: ['anonymous']
  }
};

// Create test users data
const mockTestUsersConfig = {
  users: {
    user_active_test: {
      id: 'user_active_test',
      username: 'activeuser',
      email: 'active@example.com',
      name: 'Active User',
      active: true,
      passwordHash: '$2b$12$testHash',
      internalGroups: ['users'],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    user_disabled_test: {
      id: 'user_disabled_test',
      username: 'disableduser',
      email: 'disabled@example.com',
      name: 'Disabled User',
      active: false, // User is disabled
      passwordHash: '$2b$12$testHash',
      internalGroups: ['users'],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    user_demoted_local_test: {
      id: 'user_demoted_local_test',
      username: 'demotedlocaluser',
      email: 'demotedlocal@example.com',
      name: 'Demoted Local User',
      active: true,
      passwordHash: '$2b$12$testHash',
      // Admin group has since been revoked in users.json, but a still-valid token
      // minted while the user was an admin carries the old `groups` claim.
      internalGroups: ['users'],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    user_demoted_oidc_test: {
      id: 'user_demoted_oidc_test',
      username: 'demotedoidcuser',
      email: 'demotedoidc@example.com',
      name: 'Demoted OIDC User',
      active: true,
      authMethods: ['oidc'],
      // 'admin' manual group has been revoked since the token was minted.
      internalGroups: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    },
    user_promoted_oidc_test: {
      id: 'user_promoted_oidc_test',
      username: 'promotedoidcuser',
      email: 'promotedoidc@example.com',
      name: 'Promoted OIDC User',
      active: true,
      authMethods: ['oidc'],
      // 'manager' manual group has been granted since the token was minted.
      internalGroups: ['manager'],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
  },
  metadata: {
    version: '2.0.0',
    lastUpdated: new Date().toISOString()
  }
};

// Mock configCache. Must use unstable_mockModule (not jest.mock) because this project's
// Jest config runs source files as native ESM (transform: {}), where plain jest.mock calls
// are not hoisted above the static imports that pull in the real module.
jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => mockPlatformConfig,
    get: key => {
      if (key === 'config/users.json' || key === 'config/users-test.json') {
        return { data: mockTestUsersConfig };
      }
      return null;
    },
    setCacheEntry: () => {},
    getApps: () => ({ data: [], etag: 'test' }),
    getModels: () => ({ data: [], etag: 'test' })
  }
}));

// Mock config
jest.unstable_mockModule('../config.js', () => ({
  __esModule: true,
  default: {
    JWT_SECRET: TEST_JWT_SECRET,
    PORT: 3000,
    CONTENTS_DIR: 'contents'
  }
}));

const { setupMiddleware } = await import('../middleware/setup.js');
const { default: registerAuthRoutes } = await import('../routes/auth.js');
const { default: jwtAuthMiddleware } = await import('../middleware/jwtAuth.js');
const { authRequired } = await import('../middleware/authRequired.js');

// enhanceUserWithPermissions (invoked by setupMiddleware on every authenticated
// request) calls loadGroupsConfiguration(), which reads contents/config/groups.json
// directly from disk rather than through configCache. Ensure a minimal fixture exists
// for the test process and tear it down afterwards. If the file already exists (full
// dev environment), leave it alone. Mirrors the pattern in ntlmAuth-domain.test.js.
const groupsConfigPath = path.join(__dirname, '../../contents/config/groups.json');
let createdGroupsFixture = false;
let createdContentsConfig = false;
let createdContents = false;

describe('JWT User Validation Security Tests', () => {
  let app;

  beforeAll(() => {
    const contentsConfigDir = path.dirname(groupsConfigPath);
    const contentsDir = path.dirname(contentsConfigDir);
    if (!fs.existsSync(contentsDir)) {
      fs.mkdirSync(contentsDir);
      createdContents = true;
    }
    if (!fs.existsSync(contentsConfigDir)) {
      fs.mkdirSync(contentsConfigDir);
      createdContentsConfig = true;
    }
    if (!fs.existsSync(groupsConfigPath)) {
      fs.writeFileSync(
        groupsConfigPath,
        JSON.stringify({
          groups: {
            anonymous: { id: 'anonymous', name: 'Anonymous', permissions: {} },
            authenticated: {
              id: 'authenticated',
              name: 'Authenticated',
              inherits: ['anonymous'],
              permissions: {}
            },
            users: { id: 'users', name: 'Users', inherits: ['authenticated'], permissions: {} },
            admin: {
              id: 'admin',
              name: 'Admin',
              inherits: ['users'],
              permissions: { adminAccess: true }
            },
            'oidc-default': {
              id: 'oidc-default',
              name: 'OIDC Default',
              inherits: ['authenticated'],
              permissions: {}
            },
            manager: {
              id: 'manager',
              name: 'Manager',
              inherits: ['authenticated'],
              permissions: {}
            }
          }
        })
      );
      createdGroupsFixture = true;
    }

    // Create test app
    app = express();
    app.set('platform', mockPlatformConfig);

    // Setup middleware
    setupMiddleware(app, '', mockPlatformConfig);

    // Add JWT auth middleware
    app.use(jwtAuthMiddleware);

    // Register auth routes
    registerAuthRoutes(app, '');

    // Add a protected test endpoint
    app.get('/api/test/protected', authRequired, (req, res) => {
      res.json({
        success: true,
        user: {
          id: req.user.id,
          name: req.user.name,
          groups: req.user.groups
        }
      });
    });
  });

  afterAll(() => {
    if (createdGroupsFixture) fs.rmSync(groupsConfigPath, { force: true });
    if (createdContentsConfig)
      fs.rmSync(path.dirname(groupsConfigPath), { force: true, recursive: true });
    if (createdContents)
      fs.rmSync(path.dirname(path.dirname(groupsConfigPath)), { force: true, recursive: true });
  });

  describe('Active User JWT Validation', () => {
    test('should allow access with valid JWT for active user', async () => {
      // Generate JWT for active user
      const token = jwt.sign(
        {
          sub: 'user_active_test',
          username: 'activeuser',
          name: 'Active User',
          email: 'active@example.com',
          groups: ['users'],
          authMode: 'local'
        },
        TEST_JWT_SECRET,
        {
          expiresIn: '7d',
          issuer: 'ihub-apps',
          audience: 'ihub-apps'
        }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.id).toBe('user_active_test');
    });
  });

  describe('Disabled User JWT Validation', () => {
    test('should reject JWT for disabled user', async () => {
      // Generate JWT for disabled user
      const token = jwt.sign(
        {
          sub: 'user_disabled_test',
          username: 'disableduser',
          name: 'Disabled User',
          email: 'disabled@example.com',
          groups: ['users'],
          authMode: 'local'
        },
        TEST_JWT_SECRET,
        {
          expiresIn: '7d',
          issuer: 'ihub-apps',
          audience: 'ihub-apps'
        }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('access_denied');
      expect(response.body.error_description).toBe('User account has been disabled');
    });
  });

  describe('Deleted User JWT Validation', () => {
    test('should reject JWT for deleted user', async () => {
      // Generate JWT for a user that doesn't exist in the database
      const token = jwt.sign(
        {
          sub: 'user_deleted_test',
          username: 'deleteduser',
          name: 'Deleted User',
          email: 'deleted@example.com',
          groups: ['users'],
          authMode: 'local'
        },
        TEST_JWT_SECRET,
        {
          expiresIn: '7d',
          issuer: 'ihub-apps',
          audience: 'ihub-apps'
        }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid_token');
      expect(response.body.error_description).toBe('User account no longer exists');
    });
  });

  describe('Local Auth Disabled', () => {
    test('should reject local JWT when local auth is disabled', async () => {
      // Temporarily modify platform config
      const originalLocalAuth = mockPlatformConfig.localAuth;
      mockPlatformConfig.localAuth = { enabled: false };

      // Generate JWT for active user
      const token = jwt.sign(
        {
          sub: 'user_active_test',
          username: 'activeuser',
          name: 'Active User',
          email: 'active@example.com',
          groups: ['users'],
          authMode: 'local'
        },
        TEST_JWT_SECRET,
        {
          expiresIn: '7d',
          issuer: 'ihub-apps',
          audience: 'ihub-apps'
        }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid_token');
      expect(response.body.error_description).toBe('Local authentication is not enabled');

      // Restore original config
      mockPlatformConfig.localAuth = originalLocalAuth;
    });
  });

  describe('Cookie-based JWT Validation', () => {
    test('should reject disabled user JWT from cookie', async () => {
      // Generate JWT for disabled user
      const token = jwt.sign(
        {
          sub: 'user_disabled_test',
          username: 'disableduser',
          name: 'Disabled User',
          email: 'disabled@example.com',
          groups: ['users'],
          authMode: 'local'
        },
        TEST_JWT_SECRET,
        {
          expiresIn: '7d',
          issuer: 'ihub-apps',
          audience: 'ihub-apps'
        }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Cookie', [`authToken=${token}`]);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('access_denied');
      expect(response.body.error_description).toBe('User account has been disabled');
    });
  });

  describe('Group revocation is not frozen in the JWT', () => {
    test('local: a still-valid token minted before a group demotion loses the revoked group immediately', async () => {
      // Token was minted while the user was in the 'admin' group.
      const token = jwt.sign(
        {
          sub: 'user_demoted_local_test',
          username: 'demotedlocaluser',
          name: 'Demoted Local User',
          email: 'demotedlocal@example.com',
          groups: ['users', 'admin', 'authenticated'],
          authMode: 'local'
        },
        TEST_JWT_SECRET,
        { expiresIn: '7d', issuer: 'ihub-apps', audience: 'ihub-apps' }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      // users.json now only lists 'users' as an internal group for this user —
      // groups must be re-derived from that, not trusted from the stale token.
      expect(response.body.user.groups).toEqual(expect.arrayContaining(['users', 'authenticated']));
      expect(response.body.user.groups).not.toContain('admin');
    });

    test('oidc: revoking a manually-assigned group takes effect before the token expires', async () => {
      // Token minted while 'admin' was a manually-assigned internal group. The
      // internalGroups claim records that snapshot so it can be diffed later.
      const token = jwt.sign(
        {
          sub: 'user_demoted_oidc_test',
          username: 'demotedoidcuser',
          name: 'Demoted OIDC User',
          email: 'demotedoidc@example.com',
          groups: ['authenticated', 'oidc-default', 'admin'],
          internalGroups: ['admin'],
          authMode: 'oidc'
        },
        TEST_JWT_SECRET,
        { expiresIn: '7d', issuer: 'ihub-apps', audience: 'ihub-apps' }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      // 'admin' was removed from users.json since mint time, so it must be gone,
      // while the externally-mapped groups from the token are left untouched.
      expect(response.body.user.groups).toEqual(
        expect.arrayContaining(['authenticated', 'oidc-default'])
      );
      expect(response.body.user.groups).not.toContain('admin');
    });

    test('oidc: granting a new manually-assigned group takes effect before the token expires', async () => {
      // Token minted before the 'manager' internal group was granted.
      const token = jwt.sign(
        {
          sub: 'user_promoted_oidc_test',
          username: 'promotedoidcuser',
          name: 'Promoted OIDC User',
          email: 'promotedoidc@example.com',
          groups: ['authenticated', 'oidc-default'],
          internalGroups: [],
          authMode: 'oidc'
        },
        TEST_JWT_SECRET,
        { expiresIn: '7d', issuer: 'ihub-apps', audience: 'ihub-apps' }
      );

      const response = await request(app)
        .get('/api/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.user.groups).toEqual(
        expect.arrayContaining(['authenticated', 'oidc-default', 'manager'])
      );
    });
  });
});
