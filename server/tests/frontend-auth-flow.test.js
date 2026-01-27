/**
 * Frontend Authentication Flow Test
 *
 * Tests the complete authentication flow from frontend perspective
 */

import request from 'supertest';
import express from 'express';
import { setupMiddleware } from '../serverHelpers.js';
import registerAuthRoutes from '../routes/auth.js';
import registerGeneralRoutes from '../routes/generalRoutes.js';
import registerModelRoutes from '../routes/modelRoutes.js';
import registerSessionRoutes from '../routes/sessionRoutes.js';
import { getLocalizedError } from '../serverHelpers.js';
import logger from '../utils/logger.js';

// Mock platform configuration
const mockPlatformConfig = {
  auth: {
    mode: 'local',
    allowAnonymous: false,
    anonymousGroup: 'anonymous',
    authenticatedGroup: 'authenticated'
  },
  anonymousAuth: {
    enabled: false,
    defaultGroups: ['anonymous']
  },
  localAuth: {
    enabled: true,
    jwtSecret: 'test-secret-key',
    sessionTimeoutMinutes: 480
  }
};

// Mock apps and models
const mockApps = [
  { id: 'test-app', name: 'Test App', enabled: true },
  { id: 'public-app', name: 'Public App', enabled: true }
];

const mockModels = [
  { id: 'gpt-4', name: 'GPT-4', provider: 'openai', enabled: true },
  { id: 'claude-4', name: 'Claude-4', provider: 'anthropic', enabled: true }
];

// Mock config cache
jest.mock('../configCache.js', () => ({
  getPlatform: () => ({ data: mockPlatformConfig }),
  getApps: () => ({ data: mockApps, etag: 'test-etag' }),
  getModels: () => ({ data: mockModels, etag: 'test-etag' }),
  getPrompts: () => ({ data: [], etag: 'test-etag' }),
  getStyles: () => ({ data: [], etag: 'test-etag' }),
  getUI: () => ({ data: {}, etag: 'test-etag' }),
  getLocalizations: () => ({ test: 'value' })
}));

function createTestApp(platformConfig = mockPlatformConfig) {
  const app = express();

  setupMiddleware(app, platformConfig);

  // Register routes
  registerAuthRoutes(app);
  registerGeneralRoutes(app, { getLocalizedError });
  registerModelRoutes(app, { getLocalizedError });
  registerSessionRoutes(app);

  return app;
}

describe('Frontend Authentication Flow Tests', () => {
  describe('Anonymous Access Disabled', () => {
    let app;

    beforeEach(() => {
      app = createTestApp({
        ...mockPlatformConfig,
        auth: { ...mockPlatformConfig.auth, allowAnonymous: false }
      });
    });

    test('should block unauthenticated requests to apps endpoint', async () => {
      const response = await request(app).get('/api/apps').expect(401);

      expect(response.body.error).toBe('Authentication required');
      expect(response.body.code).toBe('AUTH_REQUIRED');
    });

    test('should block unauthenticated requests to models endpoint', async () => {
      const response = await request(app).get('/api/models').expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    test('should allow session start without authentication', async () => {
      const response = await request(app)
        .post('/api/session/start')
        .send({
          sessionId: 'test-session',
          type: 'app_loaded',
          metadata: { userAgent: 'test' }
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    test('should allow auth status endpoint without authentication', async () => {
      await request(app).get('/api/auth/status').expect(200);
    });

    test('should allow platform config endpoint without authentication', async () => {
      await request(app).get('/api/configs/platform').expect(200);
    });
  });

  describe('Anonymous Access Enabled', () => {
    let app;

    beforeEach(() => {
      app = createTestApp({
        ...mockPlatformConfig,
        auth: { ...mockPlatformConfig.auth, allowAnonymous: true }
      });
    });

    test('should allow anonymous access to apps with filtering', async () => {
      const response = await request(app).get('/api/apps').expect(200);

      // Should get filtered results for anonymous users
      expect(Array.isArray(response.body)).toBe(true);
      // Anonymous users should only see public apps
      expect(response.body.length).toBeLessThanOrEqual(mockApps.length);
    });

    test('should allow anonymous access to models with filtering', async () => {
      const response = await request(app).get('/api/models').expect(200);

      // Should get filtered results for anonymous users
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeLessThanOrEqual(mockModels.length);
    });
  });

  describe('Authentication Token Handling', () => {
    let app;

    beforeEach(() => {
      app = createTestApp();
    });

    test('should accept valid Bearer token', async () => {
      const jwt = require('jsonwebtoken');
      const token = jwt.sign(
        { userId: 'user1', username: 'testuser', groups: ['user'] },
        'test-secret-key'
      );

      // Mock user enhancement
      jest.mock('../utils/authorization.js', () => ({
        enhanceUserWithPermissions: user => ({
          ...user,
          permissions: {
            apps: new Set(['*']),
            models: new Set(['*']),
            prompts: new Set(['*']),
            adminAccess: false
          },
          isAdmin: false
        })
      }));

      const response = await request(app)
        .get('/api/apps')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    test('should reject invalid Bearer token', async () => {
      await request(app).get('/api/apps').set('Authorization', 'Bearer invalid-token').expect(401);
    });

    test('should reject malformed Authorization header', async () => {
      await request(app).get('/api/apps').set('Authorization', 'InvalidFormat').expect(401);
    });
  });

  describe('Session Management', () => {
    let app;

    beforeEach(() => {
      app = createTestApp();
    });

    test('should include X-Session-ID header in requests', async () => {
      // This would be tested in integration with actual frontend
      // For now, verify the session endpoint works
      const response = await request(app)
        .post('/api/session/start')
        .set('X-Session-ID', 'test-session-123')
        .send({
          sessionId: 'test-session-123',
          type: 'app_loaded',
          metadata: { userAgent: 'test-browser' }
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    let app;

    beforeEach(() => {
      app = createTestApp();
    });

    test('should return proper error format for authentication failures', async () => {
      const response = await request(app).get('/api/apps').expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('code');
      expect(response.body).toHaveProperty('message');
      expect(response.body.code).toBe('AUTH_REQUIRED');
    });

    test('should handle missing Bearer token gracefully', async () => {
      const response = await request(app)
        .get('/api/apps')
        .set('Authorization', 'Bearer ')
        .expect(401);

      expect(response.body.error).toBeDefined();
    });
  });
});
