/**
 * Where a model's API key comes from, and what happens when there is none.
 *
 * What has to hold:
 *   - a stored key the server cannot decrypt is reported as such
 *     (`undecryptable`), not as "no key" — they need different fixes — and a
 *     later source (environment variable) still wins over it;
 *   - a local server, or an OpenAI-compatible one at a custom URL, runs
 *     without a key; the vendors' own endpoints and models linked to a custom
 *     provider do not;
 *   - the chat path reports each case with its own error (`API_KEY_ERROR`
 *     for none, `API_KEY_UNDECRYPTABLE` for an unreadable one) and a keyless
 *     model passes with no key at all;
 *   - the admin status endpoints say the same, and never return a key;
 *   - the request goes out without an Authorization header when there is no key.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// config.js snapshots the environment when it is first imported.
delete process.env.OPENAI_API_KEY;
delete process.env.LOCAL_API_KEY;
delete process.env.DEFAULT_API_KEY;
process.env.GATEWAY_API_KEY = 'gateway-env-key';
process.env.ANTHROPIC_API_KEY = 'sk-ant-env';

/** In-memory `contents/`, keyed by relative path. */
const store = {};
const clone = value => JSON.parse(JSON.stringify(value));

function reset() {
  for (const key of Object.keys(store)) delete store[key];
  store['config/providers.json'] = {
    providers: [
      { id: 'openai', name: 'OpenAI', enabled: true },
      { id: 'local', name: 'Local LLM', enabled: true },
      { id: 'anthropic', name: 'Anthropic', enabled: true },
      { id: 'gateway', name: 'Gateway', category: 'llm', apiType: 'openai', enabled: true },
      { id: 'sealed', name: 'Sealed', category: 'llm', apiType: 'openai', enabled: true },
      {
        id: 'broken',
        name: 'Broken',
        category: 'llm',
        apiType: 'openai',
        apiKey: 'enc:bad-key',
        enabled: true
      },
      { id: 'localgw', name: 'Local gateway', category: 'llm', apiType: 'local', enabled: true },
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
  store[`models/${model.id}.json`] = {
    modelId: 'm',
    name: { en: model.id },
    description: { en: 'test' },
    enabled: true,
    ...clone(model)
  };
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
    getLocalizations: () => ({
      data: {
        serverErrors: {
          apiKeyNotFound: 'API key not found for provider: {provider}',
          apiKeyUnreadable: 'Stored key of {modelId} cannot be decrypted',
          internalError: 'Internal server error'
        }
      }
    }),
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
    remove: async () => false,
    resolveIdToPath: async (kind, id) => `${kind}/${id}.json`
  }
}));

// A value starting `enc:bad` stands for one encrypted under another server key.
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    encryptString: value => `enc:${value}`,
    isEncrypted: value => typeof value === 'string' && value.startsWith('enc:'),
    decryptString: value => {
      if (value.startsWith('enc:bad')) throw new Error('Failed to decrypt string.');
      return value.slice(4);
    }
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { default: registerAdminModelsRoutes } = await import('../routes/admin/models.js');
const { default: registerAdminProvidersRoutes } = await import('../routes/admin/providers.js');
const { resolveModelApiKey, getApiKeyForModel } = await import('../utils.js');
const { default: ApiKeyVerifier } = await import('../utils/ApiKeyVerifier.js');
const { default: logger } = await import('../utils/logger.js');
const { allowsMissingApiKey } = await import('../../shared/llmProviders.js');
const { default: VLLMAdapter } = await import('../adapters/vllm.js');
const { default: AnthropicAdapter } = await import('../adapters/anthropic.js');

const app = express();
app.use(express.json());
registerAdminModelsRoutes(app);
registerAdminProvidersRoutes(app);

beforeEach(reset);

describe('allowsMissingApiKey', () => {
  it('allows local servers', () => {
    expect(allowsMissingApiKey({ provider: 'local' })).toBe(true);
    expect(allowsMissingApiKey({ provider: 'local', providerId: 'my-vllm' })).toBe(true);
  });

  it('allows an OpenAI-compatible server at a custom URL', () => {
    expect(
      allowsMissingApiKey({ provider: 'openai', url: 'http://gpu01:8000/v1/chat/completions' })
    ).toBe(true);
  });

  it("does not allow the vendors' own endpoints or models of a custom provider", () => {
    expect(
      allowsMissingApiKey({
        provider: 'openai',
        url: 'https://api.openai.com/v1/chat/completions'
      })
    ).toBe(false);
    expect(
      allowsMissingApiKey({ provider: 'openai', providerId: 'gateway', url: 'https://gw/v1' })
    ).toBe(false);
    expect(allowsMissingApiKey({ provider: 'openai' })).toBe(false);
    expect(allowsMissingApiKey({ provider: 'openai', url: 'not a url' })).toBe(false);
    expect(allowsMissingApiKey({ provider: 'anthropic', url: 'http://localhost/v1' })).toBe(false);
    expect(allowsMissingApiKey(null)).toBe(false);
  });
});

describe('resolveModelApiKey', () => {
  it('uses the key stored on the model', async () => {
    addModel({ id: 'm1', provider: 'openai', apiKey: 'enc:sk-model' });
    expect(await resolveModelApiKey('m1')).toMatchObject({
      state: 'ok',
      source: 'model',
      apiKey: 'sk-model'
    });
  });

  it('uses the environment variable of the API type', async () => {
    addModel({ id: 'claude', provider: 'anthropic' });
    expect(await resolveModelApiKey('claude')).toMatchObject({
      state: 'ok',
      source: 'env',
      envVar: 'ANTHROPIC_API_KEY',
      apiKey: 'sk-ant-env'
    });
  });

  it('reports a stored key it cannot decrypt as undecryptable, not as missing', async () => {
    addModel({ id: 'm1', provider: 'openai', apiKey: 'enc:bad-1' });
    expect(await resolveModelApiKey('m1')).toMatchObject({
      state: 'undecryptable',
      source: 'model',
      apiKey: null
    });
  });

  it('also reports an unreadable key on the provider entry', async () => {
    addModel({ id: 'm1', provider: 'openai', providerId: 'broken' });
    expect(await resolveModelApiKey('m1')).toMatchObject({
      state: 'undecryptable',
      source: 'provider'
    });
  });

  it('lets a later source win over an unreadable key', async () => {
    addModel({ id: 'm1', provider: 'anthropic', apiKey: 'enc:bad-1' });
    expect(await resolveModelApiKey('m1')).toMatchObject({
      state: 'ok',
      source: 'env',
      apiKey: 'sk-ant-env'
    });
  });

  it('does not treat an unreadable key as "no key needed" for a local server', async () => {
    addModel({ id: 'loc', provider: 'local', apiKey: 'enc:bad-1' });
    expect((await resolveModelApiKey('loc')).state).toBe('undecryptable');
  });

  it('lets a local server run without a key', async () => {
    addModel({ id: 'loc', provider: 'local', url: 'http://localhost:1234/v1/chat/completions' });
    expect(await resolveModelApiKey('loc')).toMatchObject({
      state: 'keyless',
      source: 'none',
      apiKey: null
    });
    expect(await getApiKeyForModel('loc')).toBeNull();
  });

  it('lets an OpenAI-compatible server at a custom URL run without a key', async () => {
    addModel({ id: 'gpu', provider: 'openai', url: 'http://gpu01:8000/v1/chat/completions' });
    expect((await resolveModelApiKey('gpu')).state).toBe('keyless');
  });

  it("still requires a key for OpenAI's own endpoint", async () => {
    addModel({
      id: 'gpt',
      provider: 'openai',
      url: 'https://api.openai.com/v1/chat/completions'
    });
    expect((await resolveModelApiKey('gpt')).state).toBe('missing');
  });

  it('still requires a key for a model linked to a custom provider', async () => {
    addModel({ id: 'linked', provider: 'openai', providerId: 'sealed', url: 'http://gw/v1' });
    expect((await resolveModelApiKey('linked')).state).toBe('missing');
  });

  it("sends a configured key to a local server — keyless only applies when there's none", async () => {
    addModel({ id: 'loc', provider: 'local', apiKey: 'enc:lm-studio' });
    expect(await resolveModelApiKey('loc')).toMatchObject({ state: 'ok', apiKey: 'lm-studio' });
  });

  it('reports an unknown model', async () => {
    expect((await resolveModelApiKey('nope')).state).toBe('unknown-model');
  });
});

describe('ApiKeyVerifier.verifyApiKey', () => {
  const verifier = new ApiKeyVerifier();

  it('passes a model with a key', async () => {
    addModel({ id: 'm1', provider: 'openai', apiKey: 'enc:sk-model' });
    expect(await verifier.verifyApiKey({ id: 'm1', provider: 'openai' })).toEqual({
      success: true,
      apiKey: 'sk-model'
    });
  });

  it('passes a keyless model with no key', async () => {
    addModel({ id: 'loc', provider: 'local' });
    expect(await verifier.verifyApiKey({ id: 'loc', provider: 'local' })).toEqual({
      success: true,
      apiKey: null
    });
  });

  it('fails a model that needs a key with API_KEY_ERROR', async () => {
    addModel({ id: 'gpt', provider: 'openai', url: 'https://api.openai.com/v1/chat/completions' });
    const result = await verifier.verifyApiKey({ id: 'gpt', provider: 'openai' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('API_KEY_ERROR');
    expect(result.error.message).toContain('API key not found');
  });

  it('fails an unreadable key with its own error, naming the model', async () => {
    addModel({ id: 'm1', provider: 'openai', apiKey: 'enc:bad-1' });
    const result = await verifier.verifyApiKey({ id: 'm1', provider: 'openai' });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('API_KEY_UNDECRYPTABLE');
    expect(result.error.message).toBe('Stored key of m1 cannot be decrypted');
    // Handled like a missing key wherever the code is checked by prefix.
    expect(result.error.code.startsWith('API_KEY')).toBe(true);
  });
});

describe('startup validation', () => {
  it('names the models whose stored key cannot be decrypted', async () => {
    addModel({ id: 'm1', provider: 'openai', apiKey: 'enc:bad-1', enabled: true });
    addModel({ id: 'm2', provider: 'openai', apiKey: 'enc:sk-fine', enabled: true });
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await new ApiKeyVerifier().validateEnabledModelsApiKeys(modelsInStore());

    const call = errorLog.mock.calls.find(([message]) => /cannot be decrypted/.test(message));
    errorLog.mockRestore();
    expect(call?.[1]).toMatchObject({ component: 'ApiKeyVerifier', modelIds: ['m1'] });
  });

  it('accepts a local server and a custom-URL OpenAI server without a key', async () => {
    const verifier = new ApiKeyVerifier();
    const result = await verifier.validateEnabledModelsApiKeys([
      { id: 'loc', provider: 'local', enabled: true },
      { id: 'gpu', provider: 'openai', enabled: true, url: 'http://gpu01:8000/v1/chat/completions' }
    ]);
    expect(result).toEqual({ valid: true, missing: {}, unreadable: [] });
  });

  it('does not let a keyless model hide a missing key of another model of the same API type', async () => {
    const gpu = { id: 'gpu', provider: 'openai', enabled: true, url: 'http://gpu01:8000/v1' };
    const official = {
      id: 'gpt',
      provider: 'openai',
      enabled: true,
      url: 'https://api.openai.com/v1/chat/completions'
    };
    const verifier = new ApiKeyVerifier();

    // Whichever of the two comes first.
    for (const models of [
      [gpu, official],
      [official, gpu]
    ]) {
      const result = await verifier.validateEnabledModelsApiKeys(models);
      expect(result).toEqual({ valid: false, missing: { openai: ['gpt'] }, unreadable: [] });
    }
  });

  it('fails validation for a model whose only key cannot be decrypted', async () => {
    addModel({ id: 'm1', provider: 'openai', apiKey: 'enc:bad-1', enabled: true });
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const result = await new ApiKeyVerifier().validateEnabledModelsApiKeys(modelsInStore());

    errorLog.mockRestore();
    expect(result).toEqual({ valid: false, missing: {}, unreadable: ['m1'] });
  });

  it('judges a model linked to a custom provider by that provider, not by its API type', async () => {
    // ANTHROPIC_API_KEY is set, but a model linked to a provider takes only the provider's key.
    const result = await new ApiKeyVerifier().validateEnabledModelsApiKeys([
      { id: 'linked', provider: 'openai', providerId: 'sealed', enabled: true }
    ]);
    expect(result.missing).toEqual({ sealed: ['linked'] });
  });
});

describe('GET /api/admin/models/_key-status', () => {
  it('reports each chat model and never returns a key', async () => {
    addModel({ id: 'withkey', provider: 'openai', apiKey: 'enc:sk-secret-value' });
    addModel({ id: 'unreadable', provider: 'openai', apiKey: 'enc:bad-1' });
    addModel({ id: 'loc', provider: 'local', enabled: false });
    addModel({
      id: 'nokey',
      provider: 'openai',
      url: 'https://api.openai.com/v1/chat/completions'
    });
    addModel({ id: 'voice', provider: 'openai', modelType: 'transcription' });

    const res = await request(app).get('/api/admin/models/_key-status');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.statuses).toEqual({
      withkey: { state: 'ok', source: 'model', envVar: null, enabled: true },
      unreadable: { state: 'undecryptable', source: 'model', envVar: null, enabled: true },
      loc: { state: 'keyless', source: 'none', envVar: null, enabled: false },
      nokey: { state: 'missing', source: 'none', envVar: null, enabled: true }
    });
    expect(JSON.stringify(res.body)).not.toContain('sk-secret-value');
  });

  it('keeps a model whose id is a prototype property name', async () => {
    // The admin API rejects such ids, but a hand-written model file can carry one.
    addModel({ id: '__proto__', provider: 'local' });

    const res = await request(app).get('/api/admin/models/_key-status');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.statuses)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(res.body.statuses, '__proto__')?.value.state).toBe(
      'keyless'
    );
  });
});

describe('GET /api/admin/providers/_key-status', () => {
  it('reports LLM providers only', async () => {
    const res = await request(app).get('/api/admin/providers/_key-status');

    expect(res.status).toBe(200);
    expect(res.body.statuses.broken).toEqual({
      state: 'undecryptable',
      source: 'provider',
      envVar: null
    });
    expect(res.body.statuses.gateway).toEqual({
      state: 'ok',
      source: 'env',
      envVar: 'GATEWAY_API_KEY'
    });
    expect(res.body.statuses.sealed).toMatchObject({ state: 'missing', envVar: 'SEALED_API_KEY' });
    expect(res.body.statuses.local.state).toBe('keyless');
    // A custom provider speaking the local API type runs its models without a
    // key, so it must not read as "missing" next to them.
    expect(res.body.statuses.localgw.state).toBe('keyless');
    expect(res.body.statuses.anthropic).toMatchObject({ state: 'ok', source: 'env' });
    expect(res.body.statuses.brave).toBeUndefined();
  });
});

describe('request headers', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const model = {
    id: 'loc',
    modelId: 'served-model',
    provider: 'local',
    url: 'http://localhost:1234/v1/chat/completions'
  };

  it('sends no Authorization header without a key', async () => {
    for (const noKey of [null, undefined, '']) {
      const req = await VLLMAdapter.createCompletionRequest(model, messages, noKey, {});
      expect(req.headers).not.toHaveProperty('Authorization');
      expect(req.headers['Content-Type']).toBe('application/json');
    }
  });

  it('sends the key as a bearer token when there is one', async () => {
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'lm-studio', {});
    expect(req.headers.Authorization).toBe('Bearer lm-studio');
  });

  it('keeps sending a whitespace-only key as before, for gateways that need the header', async () => {
    const req = await VLLMAdapter.createCompletionRequest(model, messages, '   ', {});
    expect(req.headers.Authorization).toBe('Bearer    ');
  });

  it('leaves Anthropic untouched', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(
      { id: 'c', modelId: 'claude', provider: 'anthropic', url: 'https://api.anthropic.com/v1' },
      messages,
      'sk-ant',
      {}
    );
    expect(req.headers['x-api-key']).toBe('sk-ant');
  });
});
