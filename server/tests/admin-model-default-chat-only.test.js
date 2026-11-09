// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Only a chat model can be the default model. A text-to-speech or
 * transcription model never takes the `default` flag through the admin
 * routes, neither when it is saved with the flag (which used to demote the
 * real chat default on disk) nor when the default model is disabled or
 * deleted and the flag moves on to another model.
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
/** What the config cache shows while it lags behind the stored files; null = in step with them. */
let staleCache = null;

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
const tts = (id, extra = {}) => ({
  ...chat(id),
  modelType: 'tts',
  url: 'https://api.mistral.ai/v1/audio/speech',
  ...extra
});

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: value => value,
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getModels: () => ({ data: staleCache ? clone(staleCache) : modelsInStore(), etag: 'm' }),
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
    // Read, change, write; `undefined` from `mutate` leaves the file as it is.
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
    // The stored files of a directory, as the real store lists them.
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

const app = express();
app.use(express.json());
registerAdminModelsRoutes(app);

function seed(...models) {
  staleCache = null;
  for (const key of Object.keys(store)) delete store[key];
  for (const model of models) store[`models/${model.id}.json`] = clone(model);
}

describe('the default model is always a chat model', () => {
  test('saving a TTS model with the flag keeps the chat default', async () => {
    seed(chat('small', { default: true }), tts('voxtral'));
    const res = await request(app)
      .put('/api/admin/models/voxtral')
      .send({ ...tts('voxtral'), default: true });
    expect(res.status).toBe(200);
    expect(stored('voxtral').default).toBe(false);
    expect(stored('small').default).toBe(true);
  });

  test('creating a TTS model with the flag keeps the chat default', async () => {
    seed(chat('small', { default: true }));
    const res = await request(app)
      .post('/api/admin/models')
      .send({ ...tts('voxtral'), default: true });
    expect(res.status).toBe(201);
    expect(stored('voxtral').default).toBe(false);
    expect(stored('small').default).toBe(true);
  });

  test('disabling the default passes it to a chat model, not a TTS model', async () => {
    seed(chat('small', { default: true }), tts('voxtral'), chat('large'));
    const res = await request(app).post('/api/admin/models/small/_toggle').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(stored('small').default).toBe(false);
    expect(stored('voxtral').default).toBeUndefined();
    expect(stored('large').default).toBe(true);
  });

  test('disabling several models passes the default to a chat model', async () => {
    seed(chat('small', { default: true }), tts('voxtral'), chat('large'));
    const res = await request(app).post('/api/admin/models/small/_toggle').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(stored('voxtral').default).toBeUndefined();
    expect(stored('large').default).toBe(true);
  });

  test('deleting the default passes it to a chat model', async () => {
    seed(chat('small', { default: true }), tts('voxtral'), chat('large'));
    const res = await request(app).delete('/api/admin/models/small');
    expect(res.status).toBe(204);
    expect(stored('voxtral').default).toBeUndefined();
    expect(stored('large').default).toBe(true);
  });
});

/**
 * Behind the config cache of one worker lies a save another worker has just made.
 * A route that rewrote the cached copy of a model would write the old version back
 * over that save, so these routes start from the stored files. Each test seeds the
 * store with the fresh state and the cache with the state before it.
 */
describe('routes that move the default model read the stored files, not a lagging cache', () => {
  /** The cache still shows `large` as it was before its window was raised to 65536. */
  function seedWithLaggingCache(...models) {
    seed(...models);
    staleCache = models.map(model =>
      model.id === 'large' ? { ...model, contextWindow: 4096 } : model
    );
  }

  test('disabling the default does not write the old copy of the model that inherits it', async () => {
    seedWithLaggingCache(chat('small', { default: true }), chat('large', { contextWindow: 65536 }));
    const res = await request(app).post('/api/admin/models/small/_toggle').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(stored('large').default).toBe(true);
    expect(stored('large').contextWindow).toBe(65536);
  });

  test('disabling several models does not write the old copy of the model that inherits the default', async () => {
    seedWithLaggingCache(
      chat('small', { default: true }),
      chat('extra'),
      chat('large', { contextWindow: 65536 })
    );
    const res = await request(app)
      .post('/api/admin/models/small,extra/_toggle')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(stored('small').enabled).toBe(false);
    expect(stored('extra').enabled).toBe(false);
    expect(stored('large').default).toBe(true);
    expect(stored('large').contextWindow).toBe(65536);
  });

  test('deleting the default does not write the old copy of the model that inherits it', async () => {
    seedWithLaggingCache(chat('small', { default: true }), chat('large', { contextWindow: 65536 }));
    const res = await request(app).delete('/api/admin/models/small');
    expect(res.status).toBe(204);
    expect(stored('small')).toBeUndefined();
    expect(stored('large').default).toBe(true);
    expect(stored('large').contextWindow).toBe(65536);
  });

  test('saving a model as the default does not write back the old copy of the previous default', async () => {
    // The stored default already moved to `small`; the cache still says `large`, with its old window.
    seed(chat('small', { default: true }), chat('large', { contextWindow: 65536 }));
    staleCache = [chat('small'), chat('large', { default: true, contextWindow: 4096 })];
    const res = await request(app)
      .post('/api/admin/models')
      .send({ ...chat('fresh'), default: true });
    expect(res.status).toBe(201);
    expect(stored('fresh').default).toBe(true);
    expect(stored('small').default).toBe(false);
    // `large` was not the stored default: its file is left as it is.
    expect(stored('large').contextWindow).toBe(65536);
  });

  test('replacing a model as the default does not write back the old copy of the previous default', async () => {
    seed(chat('small', { default: true }), chat('large', { contextWindow: 65536 }), chat('extra'));
    staleCache = [
      chat('small'),
      chat('large', { default: true, contextWindow: 4096 }),
      chat('extra')
    ];
    const res = await request(app)
      .put('/api/admin/models/extra')
      .send({ ...chat('extra'), default: true });
    expect(res.status).toBe(200);
    expect(stored('extra').default).toBe(true);
    expect(stored('small').default).toBe(false);
    expect(stored('large').contextWindow).toBe(65536);
  });

  test('a toggle leaves the models the cache holds untouched', async () => {
    seed(chat('small', { default: true }), chat('large'));
    const before = JSON.stringify(modelsInStore());
    const res = await request(app).post('/api/admin/models/large/_toggle').send({ enabled: false });
    expect(res.status).toBe(200);
    // Only the toggled model changed on disk; the default stayed where it was.
    expect(stored('large').enabled).toBe(false);
    expect(stored('small')).toEqual(JSON.parse(before).find(m => m.id === 'small'));
  });

  test('toggling a model that has no file skips it and writes nothing', async () => {
    seed(chat('small', { default: true }));
    staleCache = [chat('small', { default: true }), chat('ghost')];
    const res = await request(app).post('/api/admin/models/ghost/_toggle').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(stored('ghost')).toBeUndefined();
  });
});
