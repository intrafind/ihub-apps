// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Error paths of the example-app routes (routes/admin/integrationExampleApps.js)
 * through the global error middleware: unknown installation (NOT_FOUND),
 * installation whose definition is not loaded (CONFLICT), invalid id
 * (BAD_REQUEST), an example app failing the app schema (BAD_REQUEST) and a
 * create race on the app file (CONFLICT). The happy paths and the plain
 * status codes are in exampleAppRoutes.test.js.
 */

const state = { integrations: null, apps: [], createError: null };

jest.unstable_mockModule('../../services/config/ConfigStore.js', () => ({
  default: {
    createJson: async () => {
      if (state.createError) throw state.createError;
    }
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    get: key =>
      key === 'config/integrations.json'
        ? { data: structuredClone(state.integrations), etag: null }
        : { data: null, etag: null },
    getApps: () => ({ data: structuredClone(state.apps), etag: null }),
    refreshAppsCache: async () => {},
    getPlatform: () => ({})
  },
  resolveEnvVarsInObject: value => value
}));
jest.unstable_mockModule('../../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin', permissions: { integrations: new Set(['*']) } };
    return next();
  }
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
jest.unstable_mockModule('../../services/tools/OpenApiToolRunner.js', () => ({
  parseOpenApiText: text => JSON.parse(text),
  invalidateSpecCache: () => {},
  invalidateToolsWithPrefix: () => {},
  getOpenApiToolParameters: async () => ({}),
  runOpenApiTool: async () => ({})
}));
jest.unstable_mockModule('../../services/AuditLogService.js', () => ({
  logAudit: () => {}
}));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-example-app-errors-'));
const shippedDir = path.join(root, 'shipped');

async function writeDefinition(dirName, definition, files = {}) {
  const dir = path.join(shippedDir, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(definition));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(content));
  }
}

// An example app that is not a valid app (no name, system prompt, ...).
await writeDefinition(
  'org.example__broken',
  {
    id: 'org.example/broken',
    version: '1.0.0',
    name: { en: 'Broken' },
    protocol: { type: 'native', module: 'broken' },
    auth: { modes: ['none'] },
    exampleApps: [{ file: 'apps/broken.json' }]
  },
  { 'apps/broken.json': { id: 'broken-app', color: 12345, tokenLimit: 'lots' } }
);

await writeDefinition(
  'org.example__portal',
  {
    id: 'org.example/portal',
    version: '1.0.0',
    name: { en: 'Portal', de: 'Portal' },
    protocol: { type: 'native', module: 'portal' },
    auth: { modes: ['none'] },
    exampleApps: [{ file: 'apps/portal-assistant.json' }]
  },
  {
    'apps/portal-assistant.json': {
      id: 'portal-assistant',
      name: { en: 'Portal assistant', de: 'Portal-Assistent' },
      description: { en: 'Ask the portal', de: 'Das Portal fragen' },
      color: '#0F766E',
      icon: 'chart-bar',
      system: { en: 'Use the portal.', de: 'Nutze das Portal.' },
      integrations: { 'org.example/portal': { actions: ['search'] } }
    }
  }
);

const registryModule =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const registry = new registryModule.IntegrationRegistry({
  shippedDir,
  contentsDir: path.join(root, 'contents')
});
for (const method of ['reload', 'ensureLoaded', 'list', 'get', 'readExampleApp']) {
  registryModule.default[method] = registry[method].bind(registry);
}

const { default: registerRoutes } = await import('../../routes/admin/integrationExampleApps.js');
const { default: errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerRoutes(app);
app.use(errorHandler);
const URL = id => `/api/admin/integrations/installed/${id}/example-apps`;

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
}

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
  state.integrations = {
    installed: [
      {
        id: 'broken',
        definition: 'org.example/broken',
        definitionVersion: '1.0.0'
      },
      { id: 'portal', definition: 'org.example/portal', definitionVersion: '1.0.0' },
      { id: 'orphan', definition: 'org.example/not-shipped', definitionVersion: '1.0.0' }
    ]
  };
  state.apps = [];
  state.createError = null;
});

describe('example app routes: errors', () => {
  it.each(['get', 'post'])('%s answers NOT_FOUND for an unknown installation', async method => {
    const res = await request(app)[method](URL('nope'));
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.body.detail).toContain('Integration not found');
  });

  it.each(['get', 'post'])('%s answers BAD_REQUEST for an invalid id', async method => {
    const res = await request(app)[method](URL('bad%20id'));
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toBeTruthy();
  });

  it.each(['get', 'post'])(
    '%s answers CONFLICT when the definition of the installation is not loaded',
    async method => {
      const res = await request(app)[method](URL('orphan'));
      expectProblem(res, 409, 'CONFLICT');
      expect(res.body.detail).toContain('definition of this installation is not loaded');
    }
  );

  it('answers BAD_REQUEST for an unknown template', async () => {
    const res = await request(app).post(URL('broken')).send({ template: 'apps/other.json' });
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toContain('Unknown example app');
  });

  it('answers BAD_REQUEST for an invalid typed app id', async () => {
    const res = await request(app).post(URL('broken')).send({ appId: 'Bad Id' });
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toContain('Invalid app id');
  });

  it('answers CONFLICT for a taken app id', async () => {
    state.apps = [{ id: 'Mine' }];
    const res = await request(app).post(URL('broken')).send({ appId: 'mine' });
    expectProblem(res, 409, 'CONFLICT');
    expect(res.body.detail).toContain('already exists');
  });

  it('answers BAD_REQUEST when the example app does not pass the app schema', async () => {
    const res = await request(app).post(URL('broken')).send({});
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toContain('Invalid app configuration:');
  });

  it('answers CONFLICT when the app file appears between check and create', async () => {
    state.createError = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const res = await request(app).post(URL('portal')).send({});
    expectProblem(res, 409, 'CONFLICT');
    expect(res.body.detail).toContain('already exists');
  });

  it('answers an unexpected create failure with a 500 that does not leak the cause', async () => {
    state.createError = new Error('EACCES /secret/path');
    const res = await request(app).post(URL('portal')).send({});
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('/secret/path');
  });
});
