// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Creating or updating an app through the admin API validates the
 * configuration against the app schema and answers 400 with the issues when
 * it does not pass. Nothing is written in that case.
 *
 * The apps loader only warns about an invalid file, so before this check an
 * admin save stored whatever it was sent — including a redirect or iframe URL
 * with a scheme other than http(s).
 *
 * Creating also takes the query parameter `origin`: how the app was started.
 * It is audit metadata, checked against a fixed list, and changes nothing
 * about the app or about what a caller without it gets.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

/** In-memory `contents/`, keyed by relative path. */
const store = {};
/** Every audit entry and change-history snapshot the routes asked for. */
const audits = [];
const snapshots = [];
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
  logAudit: async entry => {
    // The request object is not part of what gets recorded.
    const { req: _req, ...recorded } = entry;
    audits.push(recorded);
  }
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async snapshot => {
    snapshots.push(snapshot);
  }
}));

const { default: registerAdminAppsRoutes } = await import('../routes/admin/apps.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { appConfigSchema } = await import('../validators/appConfigSchema.js');
const { APP_CREATE_ORIGINS } = await import('../../shared/appGenerator.js');

const app = express();
app.use(express.json());
registerAdminAppsRoutes(app);
app.use(errorHandler);

function seed(...apps) {
  for (const key of Object.keys(store)) delete store[key];
  for (const appConfig of apps) store[`apps/${appConfig.id}.json`] = clone(appConfig);
  audits.length = 0;
  snapshots.length = 0;
}

beforeEach(() => seed());

describe('POST /api/admin/apps', () => {
  test('creates a valid app and stores the body unchanged', async () => {
    const res = await request(app).post('/api/admin/apps').send(chatApp('helper'));

    expect(res.status).toBe(201);
    // Stored as sent: schema defaults are not written into the file.
    expect(store['apps/helper.json']).toEqual(chatApp('helper'));
  });

  test('creates a redirect app with an https URL', async () => {
    const res = await request(app)
      .post('/api/admin/apps')
      .send(redirectApp('tool', 'https://example.com/tool'));

    expect(res.status).toBe(201);
    expect(store['apps/tool.json'].redirectConfig.url).toBe('https://example.com/tool');
  });

  test('rejects a redirect URL that is not http(s) with 400 and stores nothing', async () => {
    const res = await request(app)
      .post('/api/admin/apps')
      .send(redirectApp('tool', 'javascript:void(0)'));

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/^Invalid app configuration: /);
    expect(res.body.detail).toContain('redirectConfig.url: Redirect URL must use http or https');
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ pointer: '/redirectConfig/url' })])
    );
    expect(store['apps/tool.json']).toBeUndefined();
  });

  test('rejects keys the app schema does not know', async () => {
    const res = await request(app)
      .post('/api/admin/apps')
      .send(chatApp('helper', { useManual: true }));

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('useManual');
    expect(store['apps/helper.json']).toBeUndefined();
  });

  test('still reports missing required fields first', async () => {
    const res = await request(app).post('/api/admin/apps').send({ id: 'helper' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('Missing required fields');
  });

  // The shape `uap_` plus 32 hex characters belongs to personal apps: no write
  // path may create an app file with it.
  test('refuses an ID of the shape reserved for personal apps and stores nothing', async () => {
    const personalId = 'uap_3f9c2a0b1d4e5f60718293a4b5c6d7e8';
    const res = await request(app).post('/api/admin/apps').send(chatApp(personalId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.detail).toContain('id: This ID is reserved for personal apps');
    expect(store[`apps/${personalId}.json`]).toBeUndefined();
  });

  test('accepts an ID that only starts with the prefix of personal apps', async () => {
    const res = await request(app).post('/api/admin/apps').send(chatApp('uap_helper'));

    expect(res.status).toBe(201);
    expect(store['apps/uap_helper.json']).toEqual(chatApp('uap_helper'));
  });
});

describe('POST /api/admin/apps?origin=', () => {
  test('knows the six ways an app is started', () => {
    expect([...APP_CREATE_ORIGINS]).toEqual([
      'blank',
      'template',
      'copy',
      'generated',
      'link',
      'upload'
    ]);
  });

  test('records origin=generated in the audit entry and stores the body unchanged', async () => {
    const body = chatApp('drafted', { enabled: false });

    const res = await request(app).post('/api/admin/apps?origin=generated').send(body);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe('/api/admin/apps/drafted');
    expect(res.body).toEqual(body);
    expect(store['apps/drafted.json']).toEqual(body);
    expect(audits).toEqual([
      {
        action: 'create',
        resource: 'app',
        resourceId: 'drafted',
        summary: 'Created app drafted',
        details: { origin: 'generated' }
      }
    ]);
  });

  test.each(['blank', 'template', 'copy', 'generated', 'link', 'upload'])(
    'accepts origin=%s',
    async origin => {
      const res = await request(app)
        .post(`/api/admin/apps?origin=${origin}`)
        .send(chatApp(`from-${origin}`));

      expect(res.status).toBe(201);
      expect(audits).toHaveLength(1);
      expect(audits[0].details).toEqual({ origin });
      // The origin is audit metadata: it is neither stored nor answered.
      expect(JSON.stringify(store[`apps/from-${origin}.json`])).not.toContain('origin');
      expect('origin' in res.body).toBe(false);
    }
  );

  test.each([
    ['an unknown value', '?origin=nonsense'],
    ['another spelling', '?origin=Generated'],
    ['an empty value', '?origin='],
    ['a repeated parameter', '?origin=blank&origin=copy']
  ])('answers %s with 400 VALIDATION_FAILED and creates nothing', async (_name, query) => {
    const res = await request(app).post(`/api/admin/apps${query}`).send(chatApp('helper'));

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.detail).toBe(
      'origin must be one of: blank, template, copy, generated, link, upload'
    );
    expect(res.body.errors).toEqual([
      expect.objectContaining({ pointer: '/origin', code: 'INVALID' })
    ]);
    expect(store['apps/helper.json']).toBeUndefined();
    expect(audits).toEqual([]);
  });

  test('refuses an unknown origin before it looks at the body', async () => {
    const res = await request(app).post('/api/admin/apps?origin=nonsense').send({ id: 'helper' });
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.detail).toMatch(/^origin must be one of/);
  });

  test('without the parameter and without `enabled` it still creates a published app', async () => {
    const body = chatApp('helper');
    expect('enabled' in body).toBe(false);

    const res = await request(app).post('/api/admin/apps').send(body);

    expect(res.status).toBe(201);
    // Stored as sent: no `enabled` key, which the app schema reads as published.
    expect(store['apps/helper.json']).toEqual(body);
    expect(appConfigSchema.parse(store['apps/helper.json']).enabled).toBe(true);
    // The audit entry is the one it always was.
    expect(audits).toEqual([
      { action: 'create', resource: 'app', resourceId: 'helper', summary: 'Created app helper' }
    ]);
  });

  test('writes no change-history snapshot on create, with or without an origin', async () => {
    await request(app).post('/api/admin/apps').send(chatApp('one')).expect(201);
    await request(app).post('/api/admin/apps?origin=copy').send(chatApp('two')).expect(201);
    expect(snapshots).toEqual([]);

    // The first edit writes one whose "before" is the created app.
    const edited = chatApp('one', { description: { en: 'Edited' } });
    await request(app).put('/api/admin/apps/one').send(edited).expect(200);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      resource: 'app',
      id: 'one',
      before: chatApp('one'),
      after: edited
    });
  });

  test('does not read an origin from the body', async () => {
    const res = await request(app)
      .post('/api/admin/apps')
      .send(chatApp('helper', { origin: 'generated' }));

    // The app schema is strict: a body field would be refused, not recorded.
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('origin');
    expect(audits).toEqual([]);
  });

  test('a duplicate still answers 409 with an origin', async () => {
    seed(chatApp('helper'));
    const res = await request(app).post('/api/admin/apps?origin=copy').send(chatApp('helper'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(audits).toEqual([]);
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
    expect(res.body.detail).toContain('iframeConfig.url: Iframe URL must use http or https');
    expect(store['apps/embed.json']).toEqual(existing);
  });

  test('keeps the personal app a published app came from, and refuses another value', async () => {
    const source = 'uap_0123456789abcdef0123456789abcdef';
    seed(chatApp('published', { sourceUserAppId: source }));
    const edited = chatApp('published', {
      sourceUserAppId: source,
      description: { en: 'Edited by an admin' }
    });

    const res = await request(app).put('/api/admin/apps/published').send(edited);
    expect(res.status).toBe(200);
    expect(store['apps/published.json']).toEqual(edited);

    const wrong = await request(app)
      .put('/api/admin/apps/published')
      .send({ ...edited, sourceUserAppId: 'not-a-personal-app' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.detail).toContain('sourceUserAppId');
    expect(store['apps/published.json']).toEqual(edited);
  });

  test('rejects an update with an invalid field value', async () => {
    seed(chatApp('helper'));

    const res = await request(app)
      .put('/api/admin/apps/helper')
      .send(chatApp('helper', { color: 'blue' }));

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('color:');
    expect(store['apps/helper.json']).toEqual(chatApp('helper'));
  });
});

describe('error responses of the app routes', () => {
  test('answers a duplicate app with CONFLICT and stores nothing new', async () => {
    seed(chatApp('helper'));

    const res = await request(app).post('/api/admin/apps').send(chatApp('helper'));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ detail: 'App with this ID already exists', code: 'CONFLICT' });
  });

  test('answers an unknown app with NOT_FOUND and an unsafe id with BAD_REQUEST', async () => {
    const missing = await request(app).get('/api/admin/apps/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ detail: 'App not found', code: 'NOT_FOUND' });

    const unsafe = await request(app).get('/api/admin/apps/bad%20id');
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
  });

  test('refuses to change the id of an app', async () => {
    seed(chatApp('helper'));

    const res = await request(app).put('/api/admin/apps/helper').send(chatApp('other'));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ detail: 'App ID cannot be changed', code: 'BAD_REQUEST' });
  });

  test('refuses a reorder with duplicates or unknown ids', async () => {
    seed(chatApp('helper'));

    const duplicates = await request(app)
      .post('/api/admin/apps/_reorder')
      .send({ ids: ['helper', 'helper'] });
    expect(duplicates.status).toBe(400);
    expect(duplicates.body.detail).toBe('ids must not contain duplicates');

    const unknown = await request(app)
      .post('/api/admin/apps/_reorder')
      .send({ ids: ['ghost'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.detail).toBe('Unknown app ids: ghost');
  });

  test('answers a missing enabled flag with BAD_REQUEST', async () => {
    const res = await request(app).post('/api/admin/apps/helper/_toggle').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ detail: 'Missing enabled flag', code: 'BAD_REQUEST' });
  });
});
