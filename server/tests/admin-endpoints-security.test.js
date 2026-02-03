/**
 * Admin Endpoints Security Test Suite
 *
 * Comprehensive security tests for all /admin/* endpoints to ensure
 * proper authentication and authorization is enforced.
 *
 * This test suite prevents regression of security vulnerabilities like:
 * - Unauthenticated access to admin endpoints
 * - Non-admin users accessing admin functions
 * - Privilege escalation attacks
 */

import request from 'supertest';
import express from 'express';
import { setupMiddleware } from '../middleware/setup.js';
import registerAdminRoutes from '../routes/adminRoutes.js';
import jwt from 'jsonwebtoken';

// Mock configuration for testing
const mockPlatformConfig = {
  auth: {
    mode: 'local',
    allowAnonymous: false
  },
  anonymousAuth: {
    enabled: false,
    defaultGroups: ['anonymous']
  },
  localAuth: {
    enabled: true,
    jwtSecret: 'test-secret-key-for-admin-tests',
    sessionTimeoutMinutes: 480
  }
};

// Mock apps, models, etc.
const mockApps = [{ id: 'test-app', name: 'Test App', enabled: true }];
const mockModels = [{ id: 'test-model', name: 'Test Model', provider: 'openai', enabled: true }];

// Mock group permissions
const mockGroupPermissions = {
  groups: {
    anonymous: {
      id: 'anonymous',
      permissions: {
        apps: [],
        prompts: [],
        models: [],
        adminAccess: false
      }
    },
    user: {
      id: 'user',
      permissions: {
        apps: ['*'],
        prompts: ['*'],
        models: ['*'],
        adminAccess: false
      }
    },
    admin: {
      id: 'admin',
      permissions: {
        apps: ['*'],
        prompts: ['*'],
        models: ['*'],
        adminAccess: true
      }
    }
  }
};

// Mock config cache
jest.mock('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({ data: mockPlatformConfig }),
    getApps: () => ({ data: mockApps, etag: 'test-etag' }),
    getModels: () => ({ data: mockModels, etag: 'test-etag' }),
    getPrompts: () => ({ data: [], etag: 'test-etag' }),
    getStyles: () => ({ data: [], etag: 'test-etag' }),
    getUI: () => ({ data: {}, etag: 'test-etag' }),
    getProviders: () => ({ data: [], etag: 'test-etag' }),
    getSources: () => ({ data: [], etag: 'test-etag' }),
    getTools: () => ({ data: [], etag: 'test-etag' }),
    getOAuthClients: () => ({ data: [], etag: 'test-etag' }),
    getGroups: () => ({ data: mockGroupPermissions.groups, etag: 'test-etag' }),
    refreshAll: jest.fn(),
    refreshModelsCache: jest.fn(),
    refreshAppsCache: jest.fn()
  }
}));

// Mock authorization utilities
jest.mock('../utils/authorization.js', () => ({
  loadGroupsConfiguration: () => mockGroupPermissions,
  enhanceUserWithPermissions: (user, config) => {
    if (!user || !user.groups) return user;

    const permissions = {
      apps: new Set(),
      prompts: new Set(),
      models: new Set(),
      adminAccess: false
    };

    user.groups.forEach(groupName => {
      const group = mockGroupPermissions.groups[groupName];
      if (group) {
        if (group.permissions.apps) {
          group.permissions.apps.forEach(app => permissions.apps.add(app));
        }
        if (group.permissions.prompts) {
          group.permissions.prompts.forEach(prompt => permissions.prompts.add(prompt));
        }
        if (group.permissions.models) {
          group.permissions.models.forEach(model => permissions.models.add(model));
        }
        if (group.permissions.adminAccess) {
          permissions.adminAccess = true;
        }
      }
    });

    return { ...user, permissions };
  },
  isAnonymousAccessAllowed: config => config?.anonymousAuth?.enabled === true
}));

// Helper to create JWT token
function createTestToken(payload) {
  return jwt.sign(payload, mockPlatformConfig.localAuth.jwtSecret, { expiresIn: '1h' });
}

// Helper to create test app
async function createTestApp() {
  const app = express();
  await setupMiddleware(app);
  app.set('platform', mockPlatformConfig);
  await registerAdminRoutes(app, '');
  return app;
}

describe('Admin Endpoints Security - Comprehensive Audit', () => {
  let app;

  beforeEach(async () => {
    app = await createTestApp();
  });

  describe('CRITICAL: Backup Endpoints Protection', () => {
    test('should require admin auth for backup export', async () => {
      // Test without auth - should fail
      const response = await request(app).get('/api/admin/backup/export');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    test('should require admin auth for backup import', async () => {
      // Test without auth - should fail
      const response = await request(app).post('/api/admin/backup/import');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    test('should block non-admin user from backup export', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      const response = await request(app)
        .get('/api/admin/backup/export')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
    });

    test('should block non-admin user from backup import', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      const response = await request(app)
        .post('/api/admin/backup/import')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
    });

    test('should allow admin user to access backup export', async () => {
      const token = createTestToken({
        userId: 'admin1',
        username: 'admin',
        groups: ['admin', 'authenticated']
      });

      const response = await request(app)
        .get('/api/admin/backup/export')
        .set('Authorization', `Bearer ${token}`);

      // Should not be 401 or 403 (auth/authz errors)
      // May be 500 or other error due to missing file system setup in test
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });
  });

  describe('Admin Apps Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/apps', async () => {
      const response = await request(app).get('/api/admin/apps');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/apps', async () => {
      const response = await request(app).post('/api/admin/apps').send({});
      expect(response.status).toBe(401);
    });

    test('should block non-admin from accessing apps admin endpoint', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user']
      });

      const response = await request(app)
        .get('/api/admin/apps')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
    });
  });

  describe('Admin Models Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/models', async () => {
      const response = await request(app).get('/api/admin/models');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/models', async () => {
      const response = await request(app).post('/api/admin/models').send({});
      expect(response.status).toBe(401);
    });

    test('should block non-admin from accessing models admin endpoint', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user']
      });

      const response = await request(app)
        .get('/api/admin/models')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
    });
  });

  describe('Admin Auth Endpoints Protection', () => {
    test('should allow unauthenticated access to /api/admin/auth/status (by design)', async () => {
      const response = await request(app).get('/api/admin/auth/status');

      // This endpoint should be accessible without auth to check if auth is required
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('authRequired');
    });

    test('should require admin auth for GET /api/admin/auth/users', async () => {
      const response = await request(app).get('/api/admin/auth/users');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/auth/users', async () => {
      const response = await request(app).post('/api/admin/auth/users').send({});
      expect(response.status).toBe(401);
    });

    test('should block non-admin from user management', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user']
      });

      const response = await request(app)
        .get('/api/admin/auth/users')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
    });
  });

  describe('Admin Config Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/configs/platform', async () => {
      const response = await request(app).get('/api/admin/configs/platform');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/configs/platform', async () => {
      const response = await request(app).post('/api/admin/configs/platform').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Groups Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/groups', async () => {
      const response = await request(app).get('/api/admin/groups');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/groups', async () => {
      const response = await request(app).post('/api/admin/groups').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Sources Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/sources', async () => {
      const response = await request(app).get('/api/admin/sources');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/sources', async () => {
      const response = await request(app).post('/api/admin/sources').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Tools Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/tools', async () => {
      const response = await request(app).get('/api/admin/tools');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/tools', async () => {
      const response = await request(app).post('/api/admin/tools').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Prompts Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/prompts', async () => {
      const response = await request(app).get('/api/admin/prompts');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/prompts', async () => {
      const response = await request(app).post('/api/admin/prompts').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Cache Endpoints Protection', () => {
    test('should require admin auth for POST /api/admin/cache/_refresh', async () => {
      const response = await request(app).post('/api/admin/cache/_refresh');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for GET /api/admin/usage', async () => {
      const response = await request(app).get('/api/admin/usage');
      expect(response.status).toBe(401);
    });
  });

  describe('Admin OAuth Clients Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/oauth/clients', async () => {
      const response = await request(app).get('/api/admin/oauth/clients');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/oauth/clients', async () => {
      const response = await request(app).post('/api/admin/oauth/clients').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Pages Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/pages', async () => {
      const response = await request(app).get('/api/admin/pages');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/pages', async () => {
      const response = await request(app).post('/api/admin/pages').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Providers Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/providers', async () => {
      const response = await request(app).get('/api/admin/providers');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/providers', async () => {
      const response = await request(app).post('/api/admin/providers').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Schemas Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/schemas', async () => {
      const response = await request(app).get('/api/admin/schemas');
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Translate Endpoint Protection', () => {
    test('should require admin auth for POST /api/admin/translate', async () => {
      const response = await request(app).post('/api/admin/translate').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin UI Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/ui/config', async () => {
      const response = await request(app).get('/api/admin/ui/config');
      expect(response.status).toBe(401);
    });

    test('should require admin auth for POST /api/admin/ui/config', async () => {
      const response = await request(app).post('/api/admin/ui/config').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('Admin Version Endpoints Protection', () => {
    test('should require admin auth for GET /api/admin/version', async () => {
      const response = await request(app).get('/api/admin/version');
      expect(response.status).toBe(401);
    });
  });
});
