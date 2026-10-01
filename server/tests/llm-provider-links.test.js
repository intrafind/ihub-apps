/**
 * Custom LLM providers and the models linked to them.
 *
 * A provider such as T-Systems LLM Hub holds one API key and declares the API
 * type its endpoint speaks (`apiType`); its models carry `providerId`. What
 * has to hold:
 *   - a linked model takes its key from the provider, and never falls back to
 *     the environment key of its API type (OPENAI_API_KEY must not reach LLM Hub);
 *   - a linked model's `provider` always equals the provider's `apiType`, also
 *     after the provider's API type changes;
 *   - provider name and description are plain text;
 *   - a provider still used by models cannot be deleted.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

process.env.OPENAI_API_KEY = 'sk-openai-env';
process.env.GATEWAY_API_KEY = 'gateway-env-key';

/** In-memory `contents/`, keyed by relative path. */
const store = {};
const clone = value => JSON.parse(JSON.stringify(value));

function reset() {
  for (const key of Object.keys(store)) delete store[key];
  store['config/providers.json'] = {
    providers: [
      { id: 'openai', name: 'OpenAI', description: 'OpenAI API', enabled: true },
      { id: 'local', name: 'Local LLM', description: '', enabled: true },
      {
        id: 'llmhub',
        name: 'T-Systems LLM Hub',
        description: '',
        category: 'llm',
        apiType: 'openai',
        apiKey: 'enc:llmhub-secret',
        enabled: true
      },
      { id: 'gateway', name: 'Gateway', category: 'llm', apiType: 'openai', enabled: true },
      { id: 'nokey', name: 'No key', category: 'llm', apiType: 'openai', enabled: true },
      // Created before API-type names were reserved as provider IDs.
      {
        id: 'openai-responses',
        name: 'Legacy gateway',
        category: 'llm',
        apiType: 'openai-responses',
        enabled: true
      },
      { id: 'brave', name: 'Brave', category: 'websearch', enabled: true }
    ]
  };
}

function modelsInStore() {
  return Object.entries(store)
    .filter(([key]) => key.startsWith('models/'))
    .map(([, value]) => clone(value));
}

function addModel(model) {
  store[`models/${model.id}.json`] = clone(model);
}

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: value => value,
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getModels: () => ({ data: modelsInStore(), etag: 'm' }),
    getProviders: () => ({ data: clone(store['config/providers.json'].providers), etag: 'p' }),
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

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    encryptString: value => `enc:${value}`,
    isEncrypted: value => typeof value === 'string' && value.startsWith('enc:'),
    decryptString: value => value.slice(4)
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { default: registerAdminModelsRoutes } = await import('../routes/admin/models.js');
const { default: registerAdminProvidersRoutes } = await import('../routes/admin/providers.js');
const { getApiKeyForModel } = await import('../utils.js');
const { modelConfigSchema } = await import('../validators/modelConfigSchema.js');
const { MODEL_API_TYPES } = await import('../../shared/llmProviders.js');

const app = express();
app.use(express.json());
registerAdminModelsRoutes(app);
registerAdminProvidersRoutes(app);

const baseModel = {
  modelId: 'gpt-oss-120b',
  name: { en: 'GPT OSS 120B' },
  description: { en: 'Imported' },
  url: 'https://llm-server.llmhub.t-systems.net/v2/chat/completions'
};

beforeEach(reset);

describe('API key of a linked model', () => {
  it('comes from the linked provider', async () => {
    addModel({ ...baseModel, id: 'llmhub-gpt-oss', provider: 'openai', providerId: 'llmhub' });
    expect(await getApiKeyForModel('llmhub-gpt-oss')).toBe('llmhub-secret');
  });

  it("falls back to the provider's own environment variable", async () => {
    addModel({ ...baseModel, id: 'gw-model', provider: 'openai', providerId: 'gateway' });
    expect(await getApiKeyForModel('gw-model')).toBe('gateway-env-key');
  });

  it('never falls back to the environment key of its API type', async () => {
    addModel({ ...baseModel, id: 'nokey-model', provider: 'openai', providerId: 'nokey' });
    expect(await getApiKeyForModel('nokey-model')).toBeNull();
  });

  it('is unchanged for unlinked models', async () => {
    addModel({ ...baseModel, id: 'plain-openai', provider: 'openai' });
    expect(await getApiKeyForModel('plain-openai')).toBe('sk-openai-env');
  });
});

describe('POST/PUT /api/admin/models with providerId', () => {
  it("takes the provider's API type and stores no key on the model", async () => {
    const res = await request(app)
      .post('/api/admin/models')
      .send({ ...baseModel, id: 'llmhub-gpt-oss', provider: 'local', providerId: 'llmhub' });
    expect(res.status).toBe(200);
    expect(store['models/llmhub-gpt-oss.json']).toMatchObject({
      provider: 'openai',
      providerId: 'llmhub'
    });
    expect(store['models/llmhub-gpt-oss.json'].apiKey).toBeUndefined();
  });

  it('drops a link to the built-in provider of the same API type', async () => {
    const res = await request(app)
      .post('/api/admin/models')
      .send({ ...baseModel, id: 'gpt-x', provider: 'openai', providerId: 'openai' });
    expect(res.status).toBe(200);
    expect(store['models/gpt-x.json'].providerId).toBeUndefined();
  });

  it('keeps a link to a custom provider even when its ID equals its API type', async () => {
    const res = await request(app)
      .post('/api/admin/models')
      .send({ ...baseModel, id: 'legacy-m', provider: 'openai', providerId: 'openai-responses' });
    expect(res.status).toBe(200);
    expect(store['models/legacy-m.json']).toMatchObject({
      provider: 'openai-responses',
      providerId: 'openai-responses'
    });
  });

  it('rejects a link to an unknown or non-LLM provider', async () => {
    for (const providerId of ['missing', 'brave']) {
      const res = await request(app)
        .post('/api/admin/models')
        .send({ ...baseModel, id: `m-${providerId}`, provider: 'openai', providerId });
      expect(res.status).toBe(400);
    }
  });

  it('keeps the link in line on update', async () => {
    addModel({ ...baseModel, id: 'llmhub-gpt-oss', provider: 'openai', providerId: 'llmhub' });
    const res = await request(app)
      .put('/api/admin/models/llmhub-gpt-oss')
      .send({ ...baseModel, id: 'llmhub-gpt-oss', provider: 'mistral', providerId: 'llmhub' });
    expect(res.status).toBe(200);
    expect(store['models/llmhub-gpt-oss.json'].provider).toBe('openai');
  });
});

describe('LLM provider CRUD', () => {
  it('creates a custom LLM provider with plain-text name, API type and base URL', async () => {
    const res = await request(app).post('/api/admin/providers').send({
      id: 'hub2',
      name: '  Hub Two ',
      category: 'llm',
      apiType: 'local',
      baseUrl: 'https://hub2.example.com/v1/',
      apiKey: 'k2'
    });
    expect(res.status).toBe(201);
    const saved = store['config/providers.json'].providers.find(p => p.id === 'hub2');
    expect(saved).toMatchObject({
      name: 'Hub Two',
      description: '',
      apiType: 'local',
      baseUrl: 'https://hub2.example.com/v1',
      apiKey: 'enc:k2',
      enabled: true
    });
  });

  it('requires an API type for a custom LLM provider and text for the name', async () => {
    const noType = await request(app)
      .post('/api/admin/providers')
      .send({ id: 'hub3', name: 'Hub', category: 'llm' });
    expect(noType.status).toBe(400);
    const localizedName = await request(app)
      .post('/api/admin/providers')
      .send({ id: 'hub4', name: { en: 'Hub' }, category: 'llm', apiType: 'openai' });
    expect(localizedName.status).toBe(400);
  });

  it("moves linked models to a provider's new API type", async () => {
    addModel({ ...baseModel, id: 'llmhub-a', provider: 'openai', providerId: 'llmhub' });
    addModel({ ...baseModel, id: 'other', provider: 'openai' });
    const provider = store['config/providers.json'].providers.find(p => p.id === 'llmhub');
    const res = await request(app)
      .put('/api/admin/providers/llmhub')
      .send({ ...provider, apiKey: '••••••••', apiType: 'local', category: 'custom' });
    expect(res.status).toBe(200);
    expect(res.body.updatedModels).toEqual(['llmhub-a']);
    expect(store['models/llmhub-a.json'].provider).toBe('local');
    expect(store['models/other.json'].provider).toBe('openai');
    const saved = store['config/providers.json'].providers.find(p => p.id === 'llmhub');
    // The category is fixed at creation and the stored key is preserved.
    expect(saved.category).toBe('llm');
    expect(saved.apiKey).toBe('enc:llmhub-secret');
  });

  it('drops an API type sent for a built-in provider', async () => {
    const res = await request(app)
      .put('/api/admin/providers/openai')
      .send({ id: 'openai', name: 'OpenAI (company)', apiType: 'local' });
    expect(res.status).toBe(200);
    const saved = store['config/providers.json'].providers.find(p => p.id === 'openai');
    expect(saved.name).toBe('OpenAI (company)');
    expect(saved.apiType).toBeUndefined();
  });

  it('refuses to delete a provider that models are linked to', async () => {
    addModel({ ...baseModel, id: 'llmhub-a', provider: 'openai', providerId: 'llmhub' });
    const refused = await request(app).delete('/api/admin/providers/llmhub');
    expect(refused.status).toBe(409);
    expect(refused.body.linkedModels).toEqual(['llmhub-a']);

    delete store['models/llmhub-a.json'];
    const deleted = await request(app).delete('/api/admin/providers/llmhub');
    expect(deleted.status).toBe(200);
  });

  it('refuses an API-type name as the ID of a new provider', async () => {
    for (const id of ['google-live', 'openai-responses', 'vllm-realtime']) {
      const res = await request(app)
        .post('/api/admin/providers')
        .send({ id, name: 'Gateway', category: 'llm', apiType: 'openai' });
      expect(res.status).toBe(400);
    }
  });

  it('reserves exactly the API types the model schema accepts', () => {
    expect([...MODEL_API_TYPES].sort()).toEqual(
      [...modelConfigSchema.shape.provider.options].sort()
    );
  });

  it('refuses to delete a built-in provider', async () => {
    const res = await request(app).delete('/api/admin/providers/local');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/models/_discover with providerId', () => {
  it('answers 404 for an unknown provider and 400 for a non-LLM one', async () => {
    const missing = await request(app)
      .post('/api/admin/models/_discover')
      .send({ providerId: 'missing', url: 'https://host/v1' });
    expect(missing.status).toBe(404);
    const websearch = await request(app)
      .post('/api/admin/models/_discover')
      .send({ providerId: 'brave', url: 'https://host/v1' });
    expect(websearch.status).toBe(400);
  });

  it('needs a URL when the provider has no base URL', async () => {
    const res = await request(app)
      .post('/api/admin/models/_discover')
      .send({ providerId: 'nokey' });
    expect(res.status).toBe(400);
  });
});
