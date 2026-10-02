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
    // Off here: these specs are about the default flag, and the EU AI Act gate
    // (enabling an unmarked model needs a justification) has its own specs.
    getFeatures: () => ({ aiTransparency: false }),
    getModels: () => ({ data: modelsInStore(), etag: 'm' }),
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
    remove: async rel => {
      const existed = rel in store;
      delete store[rel];
      return existed;
    },
    resolveIdToPath: async (kind, id) => `${kind}/${id}.json`
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
    expect(res.status).toBe(200);
    expect(stored('voxtral').default).toBe(false);
    expect(stored('small').default).toBe(true);
  });

  test('disabling the default passes it to a chat model, not a TTS model', async () => {
    seed(chat('small', { default: true }), tts('voxtral'), chat('large'));
    const res = await request(app).post('/api/admin/models/small/toggle');
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
    expect(res.status).toBe(200);
    expect(stored('voxtral').default).toBeUndefined();
    expect(stored('large').default).toBe(true);
  });
});
