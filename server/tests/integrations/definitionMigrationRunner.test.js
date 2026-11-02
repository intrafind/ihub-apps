// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Versioning phase 2 (#3090): the definition migration runner against a
 * real contents folder — backups and their manifest, the staged commit with
 * its marker, recovery of an interrupted commit, failure handling, the lock
 * and its fencing token, restore and adopt, the startup run and the
 * marketplace update path.
 *
 * Run with `npm run test:integrations`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-definition-migrations-'));
const contents = path.join(root, 'contents');
const shipped = path.join(root, 'shipped');
// Read by `config.js` when the server modules load below.
process.env.CONTENTS_DIR = contents;

const { IntegrationRegistry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const { DefinitionMigrationRunner, migrationLockName } =
  await import('../../services/integrations/definitions/DefinitionMigrationRunner.js');
const backups = await import('../../services/integrations/definitions/migrationBackups.js');
const { FilesystemLockManager } =
  await import('../../storage/providers/filesystem/FilesystemLockManager.js');
const { default: configStore } = await import('../../services/config/ConfigStore.js');
const { IntegrationError } =
  await import('../../services/integrations/InstalledIntegrationService.js');

const INTEGRATIONS = 'config/integrations.json';
const MANIFEST = 'config/installations.json';
const OPENAPI = {
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  paths: {
    '/search': { get: { operationId: 'search', responses: {} } },
    '/get': { get: { operationId: 'get', responses: {} } }
  }
};

/**
 * The fixture definition at a version: 1.2.0 (actions `search`, `get`,
 * value `fq`), 1.3.0 (renames `fq` → `defaultFilter`, `search` →
 * `dataset_search`), 1.4.0 (sets `rows` when missing).
 */
function portalDefinition(id, version) {
  const releases = [
    { version: '1.4.0', date: '2026-11-12', summary: 'rows', migration: '1.4.0' },
    { version: '1.3.0', date: '2026-10-28', summary: 'renames', migration: '1.3.0' },
    { version: '1.2.0', date: '2026-10-01', summary: 'first' }
  ].filter(r => r.version <= version);
  const migrations = [
    {
      id: '1.3.0',
      steps: [
        { renameValue: { from: 'fq', to: 'defaultFilter' } },
        { renameAction: { from: 'search', to: 'dataset_search' } }
      ]
    },
    { id: '1.4.0', steps: [{ setValue: { key: 'rows', value: 20, when: 'missing' } }] }
  ].filter(m => m.id <= version);
  const renamed = version >= '1.3.0';
  return {
    id,
    version,
    name: { en: `Portal ${id}` },
    type: 'people-directory',
    protocol: { type: 'openapi', document: 'api.json', baseUrl: '{baseUrl}' },
    auth: { modes: ['none'] },
    install: [
      { key: 'baseUrl', type: 'url', title: 'URL', required: true },
      { key: renamed ? 'defaultFilter' : 'fq', type: 'string', title: 'Filter' },
      { key: 'rows', type: 'number', title: 'Rows', min: 1, max: 100 }
    ],
    actions: [
      { name: renamed ? 'dataset_search' : 'search', operationId: 'search', sideEffect: 'read' },
      { name: 'get', operationId: 'get', sideEffect: 'read' }
    ],
    scopes: {
      action: renamed ? 'dataset_search' : 'search',
      label: 'Publisher',
      map: { id: 'name', name: 'title' },
      applyAs: {
        [`${renamed ? 'dataset_search' : 'search'}.fq`]: { value: '{id}', mode: 'append' }
      }
    },
    releases,
    ...(migrations.length ? { migrations } : {})
  };
}

function folderOf(id) {
  return id.replace('/', '__');
}

function packageFiles(definition) {
  return { 'integration.json': definition, 'api.json': JSON.stringify(OPENAPI) };
}

async function writeFolder(base, definition) {
  const dir = path.join(base, folderOf(definition.id));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(packageFiles(definition))) {
    await fs.writeFile(
      path.join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    );
  }
}

async function readFolderVersion(id) {
  const file = path.join(contents, 'integration-definitions', folderOf(id), 'integration.json');
  return JSON.parse(await fs.readFile(file, 'utf8')).version;
}

function installation(id, definition, extra = {}) {
  return {
    id,
    definition,
    definitionVersion: '1.2.0',
    enabled: true,
    values: { baseUrl: 'https://portal.example', fq: 'groups:env' },
    auth: { mode: 'none' },
    actions: {
      enabled: ['search', 'get'],
      disabled: [],
      overrides: { search: { sideEffect: 'read' } }
    },
    ...extra
  };
}

async function writeJson(rel, data) {
  await configStore.writeJson(rel, data);
}

async function readJson(rel) {
  return configStore.readJson(rel);
}

async function entryOf(id) {
  return (await readJson(INTEGRATIONS)).installed.find(inst => inst.id === id);
}

/** A change queue and hooks like the service's, without the cache. */
const service = {
  _serialize: fn => fn(),
  _afterChange: async () => {}
};

const locks = new FilesystemLockManager({ baseDir: path.join(root, 'data') });
let clockTick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 2, 10, 0, 0, clockTick++));

let registry;
function runner(options = {}) {
  return new DefinitionMigrationRunner({ registry, service, locks, clock, ...options });
}

/** The ids of the backups of an installation, newest first. */
async function backupsOf(instanceId) {
  return backups.listSnapshots({ instanceId });
}

before(async () => {
  await fs.mkdir(path.join(contents, 'config'), { recursive: true });
  await fs.mkdir(path.join(contents, 'apps'), { recursive: true });
  // A built-in definition the "iHub release" updated to 1.4.0, and two
  // marketplace definitions: one already at 1.4.0 (copied in by hand), one
  // at 1.2.0 that the marketplace updates.
  await writeFolder(shipped, portalDefinition('com.example/builtin', '1.4.0'));
  await writeFolder(
    path.join(contents, 'integration-definitions'),
    portalDefinition('org.example/portal', '1.4.0')
  );
  await writeFolder(
    path.join(contents, 'integration-definitions'),
    portalDefinition('org.example/market', '1.2.0')
  );
  await writeFolder(path.join(contents, 'integration-definitions'), {
    ...portalDefinition('org.example/plain', '1.2.0'),
    version: '1.2.1',
    releases: [
      { version: '1.2.1', date: '2026-11-01', summary: 'fix' },
      { version: '1.2.0', date: '2026-10-01', summary: 'first' }
    ]
  });
  await writeFolder(path.join(contents, 'integration-definitions'), {
    ...portalDefinition('org.example/future', '1.4.0'),
    compatibility: { ihub: '>=99.0.0' }
  });
  registry = new IntegrationRegistry({
    shippedDir: shipped,
    contentsDir: path.join(contents, 'integration-definitions')
  });
  await registry.reload();
  await writeJson(INTEGRATIONS, {
    installed: [
      installation('govdata', 'org.example/portal'),
      installation('sibling', 'org.example/portal'),
      installation('collide', 'org.example/portal', {
        values: { baseUrl: 'https://portal.example', fq: 'a', defaultFilter: 'b' }
      }),
      installation('appclash', 'org.example/portal', {
        actions: { enabled: ['*'], disabled: [], overrides: {} }
      }),
      installation('plain', 'org.example/plain', {
        actions: { enabled: ['*'], disabled: [], overrides: {} }
      }),
      installation('builtin', 'com.example/builtin'),
      installation('future', 'org.example/future'),
      installation('market', 'org.example/market'),
      installation('crash', 'org.example/portal'),
      installation('ioerror', 'org.example/portal'),
      installation('fenced', 'org.example/portal'),
      installation('nover', 'org.example/plain', {
        definitionVersion: undefined,
        actions: { enabled: ['*'], disabled: [], overrides: {} }
      }),
      installation('badvalues', 'org.example/plain', {
        definitionVersion: undefined,
        values: { baseUrl: 'https://x', unknownField: 'x' },
        actions: { enabled: ['*'], disabled: [], overrides: {} }
      })
    ],
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
  await writeJson('apps/own.json', {
    id: 'own',
    integrations: {
      govdata: { actions: ['search', 'get'], pinnedScope: 'org:env' },
      crash: { actions: ['search'] },
      ioerror: { actions: ['search'] }
    }
  });
  await writeJson('apps/all-portals.json', {
    id: 'all-portals',
    integrations: { 'org.example/portal': { actions: ['search'] } }
  });
  await writeJson('apps/typed.json', {
    id: 'typed',
    integrations: { 'type:people-directory': { actions: ['search'] } }
  });
  await writeJson('apps/clash.json', {
    id: 'clash',
    integrations: { appclash: { actions: ['search', 'dataset_search'] } }
  });
  await writeJson('apps/market-app.json', {
    id: 'market-app',
    integrations: { market: { actions: ['search'] } }
  });
  await writeJson(MANIFEST, {
    installations: {
      'integration:org.example__market': {
        type: 'integration',
        itemId: 'org.example__market',
        registryId: 'reg',
        version: '1.2.0'
      }
    }
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('a manual migration', () => {
  it('backs up, migrates values, policy and bindings, and commits with a finished marker', async () => {
    const before = await entryOf('govdata');
    const outcome = await runner().migrate('govdata', { by: 'admin', notify: false });
    assert.equal(outcome.result, 'migrated');

    const migrated = await entryOf('govdata');
    assert.equal(migrated.definitionVersion, '1.4.0');
    assert.deepEqual(migrated.values, {
      baseUrl: 'https://portal.example',
      defaultFilter: 'groups:env',
      rows: 20
    });
    assert.deepEqual(migrated.actions.enabled, ['dataset_search', 'get']);
    assert.deepEqual(Object.keys(migrated.actions.overrides), ['dataset_search']);
    assert.equal(migrated.status, undefined);
    assert.deepEqual(migrated.auth, before.auth, 'auth untouched');

    const own = await readJson('apps/own.json');
    assert.deepEqual(own.integrations.govdata, {
      actions: ['dataset_search', 'get'],
      pinnedScope: 'org:env'
    });
    assert.deepEqual(own.integrations.crash, { actions: ['search'] }, 'other installations stay');
    const shared = await readJson('apps/all-portals.json');
    assert.deepEqual(shared.integrations['org.example/portal'].actions, ['dataset_search']);
    const typed = await readJson('apps/typed.json');
    assert.deepEqual(
      typed.integrations['type:people-directory'].actions,
      ['search'],
      'type binding kept'
    );

    const log = migrated.migrationLog.at(-1);
    assert.equal(log.result, 'migrated');
    assert.equal(log.from, '1.2.0');
    assert.equal(log.to, '1.4.0');
    assert.equal(log.by, 'admin');
    assert.equal(log.trigger, 'manual');
    assert.deepEqual(log.migrations, ['1.3.0', '1.4.0']);
    assert.ok(log.steps.includes('1.3.0: renameValue fq → defaultFilter'));
    assert.deepEqual(log.changes, { values: 2, actions: 1, apps: 2 });
    assert.ok(
      log.warnings.some(w => w.code === 'TYPE_BINDING_NOT_REWRITTEN' && w.appId === 'typed')
    );
    assert.deepEqual(outcome.logEntry, log);

    // The backup: manifest and copies of what was there before.
    const [boundary, pre] = await backupsOf('govdata');
    assert.equal(pre.id, log.backup);
    assert.match(pre.id, /^govdata-1\.2\.0-\d{8}T\d{9}Z$/);
    assert.equal(pre.manifest.representedVersion, '1.2.0');
    assert.equal(pre.manifest.instanceId, 'govdata');
    assert.equal(pre.manifest.definitionId, 'org.example/portal');
    assert.equal(pre.manifest.kind, 'pre-migration');
    assert.ok(Date.parse(pre.manifest.createdAt));
    assert.deepEqual(
      pre.manifest.files.map(f => f.path).sort(),
      ['apps/all-portals.json', 'apps/own.json', INTEGRATIONS].sort(),
      'the type-only app is not rewritten, so not kept'
    );
    assert.deepEqual(pre.manifest.files.find(f => f.path === 'apps/own.json').bindingKeys, [
      'govdata'
    ]);
    const keptConfig = await backups.readSnapshotJson(pre, INTEGRATIONS);
    assert.deepEqual(keptConfig.installed.find(i => i.id === 'govdata').values, before.values);
    assert.equal(
      pre.manifest.files.some(f => f.type === 'definition'),
      false,
      'the folder on disk is 1.4.0, not the version the backup represents'
    );
    const marker = await backups.readMarker(pre);
    assert.equal(marker.finished, true);
    assert.equal(marker.lock, migrationLockName('govdata'));
    assert.ok(Number.isSafeInteger(marker.token) && marker.token > 0, 'the fencing token');
    await assert.rejects(fs.access(path.join(pre.dir, 'staging')), 'staging removed');

    // The boundary between the two migrations.
    assert.equal(boundary.manifest.kind, 'boundary');
    assert.equal(boundary.manifest.representedVersion, '1.3.0');
    const atBoundary = (await backups.readSnapshotJson(boundary, INTEGRATIONS)).installed.find(
      i => i.id === 'govdata'
    );
    assert.equal(atBoundary.definitionVersion, '1.3.0');
    assert.equal(atBoundary.values.defaultFilter, 'groups:env');
    assert.equal(atBoundary.values.rows, undefined);
  });

  it('a sibling of the same definition migrates on its own, the shared binding already rewritten', async () => {
    const outcome = await runner().migrate('sibling', { notify: false });
    assert.equal(outcome.result, 'migrated');
    assert.equal((await entryOf('sibling')).definitionVersion, '1.4.0');
    const shared = await readJson('apps/all-portals.json');
    assert.deepEqual(shared.integrations['org.example/portal'].actions, ['dataset_search']);
  });

  it('answers current when there is nothing to do', async () => {
    const outcome = await runner().migrate('govdata', { notify: false });
    assert.equal(outcome.result, 'current');
    assert.equal(outcome.logEntry, null);
  });

  it('stamps the version when no migration lies between, without a backup', async () => {
    const outcome = await runner().migrate('plain', { notify: false });
    assert.equal(outcome.result, 'stamped');
    const plain = await entryOf('plain');
    assert.equal(plain.definitionVersion, '1.2.1');
    assert.equal(plain.migrationLog.at(-1).result, 'stamped');
    assert.equal((await backupsOf('plain')).length, 0);
  });
});

describe('a failing migration', () => {
  it('a collision leaves values and version, marks migrationFailed and keeps the backup', async () => {
    const before = await entryOf('collide');
    await assert.rejects(
      () => runner().migrate('collide', { by: 'admin', notify: false }),
      error => {
        assert.ok(error instanceof IntegrationError);
        assert.equal(error.status, 422);
        assert.equal(error.code, 'MIGRATION_FAILED');
        assert.match(error.details.reason, /collides on defaultFilter/);
        assert.equal(error.details.logEntry.result, 'failed');
        return true;
      }
    );
    const failed = await entryOf('collide');
    assert.equal(failed.status, 'migrationFailed');
    assert.match(failed.statusReason, /defaultFilter/);
    assert.equal(failed.definitionVersion, '1.2.0');
    assert.deepEqual(failed.values, before.values);
    assert.equal(failed.migrationLog.at(-1).result, 'failed');
    const [backup] = await backupsOf('collide');
    assert.equal(backup.manifest.representedVersion, '1.2.0');
    assert.equal(failed.migrationLog.at(-1).backup, backup.id);
  });

  it('an app binding collision can be fixed in the app and the migration re-run', async () => {
    await assert.rejects(() => runner().migrate('appclash', { notify: false }), {
      code: 'MIGRATION_FAILED'
    });
    assert.equal((await entryOf('appclash')).status, 'migrationFailed');
    await writeJson('apps/clash.json', {
      id: 'clash',
      integrations: { appclash: { actions: ['search'] } }
    });
    const outcome = await runner().migrate('appclash', { notify: false });
    assert.equal(outcome.result, 'migrated');
    const fixed = await entryOf('appclash');
    assert.equal(fixed.status, undefined);
    assert.equal(fixed.statusReason, undefined);
    assert.deepEqual(
      fixed.migrationLog.map(entry => entry.result),
      ['failed', 'migrated']
    );
    assert.deepEqual((await readJson('apps/clash.json')).integrations.appclash.actions, [
      'dataset_search'
    ]);
  });

  it('a failing write rolls everything back and marks migrationFailed', async () => {
    const failingStore = {
      ...configStore,
      readJson: rel => configStore.readJson(rel),
      listDocuments: ns => configStore.listDocuments(ns),
      writeJson: async (rel, data) => {
        if (rel === 'apps/own.json') throw new Error('disk full');
        return configStore.writeJson(rel, data);
      }
    };
    const before = await entryOf('ioerror');
    await assert.rejects(
      () => runner({ store: failingStore }).migrate('ioerror', { notify: false }),
      {
        code: 'MIGRATION_FAILED'
      }
    );
    const after = await entryOf('ioerror');
    assert.equal(after.definitionVersion, '1.2.0');
    assert.deepEqual(after.values, before.values);
    assert.equal(after.status, 'migrationFailed');
    assert.match(after.statusReason, /disk full/);
    const [backup] = await backupsOf('ioerror');
    const marker = await backups.readMarker(backup);
    assert.equal(marker.finished, true);
    assert.equal(marker.rolledBack, true);
  });
});

describe('the lock', () => {
  it('answers MIGRATION_LOCKED while another holder runs a migration of the installation', async () => {
    // withLock takes the lock asynchronously: wait until the holder is
    // inside it, or migrate() can win the race and run.
    let release;
    let entered;
    const inside = new Promise(resolve => (entered = resolve));
    const held = locks.withLock(
      migrationLockName('builtin'),
      () =>
        new Promise(resolve => {
          release = resolve;
          entered();
        })
    );
    await inside;
    try {
      await assert.rejects(
        () =>
          runner().migrate('builtin', {
            notify: false,
            lockOptions: { ttlMs: 60_000, waitMs: 50 }
          }),
        error => error.status === 409 && error.code === 'MIGRATION_LOCKED'
      );
    } finally {
      release();
      await held;
    }
    assert.equal((await entryOf('builtin')).definitionVersion, '1.2.0', 'nothing ran');
  });

  it('refuses the commit of a holder whose token is no longer current, and discards its staging', async () => {
    const staleLocks = {
      withLock: (name, fn) => fn({ name, token: 3, isCurrent: async () => false })
    };
    const before = await entryOf('fenced');
    await assert.rejects(
      () => runner({ locks: staleLocks }).migrate('fenced', { notify: false }),
      error => error.status === 409 && error.code === 'MIGRATION_LOCK_LOST'
    );
    assert.deepEqual(await entryOf('fenced'), before, 'nothing moved into place, no state written');
    const [backup] = await backupsOf('fenced');
    assert.equal(await backups.readMarker(backup), null, 'the marker is gone');
    await assert.rejects(fs.access(path.join(backup.dir, 'staging')));
  });
});

describe('an interrupted commit', () => {
  it('is rolled back by the recovery at the next start', async () => {
    // The process "dies" while the app file is being written:
    // integrations.json already says 1.4.0, the app still names `search`.
    const hangingStore = {
      ...configStore,
      readJson: rel => configStore.readJson(rel),
      listDocuments: ns => configStore.listDocuments(ns),
      writeJson: (rel, data) =>
        rel === 'apps/own.json' ? new Promise(() => {}) : configStore.writeJson(rel, data)
    };
    const crashing = runner({ store: hangingStore });
    void crashing.migrate('crash', { notify: false }).catch(() => {});
    for (let i = 0; i < 200 && (await entryOf('crash')).definitionVersion !== '1.4.0'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await entryOf('crash')).definitionVersion, '1.4.0', 'half written');
    const [backup] = await backupsOf('crash');
    assert.equal((await backups.readMarker(backup)).finished, false);

    // The next start, before anything loads.
    const recovered = await runner().recoverInterruptedCommits();
    assert.equal(recovered, 1);
    const rolledBack = await entryOf('crash');
    assert.equal(rolledBack.definitionVersion, '1.2.0');
    assert.equal(rolledBack.values.fq, 'groups:env');
    assert.equal(rolledBack.migrationLog.at(-1).result, 'rolledBack');
    assert.deepEqual((await readJson('apps/own.json')).integrations.crash.actions, ['search']);
    const marker = await backups.readMarker(backup);
    assert.equal(marker.finished, true);
    assert.equal(marker.rolledBack, true);
    assert.equal(await runner().recoverInterruptedCommits(), 0, 'nothing left to recover');
  });
});

describe('restore and adopt', () => {
  it('restores the backup taken before a failed migration', async () => {
    const outcome = await runner().restore('collide', { by: 'admin', notify: false });
    const restored = await entryOf('collide');
    assert.equal(restored.status, undefined);
    assert.equal(restored.definitionVersion, '1.2.0');
    assert.equal(restored.migrationLog.at(-1).result, 'restored');
    assert.equal(outcome.backup.representedVersion, '1.2.0');
    assert.equal(outcome.backup.kind, 'pre-migration');
  });

  it('refuses a restore where nothing needs one, and an unknown or foreign backup', async () => {
    await assert.rejects(() => runner().restore('govdata', { notify: false }), {
      code: 'RESTORE_NOT_APPLICABLE'
    });
    const [foreign] = await backupsOf('govdata');
    await writeJson(INTEGRATIONS, {
      ...(await readJson(INTEGRATIONS)),
      installed: (await readJson(INTEGRATIONS)).installed.map(inst =>
        inst.id === 'collide' ? { ...inst, status: 'migrationFailed', statusReason: 'x' } : inst
      )
    });
    await assert.rejects(() => runner().restore('collide', { backup: foreign.id, notify: false }), {
      code: 'BACKUP_NOT_FOUND'
    });
    await assert.rejects(() => runner().restore('collide', { backup: 'nope', notify: false }), {
      code: 'BACKUP_NOT_FOUND'
    });
  });

  it('adopts the loaded version for an installation without one, after validating it', async () => {
    const outcome = await runner().adopt('nover', { by: 'admin', notify: false });
    assert.equal(outcome.instance.definitionVersion, '1.2.1');
    const adopted = await entryOf('nover');
    assert.equal(adopted.definitionVersion, '1.2.1');
    assert.equal(adopted.migrationLog.at(-1).result, 'adopted');
    await assert.rejects(() => runner().adopt('nover', { notify: false }), {
      code: 'ADOPT_NOT_APPLICABLE'
    });
    await assert.rejects(
      () => runner().adopt('badvalues', { notify: false }),
      error => error.code === 'ADOPT_INVALID' && error.details.some(e => e.key === 'unknownField')
    );
    assert.equal((await entryOf('badvalues')).definitionVersion, undefined);
  });

  it('refuses to migrate an installation that needs a review', async () => {
    await assert.rejects(() => runner().migrate('badvalues', { notify: false }), {
      code: 'MIGRATION_NOT_APPLICABLE'
    });
  });
});

describe('the startup run', () => {
  it('migrates built-ins, leaves marketplace and incompatible definitions alone', async () => {
    const result = await runner().runStartup();
    const byId = Object.fromEntries(result.results.map(r => [r.id, r.result]));
    assert.equal(byId.builtin, 'migrated');
    assert.equal((await entryOf('builtin')).definitionVersion, '1.4.0');
    assert.equal((await entryOf('builtin')).migrationLog.at(-1).trigger, 'startup');
    assert.equal(byId.future, undefined, 'incompatible: never migrated');
    assert.equal((await entryOf('future')).definitionVersion, '1.2.0');
    assert.equal(byId.fenced, undefined, 'a marketplace definition waits for the admin');
    assert.equal((await entryOf('fenced')).definitionVersion, '1.2.0');
  });

  it('restores the matching backup when a definition went back (downgrade)', async () => {
    // iHub downgraded: the built-in definition is 1.2.0 again.
    await writeFolder(shipped, portalDefinition('com.example/builtin', '1.2.0'));
    await registry.reload();
    const result = await runner().runStartup();
    assert.deepEqual(
      result.results.filter(r => r.id === 'builtin').map(r => r.result),
      ['restored']
    );
    const restored = await entryOf('builtin');
    assert.equal(restored.definitionVersion, '1.2.0');
    assert.equal(restored.values.fq, 'groups:env');
    assert.equal(restored.migrationLog.at(-1).trigger, 'downgrade');
  });
});

describe('the marketplace update', () => {
  it('swaps the staged folder in only with the commit, and migrates the installation', async () => {
    const seen = [];
    const watchingStore = {
      ...configStore,
      readJson: rel => configStore.readJson(rel),
      writeJson: (rel, data) => configStore.writeJson(rel, data),
      listDocuments: async ns => {
        seen.push(await readFolderVersion('org.example/market'));
        return configStore.listDocuments(ns);
      }
    };
    const outcome = await runner({ store: watchingStore }).applyDefinitionUpdate({
      definitionId: 'org.example/market',
      files: packageFiles(portalDefinition('org.example/market', '1.4.0')),
      manifestKey: 'integration:org.example__market',
      manifestPatch: { version: '1.4.0', updatedBy: 'admin', updateAvailable: null },
      by: 'admin',
      notify: false
    });
    assert.deepEqual(seen, ['1.2.0'], 'planned while the old folder was in place');
    assert.equal(await readFolderVersion('org.example/market'), '1.4.0');
    assert.deepEqual(
      outcome.installations.map(r => [r.id, r.result]),
      [['market', 'migrated']]
    );
    const market = await entryOf('market');
    assert.equal(market.definitionVersion, '1.4.0');
    assert.equal(market.values.defaultFilter, 'groups:env');
    assert.equal(market.migrationLog.at(-1).trigger, 'marketplace');
    assert.deepEqual((await readJson('apps/market-app.json')).integrations.market.actions, [
      'dataset_search'
    ]);
    const manifest = await readJson(MANIFEST);
    assert.equal(manifest.installations['integration:org.example__market'].version, '1.4.0');

    // The backup holds the pre-update package and the manifest.
    const pre = (await backupsOf('market')).find(b => b.manifest.kind === 'pre-migration');
    const definitionFile = pre.manifest.files.find(f => f.type === 'definition');
    assert.equal(definitionFile.version, '1.2.0');
    const keptDir = await backups.snapshotDefinitionDir(pre);
    const kept = JSON.parse(await fs.readFile(path.join(keptDir, 'integration.json'), 'utf8'));
    assert.equal(kept.version, '1.2.0');
    assert.ok(pre.manifest.files.some(f => f.type === 'marketplace-manifest'));
    const leftovers = (await fs.readdir(path.join(contents, 'integration-definitions'))).filter(n =>
      n.startsWith('.')
    );
    assert.deepEqual(leftovers, [], 'no staging or previous folder left behind');
  });

  it('a failing commit leaves the old folder, the old values and the manifest', async () => {
    // Back to 1.2.0 for this case.
    await writeFolder(
      path.join(contents, 'integration-definitions'),
      portalDefinition('org.example/market', '1.2.0')
    );
    await registry.reload();
    const config = await readJson(INTEGRATIONS);
    config.installed = config.installed.map(inst =>
      inst.id === 'market' ? installation('market', 'org.example/market') : inst
    );
    await writeJson(INTEGRATIONS, config);
    const manifest = await readJson(MANIFEST);
    manifest.installations['integration:org.example__market'].version = '1.2.0';
    await writeJson(MANIFEST, manifest);
    await writeJson('apps/market-app.json', {
      id: 'market-app',
      integrations: { market: { actions: ['search'] } }
    });

    const failingStore = {
      ...configStore,
      readJson: rel => configStore.readJson(rel),
      listDocuments: ns => configStore.listDocuments(ns),
      writeJson: async (rel, data) => {
        if (rel === MANIFEST) throw new Error('read-only volume');
        return configStore.writeJson(rel, data);
      }
    };
    await assert.rejects(
      () =>
        runner({ store: failingStore }).applyDefinitionUpdate({
          definitionId: 'org.example/market',
          files: packageFiles(portalDefinition('org.example/market', '1.4.0')),
          manifestKey: 'integration:org.example__market',
          manifestPatch: { version: '1.4.0' },
          notify: false
        }),
      /read-only volume/
    );
    assert.equal(await readFolderVersion('org.example/market'), '1.2.0', 'old folder');
    const market = await entryOf('market');
    assert.equal(market.definitionVersion, '1.2.0', 'old version');
    assert.equal(market.values.fq, 'groups:env', 'old values');
    assert.equal(market.status, undefined);
    assert.deepEqual((await readJson('apps/market-app.json')).integrations.market.actions, [
      'search'
    ]);
    assert.equal(
      (await readJson(MANIFEST)).installations['integration:org.example__market'].version,
      '1.2.0'
    );
    const leftovers = (await fs.readdir(path.join(contents, 'integration-definitions'))).filter(n =>
      n.startsWith('.')
    );
    assert.deepEqual(leftovers, []);
  });

  it('a migration that fails marks the installation and a restore brings the old package back', async () => {
    await registry.reload();
    const config = await readJson(INTEGRATIONS);
    config.installed = config.installed.map(inst =>
      inst.id === 'market'
        ? installation('market', 'org.example/market', {
            values: { baseUrl: 'https://portal.example', fq: 'a', defaultFilter: 'b' }
          })
        : inst
    );
    await writeJson(INTEGRATIONS, config);
    const outcome = await runner().applyDefinitionUpdate({
      definitionId: 'org.example/market',
      files: packageFiles(portalDefinition('org.example/market', '1.4.0')),
      manifestKey: 'integration:org.example__market',
      manifestPatch: { version: '1.4.0' },
      notify: false
    });
    assert.deepEqual(
      outcome.installations.map(r => [r.id, r.result]),
      [['market', 'failed']]
    );
    assert.equal(await readFolderVersion('org.example/market'), '1.4.0', 'the update went in');
    const failed = await entryOf('market');
    assert.equal(failed.status, 'migrationFailed');
    assert.equal(failed.definitionVersion, '1.2.0');
    assert.deepEqual(failed.values, {
      baseUrl: 'https://portal.example',
      fq: 'a',
      defaultFilter: 'b'
    });

    await registry.reload();
    const restored = await runner().restore('market', { notify: false });
    assert.equal(restored.backup.hasDefinition, true);
    assert.equal(await readFolderVersion('org.example/market'), '1.2.0', 'pre-update package back');
    const entry = await entryOf('market');
    assert.equal(entry.status, undefined);
    assert.equal(entry.definitionVersion, '1.2.0');
    assert.equal(
      (await readJson(MANIFEST)).installations['integration:org.example__market'].version,
      '1.2.0'
    );
  });
});
