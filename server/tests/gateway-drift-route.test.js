// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/admin/providers/:providerId/_model-drift`: the comparison of an
 * iFinder Model Gateway, or of Google, with the models imported from it.
 *
 * What has to hold:
 *   - the gateway is asked on `/v1/gateway/models` with the provider's stored
 *     project key, and the answer is compared with the provider's models;
 *   - Google is asked on its `/models` listing with the provider's stored key,
 *     and a model that does not declare the provider's EU AI Act marking yet is
 *     offered it;
 *   - nothing is written;
 *   - every failure is a thrown `ServiceError` with a registry `code`, which the
 *     error middleware answers with: 404 for an unknown provider, 400 for one that
 *     is neither a gateway nor Google or has no base URL, 502 for a provider that
 *     cannot be reached or turns the key down. (The middleware does not send `application/problem+json`
 *     yet, see docs/error-responses.md, so the body's media type is not asserted.)
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const clone = value => JSON.parse(JSON.stringify(value));

let providers;
let models;
/** What the faked gateway answers next, and what it was asked. */
let gatewayAnswer;
let gatewayCalls;
let writes;
/** The stored model files, and what the config cache shows (stale until refreshed). */
let files;
let refreshes;
let audits;
let snapshots;

function reset() {
  providers = [
    { id: 'openai', name: 'OpenAI', enabled: true },
    {
      id: 'ifinder-gw',
      name: 'iFinder gateway',
      category: 'llm',
      apiType: 'openai',
      gateway: 'ifinder-model-gateway',
      baseUrl: 'https://gw.example.com:9614',
      apiKey: 'enc:project-key',
      enabled: true
    },
    {
      id: 'no-url-gw',
      name: 'Gateway without URL',
      category: 'llm',
      apiType: 'openai',
      gateway: 'ifinder-model-gateway',
      enabled: true
    },
    {
      id: 'llmhub',
      name: 'LLM Hub',
      category: 'llm',
      apiType: 'openai',
      baseUrl: 'https://hub.example.com/v2',
      enabled: true
    }
  ];
  models = [
    {
      id: 'ifinder-gw-qwen',
      modelId: 'qwen3-vl',
      providerId: 'ifinder-gw',
      provider: 'openai',
      url: 'https://gw.example.com:9614/v1/gateway/proxy/chat/completions',
      contextWindow: 4096,
      enabled: true
    },
    {
      id: 'ifinder-gw-gone',
      modelId: 'retired-model',
      providerId: 'ifinder-gw',
      provider: 'openai',
      url: 'https://gw.example.com:9614/v1/gateway/proxy/chat/completions',
      enabled: true
    }
  ];
  gatewayCalls = [];
  writes = 0;
  refreshes = 0;
  audits = [];
  snapshots = [];
  files = new Map(models.map(m => [`models/${m.id}.json`, clone(m)]));
  gatewayAnswer = {
    status: 200,
    body: {
      data: [
        {
          id: 'qwen3-vl',
          object: 'model',
          api_type: 'OPENAI',
          max_model_len: 32768,
          endpoints: ['CHAT'],
          modalities: ['VISION']
        },
        {
          id: 'mistral-large-3',
          object: 'model',
          api_type: 'MISTRAL',
          max_model_len: 131072,
          endpoints: ['CHAT'],
          modalities: []
        },
        { id: 'e5', object: 'model', api_type: 'OPENAI', endpoints: ['EMBEDDING'], modalities: [] }
      ]
    }
  };
}

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: value => value,
  default: {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getModels: () => ({ data: clone(models), etag: 'm' }),
    getProviders: () => ({ data: clone(providers), etag: 'p' }),
    refreshModelsCache: async () => {
      refreshes++;
      models = [...files.entries()]
        .filter(([key]) => key.startsWith('models/'))
        .map(([, v]) => clone(v));
    },
    refreshProvidersCache: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async rel => (files.has(rel) ? clone(files.get(rel)) : null),
    writeJson: async (rel, data) => {
      writes++;
      files.set(rel, clone(data));
    },
    remove: async () => false,
    resolveIdToPath: async (kind, id) => `${kind}/${id}.json`
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async entry => {
    audits.push(entry);
  }
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async entry => {
    snapshots.push(entry);
  }
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    encryptString: value => `enc:${value}`,
    isEncrypted: value => typeof value === 'string' && value.startsWith('enc:'),
    decryptString: value => value.slice(4)
  }
}));

// The gateway itself: the only outbound call the route makes. Everything else of
// httpConfig stays real; only the fetch is replaced.
const realHttpConfig = await import('../utils/httpConfig.js');
jest.unstable_mockModule('../utils/httpConfig.js', () => ({
  ...realHttpConfig,
  httpFetch: async (url, init) => {
    gatewayCalls.push({ url, init });
    const { status, body } = gatewayAnswer;
    const text = JSON.stringify(body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => text
    };
  }
}));

const { default: registerAdminProvidersRoutes } = await import('../routes/admin/providers.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
// Like the real server (middleware/setup.js), with room for a body of the most picks allowed.
app.use(express.json({ limit: '5mb' }));
registerAdminProvidersRoutes(app);
app.use(errorHandler);

beforeEach(reset);

const drift = id => request(app).get(`/api/admin/providers/${id}/_model-drift`);

describe('GET /api/admin/providers/:providerId/_model-drift', () => {
  it('compares the gateway listing with the provider’s models', async () => {
    const res = await drift('ifinder-gw');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.modelsUrl).toBe('https://gw.example.com:9614/v1/gateway/models');
    expect(res.body.items.map(i => `${i.kind}:${i.remoteId}`)).toEqual([
      'changed:qwen3-vl',
      'added:mistral-large-3',
      'removed:retired-model'
    ]);

    const [changed, added, removed] = res.body.items;
    expect(changed.modelId).toBe('ifinder-gw-qwen');
    expect(changed.changes).toEqual(
      expect.arrayContaining([
        { field: 'contextWindow', from: 4096, to: 32768 },
        { field: 'supportsVision', from: false, to: true }
      ])
    );
    expect(added.model).toMatchObject({
      id: 'ifinder-gw-mistral-large-3',
      modelId: 'mistral-large-3',
      provider: 'mistral',
      providerId: 'ifinder-gw',
      url: 'https://gw.example.com:9614/v1/gateway/proxy/chat/completions'
    });
    expect(removed).toMatchObject({
      modelId: 'ifinder-gw-gone',
      reason: 'missing'
    });
  });

  it('asks the gateway with the stored project key and changes nothing', async () => {
    await drift('ifinder-gw');

    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0].url).toBe('https://gw.example.com:9614/v1/gateway/models');
    expect(gatewayCalls[0].init.headers.Authorization).toBe('Bearer project-key');
    expect(writes).toBe(0);
  });

  it('reports no items when everything matches', async () => {
    models = [];
    gatewayAnswer.body = { data: [] };
    const res = await drift('ifinder-gw');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('answers 404 NOT_FOUND for an unknown provider', async () => {
    const res = await drift('missing');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(gatewayCalls).toHaveLength(0);
  });

  it('answers 400 BAD_REQUEST for a provider that is no model gateway', async () => {
    for (const id of ['llmhub', 'openai']) {
      const res = await drift(id);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    }
    expect(gatewayCalls).toHaveLength(0);
  });

  it('answers 400 BAD_REQUEST for a gateway without a base URL', async () => {
    const res = await drift('no-url-gw');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.details).toEqual({ providerId: 'no-url-gw' });
  });

  it('answers 502 UPSTREAM_ERROR when the gateway turns the key down', async () => {
    gatewayAnswer = { status: 401, body: {} };
    const res = await drift('ifinder-gw');

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: 'UPSTREAM_ERROR',
      details: { reason: 'authenticationFailed', upstreamStatus: 401 }
    });
    expect(writes).toBe(0);
  });

  it('answers 502 UPSTREAM_ERROR when the answer is no model listing', async () => {
    gatewayAnswer = { status: 200, body: { hello: 'world' } };
    const res = await drift('ifinder-gw');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
    expect(res.body.details.reason).toBe('invalidResponse');
  });
});

describe('POST /api/admin/providers/:providerId/_sync-models', () => {
  const sync = (id, body) =>
    request(app).post(`/api/admin/providers/${id}/_sync-models`).send(body);
  const PICKS = [
    { kind: 'changed', remoteId: 'qwen3-vl', modelId: 'ifinder-gw-qwen' },
    { kind: 'added', remoteId: 'mistral-large-3' },
    { kind: 'removed', remoteId: 'retired-model', modelId: 'ifinder-gw-gone' }
  ];

  it('applies the picked items and refreshes the cache once', async () => {
    const res = await sync('ifinder-gw', { items: PICKS });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.items.map(i => `${i.kind}:${i.remoteId}=${i.status}`)).toEqual([
      'added:mistral-large-3=applied',
      'changed:qwen3-vl=applied',
      'removed:retired-model=applied'
    ]);
    expect(refreshes).toBe(1);

    expect(files.get('models/ifinder-gw-mistral-large-3.json')).toMatchObject({
      modelId: 'mistral-large-3',
      provider: 'mistral',
      providerId: 'ifinder-gw'
    });
    expect(files.get('models/ifinder-gw-qwen.json')).toMatchObject({
      contextWindow: 32768,
      supportsVision: true
    });
    expect(files.get('models/ifinder-gw-gone.json')).toMatchObject({ enabled: false });
    // Never deleted: the file is still there.
    expect(files.has('models/ifinder-gw-gone.json')).toBe(true);
  });

  it('an update followed by a disable keeps both, although the cache is stale in between', async () => {
    await sync('ifinder-gw', {
      items: [
        { kind: 'removed', remoteId: 'retired-model', modelId: 'ifinder-gw-gone' },
        { kind: 'changed', remoteId: 'qwen3-vl', modelId: 'ifinder-gw-qwen' }
      ]
    });
    expect(files.get('models/ifinder-gw-qwen.json').contextWindow).toBe(32768);
    expect(files.get('models/ifinder-gw-gone.json').enabled).toBe(false);
  });

  it('writes an audit entry and a change snapshot per changed model', async () => {
    await sync('ifinder-gw', { items: PICKS });
    expect(audits.map(a => `${a.action}:${a.resourceId}`).sort()).toEqual([
      'create:ifinder-gw-mistral-large-3',
      'update:ifinder-gw-gone',
      'update:ifinder-gw-qwen'
    ]);
    expect(snapshots.map(s => s.id).sort()).toEqual(['ifinder-gw-gone', 'ifinder-gw-qwen']);
  });

  it('applies only what is picked', async () => {
    const res = await sync('ifinder-gw', {
      items: [{ kind: 'added', remoteId: 'mistral-large-3' }]
    });
    expect(res.body.items).toHaveLength(1);
    expect(files.get('models/ifinder-gw-qwen.json').contextWindow).toBe(4096);
    expect(files.get('models/ifinder-gw-gone.json').enabled).toBe(true);
  });

  describe('when two iHub models share one remote model (Clone keeps modelId and provider)', () => {
    beforeEach(() => {
      const clone = { ...models.find(m => m.id === 'ifinder-gw-gone'), id: 'ifinder-gw-gone-copy' };
      models.push(clone);
      files.set('models/ifinder-gw-gone-copy.json', clone);
    });

    it('reports each one as its own item', async () => {
      const res = await drift('ifinder-gw');
      const gone = res.body.items.filter(i => i.kind === 'removed');
      expect(gone.map(i => [i.remoteId, i.modelId])).toEqual([
        ['retired-model', 'ifinder-gw-gone'],
        ['retired-model', 'ifinder-gw-gone-copy']
      ]);
    });

    it('disables both when both are picked, and answers once for each', async () => {
      const res = await sync('ifinder-gw', {
        items: [
          { kind: 'removed', remoteId: 'retired-model', modelId: 'ifinder-gw-gone' },
          { kind: 'removed', remoteId: 'retired-model', modelId: 'ifinder-gw-gone-copy' }
        ]
      });
      expect(res.body.items.map(i => [i.modelId, i.status])).toEqual([
        ['ifinder-gw-gone', 'applied'],
        ['ifinder-gw-gone-copy', 'applied']
      ]);
      expect(files.get('models/ifinder-gw-gone.json').enabled).toBe(false);
      expect(files.get('models/ifinder-gw-gone-copy.json').enabled).toBe(false);
    });

    it('disables only the one that is picked', async () => {
      const res = await sync('ifinder-gw', {
        items: [{ kind: 'removed', remoteId: 'retired-model', modelId: 'ifinder-gw-gone-copy' }]
      });
      expect(res.body.items).toHaveLength(1);
      expect(files.get('models/ifinder-gw-gone.json').enabled).toBe(true);
      expect(files.get('models/ifinder-gw-gone-copy.json').enabled).toBe(false);
    });
  });

  it('skips a pick that no longer matches the gateway and writes nothing for it', async () => {
    const res = await sync('ifinder-gw', {
      items: [
        { kind: 'removed', remoteId: 'qwen3-vl', modelId: 'ifinder-gw-qwen' },
        { kind: 'added', remoteId: 'unknown' }
      ]
    });
    expect(res.status).toBe(200);
    expect(res.body.items.map(i => [i.status, i.detail])).toEqual([
      ['skipped', 'changedSinceReview'],
      ['skipped', 'changedSinceReview']
    ]);
    expect(writes).toBe(0);
    expect(refreshes).toBe(0);
  });

  it('takes no model config from the request', async () => {
    await sync('ifinder-gw', {
      items: [
        {
          kind: 'added',
          remoteId: 'mistral-large-3',
          model: { id: 'evil', provider: 'openai', url: 'https://evil.example/' }
        }
      ]
    });
    expect(files.has('models/evil.json')).toBe(false);
    expect(files.get('models/ifinder-gw-mistral-large-3.json').url).toBe(
      'https://gw.example.com:9614/v1/gateway/proxy/chat/completions'
    );
  });

  it('answers 400 BAD_REQUEST for a body that is no list of picks', async () => {
    const bad = [
      {},
      { items: 'all' },
      { items: [{ kind: 'deleted', remoteId: 'x' }] },
      { items: [{ kind: 'added' }] },
      { items: [null] },
      // a changed or removed pick names the iHub model; an added one has none yet
      { items: [{ kind: 'changed', remoteId: 'qwen3-vl' }] },
      { items: [{ kind: 'removed', remoteId: 'retired-model', modelId: '' }] },
      { items: [{ kind: 'added', remoteId: 'x', modelId: 'ifinder-gw-x' }] },
      { items: Array.from({ length: 5001 }, () => ({ kind: 'added', remoteId: 'x' })) }
    ];
    for (const body of bad) {
      const res = await sync('ifinder-gw', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    }
    expect(gatewayCalls).toHaveLength(0);
    expect(writes).toBe(0);
  });

  it('answers 404 for an unknown provider and 400 for one that is no gateway', async () => {
    expect((await sync('missing', { items: [] })).status).toBe(404);
    const res = await sync('llmhub', { items: PICKS });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(writes).toBe(0);
  });

  it('answers 502 and changes nothing when the gateway cannot be asked', async () => {
    gatewayAnswer = { status: 401, body: {} };
    const res = await sync('ifinder-gw', { items: PICKS });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
    expect(writes).toBe(0);
    expect(refreshes).toBe(0);
  });

  it('reports one failed item without stopping the rest', async () => {
    // An iHub model with the id the new model would get exists by now.
    files.set('models/ifinder-gw-mistral-large-3.json', { id: 'ifinder-gw-mistral-large-3' });
    const res = await sync('ifinder-gw', { items: PICKS });
    expect(res.body.items.map(i => `${i.kind}=${i.status}`)).toEqual([
      'added=failed',
      'changed=applied',
      'removed=applied'
    ]);
    expect(res.body.items[0].detail).toMatch(/already exists/);
  });
});

describe('a Google provider', () => {
  const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const SYNTHID = {
    by: 'provider',
    scheme: 'synthid',
    statementRef: 'Google DeepMind, SynthID: https://deepmind.google/technologies/synthid/'
  };

  beforeEach(() => {
    providers.push({
      id: 'google',
      name: 'Google',
      baseUrl: GOOGLE_BASE,
      apiKey: 'enc:google-key',
      enabled: true
    });
    const model = {
      id: 'gemini-flash',
      modelId: 'gemini-2.5-flash',
      provider: 'google',
      url: `${GOOGLE_BASE}/models/gemini-2.5-flash:streamGenerateContent`,
      contextWindow: 1048576,
      supportsVision: true,
      contentMarking: { text: { by: 'none' } },
      enabled: true
    };
    models = [model];
    files = new Map([[`models/${model.id}.json`, clone(model)]]);
    gatewayAnswer = {
      status: 200,
      body: {
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent']
          }
        ]
      }
    };
  });

  it('is asked on its listing with the stored key and offered the SynthID marking', async () => {
    const res = await drift('google');

    expect(res.status).toBe(200);
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0].url).toBe(`${GOOGLE_BASE}/models?pageSize=1000`);
    expect(gatewayCalls[0].init.headers['x-goog-api-key']).toBe('google-key');
    expect(res.body.items).toEqual([
      {
        kind: 'changed',
        remoteId: 'gemini-2.5-flash',
        modelId: 'gemini-flash',
        changes: [
          {
            field: 'contentMarking',
            from: { text: { by: 'none' } },
            to: { text: SYNTHID }
          }
        ]
      }
    ]);
    expect(writes).toBe(0);
  });

  it('writes the marking to the stored model when the admin picks it', async () => {
    const res = await request(app)
      .post('/api/admin/providers/google/_sync-models')
      .send({
        items: [{ kind: 'changed', remoteId: 'gemini-2.5-flash', modelId: 'gemini-flash' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        kind: 'changed',
        remoteId: 'gemini-2.5-flash',
        modelId: 'gemini-flash',
        status: 'applied'
      }
    ]);
    const stored = files.get('models/gemini-flash.json');
    expect(stored.contentMarking).toEqual({ text: SYNTHID });
    expect(stored.supportsVision).toBe(true);
    expect(refreshes).toBe(1);
    expect(audits).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
  });

  it('reports nothing once the model declares the marking', async () => {
    const declared = {
      ...files.get('models/gemini-flash.json'),
      contentMarking: { text: SYNTHID }
    };
    models = [clone(declared)];
    const res = await drift('google');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('answers 502 UPSTREAM_ERROR when Google turns the key down', async () => {
    gatewayAnswer = { status: 403, body: {} };
    const res = await drift('google');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
    expect(writes).toBe(0);
  });
});

describe('an Anthropic provider', () => {
  const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

  beforeEach(() => {
    providers.push(
      {
        id: 'anthropic',
        name: 'Anthropic',
        baseUrl: ANTHROPIC_BASE,
        apiKey: 'enc:anthropic-key',
        enabled: true
      },
      { id: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', enabled: true }
    );
    models = [
      {
        id: 'claude-opus',
        modelId: 'claude-opus-5-5',
        provider: 'anthropic',
        url: `${ANTHROPIC_BASE}/messages`,
        contentMarking: { text: { by: 'none' } },
        enabled: true
      },
      // Configured with the alias; the listing names the dated snapshot.
      {
        id: 'claude-haiku',
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        url: `${ANTHROPIC_BASE}/messages`,
        enabled: true
      }
    ];
    files = new Map(models.map(m => [`models/${m.id}.json`, clone(m)]));
    gatewayAnswer = {
      status: 200,
      body: {
        data: [
          { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
          { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' }
        ]
      }
    };
  });

  it('is asked on its listing with the stored key and offered the watermark declaration', async () => {
    const res = await drift('anthropic');

    expect(res.status).toBe(200);
    expect(gatewayCalls[0].url).toBe(`${ANTHROPIC_BASE}/models?limit=1000`);
    expect(gatewayCalls[0].init.headers['x-api-key']).toBe('anthropic-key');
    expect(gatewayCalls[0].init.headers['anthropic-version']).toBeDefined();

    const changed = res.body.items.filter(item => item.kind === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ modelId: 'claude-opus', remoteId: 'claude-opus-5-5' });
    expect(changed[0].changes).toEqual([
      expect.objectContaining({
        field: 'contentMarking',
        from: { text: { by: 'none' } },
        to: { text: expect.objectContaining({ by: 'provider', scheme: 'synthid-text' }) }
      })
    ]);
    // The alias is not in the listing, which proves nothing: not reported as gone.
    expect(res.body.items.filter(item => item.kind === 'removed')).toEqual([]);
    expect(writes).toBe(0);
  });

  it('writes the declaration to the stored model when the admin picks it', async () => {
    const res = await request(app)
      .post('/api/admin/providers/anthropic/_sync-models')
      .send({ items: [{ kind: 'changed', remoteId: 'claude-opus-5-5', modelId: 'claude-opus' }] });

    expect(res.status).toBe(200);
    expect(res.body.items.map(item => item.status)).toEqual(['applied']);
    expect(files.get('models/claude-opus.json').contentMarking.text).toMatchObject({
      by: 'provider',
      scheme: 'synthid-text'
    });
  });

  it('answers 400 for Mistral, which has nothing to compare or declare', async () => {
    const res = await drift('mistral');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(gatewayCalls).toHaveLength(0);
  });
});
