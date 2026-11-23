// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model lifecycle routes of the admin:
 *
 * - `GET /api/admin/models/{id}/_dependants` lists what names a model before
 *   it is deleted (AI-B12);
 * - `POST /api/admin/models/{id}/_make-default` makes an enabled chat model
 *   the default;
 * - create, update, `_toggle` and delete send `Default-Model-Assigned` when the
 *   server made a model the default that the admin did not choose (AI-B13).
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

/** In-memory `contents/`, keyed by relative path. */
const store = {};
const clone = value => JSON.parse(JSON.stringify(value));
const modelsInStore = () =>
  Object.entries(store)
    .filter(([key]) => key.startsWith('models/'))
    .map(([, value]) => clone(value));
const stored = id => store[`models/${id}.json`];
let apps = [];
let workflows = [];

const chat = (id, extra = {}) => ({
  id,
  modelId: id,
  name: { en: id },
  description: { en: id },
  provider: 'mistral',
  url: 'https://api.mistral.ai/v1/chat/completions',
  enabled: true,
  ...extra
});

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: value => value,
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getModels: () => ({ data: modelsInStore(), etag: 'm' }),
    getApps: () => ({ data: clone(apps), etag: 'a' }),
    getWorkflows: () => ({ data: clone(workflows), etag: 'w' }),
    getProviders: () => ({ data: [], etag: 'p' }),
    refreshModelsCache: async () => {},
    refreshProvidersCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async rel => (rel in store ? clone(store[rel]) : null),
    writeJson: async (rel, data) => {
      store[rel] = clone(data);
    },
    updateJson: async (rel, mutate) => {
      const next = await mutate(rel in store ? clone(store[rel]) : null);
      if (next !== undefined) store[rel] = clone(next);
      return { data: rel in store ? clone(store[rel]) : null, written: next !== undefined };
    },
    remove: async rel => {
      const existed = rel in store;
      delete store[rel];
      return existed;
    },
    resolveIdToPath: async (kind, id) => `${kind}/${id}.json`,
    listDocuments: async dir =>
      Object.entries(store)
        .filter(([key]) => key.startsWith(`${dir}/`))
        .map(([key, value]) => ({
          key: key.slice(dir.length + 1).replace(/\.json$/, ''),
          path: key,
          data: clone(value)
        }))
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { default: registerAdminModelsRoutes } = await import('../routes/admin/models.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminModelsRoutes(app);
app.use(errorHandler);

function seed(...models) {
  for (const key of Object.keys(store)) delete store[key];
  for (const model of models) store[`models/${model.id}.json`] = clone(model);
  apps = [];
  workflows = [];
}

const ASSIGNED = 'default-model-assigned';

describe('GET /api/admin/models/{id}/_dependants', () => {
  test('lists the apps, workflows and groups that name the model', async () => {
    seed(chat('small', { default: true }), chat('large'));
    apps = [
      { id: 'chat', name: { en: 'Chat' }, preferredModel: 'large' },
      { id: 'compare', name: { en: 'Compare' }, allowedModels: ['small', 'large'] },
      { id: 'other', name: { en: 'Other' }, preferredModel: 'small' }
    ];
    workflows = [
      { id: 'research', name: { en: 'Research' }, config: { defaultModelId: 'large' }, nodes: [] },
      {
        id: 'loop',
        name: { en: 'Loop' },
        nodes: [{ id: 'l', config: { nodes: [{ id: 'inner', config: { modelId: 'large' } }] } }]
      }
    ];
    store['config/groups.json'] = {
      groups: {
        users: { id: 'users', name: 'Users', permissions: { models: ['*'] } },
        pilot: { id: 'pilot', name: 'Pilot', permissions: { models: ['large'] } }
      }
    };

    const res = await request(app).get('/api/admin/models/large/_dependants');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      apps: [
        { id: 'chat', name: { en: 'Chat' }, references: ['preferredModel'] },
        { id: 'compare', name: { en: 'Compare' }, references: ['allowedModels'] }
      ],
      workflows: [
        { id: 'research', name: { en: 'Research' }, references: ['defaultModel'] },
        { id: 'loop', name: { en: 'Loop' }, references: ['node'] }
      ],
      groups: [{ id: 'pilot', name: 'Pilot' }],
      isDefault: false
    });
  });

  test('says when the model is the default and which model takes over', async () => {
    seed(chat('small', { default: true }), chat('large'));
    const res = await request(app).get('/api/admin/models/small/_dependants');
    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.nextDefaultModelId).toBe('large');
  });

  test('leaves out the successor when no other chat model is enabled', async () => {
    seed(chat('small', { default: true }), chat('large', { enabled: false }));
    const res = await request(app).get('/api/admin/models/small/_dependants');
    expect(res.body.isDefault).toBe(true);
    expect(res.body).not.toHaveProperty('nextDefaultModelId');
  });

  test('answers 404 as problem+json for an unknown model', async () => {
    seed(chat('small', { default: true }));
    const res = await request(app).get('/api/admin/models/ghost/_dependants');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/admin/models/{id}/_make-default', () => {
  test('moves the default flag to the model and answers with it', async () => {
    seed(chat('small', { default: true }), chat('large', { apiKey: 'enc' }));
    const res = await request(app).post('/api/admin/models/large/_make-default');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'large', default: true, apiKeySet: true });
    expect(res.body).not.toHaveProperty('apiKey');
    expect(stored('large').default).toBe(true);
    expect(stored('small').default).toBe(false);
    // The admin chose it: nothing to announce.
    expect(res.headers[ASSIGNED]).toBeUndefined();
  });

  test('refuses a disabled model with 409', async () => {
    seed(chat('small', { default: true }), chat('large', { enabled: false }));
    const res = await request(app).post('/api/admin/models/large/_make-default');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(stored('small').default).toBe(true);
  });

  test('refuses a text-to-speech model with 400', async () => {
    seed(chat('small', { default: true }), chat('voice', { modelType: 'tts' }));
    const res = await request(app).post('/api/admin/models/voice/_make-default');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  test('answers 404 for an unknown model', async () => {
    seed(chat('small', { default: true }));
    const res = await request(app).post('/api/admin/models/ghost/_make-default');
    expect(res.status).toBe(404);
  });
});

describe('Default-Model-Assigned names a default the server picked on its own', () => {
  test('creating the first enabled chat model makes it the default and says so', async () => {
    seed(chat('off', { enabled: false }));
    const res = await request(app).post('/api/admin/models').send(chat('fresh'));
    expect(res.status).toBe(201);
    expect(res.headers[ASSIGNED]).toBe('fresh');
  });

  test('creating a model ticked as default is not announced', async () => {
    seed(chat('off', { enabled: false }));
    const res = await request(app)
      .post('/api/admin/models')
      .send({ ...chat('fresh'), default: true });
    expect(res.status).toBe(201);
    expect(res.headers[ASSIGNED]).toBeUndefined();
  });

  test('creating a model beside an existing default is not announced', async () => {
    seed(chat('small', { default: true }));
    const res = await request(app).post('/api/admin/models').send(chat('fresh'));
    expect(res.headers[ASSIGNED]).toBeUndefined();
  });

  test('disabling the default names the model that took over', async () => {
    seed(chat('small', { default: true }), chat('large'));
    const res = await request(app).post('/api/admin/models/small/_toggle').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, ids: ['small'] });
    expect(res.headers[ASSIGNED]).toBe('large');
  });

  test('enabling a model when none is enabled names it', async () => {
    seed(chat('small', { enabled: false }));
    const res = await request(app).post('/api/admin/models/small/_toggle').send({ enabled: true });
    expect(res.headers[ASSIGNED]).toBe('small');
  });

  test('disabling a model that is not the default is not announced', async () => {
    seed(chat('small', { default: true }), chat('large'));
    const res = await request(app).post('/api/admin/models/large/_toggle').send({ enabled: false });
    expect(res.headers[ASSIGNED]).toBeUndefined();
  });

  test('deleting the default names the model that took over', async () => {
    seed(chat('small', { default: true }), chat('large'));
    const res = await request(app).delete('/api/admin/models/small');
    expect(res.status).toBe(204);
    expect(res.headers[ASSIGNED]).toBe('large');
  });

  test('saving the default as disabled names the model that took over', async () => {
    seed(chat('small', { default: true }), chat('large'));
    const res = await request(app)
      .put('/api/admin/models/small')
      .send({ ...chat('small'), enabled: false, default: false });
    expect(res.status).toBe(200);
    expect(res.headers[ASSIGNED]).toBe('large');
  });

  test('unticking Enabled on the default (default still sent) hands the default on', async () => {
    seed(chat('small', { default: true }), chat('large'));
    const res = await request(app)
      .put('/api/admin/models/small')
      .send({ ...chat('small'), enabled: false, default: true });
    expect(res.status).toBe(200);
    expect(res.body.default).toBe(false);
    expect(res.headers[ASSIGNED]).toBe('large');
  });
});
