// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Example apps of an installation (#3128, routes/admin/integrationExampleApps.js)
 * against an in-memory integrations.json and app list, with shipped
 * definitions in a temp directory: one with an example app, one without.
 */

const state = { integrations: null, apps: [], created: [], refreshedApps: 0 };

jest.unstable_mockModule('../../services/config/ConfigStore.js', () => ({
  default: {
    createJson: async (file, data) => {
      if (state.apps.some(app => `apps/${app.id}.json` === file)) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      state.created.push({ file, data: structuredClone(data) });
      state.apps.push(structuredClone(data));
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
    refreshAppsCache: async () => {
      state.refreshedApps += 1;
    },
    getPlatform: () => ({})
  },
  resolveEnvVarsInObject: value => value
}));
// The admin middleware stands in for the real one: `X-Admin` lets the request
// through, `X-Grants` sets the admin's integration grants.
jest.unstable_mockModule('../../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    if (req.headers['x-admin'] !== 'yes') return res.status(401).json({ error: 'no' });
    req.user = {
      id: 'admin',
      permissions: {
        integrations: new Set(
          String(req.headers['x-grants'] || '*')
            .split(',')
            .filter(Boolean)
        )
      }
    };
    return next();
  }
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
// Loaded through the protocol adapters; never called here.
jest.unstable_mockModule('../../services/tools/OpenApiToolRunner.js', () => ({
  parseOpenApiText: text => JSON.parse(text),
  invalidateSpecCache: () => {},
  invalidateToolsWithPrefix: () => {},
  getOpenApiToolParameters: async () => ({}),
  runOpenApiTool: async () => ({})
}));
const audits = [];
jest.unstable_mockModule('../../services/AuditLogService.js', () => ({
  logAudit: entry => audits.push(entry)
}));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-example-app-routes-'));
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
await writeDefinition('org.example__plain', {
  id: 'org.example/plain',
  version: '1.0.0',
  name: { en: 'Plain', de: 'Schlicht' },
  description: { en: 'A plain integration.' },
  protocol: { type: 'native', module: 'plain' },
  auth: { modes: ['none'] }
});

const registryModule =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const registry = new registryModule.IntegrationRegistry({
  shippedDir,
  contentsDir: path.join(root, 'contents')
});
// Point the singleton at the temp registry.
for (const method of ['reload', 'ensureLoaded', 'list', 'get', 'readExampleApp']) {
  registryModule.default[method] = registry[method].bind(registry);
}

const { default: registerRoutes } = await import('../../routes/admin/integrationExampleApps.js');

const app = express();
app.use(express.json());
registerRoutes(app);
const admin = r => r.set('X-Admin', 'yes');
const URL = id => `/api/admin/integrations/installed/${id}/example-apps`;

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
  state.integrations = {
    installed: [
      {
        id: 'govdata',
        definition: 'org.example/portal',
        label: 'GovData',
        definitionVersion: '1.0.0'
      },
      { id: 'plain', definition: 'org.example/plain', definitionVersion: '1.0.0', enabled: false }
    ]
  };
  state.apps = [];
  state.created = [];
  state.refreshedApps = 0;
  audits.length = 0;
});

describe('GET example apps', () => {
  it('requires admin', async () => {
    await request(app).get(URL('govdata')).expect(401);
  });

  it('lists the shipped example apps with a suggested id', async () => {
    state.apps = [{ id: 'portal-assistant' }];
    const res = await admin(request(app).get(`${URL('govdata')}?lang=de`)).expect(200);
    expect(res.body).toMatchObject({ success: true, grantedToYou: true, enabled: true });
    expect(res.body.templates).toEqual([
      expect.objectContaining({
        key: 'apps/portal-assistant.json',
        source: 'definition',
        name: 'Portal-Assistent',
        suggestedId: 'portal-assistant-govdata'
      })
    ]);
  });

  it('offers a generated app when the definition ships none, and reports a missing grant', async () => {
    const res = await admin(request(app).get(URL('plain')))
      .set('X-Grants', 'govdata')
      .expect(200);
    expect(res.body).toMatchObject({ grantedToYou: false, enabled: false });
    expect(res.body.templates).toEqual([
      expect.objectContaining({
        key: 'generated',
        source: 'generated',
        suggestedId: 'plain-assistant'
      })
    ]);
  });

  it('answers 404 for an unknown installation and 400 for an invalid id', async () => {
    await admin(request(app).get(URL('nope'))).expect(404);
    await admin(request(app).get(URL('bad%20id'))).expect(400);
  });
});

describe('POST example apps', () => {
  it('creates the example app bound to the installation and audits it', async () => {
    const res = await admin(request(app).post(URL('govdata')).send({})).expect(201);
    expect(res.body.app).toMatchObject({
      id: 'portal-assistant',
      enabled: true,
      integrations: { govdata: { actions: ['search'] } },
      name: { en: 'Portal assistant', de: 'Portal-Assistent' }
    });
    expect(state.created.map(c => c.file)).toEqual(['apps/portal-assistant.json']);
    expect(state.refreshedApps).toBe(1);
    expect(audits[0]).toMatchObject({
      action: 'create',
      resource: 'app',
      resourceId: 'portal-assistant'
    });
  });

  it('names the installation when the template id is taken', async () => {
    state.apps = [{ id: 'portal-assistant' }];
    const res = await admin(
      request(app)
        .post(URL('govdata'))
        .send({ template: 'apps/portal-assistant.json', enabled: false })
    ).expect(201);
    expect(res.body.app).toMatchObject({
      id: 'portal-assistant-govdata',
      enabled: false,
      name: { en: 'Portal assistant (GovData)', de: 'Portal-Assistent (GovData)' }
    });
  });

  it('takes the id the admin typed, refusing taken and invalid ones', async () => {
    state.apps = [{ id: 'mine' }];
    await admin(request(app).post(URL('govdata')).send({ appId: 'mine' })).expect(409);
    await admin(request(app).post(URL('govdata')).send({ appId: 'Bad Id' })).expect(400);
    const res = await admin(
      request(app).post(URL('govdata')).send({ appId: 'portal-test' })
    ).expect(201);
    expect(res.body.app.id).toBe('portal-test');
  });

  it('creates the generated app for a definition without example apps', async () => {
    const res = await admin(request(app).post(URL('plain')).send({ template: 'generated' })).expect(
      201
    );
    expect(res.body.app).toMatchObject({
      id: 'plain-assistant',
      integrations: { plain: {} },
      name: { en: 'Plain', de: 'Schlicht' }
    });
  });

  it('refuses an unknown template', async () => {
    await admin(request(app).post(URL('govdata')).send({ template: 'apps/other.json' })).expect(
      400
    );
    expect(state.created).toEqual([]);
  });
});
