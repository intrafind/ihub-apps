// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Versioning phase 2 (#3090), the admin API: the migration fields of the
 * installed list and detail, `_migrate`, `_restore`, `_adopt`, the refusal
 * codes of an ordinary save, which installations offer tools in each
 * state, and the update preview of the marketplace item detail. Config
 * files live in memory (ConfigStore mocked); backups and lock files in a
 * temp contents folder.
 */

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-migration-routes-'));
const contents = path.join(root, 'contents');
const shippedDir = path.join(root, 'shipped');
process.env.CONTENTS_DIR = contents;

const files = new Map();
const read = rel => (files.has(rel) ? structuredClone(files.get(rel)) : null);

jest.unstable_mockModule('../../services/config/ConfigStore.js', () => {
  const store = {
    readJson: async rel => read(rel),
    readJsonStrict: async rel => read(rel),
    writeJson: async (rel, data) => {
      files.set(rel, structuredClone(data));
    },
    updateJson: async function (rel, mutate) {
      const current = read(rel);
      const next = await mutate(current);
      if (next === undefined) return { data: current, written: false };
      await this.writeJson(rel, next);
      return { data: next, written: true };
    },
    listDocuments: async ns =>
      [...files.keys()]
        .filter(rel => rel.startsWith(`${ns}/`))
        .sort()
        .map(rel => ({ key: rel.slice(ns.length + 1, -5), path: rel, data: read(rel) }))
  };
  return { default: store, configStore: store };
});
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    get: key => ({ data: read(key), etag: null }),
    getIntegrations: () => ({ data: read('config/integrations.json'), etag: null }),
    getInstallations: () => ({ data: read('config/installations.json') || { installations: {} } }),
    getCredentials: () => ({ credentials: {} }),
    getFeatures: () => ({ marketplace: true }),
    getPlatform: () => ({ features: { marketplace: true } }),
    getRegistries: () => ({ data: { registries: [] } }),
    getModels: () => ({ data: [] }),
    getApps: () => ({ data: [] }),
    refreshCacheEntry: async () => {},
    refreshAppsCache: async () => {},
    refreshInstallationsCache: async () => {},
    refreshCredentialsCache: async () => {}
  },
  resolveEnvVarsInObject: value => value
}));
jest.unstable_mockModule('../../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    if (req.headers['x-admin'] !== 'yes') return res.status(401).json({ error: 'no' });
    req.user = { id: 'admin', username: 'admin' };
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
jest.unstable_mockModule('../../services/tools/OpenApiToolRunner.js', () => ({
  parseOpenApiText: text => JSON.parse(text),
  invalidateSpecCache: () => {},
  invalidateToolsWithPrefix: () => {},
  getOpenApiToolParameters: async () => ({ type: 'object', properties: {}, required: [] }),
  runOpenApiTool: async () => ({ success: true, result: { count: 1 } })
}));
let catalogItem = null;
jest.unstable_mockModule('../../services/marketplace/RegistryService.js', () => ({
  default: {
    getItemDetail: async (registryId, type, name) => ({ ...catalogItem, registryId, type, name }),
    getCachedCatalogAsync: async () => null
  }
}));

const OPENAPI = {
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  paths: {
    '/search': { get: { operationId: 'search', responses: {} } },
    '/get': { get: { operationId: 'get', responses: {} } }
  }
};

const RELEASES = [
  { version: '1.4.0', date: '2026-11-12', summary: 'rows', migration: '1.4.0' },
  { version: '1.3.0', date: '2026-10-28', summary: 'renames', migration: '1.3.0' },
  { version: '1.2.0', date: '2026-10-01', summary: 'first' }
];
const MIGRATIONS = [
  {
    id: '1.3.0',
    steps: [
      { renameValue: { from: 'fq', to: 'defaultFilter' } },
      { renameAction: { from: 'search', to: 'dataset_search' } }
    ]
  },
  { id: '1.4.0', steps: [{ setValue: { key: 'rows', value: 20, when: 'missing' } }] }
];

function portal(id, version, extra = {}) {
  return {
    id,
    version,
    name: { en: id },
    protocol: { type: 'openapi', document: 'api.json', baseUrl: '{baseUrl}' },
    auth: { modes: ['none'] },
    install: [
      { key: 'baseUrl', type: 'url', title: 'URL', required: true },
      { key: 'defaultFilter', type: 'string', title: 'Filter' },
      { key: 'rows', type: 'number', title: 'Rows' }
    ],
    actions: [
      { name: 'dataset_search', operationId: 'search', sideEffect: 'read' },
      { name: 'get', operationId: 'get', sideEffect: 'read' }
    ],
    ...extra
  };
}

async function writeDefinition(definition) {
  const dir = path.join(shippedDir, definition.id.replace('/', '__'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(definition));
  await fs.writeFile(path.join(dir, 'api.json'), JSON.stringify(OPENAPI));
}

await writeDefinition(
  portal('org.example/portal', '1.4.0', { releases: RELEASES, migrations: MIGRATIONS })
);
await writeDefinition(
  portal('org.example/plain', '1.2.1', {
    releases: [
      { version: '1.2.1', date: '2026-11-01', summary: 'fix' },
      { version: '1.2.0', date: '2026-10-01', summary: 'first' }
    ]
  })
);
await writeDefinition(
  portal('org.example/future', '1.0.0', { compatibility: { ihub: '>=99.0.0' } })
);

const { IntegrationRegistry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const registryModule =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
Object.assign(
  registryModule.default,
  new IntegrationRegistry({
    shippedDir,
    contentsDir: path.join(contents, 'integration-definitions')
  })
);
await registryModule.default.reload();

const { default: installedIntegrationService } =
  await import('../../services/integrations/InstalledIntegrationService.js');
const { discoverIntegrationTools, runIntegrationTool } =
  await import('../../services/integrations/integrationTools.js');
const { FilesystemLockManager } =
  await import('../../storage/providers/filesystem/FilesystemLockManager.js');
const { default: registerAdminIntegrationsRoutes } =
  await import('../../routes/admin/integrations.js');
const { default: errorHandler } = await import('../../middleware/errorHandler.js');
const { default: registerAdminMarketplaceRoutes } =
  await import('../../routes/admin/marketplace.js');

const app = express();
app.use(express.json());
registerAdminIntegrationsRoutes(app);
registerAdminMarketplaceRoutes(app);
app.use(errorHandler);
const admin = r => r.set('X-Admin', 'yes');

function installation(id, definition, extra = {}) {
  return {
    id,
    definition,
    definitionVersion: '1.2.0',
    enabled: true,
    values: { baseUrl: 'https://portal.example', fq: 'groups:env' },
    auth: { mode: 'none' },
    actions: { enabled: ['*', 'search'], disabled: [], overrides: {} },
    ...extra
  };
}

const NEW_ACTIONS = { enabled: ['*'], disabled: [], overrides: {} };

beforeEach(async () => {
  files.clear();
  audits.length = 0;
  await fs.rm(path.join(contents, 'backups'), { recursive: true, force: true });
  files.set('config/integrations.json', {
    installed: [
      installation('pending', 'org.example/portal'),
      installation('collide', 'org.example/portal', {
        values: { baseUrl: 'https://portal.example', fq: 'a', defaultFilter: 'b' }
      }),
      installation('stale', 'org.example/plain', {
        values: { baseUrl: 'https://plain.example' },
        actions: NEW_ACTIONS
      }),
      installation('current', 'org.example/portal', {
        definitionVersion: '1.4.0',
        values: { baseUrl: 'https://current.example' },
        actions: NEW_ACTIONS
      }),
      installation('review', 'org.example/plain', {
        definitionVersion: undefined,
        values: { baseUrl: 'https://plain.example' },
        actions: NEW_ACTIONS
      }),
      installation('failed', 'org.example/portal', {
        status: 'migrationFailed',
        statusReason: 'an earlier run failed'
      }),
      installation('future', 'org.example/future', {
        definitionVersion: '1.0.0',
        values: { baseUrl: 'https://future.example' },
        actions: NEW_ACTIONS
      })
    ],
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
  files.set('apps/own.json', {
    id: 'own',
    integrations: { pending: { actions: ['search', 'get'] } }
  });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('list and detail', () => {
  it('requires admin', async () => {
    await request(app).post('/api/admin/integrations/installed/pending/_migrate').expect(401);
    await request(app).post('/api/admin/integrations/installed/pending/_restore').expect(401);
    await request(app).post('/api/admin/integrations/installed/review/_adopt').expect(401);
  });

  it('returns the state, the log, the version and the planned migration', async () => {
    const res = await admin(request(app).get('/api/admin/integrations/installed')).expect(200);
    const byId = Object.fromEntries(res.body.items.map(item => [item.id, item]));
    expect(byId.pending).toMatchObject({
      status: 'migrationPending',
      definitionVersion: '1.2.0',
      currentVersion: '1.4.0',
      migrationLog: [],
      liveStatus: null,
      migration: {
        pending: true,
        blocked: true,
        from: '1.2.0',
        to: '1.4.0',
        migrations: ['1.3.0', '1.4.0'],
        summary: { values: 2, actions: 1, apps: 1 },
        warnings: [],
        collisions: [],
        backups: []
      }
    });
    expect(byId.pending.statusReason).toMatch(/1\.3\.0, 1\.4\.0 are pending/);
    expect(byId.collide.migration.collisions[0].key).toBe('defaultFilter');
    expect(byId.stale).toMatchObject({
      status: 'migrationPending',
      migration: { pending: true, blocked: false, migrations: [] }
    });
    expect(byId.current).toMatchObject({ status: null, migration: null });
    expect(byId.review).toMatchObject({ status: 'needsReview', definitionVersion: null });
    expect(byId.failed).toMatchObject({
      status: 'migrationFailed',
      statusReason: 'an earlier run failed'
    });
    expect(byId.future).toMatchObject({ incompatible: true, status: null, migration: null });
    expect(files.get('apps/own.json').integrations.pending.actions).toEqual(['search', 'get']);

    const detail = await admin(
      request(app).get('/api/admin/integrations/installed/pending')
    ).expect(200);
    expect(detail.body.instance.status).toBe('migrationPending');
    expect(detail.body.instance.migration.migrations).toEqual(['1.3.0', '1.4.0']);
    expect(detail.body.actions).toEqual([], 'a blocked installation is not asked for actions');
  });
});

describe('POST _migrate', () => {
  it('migrates and answers with the log entry and the new state', async () => {
    const res = await admin(
      request(app).post('/api/admin/integrations/installed/pending/_migrate')
    ).expect(200);
    expect(res.body).toMatchObject({
      result: 'migrated',
      logEntry: { from: '1.2.0', to: '1.4.0', result: 'migrated', by: 'admin', trigger: 'manual' },
      instance: { id: 'pending', status: null, definitionVersion: '1.4.0' }
    });
    expect(res.body.instance.migration.backups).toHaveLength(2);
    expect(res.body.instance.migration.backups.map(b => b.representedVersion).sort()).toEqual([
      '1.2.0',
      '1.3.0'
    ]);
    expect(files.get('apps/own.json').integrations.pending.actions).toEqual([
      'dataset_search',
      'get'
    ]);
    expect(audits.at(-1)).toMatchObject({ resource: 'integration', resourceId: 'pending' });
  });

  it('answers 422 with code and reason when the migration fails', async () => {
    const res = await admin(
      request(app).post('/api/admin/integrations/installed/collide/_migrate')
    ).expect(422);
    expect(res.body).toMatchObject({ code: 'MIGRATION_FAILED' });
    expect(res.body.details).toMatchObject({
      logEntry: { result: 'failed' },
      instance: { id: 'collide', status: 'migrationFailed', definitionVersion: '1.2.0' }
    });
    expect(res.body.details.reason).toMatch(/collides on defaultFilter/);
    expect(res.body.details.instance.migration.defaultBackup).toMatch(/^collide-1\.2\.0-/);
  });

  it('answers 409 MIGRATION_LOCKED while the lock is held', async () => {
    const locks = new FilesystemLockManager({ baseDir: path.join(contents, 'data') });
    let release;
    let entered;
    const holding = new Promise(resolve => (entered = resolve));
    const held = locks.withLock(
      'integration-migration:pending',
      () =>
        new Promise(resolve => {
          release = resolve;
          entered();
        })
    );
    // Only once the lock is held: acquiring it takes a few file operations,
    // and a request sent before they finish takes the lock itself.
    await holding;
    try {
      const res = await admin(
        request(app).post('/api/admin/integrations/installed/pending/_migrate')
      ).expect(409);
      expect(res.body.code).toBe('MIGRATION_LOCKED');
    } finally {
      release();
      await held;
    }
  });

  it('answers 409 for an installation that needs a review, 404 for an unknown one, 400 for a bad id', async () => {
    const review = await admin(
      request(app).post('/api/admin/integrations/installed/review/_migrate')
    ).expect(409);
    expect(review.body.code).toBe('MIGRATION_NOT_APPLICABLE');
    await admin(request(app).post('/api/admin/integrations/installed/nope/_migrate')).expect(404);
    await admin(request(app).post('/api/admin/integrations/installed/bad%20id/_migrate')).expect(
      400
    );
    const future = await admin(
      request(app).post('/api/admin/integrations/installed/future/_migrate')
    ).expect(422);
    expect(future.body.code).toBe('INCOMPATIBLE_DEFINITION');
  });
});

describe('POST _restore and _adopt', () => {
  it('restores the backup a failed migration took', async () => {
    await admin(request(app).post('/api/admin/integrations/installed/collide/_migrate')).expect(
      422
    );
    const res = await admin(
      request(app).post('/api/admin/integrations/installed/collide/_restore').send({})
    ).expect(200);
    expect(res.body).toMatchObject({
      backup: { representedVersion: '1.2.0', kind: 'pre-migration' },
      logEntry: { result: 'restored' },
      instance: { id: 'collide', definitionVersion: '1.2.0', status: 'migrationPending' }
    });
  });

  it('refuses where nothing needs a restore, a missing backup and a bad backup id', async () => {
    const normal = await admin(
      request(app).post('/api/admin/integrations/installed/current/_restore')
    ).expect(409);
    expect(normal.body.code).toBe('RESTORE_NOT_APPLICABLE');
    const none = await admin(
      request(app).post('/api/admin/integrations/installed/failed/_restore')
    ).expect(404);
    expect(none.body.code).toBe('BACKUP_NOT_FOUND');
    await admin(
      request(app)
        .post('/api/admin/integrations/installed/failed/_restore')
        .send({ backup: '../x' })
    ).expect(400);
  });

  it('adopts the loaded version after validating the stored values', async () => {
    const res = await admin(
      request(app).post('/api/admin/integrations/installed/review/_adopt')
    ).expect(200);
    expect(res.body).toMatchObject({
      logEntry: { result: 'adopted', to: '1.2.1' },
      instance: { id: 'review', status: null, definitionVersion: '1.2.1' }
    });
    const again = await admin(
      request(app).post('/api/admin/integrations/installed/review/_adopt')
    ).expect(409);
    expect(again.body.code).toBe('ADOPT_NOT_APPLICABLE');
  });

  it('refuses to adopt values that do not fit', async () => {
    const config = files.get('config/integrations.json');
    config.installed.find(i => i.id === 'review').values.unknownField = 'x';
    const res = await admin(
      request(app).post('/api/admin/integrations/installed/review/_adopt')
    ).expect(422);
    expect(res.body.code).toBe('ADOPT_INVALID');
    expect(res.body.errors.map(e => e.message)).toContain('unknownField: unknown install field');
  });
});

describe('POST _revert', () => {
  it('reverts to a backup the admin picked, in any state', async () => {
    const backups = await import('../../services/integrations/definitions/migrationBackups.js');
    const kept = structuredClone(files.get('config/integrations.json'));
    kept.installed.find(i => i.id === 'current').values.rows = 7;
    const snapshot = await backups.createSnapshot({
      instanceId: 'current',
      definitionId: 'org.example/portal',
      representedVersion: '1.4.0',
      integrations: kept
    });
    const res = await admin(
      request(app)
        .post('/api/admin/integrations/installed/current/_revert')
        .send({ backup: snapshot.id })
    ).expect(200);
    expect(res.body).toMatchObject({
      backup: { id: snapshot.id, representedVersion: '1.4.0', hasDefinition: false },
      logEntry: { result: 'reverted', trigger: 'revert' },
      instance: { id: 'current', status: null, definitionVersion: '1.4.0' }
    });
    const current = files.get('config/integrations.json').installed.find(i => i.id === 'current');
    expect(current.values.rows).toBe(7);
    expect(audits.at(-1).summary).toMatch(/Reverted integration "current"/);
  });

  it('needs a backup, refuses an unknown one and one without the definition of its version', async () => {
    const none = await admin(
      request(app).post('/api/admin/integrations/installed/current/_revert').send({})
    ).expect(400);
    expect(none.body.code).toBe('BACKUP_REQUIRED');
    await admin(
      request(app)
        .post('/api/admin/integrations/installed/current/_revert')
        .send({ backup: '../x' })
    ).expect(400);
    const unknown = await admin(
      request(app)
        .post('/api/admin/integrations/installed/current/_revert')
        .send({ backup: 'nope' })
    ).expect(404);
    expect(unknown.body.code).toBe('BACKUP_NOT_FOUND');
    await admin(request(app).post('/api/admin/integrations/installed/pending/_migrate')).expect(
      200
    );
    const detail = await admin(
      request(app).get('/api/admin/integrations/installed/pending')
    ).expect(200);
    const boundary = detail.body.instance.migration.backups.find(b => b.kind === 'boundary');
    const res = await admin(
      request(app)
        .post('/api/admin/integrations/installed/pending/_revert')
        .send({ backup: boundary.id })
    ).expect(422);
    expect(res.body.code).toBe('REVERT_DEFINITION_MISSING');
    await request(app).post('/api/admin/integrations/installed/current/_revert').expect(401);
  });
});

describe('an ordinary save', () => {
  const save = (id, body) =>
    admin(request(app).put(`/api/admin/integrations/installed/${id}`).send(body));

  it('is refused while a migration is pending, failed, or a review is needed', async () => {
    const body = { definition: 'org.example/portal', values: { baseUrl: 'https://x' } };
    expect((await save('pending', body).expect(409)).body.code).toBe('MIGRATION_PENDING');
    expect((await save('failed', body).expect(409)).body.code).toBe('MIGRATION_FAILED');
    expect(
      (
        await save('review', {
          definition: 'org.example/plain',
          values: { baseUrl: 'https://x' }
        }).expect(409)
      ).body.code
    ).toBe('NEEDS_REVIEW');
  });

  it('stamps the new version when no migration lies between, and keeps the log', async () => {
    const res = await save('stale', {
      definition: 'org.example/plain',
      values: { baseUrl: 'https://plain.example' },
      status: 'needsReview',
      migrationLog: []
    }).expect(200);
    expect(res.body.definitionVersion).toBe('1.2.1');
    expect(res.body.status).toBeUndefined();
  });
});

describe('tools in each state', () => {
  it('only installations whose state allows it offer tools', async () => {
    const offered = (await installedIntegrationService.resolveAllEnabled()).map(r => r.instance.id);
    expect(offered.sort()).toEqual(['current', 'stale']);
    const tools = await discoverIntegrationTools('en');
    const owners = [...new Set(tools.map(tool => tool._integration.instanceId))].sort();
    expect(owners).toEqual(['current', 'stale']);
  });

  it('refuses to run a tool of a blocked installation', async () => {
    const tool = { id: 'pending__get', _integration: { instanceId: 'pending', action: 'get' } };
    await expect(runIntegrationTool(tool, {})).rejects.toThrow(/cannot run: migrationPending/);
    const failed = { id: 'failed__get', _integration: { instanceId: 'failed', action: 'get' } };
    await expect(runIntegrationTool(failed, {})).rejects.toThrow(/migrationFailed/);
  });
});

describe('the marketplace update preview', () => {
  it('plans the catalog migrations against every installation of the definition', async () => {
    catalogItem = { version: '1.4.0', releases: RELEASES, migrations: MIGRATIONS };
    const res = await admin(
      request(app).get(
        '/api/admin/marketplace/registries/reg/items/integration/org.example__portal'
      )
    ).expect(200);
    const preview = res.body.migrationPreview;
    expect(preview).toMatchObject({
      definitionId: 'org.example/portal',
      to: '1.4.0',
      planFromCatalog: true
    });
    const byId = Object.fromEntries(preview.installations.map(row => [row.id, row]));
    expect(byId.pending).toMatchObject({
      ok: true,
      migrations: ['1.3.0', '1.4.0'],
      summary: { values: 2, actions: 1, apps: 1 }
    });
    expect(byId.collide.ok).toBe(false);
    expect(byId.collide.collisions[0].key).toBe('defaultFilter');
    expect(byId.current.reason).toMatch(/already at 1\.4\.0/);
    expect(files.get('config/integrations.json').installed[0].definitionVersion).toBe('1.2.0');
  });

  it('says when it cannot plan from the catalog', async () => {
    catalogItem = {
      version: '1.4.0',
      releases: RELEASES.slice(0, 1),
      migrations: MIGRATIONS.slice(1)
    };
    const res = await admin(
      request(app).get(
        '/api/admin/marketplace/registries/reg/items/integration/org.example__portal'
      )
    ).expect(200);
    expect(res.body.migrationPreview.planFromCatalog).toBe(false);
    expect(res.body.migrationPreview.reason).toMatch(/older than the releases the catalog lists/);
  });

  it('has no preview for a definition without installations', async () => {
    catalogItem = { version: '1.0.0', releases: [], migrations: [] };
    const res = await admin(
      request(app).get('/api/admin/marketplace/registries/reg/items/integration/org.example__none')
    ).expect(200);
    expect(res.body.migrationPreview).toBeNull();
  });
});
