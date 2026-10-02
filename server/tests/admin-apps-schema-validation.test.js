/**
 * Creating or updating an app through the admin API validates the
 * configuration against the app schema and answers 400 with the issues when
 * it does not pass. Nothing is written in that case.
 *
 * The apps loader only warns about an invalid file, so before this check an
 * admin save stored whatever it was sent — including a redirect or iframe URL
 * with a scheme other than http(s).
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

/** In-memory `contents/`, keyed by relative path. */
const store = {};
const clone = value => JSON.parse(JSON.stringify(value));
const appsInStore = () =>
  Object.entries(store)
    .filter(([key]) => key.startsWith('apps/'))
    .map(([, value]) => clone(value));

const chatApp = (id, extra = {}) => ({
  id,
  name: { en: 'Chat helper' },
  description: { en: 'Answers questions' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  system: { en: 'You are a helpful assistant.' },
  ...extra
});
const redirectApp = (id, url) => ({
  id,
  type: 'redirect',
  name: { en: 'External tool' },
  description: { en: 'Opens an external tool' },
  color: '#4F46E5',
  icon: 'external-link',
  redirectConfig: { url }
});

jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  contentAdminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: appsInStore(), etag: 'a' }),
    refreshAppsCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async rel => (rel in store ? clone(store[rel]) : null),
    writeJson: async (rel, data) => {
      store[rel] = clone(data);
    },
    createJson: async (rel, data) => {
      if (rel in store) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      store[rel] = clone(data);
    },
    resolveIdToPath: async (kind, id) =>
      `${kind}/${id}.json` in store ? `${kind}/${id}.json` : null
  }
}));

jest.unstable_mockModule('../utils/installationCleanup.js', () => ({
  removeMarketplaceInstallation: async () => {}
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { default: registerAdminAppsRoutes } = await import('../routes/admin/apps.js');

const app = express();
app.use(express.json());
registerAdminAppsRoutes(app);

function seed(...apps) {
  for (const key of Object.keys(store)) delete store[key];
  for (const appConfig of apps) store[`apps/${appConfig.id}.json`] = clone(appConfig);
}

beforeEach(() => seed());

describe('POST /api/admin/apps', () => {
  test('creates a valid app and stores the body unchanged', async () => {
    const res = await request(app).post('/api/admin/apps').send(chatApp('helper'));

    expect(res.status).toBe(200);
    // Stored as sent: schema defaults are not written into the file.
    expect(store['apps/helper.json']).toEqual(chatApp('helper'));
  });

  test('creates a redirect app with an https URL', async () => {
    const res = await request(app)
      .post('/api/admin/apps')
      .send(redirectApp('tool', 'https://example.com/tool'));

    expect(res.status).toBe(200);
    expect(store['apps/tool.json'].redirectConfig.url).toBe('https://example.com/tool');
  });

  test('rejects a redirect URL that is not http(s) with 400 and stores nothing', async () => {
    const res = await request(app)
      .post('/api/admin/apps')
      .send(redirectApp('tool', 'javascript:void(0)'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid app configuration: /);
    expect(res.body.error).toContain('redirectConfig.url: Redirect URL must use http or https');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['redirectConfig', 'url'] })])
    );
    expect(store['apps/tool.json']).toBeUndefined();
  });

  test('rejects keys the app schema does not know', async () => {
    const res = await request(app)
      .post('/api/admin/apps')
      .send(chatApp('helper', { useManual: true }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('useManual');
    expect(store['apps/helper.json']).toBeUndefined();
  });

  test('still reports missing required fields first', async () => {
    const res = await request(app).post('/api/admin/apps').send({ id: 'helper' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });
});

describe('PUT /api/admin/apps/:appId', () => {
  test('saves a valid update', async () => {
    seed(chatApp('helper'));
    const updated = chatApp('helper', { description: { en: 'Answers more questions' } });

    const res = await request(app).put('/api/admin/apps/helper').send(updated);

    expect(res.status).toBe(200);
    expect(store['apps/helper.json']).toEqual(updated);
  });

  test('rejects an iframe URL that is not http(s) and keeps the stored file', async () => {
    const existing = {
      ...chatApp('embed'),
      type: 'iframe',
      iframeConfig: { url: 'https://example.com/embed' }
    };
    seed(existing);

    const res = await request(app)
      .put('/api/admin/apps/embed')
      .send({ ...existing, iframeConfig: { url: 'data:text/html,hello' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('iframeConfig.url: Iframe URL must use http or https');
    expect(store['apps/embed.json']).toEqual(existing);
  });

  test('rejects an update with an invalid field value', async () => {
    seed(chatApp('helper'));

    const res = await request(app)
      .put('/api/admin/apps/helper')
      .send(chatApp('helper', { color: 'blue' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('color:');
    expect(store['apps/helper.json']).toEqual(chatApp('helper'));
  });
});
