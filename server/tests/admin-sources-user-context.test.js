/**
 * Admin Sources User Context Test Suite
 *
 * Regression tests for the admin source `test` and `preview` endpoints to
 * ensure that runtime context (the authenticated `user` plus a generated
 * `chatId`) is injected into the source configuration before it is handed
 * to the `SourceManager`.
 *
 * Without this context, handlers such as `IFinderHandler` abort with
 * "requires authenticated user in sourceConfig" / "requires chatId in
 * sourceConfig" and the admin UI surfaces a confusing error. The
 * regression these tests protect against is documented in PR #1406 /
 * issue #1404.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this
 * file uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// Captures the most recent invocations of the mocked SourceManager methods so
// each test can inspect what the route handler passed in.
const sourceManagerCalls = {
  testSource: [],
  loadContent: []
};

const mockAdminUser = {
  id: 'admin-user',
  username: 'admin',
  email: 'admin@example.com',
  groups: ['admin', 'authenticated']
};

const mockGroups = {
  admin: {
    id: 'admin',
    permissions: {
      apps: ['*'],
      prompts: ['*'],
      models: ['*'],
      adminAccess: true
    }
  }
};

const mockIFinderSource = {
  id: 'test-ifinder-source',
  name: { en: 'Test iFinder Source' },
  description: { en: 'Test iFinder source for regression coverage' },
  type: 'ifinder',
  enabled: true,
  exposeAs: 'prompt',
  config: {
    query: 'test query',
    searchProfile: 'default'
  }
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ data: {} }),
    getSources: () => ({ data: [mockIFinderSource], etag: 'test-etag' }),
    getFeatures: () => ({}),
    getGroups: () => ({ data: mockGroups, etag: 'test-etag' })
  }
}));

jest.unstable_mockModule('../utils/authorization.js', () => ({
  loadGroupsConfiguration: () => ({ groups: mockGroups }),
  enhanceUserWithPermissions: user => user,
  isAnonymousAccessAllowed: () => false
}));

// Replace the real source manager with one that records its inputs and
// emulates IFinderHandler's strict precondition checks. If the route handler
// ever stops injecting `user` / `chatId` again, the simulated handler throws
// — surfacing the regression as a 400 with the exact production error.
jest.unstable_mockModule('../sources/index.js', () => {
  const fakeManager = {
    testSource: async (type, config) => {
      sourceManagerCalls.testSource.push({ type, config });
      if (type === 'ifinder') {
        if (!config.user) {
          throw new Error('IFinderHandler requires authenticated user in sourceConfig');
        }
        if (!config.chatId) {
          throw new Error('IFinderHandler requires chatId in sourceConfig');
        }
      }
      return { accessible: true, testQuery: config.query };
    },
    loadContent: async (type, config) => {
      sourceManagerCalls.loadContent.push({ type, config });
      if (type === 'ifinder') {
        if (!config.user) {
          throw new Error('IFinderHandler requires authenticated user in sourceConfig');
        }
        if (!config.chatId) {
          throw new Error('IFinderHandler requires chatId in sourceConfig');
        }
      }
      return 'mocked source content';
    }
  };

  return {
    createSourceManager: () => fakeManager,
    validateSourceConfig: () => ({ success: true }),
    getAvailableHandlerTypes: () => ['filesystem', 'url', 'ifinder', 'page']
  };
});

// Dynamic import after mocks are registered.
const { default: registerAdminSourcesRoutes } = await import('../routes/admin/sources.js');

function createTestApp({ user = mockAdminUser } = {}) {
  const app = express();
  app.use(express.json());
  // Stub auth middleware: populate req.user so adminAuth (which the route
  // chains on) sees an admin and lets the request through.
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminSourcesRoutes(app);
  return app;
}

describe('Admin Sources Endpoints - User Context Injection (regression for PR #1406)', () => {
  let app;

  beforeEach(() => {
    sourceManagerCalls.testSource.length = 0;
    sourceManagerCalls.loadContent.length = 0;
    app = createTestApp();
  });

  describe('POST /api/admin/sources/:id/test', () => {
    test('injects req.user and a chatId into the iFinder source config', async () => {
      const response = await request(app)
        .post(`/api/admin/sources/${mockIFinderSource.id}/test`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      expect(sourceManagerCalls.testSource).toHaveLength(1);
      const { type, config } = sourceManagerCalls.testSource[0];
      expect(type).toBe('ifinder');
      expect(config.user).toEqual(mockAdminUser);
      expect(typeof config.chatId).toBe('string');
      expect(config.chatId).toMatch(
        new RegExp(
          `^admin-source-test-${mockIFinderSource.id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
        )
      );
      // Original source config is preserved alongside the injected context.
      expect(config.query).toBe(mockIFinderSource.config.query);
      expect(config.searchProfile).toBe(mockIFinderSource.config.searchProfile);
    });

    test('generates a unique chatId per request (collision-resistant)', async () => {
      const responses = await Promise.all([
        request(app).post(`/api/admin/sources/${mockIFinderSource.id}/test`).send(),
        request(app).post(`/api/admin/sources/${mockIFinderSource.id}/test`).send()
      ]);

      responses.forEach(res => expect(res.status).toBe(200));
      expect(sourceManagerCalls.testSource).toHaveLength(2);

      const [first, second] = sourceManagerCalls.testSource;
      expect(first.config.chatId).not.toBe(second.config.chatId);
    });
  });

  describe('POST /api/admin/sources/:id/preview', () => {
    test('injects req.user and a chatId into the iFinder source config', async () => {
      const response = await request(app)
        .post(`/api/admin/sources/${mockIFinderSource.id}/preview`)
        .send();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.preview).toBe('mocked source content');

      expect(sourceManagerCalls.loadContent).toHaveLength(1);
      const { type, config } = sourceManagerCalls.loadContent[0];
      expect(type).toBe('ifinder');
      expect(config.user).toEqual(mockAdminUser);
      expect(typeof config.chatId).toBe('string');
      expect(config.chatId).toMatch(
        new RegExp(
          `^admin-source-preview-${mockIFinderSource.id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
        )
      );
      expect(config.query).toBe(mockIFinderSource.config.query);
    });

    test('generates a unique chatId per request (collision-resistant)', async () => {
      const responses = await Promise.all([
        request(app).post(`/api/admin/sources/${mockIFinderSource.id}/preview`).send(),
        request(app).post(`/api/admin/sources/${mockIFinderSource.id}/preview`).send()
      ]);

      responses.forEach(res => expect(res.status).toBe(200));
      expect(sourceManagerCalls.loadContent).toHaveLength(2);

      const [first, second] = sourceManagerCalls.loadContent;
      expect(first.config.chatId).not.toBe(second.config.chatId);
    });
  });
});
