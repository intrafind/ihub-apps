/**
 * Comprehensive Authentication & Authorization Security Test Suite
 *
 * Tests critical security scenarios to prevent authentication bypass vulnerabilities
 */

import request from 'supertest';
import express from 'express';
import { setupMiddleware } from '../serverHelpers.js';
import registerChatRoutes from '../routes/chat/index.js';
import registerGeneralRoutes from '../routes/generalRoutes.js';
import registerModelRoutes from '../routes/modelRoutes.js';
import registerAdminRoutes from '../routes/adminRoutes.js';
import registerAuthRoutes from '../routes/auth.js';
import { processMessageTemplates, getLocalizedError } from '../serverHelpers.js';
import jwt from 'jsonwebtoken';

// Mock configuration for testing
const mockPlatformConfigAnonymousDisabled = {
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

const mockPlatformConfigAnonymousEnabled = {
  ...mockPlatformConfigAnonymousDisabled,
  auth: {
    ...mockPlatformConfigAnonymousDisabled.auth,
    allowAnonymous: true
  },
  authorization: {
    ...mockPlatformConfigAnonymousDisabled.authorization,
    enabled: true
  }
};

// Mock apps configuration
const mockApps = [
  { id: 'public-app', name: 'Public App', enabled: true },
  { id: 'user-app', name: 'User App', enabled: true },
  { id: 'admin-app', name: 'Admin App', enabled: true },
  { id: 'finance-app', name: 'Finance App', enabled: true }
];

// Mock models configuration
const mockModels = [
  { id: 'gpt-4', name: 'GPT-4', provider: 'openai', enabled: true },
  { id: 'claude-4', name: 'Claude-4', provider: 'anthropic', enabled: true }
];

// Mock group permissions
const mockGroupPermissions = {
  groups: {
    anonymous: {
      apps: ['public-app'],
      prompts: ['public-prompt'],
      models: ['gpt-4'],
      adminAccess: false
    },
    user: {
      apps: ['public-app', 'user-app'],
      prompts: ['*'],
      models: ['*'],
      adminAccess: false
    },
    finance: {
      apps: ['public-app', 'user-app', 'finance-app'],
      prompts: ['*'],
      models: ['*'],
      adminAccess: false
    },
    admin: {
      apps: ['*'],
      prompts: ['*'],
      models: ['*'],
      adminAccess: true
    }
  }
};

// Mock config cache
jest.mock('../configCache.js', () => ({
  getPlatform: () => ({ data: global.mockPlatformConfig }),
  getApps: () => ({ data: mockApps, etag: 'test-etag' }),
  getModels: () => ({ data: mockModels, etag: 'test-etag' }),
  getPrompts: () => ({ data: [], etag: 'test-etag' }),
  getStyles: () => ({ data: [], etag: 'test-etag' }),
  getUI: () => ({ data: {}, etag: 'test-etag' }),
  getLocalizations: () => ({ test: 'value' })
}));

// Mock authorization utils
jest.mock('../utils/authorization.js', () => ({
  enhanceUserWithPermissions: user => {
    if (!user || user.id === 'anonymous') {
      return {
        id: 'anonymous',
        name: 'Anonymous',
        email: null,
        groups: ['anonymous'],
        permissions: {
          apps: new Set(['public-app']),
          prompts: new Set(['public-prompt']),
          models: new Set(['gpt-4']),
          adminAccess: false
        },
        isAdmin: false
      };
    }

    const permissions = {
      apps: new Set(),
      prompts: new Set(),
      models: new Set(),
      adminAccess: false
    };

    // Add permissions based on user groups
    for (const group of user.groups || []) {
      const groupPerms = mockGroupPermissions.groups[group];
      if (!groupPerms) continue;

      if (groupPerms.apps?.includes('*')) {
        permissions.apps.add('*');
      } else if (Array.isArray(groupPerms.apps)) {
        groupPerms.apps.forEach(app => permissions.apps.add(app));
      }

      if (groupPerms.prompts?.includes('*')) {
        permissions.prompts.add('*');
      } else if (Array.isArray(groupPerms.prompts)) {
        groupPerms.prompts.forEach(prompt => permissions.prompts.add(prompt));
      }

      if (groupPerms.models?.includes('*')) {
        permissions.models.add('*');
      } else if (Array.isArray(groupPerms.models)) {
        groupPerms.models.forEach(model => permissions.models.add(model));
      }

      if (groupPerms.adminAccess) {
        permissions.adminAccess = true;
      }
    }

    return {
      ...user,
      permissions,
      isAdmin: permissions.adminAccess
    };
  },
  filterResourcesByPermissions: (resources, allowedResources) => {
    if (allowedResources.has('*')) return resources;
    return resources.filter(resource =>
      allowedResources.has(resource.id || resource.modelId || resource.name)
    );
  }
}));

// Helper function to create JWT token
function createTestToken(payload) {
  return jwt.sign(payload, 'test-secret-key', { expiresIn: '1h' });
}

// Helper function to create test app
async function createTestApp(platformConfig = mockPlatformConfigAnonymousDisabled) {
  const app = express();

  // Set platform config globally for test
  global.mockPlatformConfig = platformConfig;

  setupMiddleware(app, platformConfig);

  // Register routes
  registerAuthRoutes(app);
  registerGeneralRoutes(app, { getLocalizedError });
  registerModelRoutes(app, { getLocalizedError });
  registerChatRoutes(app, {
    verifyApiKey: () => Promise.resolve('test-api-key'),
    processMessageTemplates,
    getLocalizedError,
    DEFAULT_TIMEOUT: 30000
  });
  await registerAdminRoutes(app);

  return app;
}

describe('Authentication & Authorization Security Tests', () => {
  describe('Anonymous Access Disabled - Complete Lockdown', () => {
    let app;

    beforeEach(async () => {
      app = await createTestApp(mockPlatformConfigAnonymousDisabled);
    });

    test('should block unauthenticated access to /api/apps', async () => {
      const response = await request(app).get('/api/apps').expect(401);

      expect(response.body).toEqual({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to access this resource'
      });
    });

    test('should block unauthenticated access to /api/models', async () => {
      const response = await request(app).get('/api/models').expect(401);

      expect(response.body.error).toBe('Authentication required');
    });

    test('should block unauthenticated access to chat endpoints', async () => {
      // Test SSE connection endpoint
      await request(app).get('/api/apps/test-app/chat/test-chat').expect(401);

      // Test chat POST endpoint
      await request(app)
        .post('/api/apps/test-app/chat/test-chat')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          modelId: 'gpt-4'
        })
        .expect(401);

      // Test chat stop endpoint
      await request(app).post('/api/apps/test-app/chat/test-chat/stop').expect(401);
    });

    test('should block unauthenticated access to model test endpoint', async () => {
      await request(app).get('/api/models/gpt-4/chat/test').expect(401);
    });

    test('should block unauthenticated access to tools', async () => {
      await request(app).get('/api/tools').expect(401);
    });

    test('should block unauthenticated access to prompts', async () => {
      await request(app).get('/api/prompts').expect(401);
    });

    test('should block unauthenticated access to feedback', async () => {
      await request(app)
        .post('/api/feedback')
        .send({
          messageId: 'test',
          appId: 'test-app',
          chatId: 'test-chat',
          rating: 'positive'
        })
        .expect(401);
    });

    test('should allow access to auth status endpoint', async () => {
      await request(app).get('/api/auth/status').expect(200);
    });

    test('should allow access to platform config endpoint', async () => {
      await request(app).get('/api/configs/platform').expect(200);
    });
  });

  describe('Anonymous Access Enabled - Limited Access', () => {
    let app;

    beforeEach(async () => {
      app = await createTestApp(mockPlatformConfigAnonymousEnabled);
    });

    test('should allow anonymous access to apps but filter by permissions', async () => {
      const response = await request(app).get('/api/apps').expect(200);

      // Should only see apps allowed for anonymous group
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('public-app');
    });

    test('should allow anonymous access to models but filter by permissions', async () => {
      const response = await request(app).get('/api/models').expect(200);

      // Should only see models allowed for anonymous group
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('gpt-4');
    });

    test('should allow anonymous access to specific app if permitted', async () => {
      await request(app).get('/api/apps/public-app').expect(200);
    });

    test('should block anonymous access to restricted app', async () => {
      await request(app).get('/api/apps/user-app').expect(403);
    });

    test('should allow anonymous chat with permitted apps and models', async () => {
      await request(app)
        .post('/api/apps/public-app/chat/test-chat')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          modelId: 'gpt-4'
        })
        .expect(200);
    });

    test('should block anonymous chat with restricted apps', async () => {
      await request(app)
        .post('/api/apps/user-app/chat/test-chat')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          modelId: 'gpt-4'
        })
        .expect(403);
    });
  });

  describe('Authenticated User Access - Group-Based Permissions', () => {
    let app;

    beforeEach(async () => {
      app = await createTestApp(mockPlatformConfigAnonymousDisabled);
    });

    test('should allow user group access to user and public apps', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      const response = await request(app)
        .get('/api/apps')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Should see apps allowed for user group
      const appIds = response.body.map(app => app.id);
      expect(appIds).toContain('public-app');
      expect(appIds).toContain('user-app');
      expect(appIds).not.toContain('finance-app'); // Not in finance group
    });

    test('should allow finance group access to finance apps', async () => {
      const token = createTestToken({
        userId: 'user2',
        username: 'financeuser',
        groups: ['user', 'finance', 'authenticated']
      });

      const response = await request(app)
        .get('/api/apps')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Should see apps allowed for user + finance groups
      const appIds = response.body.map(app => app.id);
      expect(appIds).toContain('public-app');
      expect(appIds).toContain('user-app');
      expect(appIds).toContain('finance-app');
    });

    test('should allow user to chat with permitted apps', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      await request(app)
        .post('/api/apps/user-app/chat/test-chat')
        .set('Authorization', `Bearer ${token}`)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          modelId: 'gpt-4'
        })
        .expect(200);
    });

    test('should block user from accessing apps outside their groups', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      await request(app)
        .get('/api/apps/finance-app')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    test('should block user from chatting with apps outside their groups', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      await request(app)
        .post('/api/apps/finance-app/chat/test-chat')
        .set('Authorization', `Bearer ${token}`)
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          modelId: 'gpt-4'
        })
        .expect(403);
    });
  });

  describe('Admin Endpoint Protection', () => {
    let app;

    beforeEach(async () => {
      app = await createTestApp(mockPlatformConfigAnonymousDisabled);
    });

    test('should block regular user from accessing admin endpoints', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      await request(app).get('/api/admin/apps').set('Authorization', `Bearer ${token}`).expect(403);

      await request(app)
        .get('/api/admin/models')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      await request(app)
        .get('/api/admin/auth/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    test('should block anonymous user from accessing admin endpoints', async () => {
      await request(app).get('/api/admin/apps').expect(401);
    });

    test('should allow admin user to access admin endpoints', async () => {
      const token = createTestToken({
        userId: 'admin1',
        username: 'admin',
        groups: ['admin', 'authenticated']
      });

      await request(app)
        .get('/api/admin/auth/status')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });

  describe('JWT Token Validation', () => {
    let app;

    beforeEach(async () => {
      app = await createTestApp(mockPlatformConfigAnonymousDisabled);
    });

    test('should reject invalid JWT tokens', async () => {
      await request(app).get('/api/apps').set('Authorization', 'Bearer invalid-token').expect(401);
    });

    test('should reject expired JWT tokens', async () => {
      const expiredToken = jwt.sign(
        {
          userId: 'user1',
          username: 'testuser',
          groups: ['user']
        },
        'test-secret-key',
        { expiresIn: '-1h' } // Expired 1 hour ago
      );

      await request(app)
        .get('/api/apps')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);
    });

    test('should accept valid JWT tokens', async () => {
      const validToken = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: ['user', 'authenticated']
      });

      await request(app).get('/api/apps').set('Authorization', `Bearer ${validToken}`).expect(200);
    });
  });

  describe('Edge Cases and Security Validation', () => {
    let app;

    beforeEach(async () => {
      app = await createTestApp(mockPlatformConfigAnonymousDisabled);
    });

    test('should handle malformed authorization headers', async () => {
      await request(app).get('/api/apps').set('Authorization', 'InvalidFormat').expect(401);

      await request(app).get('/api/apps').set('Authorization', 'Bearer ').expect(401);
    });

    test('should handle user with no groups', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser'
        // No groups property
      });

      const response = await request(app)
        .get('/api/apps')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Should get default anonymous permissions
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('public-app');
    });

    test('should handle user with empty groups array', async () => {
      const token = createTestToken({
        userId: 'user1',
        username: 'testuser',
        groups: []
      });

      const response = await request(app)
        .get('/api/apps')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Should get default anonymous permissions
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('public-app');
    });

    test('should prevent privilege escalation via token manipulation', async () => {
      // Try to create a token with admin groups but wrong secret
      const maliciousToken = jwt.sign(
        {
          userId: 'hacker',
          username: 'hacker',
          groups: ['admin']
        },
        'wrong-secret' // Wrong secret
      );

      await request(app)
        .get('/api/admin/apps')
        .set('Authorization', `Bearer ${maliciousToken}`)
        .expect(401);
    });
  });

  describe('Authentication Bypass Prevention', () => {
    let app;

    beforeEach(async () => {
      app = await createTestApp(mockPlatformConfigAnonymousDisabled);
    });

    test('should not allow bypassing auth with header manipulation', async () => {
      // Try various header manipulation attempts
      await request(app).get('/api/apps').set('X-Forwarded-User', 'admin').expect(401);

      await request(app).get('/api/apps').set('X-User-Id', 'admin').expect(401);

      await request(app).get('/api/apps').set('User', 'admin').expect(401);
    });

    test('should not allow bypassing auth with query parameters', async () => {
      await request(app).get('/api/apps?user=admin&token=fake').expect(401);

      await request(app).get('/api/apps?auth=bypass').expect(401);
    });

    test('should not allow bypassing auth with request body manipulation', async () => {
      await request(app)
        .post('/api/apps/test-app/chat/test-chat')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          modelId: 'gpt-4',
          user: 'admin',
          auth: 'bypass'
        })
        .expect(401);
    });
  });
});
