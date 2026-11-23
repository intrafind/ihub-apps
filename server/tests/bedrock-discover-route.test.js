// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AWS Bedrock in `POST /api/admin/models/_discover` and on the provider entry:
 *   - the listing is asked for per region (typed → provider `config.region` →
 *     environment → eu-central-1), with the provider's stored key;
 *   - a value that is not an AWS region is refused with 400 before AWS is called;
 *   - AWS's refusals reach the client as the readable `messageKey`;
 *   - the region on the `bedrock` provider is validated when it is saved.
 *
 * The Bedrock listing itself is replaced by a recorder; its own behaviour is
 * covered in bedrock-model-discovery.test.js.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

delete process.env.AWS_REGION;
delete process.env.AWS_DEFAULT_REGION;

const store = {};
const clone = value => JSON.parse(JSON.stringify(value));

function reset() {
  for (const key of Object.keys(store)) delete store[key];
  store['config/providers.json'] = {
    providers: [
      {
        id: 'bedrock',
        name: 'AWS Bedrock',
        description: 'AWS Bedrock foundation models via the Converse API',
        category: 'llm',
        enabled: true,
        apiKey: 'enc:bedrock-secret',
        config: { region: 'eu-west-1' }
      },
      { id: 'openai', name: 'OpenAI', description: '', enabled: true }
    ]
  };
  store['models/bedrock-sonnet.json'] = {
    id: 'bedrock-sonnet',
    modelId: 'eu.anthropic.claude-sonnet-4-20250514-v1:0',
    provider: 'bedrock'
  };
  // Same remote id on another API type: not the Bedrock model.
  store['models/other-mistral.json'] = {
    id: 'other-mistral',
    modelId: 'mistral.mistral-large-2402-v1:0',
    provider: 'openai',
    url: 'https://example.com/v1/chat/completions'
  };
}

const providers = () => store['config/providers.json'].providers;
const modelsInStore = () =>
  Object.entries(store)
    .filter(([key]) => key.startsWith('models/'))
    .map(([, value]) => clone(value));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: value => value,
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getModels: () => ({ data: modelsInStore(), etag: 'm' }),
    getProviders: () => ({ data: clone(providers()), etag: 'p' }),
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
    remove: async () => false,
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

const discoverCalls = [];
let discoverImpl = null;
jest.unstable_mockModule('../services/BedrockModelDiscovery.js', () => ({
  BEDROCK_API_TYPE: 'bedrock',
  discoverBedrockModels: async params => {
    discoverCalls.push(params);
    if (discoverImpl) return discoverImpl(params);
    return {
      provider: 'bedrock',
      modelsUrl: `https://bedrock.${params.region}.amazonaws.com/foundation-models`,
      baseUrl: `https://bedrock.${params.region}.amazonaws.com`,
      azure: false,
      region: params.region,
      models: [
        { id: 'eu.anthropic.claude-sonnet-4-20250514-v1:0', type: 'chat' },
        { id: 'mistral.mistral-large-2402-v1:0', type: 'chat' }
      ]
    };
  }
}));

const { default: registerAdminModelsRoutes } = await import('../routes/admin/models.js');
const { default: registerAdminProvidersRoutes } = await import('../routes/admin/providers.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { ModelDiscoveryError } = await import('../services/ModelEndpointDiscovery.js');

const app = express();
app.use(express.json());
registerAdminModelsRoutes(app);
registerAdminProvidersRoutes(app);
app.use(errorHandler);

const discover = body => request(app).post('/api/admin/models/_discover').send(body);

beforeEach(() => {
  reset();
  discoverCalls.length = 0;
  discoverImpl = null;
});

describe('POST /api/admin/models/_discover for AWS Bedrock', () => {
  it('lists the region stored on the provider with its stored key; no URL needed', async () => {
    const res = await discover({ providerId: 'bedrock' });
    expect(res.status).toBe(200);
    expect(discoverCalls).toEqual([{ region: 'eu-west-1', apiKey: 'bedrock-secret' }]);
    expect(res.body.apiType).toBe('bedrock');
    expect(res.body.region).toBe('eu-west-1');
    const flags = Object.fromEntries(res.body.models.map(m => [m.id, m.existingModelId]));
    // Only a Bedrock model counts as "already configured".
    expect(flags['eu.anthropic.claude-sonnet-4-20250514-v1:0']).toBe('bedrock-sonnet');
    expect(flags['mistral.mistral-large-2402-v1:0']).toBeNull();
  });

  it('uses the region and key typed in the wizard over the stored ones', async () => {
    const res = await discover({ providerId: 'bedrock', region: 'us-east-1', apiKey: 'typed' });
    expect(res.status).toBe(200);
    expect(discoverCalls).toEqual([{ region: 'us-east-1', apiKey: 'typed' }]);
  });

  it('falls back to AWS_REGION, then to eu-central-1, when the provider has no region', async () => {
    delete providers()[0].config;
    process.env.AWS_REGION = 'eu-north-1';
    try {
      await discover({ providerId: 'bedrock' });
    } finally {
      delete process.env.AWS_REGION;
    }
    await discover({ providerId: 'bedrock' });
    expect(discoverCalls.map(c => c.region)).toEqual(['eu-north-1', 'eu-central-1']);
  });

  it('refuses a value that is not an AWS region with 400, before calling AWS', async () => {
    const res = await discover({ providerId: 'bedrock', region: 'evil.example.com/x' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(discoverCalls).toHaveLength(0);

    const wrongType = await discover({ providerId: 'bedrock', region: 42 });
    expect(wrongType.status).toBe(400);
  });

  it('accepts apiType bedrock without a provider entry, with the key in the body', async () => {
    const res = await discover({ apiType: 'bedrock', region: 'global', apiKey: 'k' });
    expect(res.status).toBe(200);
    expect(discoverCalls).toEqual([{ region: 'global', apiKey: 'k' }]);
  });

  it('passes AWS refusals on as the readable cause, never as 401', async () => {
    discoverImpl = () => {
      throw new ModelDiscoveryError(
        'authenticationFailed',
        'AWS did not accept the Bedrock API key',
        {
          upstreamStatus: 403,
          details: 'HTTP 403. Check that the key is complete and has not expired.'
        }
      );
    };
    const res = await discover({ providerId: 'bedrock' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('DISCOVERY_FAILED');
    expect(res.body.details.messageKey).toBe('authenticationFailed');
    expect(res.body.details.upstreamStatus).toBe(403);
  });
});

describe('region of the bedrock provider entry', () => {
  const put = body =>
    request(app)
      .put('/api/admin/providers/bedrock')
      .send({ ...clone(providers()[0]), apiKey: '••••••••', ...body });

  it('stores a valid region, trimmed, and keeps the key', async () => {
    const res = await put({ config: { region: ' us-west-2 ' } });
    expect(res.status).toBe(200);
    expect(providers()[0].config).toEqual({ region: 'us-west-2' });
    expect(providers()[0].apiKey).toBe('enc:bedrock-secret');
  });

  it('refuses a value that is not an AWS region', async () => {
    const res = await put({ config: { region: 'eu-central-1.evil.com' } });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/AWS region/);
    expect(providers()[0].config).toEqual({ region: 'eu-west-1' });
  });

  it('removes an empty region, so the environment applies again', async () => {
    const res = await put({ config: { region: '' } });
    expect(res.status).toBe(200);
    expect(providers()[0].config).toBeUndefined();
  });
});
