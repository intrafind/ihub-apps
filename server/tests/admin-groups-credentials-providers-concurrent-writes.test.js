// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * groups.json, credentials.json and providers.json are changed by several admin
 * routes (and by other workers), each of which used to read the file, change the
 * copy and write it back — so two requests in flight dropped each other's change.
 *
 * The mock store below is deliberately hostile to that pattern: every bare read
 * and write yields to the event loop, so parallel requests interleave. `updateJson`
 * is the sequential compare-and-set the real ConfigStore gives: one change at a
 * time on a body read inside the lock.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const files = new Map();
const tick = () => new Promise(resolve => setImmediate(resolve));
const queues = new Map();
const state = { providersCache: null };

jest.unstable_mockModule('../services/config/ConfigStore.js', () => {
  const store = {
    readJson: async rel => {
      await tick();
      return files.has(rel) ? structuredClone(files.get(rel)) : null;
    },
    readJsonStrict: async rel => store.readJson(rel),
    writeJson: async (rel, data) => {
      await tick();
      files.set(rel, structuredClone(data));
    },
    updateJson: (rel, mutate) => {
      const run = (queues.get(rel) || Promise.resolve()).then(async () => {
        await tick();
        const current = files.has(rel) ? structuredClone(files.get(rel)) : null;
        const next = await mutate(structuredClone(current));
        if (next === undefined) return { data: current, written: false };
        await tick();
        files.set(rel, structuredClone(next));
        return { data: structuredClone(next), written: true };
      });
      queues.set(
        rel,
        run.catch(() => {})
      );
      return run;
    },
    resolveIdToPath: async (kind, id) => `${kind}/${id}.json`
  };
  return { default: store, configStore: store };
});

jest.unstable_mockModule('../configCache.js', () => ({
  resolveEnvVarsInObject: value => value,
  default: {
    getPlatform: () => ({ auth: {} }),
    getApps: () => ({ data: [{ id: 'chat' }] }),
    getPrompts: () => ({ data: [] }),
    getWorkflows: () => ({ data: [] }),
    getSkills: () => ({ data: [] }),
    getModels: () => ({ data: [] }),
    // A cache that lags: whatever the test pinned, else the stored file.
    getProviders: () => ({
      data: structuredClone(state.providersCache ?? files.get('config/providers.json').providers),
      etag: 'p'
    }),
    refreshCacheEntry: async () => {},
    refreshCredentialsCache: async () => {},
    refreshProvidersCache: async () => {},
    refreshModelsCache: async () => {}
  }
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  contentAdminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    encryptString: value => `enc:${value}`,
    isEncrypted: value => typeof value === 'string' && value.startsWith('enc:'),
    decryptString: value => value.slice(4)
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerGroups } = await import('../routes/admin/groups.js');
const { default: registerContentAccess } = await import('../routes/admin/contentAccess.js');
const { default: registerCredentials } = await import('../routes/admin/credentials.js');
const { default: registerProviders } = await import('../routes/admin/providers.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { id: 'admin', username: 'admin', groups: ['admins'], isAdmin: true };
  next();
});
registerGroups(app);
registerContentAccess(app);
registerCredentials(app);
registerProviders(app);
app.use(errorHandler);

const perms = (extra = {}) => ({ apps: [], prompts: [], models: [], ...extra });

beforeEach(() => {
  state.providersCache = null;
  queues.clear();
  files.clear();
  files.set('config/groups.json', {
    groups: {
      admins: {
        id: 'admins',
        name: 'Admins',
        permissions: perms({ apps: ['*'], adminAccess: true })
      },
      ops: { id: 'ops', name: 'Ops', permissions: perms({ adminAccess: true }) },
      sales: { id: 'sales', name: 'Sales', permissions: perms() }
    },
    metadata: { version: '1.0.0', lastModified: 'x' }
  });
  files.set('config/credentials.json', { credentials: {} });
  files.set('config/providers.json', {
    providers: [
      { id: 'alpha', name: 'Alpha', category: 'custom', enabled: true, apiKey: 'enc:alpha-key' },
      { id: 'beta', name: 'Beta', category: 'custom', enabled: true, apiKey: 'enc:beta-key' }
    ]
  });
});

const groupsNow = () => files.get('config/groups.json').groups;

describe('groups.json', () => {
  it('lands parallel creates and an edit', async () => {
    const create = id =>
      request(app).post('/api/admin/groups').send({ id, name: id, permissions: perms() });
    const responses = await Promise.all([
      create('g1'),
      create('g2'),
      create('g3'),
      request(app).put('/api/admin/groups/sales').send({ name: 'Sales EMEA' })
    ]);
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200]);
    expect(Object.keys(groupsNow()).sort()).toEqual(['admins', 'g1', 'g2', 'g3', 'ops', 'sales']);
    expect(groupsNow().sales.name).toBe('Sales EMEA');
  });

  it('answers two creates of one id with one 200 and one 409', async () => {
    const create = () =>
      request(app).post('/api/admin/groups').send({ id: 'dup', name: 'Dup', permissions: perms() });
    const statuses = (await Promise.all([create(), create()])).map(r => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('keeps a content-access grant and a group edit that run together', async () => {
    const responses = await Promise.all([
      request(app)
        .put('/api/admin/content-access/apps/chat')
        .send({ grant: ['sales'] }),
      request(app).put('/api/admin/groups/ops').send({ description: 'Operations' })
    ]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(groupsNow().sales.permissions.apps).toContain('chat');
    expect(groupsNow().ops.description).toBe('Operations');
  });

  it('keeps one admin group when the last two lose adminAccess at once', async () => {
    const strip = id =>
      request(app)
        .put(`/api/admin/groups/${id}`)
        .send({ permissions: perms({ adminAccess: false }) });
    const statuses = (await Promise.all([strip('admins'), strip('ops')])).map(r => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    const stillAdmin = Object.values(groupsNow()).filter(g => g.permissions.adminAccess === true);
    expect(stillAdmin).toHaveLength(1);
  });

  it('keeps one admin group when one loses adminAccess while the other is deleted', async () => {
    const statuses = (
      await Promise.all([
        request(app)
          .put('/api/admin/groups/admins')
          .send({ permissions: perms({ adminAccess: false }) }),
        request(app).delete('/api/admin/groups/ops')
      ])
    )
      .map(r => r.status)
      .sort();
    // Whichever lands second is refused: it would remove the last admin group.
    expect(statuses).toContain(400);
    const stillAdmin = Object.values(groupsNow()).filter(g => g.permissions.adminAccess === true);
    expect(stillAdmin).toHaveLength(1);
  });
});

describe('credentials.json', () => {
  it('lands parallel creates', async () => {
    const create = id =>
      request(app)
        .post('/api/admin/credentials')
        .send({ id, type: 'bearer', token: `t-${id}` });
    const responses = await Promise.all(['c1', 'c2', 'c3', 'c4'].map(create));
    expect(responses.map(r => r.status)).toEqual([201, 201, 201, 201]);
    expect(Object.keys(files.get('config/credentials.json').credentials).sort()).toEqual([
      'c1',
      'c2',
      'c3',
      'c4'
    ]);
  });

  it('answers parallel creates of one name with exactly one 409', async () => {
    const create = () =>
      request(app).post('/api/admin/credentials').send({ id: 'same', type: 'bearer', token: 'x' });
    const statuses = (await Promise.all([create(), create()])).map(r => r.status).sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('keeps a created credential when another is deleted at the same time', async () => {
    files.set('config/credentials.json', {
      credentials: { old: { id: 'old', type: 'bearer', token: 'enc:o' } }
    });
    await Promise.all([
      request(app).post('/api/admin/credentials').send({ id: 'new', type: 'bearer', token: 'n' }),
      request(app).delete('/api/admin/credentials/old')
    ]);
    expect(Object.keys(files.get('config/credentials.json').credentials)).toEqual(['new']);
  });
});

describe('providers.json', () => {
  it('does not revert another provider when the cache lags', async () => {
    // Another worker disabled beta and rotated its key; this worker's cache still has the old list.
    state.providersCache = structuredClone(files.get('config/providers.json').providers);
    files.get('config/providers.json').providers[1] = {
      id: 'beta',
      name: 'Beta',
      category: 'custom',
      enabled: false,
      apiKey: 'enc:beta-rotated'
    };

    await request(app)
      .put('/api/admin/providers/alpha')
      .send({ id: 'alpha', name: 'Alpha 2', category: 'custom', enabled: true, apiKey: '••••••••' })
      .expect(200);

    const [alpha, beta] = files.get('config/providers.json').providers;
    expect(alpha).toMatchObject({ name: 'Alpha 2', apiKey: 'enc:alpha-key' });
    expect(beta).toMatchObject({ enabled: false, apiKey: 'enc:beta-rotated' });
  });

  it('lands parallel edits of different providers and a create', async () => {
    const responses = await Promise.all([
      request(app)
        .put('/api/admin/providers/alpha')
        .send({ id: 'alpha', name: 'A', category: 'custom', enabled: false, apiKey: '••••••••' }),
      request(app)
        .put('/api/admin/providers/beta')
        .send({ id: 'beta', name: 'B', category: 'custom', enabled: true, apiKey: '••••••••' }),
      request(app).post('/api/admin/providers').send({ id: 'gamma', name: 'G', category: 'custom' })
    ]);
    expect(responses.map(r => r.status)).toEqual([200, 200, 201]);
    const providers = files.get('config/providers.json').providers;
    expect(providers.map(p => p.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(providers[0]).toMatchObject({ name: 'A', enabled: false, apiKey: 'enc:alpha-key' });
    expect(providers[1]).toMatchObject({ name: 'B', apiKey: 'enc:beta-key' });
  });

  it('keeps a delete and a create that run together', async () => {
    await Promise.all([
      request(app).delete('/api/admin/providers/beta'),
      request(app).post('/api/admin/providers').send({ id: 'delta', name: 'D', category: 'custom' })
    ]);
    expect(files.get('config/providers.json').providers.map(p => p.id)).toEqual(['alpha', 'delta']);
  });
});
