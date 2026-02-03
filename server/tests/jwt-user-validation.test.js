/**
 * JWT User Validation Security Test Suite
 *
 * Tests to verify that JWT tokens are validated against the user database
 * to ensure disabled or deleted users cannot access the system with valid JWTs.
 */

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { setupMiddleware } from '../middleware/setup.js';
import registerAuthRoutes from '../routes/auth.js';
import jwtAuthMiddleware from '../middleware/jwtAuth.js';
import { authRequired } from '../middleware/authRequired.js';

// Mock JWT secret
const TEST_JWT_SECRET = 'test-jwt-secret-key-12345';

// Mock platform configuration
const mockPlatformConfig = {
  auth: {
    mode: 'local',
    jwtSecret: TEST_JWT_SECRET
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
    }
  },
  metadata: {
    version: '2.0.0',
    lastUpdated: new Date().toISOString()
  }
};

// Mock configCache
jest.mock('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => mockPlatformConfig,
    get: key => {
      if (key === 'config/users.json' || key === 'config/users-test.json') {
        return mockTestUsersConfig;
      }
      return null;
    },
    setCacheEntry: () => {},
    getApps: () => ({ data: [], etag: 'test' }),
    getModels: () => ({ data: [], etag: 'test' })
  }
}));

// Mock config
jest.mock('../config.js', () => ({
  __esModule: true,
  default: {
    JWT_SECRET: TEST_JWT_SECRET,
    PORT: 3000
  }
}));

describe('JWT User Validation Security Tests', () => {
  let app;

  beforeAll(() => {
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
          name: req.user.name
        }
      });
    });
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
          issuer: 'ihub-apps'
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
          issuer: 'ihub-apps'
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
          issuer: 'ihub-apps'
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
          issuer: 'ihub-apps'
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
          issuer: 'ihub-apps'
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
});
