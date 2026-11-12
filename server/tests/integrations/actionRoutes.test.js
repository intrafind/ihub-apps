// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Action detail, override, instructions and the test runner (#2974):
 * routes/admin/integrations.js against an in-memory integrations.json and
 * credentials.json, with an OpenAPI definition whose network call is stubbed.
 * The stub "sends" what the adapter built through the real outbound recorder,
 * so redaction is checked on what an adapter really hands over.
 */

const SECRET = 's3cr3t-token-123456';
const state = { integrations: null, credentials: { credentials: {} }, writes: [] };

jest.unstable_mockModule('../../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async (file, data) => {
      state.writes.push({ file, data: structuredClone(data) });
      if (file === 'config/integrations.json') state.integrations = structuredClone(data);
      if (file === 'config/credentials.json') state.credentials = structuredClone(data);
    },
    updateJson: async function (file, mutate) {
      const current =
        file === 'config/integrations.json'
          ? structuredClone(state.integrations)
          : file === 'config/credentials.json'
            ? structuredClone(state.credentials)
            : null;
      const next = await mutate(current);
      if (next === undefined) return { data: current, written: false };
      await this.writeJson(file, next);
      return { data: next, written: true };
    },
    readJsonStrict: async file =>
      file === 'config/credentials.json' ? structuredClone(state.credentials) : null
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    get: key =>
      key === 'config/integrations.json'
        ? { data: structuredClone(state.integrations), etag: null }
        : { data: null, etag: null },
    getIntegrations: () => ({ data: structuredClone(state.integrations), etag: null }),
    getCredentials: () => ({ credentials: structuredClone(state.credentials.credentials) }),
    refreshCacheEntry: async () => {},
    refreshCredentialsCache: async () => {},
    getPlatform: () => ({}),
    getModels: () => ({ data: [] }),
    getApps: () => ({
      data: [
        { id: 'notes-app', name: { en: 'Notes app' }, integrations: { portal: {} } },
        { id: 'other-app', name: { en: 'Other' }, integrations: {} }
      ]
    }),
    getWorkflows: () => ({
      data: [
        {
          id: 'nightly',
          name: { en: 'Nightly' },
          nodes: [{ id: 'n1', config: { integrations: { portal: {} } } }]
        }
      ]
    })
  },
  resolveEnvVarsInObject: value => value
}));
jest.unstable_mockModule('../../services/TokenStorageService.js', () => ({
  default: {
    encryptString: value => `ENC[${value}]`,
    isEncrypted: value => /^ENC\[/.test(value)
  }
}));
jest.unstable_mockModule('../../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    if (req.headers['x-admin'] !== 'yes') return res.status(401).json({ error: 'no' });
    req.user = { id: 'admin', username: 'admin', groups: ['admins'] };
    return next();
  }
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
const audits = [];
jest.unstable_mockModule('../../services/AuditLogService.js', () => ({
  logAudit: entry => audits.push(entry)
}));
jest.unstable_mockModule('../../services/integrations/integrationTools.js', () => ({
  syncIntegrationScopeProviders: async () => [],
  appBindingFor: (app, instance) => app?.integrations?.[instance.id] ?? null,
  bindingKeyFor: (app, instance) => (app?.integrations?.[instance.id] ? instance.id : null)
}));
jest.unstable_mockModule('../../services/scheduler/tasks/ScheduledTaskRepository.js', () => ({
  getScheduledTaskRepository: () => ({
    isAvailable: () => true,
    async *scanTasks() {
      yield { id: 'task-1', name: 'Morning notes', appId: 'notes-app', enabledTools: null };
      yield { id: 'task-2', name: 'Unrelated', appId: 'other-app', enabledTools: null };
    }
  })
}));

// The adapter's network call: sends what the adapter built through the real
// outbound recorder (as `safeFetch` would), with the token in the header, the
// URL and the body.
const runCalls = [];
jest.unstable_mockModule('../../services/tools/OpenApiToolRunner.js', () => ({
  parseOpenApiText: text => JSON.parse(text),
  invalidateSpecCache: () => {},
  invalidateToolsWithPrefix: () => {},
  getOpenApiToolParameters: async () => ({
    type: 'object',
    properties: { q: { type: 'string' }, note: { type: 'string' } },
    required: []
  }),
  runOpenApiTool: async (tool, args) => {
    runCalls.push({ tool, args });
    const { withOutboundRecording } = await import('../../utils/outboundRecorder.js');
    const token = String(tool.openapi.headers.Authorization || '').replace(/^Bearer /, '');
    await withOutboundRecording(
      `${tool.openapi.baseUrl}/notes?q=${encodeURIComponent(args.q || '')}&api_key=${token}`,
      {
        method: 'POST',
        headers: { ...tool.openapi.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, echo: `uses ${token}` })
      },
      async () => ({ status: 201 })
    );
    return {
      success: true,
      result: {
        saved: true,
        echo: `token ${token}`,
        sources: [{ title: 'Note A', url: 'https://portal.example/notes/a' }]
      }
    };
  }
}));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-action-routes-'));
const shippedDir = path.join(root, 'shipped');
await fs.mkdir(path.join(shippedDir, 'org.example__notes'), { recursive: true });
await fs.writeFile(
  path.join(shippedDir, 'org.example__notes', 'integration.json'),
  JSON.stringify({
    id: 'org.example/notes',
    version: '1.0.0',
    name: { en: 'Notes', de: 'Notizen' },
    protocol: {
      type: 'openapi',
      document: 'api.json',
      baseUrl: '{baseUrl}',
      responseEnvelope: { success: 'success', result: 'result', error: 'error.message' }
    },
    auth: { modes: ['service-account'], serviceAccount: { kind: 'bearer', field: 'apiToken' } },
    install: [
      { key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true },
      { key: 'apiToken', type: 'secret', title: { en: 'Token' } }
    ],
    instructions: { en: 'Notes hold the team’s meeting notes.' },
    actions: [
      {
        name: 'search',
        operationId: 'search_notes',
        sideEffect: 'read',
        guidance: { en: 'Search before answering.' },
        examples: [{ en: 'Find the notes of Monday.' }]
      },
      { name: 'create_note', operationId: 'create_note', sideEffect: 'write' },
      { name: 'guess', operationId: 'guess_notes', sideEffect: 'unknown' }
    ]
  })
);
await fs.writeFile(
  path.join(shippedDir, 'org.example__notes', 'api.json'),
  JSON.stringify({
    openapi: '3.0.0',
    info: {},
    paths: {
      '/notes': {
        get: { operationId: 'search_notes', responses: {} },
        post: { operationId: 'create_note', responses: {} }
      },
      '/guess': { delete: { operationId: 'guess_notes', responses: {} } }
    }
  })
);

const registryModule =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const registry = new registryModule.IntegrationRegistry({
  shippedDir,
  contentsDir: path.join(root, 'contents')
});
Object.assign(registryModule.default, registry);
for (const method of [
  'reload',
  'ensureLoaded',
  'list',
  'get',
  'isInstalled',
  'isIncompatible',
  'readCompanion'
]) {
  registryModule.default[method] = registry[method].bind(registry);
}

const usage = await import('../../services/integrations/actionUsage.js');
await usage._setActionUsageDir(path.join(root, 'usage'));

const { default: registerAdminIntegrationsRoutes } =
  await import('../../routes/admin/integrations.js');
const { default: errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminIntegrationsRoutes(app);
app.use(errorHandler);
const admin = r => r.set('X-Admin', 'yes');
const base = '/api/admin/integrations/installed/portal';

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
  state.integrations = {
    installed: [
      {
        id: 'portal',
        definition: 'org.example/notes',
        definitionVersion: '1.0.0',
        enabled: true,
        values: { baseUrl: 'https://portal.example' },
        auth: { mode: 'service-account', credentialRef: 'notes-token' },
        actions: { enabled: ['*'], disabled: [], overrides: {} }
      }
    ],
    security: { blockPrivateIps: true, allowedHosts: [] }
  };
  state.credentials = { credentials: { 'notes-token': { type: 'secret', value: SECRET } } };
  state.writes = [];
  audits.length = 0;
  runCalls.length = 0;
});

describe('action detail', () => {
  it('requires admin for every route', async () => {
    await request(app).get(`${base}/actions/search`).expect(401);
    await request(app).put(`${base}/actions/search`).send({}).expect(401);
    await request(app).post(`${base}/actions/search/_test`).send({}).expect(401);
    await request(app).put(`${base}/instructions`).send({}).expect(401);
    expect(runCalls).toHaveLength(0);
  });

  it('describes what the model sees, the sources of side effect and approval, and the bindings', async () => {
    const res = await admin(request(app).get(`${base}/actions/search`)).expect(200);
    const detail = res.body;
    expect(detail.action).toMatchObject({
      name: 'search',
      toolId: 'portal__search',
      guidance: 'Search before answering.',
      examples: ['Find the notes of Monday.'],
      httpMethod: 'GET',
      overridden: { description: false, guidance: false, examples: false }
    });
    expect(detail.action.parameters.properties.q.type).toBe('string');
    expect(detail.effect).toMatchObject({
      sideEffect: 'read',
      sideEffectSource: 'definition',
      dataFlow: 'external',
      dataFlowSource: 'definition'
    });
    expect(detail.approval).toMatchObject({ mode: 'never', source: 'default' });
    expect(detail.instructions).toMatchObject({
      text: 'Notes hold the team’s meeting notes.',
      source: 'definition'
    });
    expect(detail.bindings.apps.map(a => a.id)).toEqual(['notes-app']);
    expect(detail.bindings.workflows.map(w => w.id)).toEqual(['nightly']);
    expect(detail.bindings.scheduledTasks.map(t => t.id)).toEqual(['task-1']);
    expect(detail.test).toMatchObject({ needsConfirmation: false, runnable: true });
    expect(detail.test.connections).toEqual([
      { id: 'shared', kind: 'service-account', credentialRef: 'notes-token' }
    ]);
    expect(detail.usage).toMatchObject({ days: 7, calls: 0 });

    await admin(request(app).get(`${base}/actions/missing`)).expect(404);
    await admin(request(app).get(`${base}/actions/bad%20name`)).expect(400);
    await admin(request(app).get('/api/admin/integrations/installed/nope/actions/search')).expect(
      404
    );
  });

  it('suggests the side effect of an undeclared OpenAPI operation from its method', async () => {
    const detail = (await admin(request(app).get(`${base}/actions/guess`)).expect(200)).body;
    expect(detail.effect).toMatchObject({
      sideEffect: 'unknown',
      declaredSideEffect: 'unknown',
      methodSideEffect: 'destructive'
    });
    expect(detail.test.needsConfirmation).toBe(true);
  });

  it('stores the description, guidance and examples override and serves it to the model', async () => {
    const res = await admin(
      request(app)
        .put(`${base}/actions/search`)
        .send({
          description: { en: 'Search the meeting notes.' },
          guidance: { en: 'Quote the note title.', de: '' },
          examples: [{ en: 'Notes from Friday?' }],
          sideEffect: 'read'
        })
    ).expect(200);
    expect(res.body.override).toEqual({
      description: { en: 'Search the meeting notes.' },
      guidance: { en: 'Quote the note title.' },
      examples: [{ en: 'Notes from Friday?' }],
      sideEffect: 'read'
    });
    expect(res.body.detail.action).toMatchObject({
      description: 'Search the meeting notes.',
      guidance: 'Quote the note title.',
      examples: ['Notes from Friday?'],
      overridden: { description: true, guidance: true, examples: true }
    });
    expect(res.body.detail.effect.sideEffectSource).toBe('admin');
    expect(audits.at(-1).summary).toContain('action.policyChange');

    // The installation list shows the model's description too.
    const page = await admin(request(app).get(base)).expect(200);
    expect(page.body.actions.find(a => a.name === 'search').description).toBe(
      'Search the meeting notes.'
    );

    // null removes one part and keeps the others.
    const reset = await admin(
      request(app).put(`${base}/actions/search`).send({ guidance: null })
    ).expect(200);
    expect(reset.body.override.guidance).toBeUndefined();
    expect(reset.body.detail.action.guidance).toBe('Search before answering.');

    const invalid = await admin(
      request(app).put(`${base}/actions/search`).send({ sideEffect: 'maybe' })
    ).expect(400);
    expect(invalid.body.code).toBe('INVALID_OVERRIDE');
    await admin(request(app).put(`${base}/actions/missing`).send({ guidance: 'x' })).expect(404);
  });

  it('keeps the overrides and instructions when the settings form saves without them', async () => {
    await admin(request(app).put(`${base}/actions/search`).send({ guidance: 'Mine.' })).expect(200);
    await admin(
      request(app)
        .put(`${base}/instructions`)
        .send({ instructions: { en: 'Own.' } })
    );
    await admin(
      request(app)
        .put(base)
        .send({
          id: 'portal',
          definition: 'org.example/notes',
          values: { baseUrl: 'https://other.example' },
          auth: { mode: 'service-account', credentialRef: 'notes-token' }
        })
    ).expect(200);
    const stored = state.integrations.installed[0];
    expect(stored.values.baseUrl).toBe('https://other.example');
    expect(stored.instructions).toEqual({ en: 'Own.' });
    expect(stored.actions.overrides.search.guidance).toBe('Mine.');
  });

  it('sets and removes the installation instructions', async () => {
    const set = await admin(
      request(app)
        .put(`${base}/instructions`)
        .send({ instructions: { en: 'Use the notes.' } })
    ).expect(200);
    expect(set.body.instructions).toEqual({ en: 'Use the notes.' });
    const page = await admin(request(app).get(base)).expect(200);
    expect(page.body.instructions).toMatchObject({ text: 'Use the notes.', source: 'admin' });
    const removed = await admin(
      request(app).put(`${base}/instructions`).send({ instructions: null })
    ).expect(200);
    expect(removed.body.instructions).toBeUndefined();
    await admin(
      request(app)
        .put(`${base}/instructions`)
        .send({ instructions: { en: 'x'.repeat(5000) } })
    ).expect(400);
  });
});

describe('action test', () => {
  it('runs a read with the shared credential and redacts every secret it shows', async () => {
    const res = await admin(
      request(app)
        .post(`${base}/actions/search/_test`)
        .send({ args: { q: 'monday', note: 'apiKey-free' } })
    ).expect(200);
    const result = res.body;
    expect(result).toMatchObject({
      status: 'ok',
      httpStatus: 201,
      connection: 'shared',
      sideEffect: 'read',
      confirmed: false
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(runCalls).toHaveLength(1);
    // The adapter got the real secret …
    expect(runCalls[0].tool.openapi.headers.Authorization).toBe(`Bearer ${SECRET}`);
    // … the admin never sees it: not in the header, the URL, the body or the response.
    const shown = JSON.stringify(result);
    expect(shown).not.toContain(SECRET);
    const [sent] = result.request.http;
    expect(sent.method).toBe('POST');
    expect(sent.headers.Authorization).toBe('[redacted]');
    expect(sent.url).toBe('https://portal.example/notes?q=monday&api_key=[redacted]');
    expect(sent.body).toContain('uses [redacted]');
    expect(result.response.text).toContain('token [redacted]');
    expect(result.sources.items.map(s => s.title)).toEqual(['Note A']);

    const audit = audits.at(-1);
    expect(audit).toMatchObject({ action: 'execute', resource: 'integration', result: 'success' });
    expect(audit.summary).toContain('action.test');
    expect(audit.summary).toContain('"q":"monday"');
    expect(audit.summary).not.toContain(SECRET);

    // A test counts as a test, never as a call.
    const detail = await admin(request(app).get(`${base}/actions/search`)).expect(200);
    expect(detail.body.usage).toMatchObject({ calls: 0, tests: 1 });
  });

  it('redacts secret arguments in the shown request and in the audit entry', async () => {
    const res = await admin(
      request(app)
        .post(`${base}/actions/search/_test`)
        .send({ args: { q: 'x', password: 'arg-secret-value-1' } })
    ).expect(200);
    expect(res.body.request.args.password).toBe('[redacted]');
    expect(JSON.stringify(res.body)).not.toContain('arg-secret-value-1');
    expect(audits.at(-1).summary).not.toContain('arg-secret-value-1');
    expect(audits.at(-1).summary).toContain('[redacted]');
  });

  it('refuses a write test without the confirmation on the server, and runs it with it', async () => {
    const refused = await admin(
      request(app)
        .post(`${base}/actions/create_note/_test`)
        .send({ args: { note: 'hello' } })
    ).expect(409);
    expect(refused.body).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: { sideEffect: 'write' }
    });
    expect(runCalls).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({ result: 'failure' });
    expect(audits.at(-1).summary).toContain('CONFIRMATION_REQUIRED');

    // `confirm` must be the boolean true, not just truthy.
    await admin(
      request(app)
        .post(`${base}/actions/create_note/_test`)
        .send({ args: { note: 'hello' }, confirm: 'yes' })
    ).expect(409);
    expect(runCalls).toHaveLength(0);

    const ran = await admin(
      request(app)
        .post(`${base}/actions/create_note/_test`)
        .send({ args: { note: 'hello' }, confirm: true })
    ).expect(200);
    expect(ran.body).toMatchObject({ status: 'ok', confirmed: true, sideEffect: 'write' });
    expect(runCalls).toHaveLength(1);
  });

  it('treats an undeclared side effect like a write', async () => {
    await admin(request(app).post(`${base}/actions/guess/_test`).send({ args: {} })).expect(409);
    // An admin override to `read` is trusted.
    await admin(request(app).put(`${base}/actions/guess`).send({ sideEffect: 'read' })).expect(200);
    await admin(request(app).post(`${base}/actions/guess/_test`).send({ args: {} })).expect(200);
  });

  it('validates the arguments and the connection before anything runs', async () => {
    const wrongType = await admin(
      request(app)
        .post(`${base}/actions/search/_test`)
        .send({ args: { q: 42 } })
    ).expect(400);
    expect(wrongType.body.code).toBe('INVALID_ARGUMENTS');
    const notObject = await admin(
      request(app)
        .post(`${base}/actions/search/_test`)
        .send({ args: ['x'] })
    ).expect(400);
    expect(notObject.body.code).toBe('INVALID_ARGUMENTS');
    const connection = await admin(
      request(app).post(`${base}/actions/search/_test`).send({ args: {}, connection: 'me' })
    ).expect(400);
    expect(connection.body.code).toBe('INVALID_CONNECTION');
    const missing = await admin(
      request(app).post(`${base}/actions/nope/_test`).send({ args: {} })
    ).expect(404);
    expect(missing.body.code).toBe('ACTION_NOT_FOUND');
    expect(runCalls).toHaveLength(0);
  });
});
