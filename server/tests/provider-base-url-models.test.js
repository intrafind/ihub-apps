// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Linked models follow a change of their provider's base URL.
 *
 * A model created by the connect wizard or the import dialog stores its own
 * full API URL, built from the provider's base URL at that moment. When the
 * admin changes the base URL (PUT /api/admin/providers/{id}), every linked
 * model whose URL starts with the old base is moved to the new one:
 *   - the prefix is replaced, the rest of the URL is kept;
 *   - models of other providers are not touched;
 *   - a linked model with a URL of its own is left alone and reported;
 *   - each moved model gets a history snapshot and an audit entry.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

/** In-memory `contents/`, keyed by relative path. */
const store = {};
const snapshots = [];
const audits = [];
const clone = value => JSON.parse(JSON.stringify(value));

const OLD_BASE = 'https://hub.example.com/v1';
const NEW_BASE = 'https://proxy.example.com/llm/v2';

function reset() {
  for (const key of Object.keys(store)) delete store[key];
  snapshots.length = 0;
  audits.length = 0;
  store['config/providers.json'] = {
    providers: [
      {
        id: 'llmhub',
        name: 'LLM Hub',
        description: '',
        category: 'llm',
        apiType: 'openai',
        baseUrl: OLD_BASE,
        apiKey: 'enc:secret',
        enabled: true
      },
      {
        id: 'otherhub',
        name: 'Other hub',
        description: '',
        category: 'llm',
        apiType: 'openai',
        baseUrl: OLD_BASE,
        enabled: true
      }
    ]
  };
}

function addModel(model) {
  store[`models/${model.id}.json`] = clone({
    name: { en: model.id },
    description: { en: 'Imported' },
    modelId: model.id,
    provider: 'openai',
    enabled: true,
    ...model
  });
}

const modelsInStore = () =>
  Object.entries(store)
    .filter(([key]) => key.startsWith('models/'))
    .map(([, value]) => clone(value));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin', username: 'admin' };
    next();
  }
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
    updateJson: async (rel, mutate) => {
      const next = await mutate(rel in store ? clone(store[rel]) : null);
      if (next !== undefined) store[rel] = clone(next);
      return { data: rel in store ? clone(store[rel]) : null, written: next !== undefined };
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
  logAudit: async entry => {
    audits.push({ ...entry, req: undefined });
  }
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async entry => {
    snapshots.push(clone(entry));
  }
}));

const { default: registerAdminProvidersRoutes, rebaseModelUrl } =
  await import('../routes/admin/providers.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminProvidersRoutes(app);
app.use(errorHandler);

const providerEntry = id => clone(store['config/providers.json'].providers.find(p => p.id === id));

function saveProvider(id, changes) {
  return request(app)
    .put(`/api/admin/providers/${id}`)
    .send({ ...providerEntry(id), apiKey: '••••••••', ...changes });
}

beforeEach(reset);

describe('rebaseModelUrl', () => {
  it('replaces the old base and keeps the rest of the URL', () => {
    expect(rebaseModelUrl(`${OLD_BASE}/chat/completions`, OLD_BASE, NEW_BASE)).toBe(
      `${NEW_BASE}/chat/completions`
    );
    expect(rebaseModelUrl(OLD_BASE, OLD_BASE, NEW_BASE)).toBe(NEW_BASE);
    expect(rebaseModelUrl(`${OLD_BASE}?x=1`, OLD_BASE, NEW_BASE)).toBe(`${NEW_BASE}?x=1`);
  });

  it('only matches the old base at a path boundary', () => {
    expect(rebaseModelUrl('https://hub.example.com/v10/chat', OLD_BASE, NEW_BASE)).toBeNull();
    expect(rebaseModelUrl('https://elsewhere.example.com/v1/chat', OLD_BASE, NEW_BASE)).toBeNull();
    expect(rebaseModelUrl(undefined, OLD_BASE, NEW_BASE)).toBeNull();
  });
});

describe('PUT /api/admin/providers/{id} with a new base URL', () => {
  it('moves the linked models built from the old base URL', async () => {
    addModel({ id: 'hub-a', providerId: 'llmhub', url: `${OLD_BASE}/chat/completions` });
    addModel({ id: 'hub-b', providerId: 'llmhub', url: `${OLD_BASE}/responses` });

    const res = await saveProvider('llmhub', { baseUrl: `${NEW_BASE}/` });

    expect(res.status).toBe(200);
    expect(res.body.provider.baseUrl).toBe(NEW_BASE);
    expect(res.body.modelUrls).toEqual({ updated: ['hub-a', 'hub-b'], skipped: [] });
    expect(store['models/hub-a.json'].url).toBe(`${NEW_BASE}/chat/completions`);
    expect(store['models/hub-b.json'].url).toBe(`${NEW_BASE}/responses`);
  });

  it('leaves models of other providers alone', async () => {
    addModel({ id: 'hub-a', providerId: 'llmhub', url: `${OLD_BASE}/chat/completions` });
    // Same old URL, but linked to another provider.
    addModel({ id: 'other-a', providerId: 'otherhub', url: `${OLD_BASE}/chat/completions` });
    // Not linked to any custom provider.
    addModel({ id: 'plain', url: `${OLD_BASE}/chat/completions` });

    const res = await saveProvider('llmhub', { baseUrl: NEW_BASE });

    expect(res.body.modelUrls.updated).toEqual(['hub-a']);
    expect(store['models/other-a.json'].url).toBe(`${OLD_BASE}/chat/completions`);
    expect(store['models/plain.json'].url).toBe(`${OLD_BASE}/chat/completions`);
  });

  it('reports a linked model with a URL of its own as not changed', async () => {
    addModel({ id: 'hub-a', providerId: 'llmhub', url: `${OLD_BASE}/chat/completions` });
    addModel({
      id: 'hub-custom',
      providerId: 'llmhub',
      url: 'https://custom.example.com/v1/chat/completions'
    });

    const res = await saveProvider('llmhub', { baseUrl: NEW_BASE });

    expect(res.body.modelUrls).toEqual({
      updated: ['hub-a'],
      skipped: [{ id: 'hub-custom', url: 'https://custom.example.com/v1/chat/completions' }]
    });
    expect(store['models/hub-custom.json'].url).toBe(
      'https://custom.example.com/v1/chat/completions'
    );
  });

  it('keeps a history snapshot and an audit entry per moved model', async () => {
    addModel({ id: 'hub-a', providerId: 'llmhub', url: `${OLD_BASE}/chat/completions` });
    addModel({ id: 'hub-custom', providerId: 'llmhub', url: 'https://custom.example.com/v1' });

    await saveProvider('llmhub', { baseUrl: NEW_BASE });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      resource: 'model',
      id: 'hub-a',
      admin: 'admin',
      before: { url: `${OLD_BASE}/chat/completions` },
      after: { url: `${NEW_BASE}/chat/completions` }
    });
    expect(audits).toEqual([
      expect.objectContaining({ action: 'update', resource: 'model', resourceId: 'hub-a' })
    ]);
  });

  it('changes no model when the base URL stays the same', async () => {
    addModel({ id: 'hub-a', providerId: 'llmhub', url: `${OLD_BASE}/chat/completions` });

    const res = await saveProvider('llmhub', { name: 'Renamed hub' });

    expect(res.status).toBe(200);
    expect(res.body.modelUrls).toEqual({ updated: [], skipped: [] });
    expect(store['models/hub-a.json'].url).toBe(`${OLD_BASE}/chat/completions`);
    expect(snapshots).toHaveLength(0);
  });

  it('changes no model when the base URL is removed', async () => {
    addModel({ id: 'hub-a', providerId: 'llmhub', url: `${OLD_BASE}/chat/completions` });

    const res = await saveProvider('llmhub', { baseUrl: '' });

    expect(res.body.modelUrls).toEqual({ updated: [], skipped: [] });
    expect(store['models/hub-a.json'].url).toBe(`${OLD_BASE}/chat/completions`);
  });
});
