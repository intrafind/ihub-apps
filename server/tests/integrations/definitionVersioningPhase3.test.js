// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Versioning phase 3 (#3091) against a real contents folder:
 *
 * - module migration steps: the pure planner (mixed declarative and module
 *   steps in semver order, what a module may and may not change), and the
 *   runner (a registry trusted for code with the file's hash, an untrusted
 *   registry, a file changed after install, a built-in, the marketplace
 *   update);
 * - the version policy of a registry (channel, pin) and the catalog's
 *   `versions`;
 * - Revert: the boundary backups of a multi-step update hold the definition
 *   folder and the manifest entry of their version, and reverting to one puts
 *   back definition folder, installation entry, app bindings and manifest
 *   entry together; a failure mid-way rolls all four back.
 *
 * Run with `npm run test:integrations`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-versioning-p3-'));
const contents = path.join(root, 'contents');
const shipped = path.join(root, 'shipped');
// Read by `config.js` when the server modules load below.
process.env.CONTENTS_DIR = contents;

const { IntegrationRegistry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const { DefinitionMigrationRunner, migrationLockName } =
  await import('../../services/integrations/definitions/DefinitionMigrationRunner.js');
const backups = await import('../../services/integrations/definitions/migrationBackups.js');
const { planMigration, planMigrationAsync, MIGRATION_WARNINGS } =
  await import('../../services/integrations/definitions/migrationPlanner.js');
const { loadMigrationModule, MODULE_ERRORS } =
  await import('../../services/integrations/definitions/migrationModules.js');
const { FilesystemLockManager } =
  await import('../../storage/providers/filesystem/FilesystemLockManager.js');
const { default: configStore } = await import('../../services/config/ConfigStore.js');
const { validateIntegrationDefinition } =
  await import('../../validators/integrationDefinitionSchema.js');
const { validateRegistryConfig } = await import('../../validators/registryConfigSchema.js');
const { validateCatalog } = await import('../../validators/catalogSchema.js');
const versionPolicy = await import('../../services/marketplace/versionPolicy.js');

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

function sha256(text) {
  return `sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/**
 * The migration module of the fixture (1.4.0): sets `rows` from the filter
 * the declarative 1.3.0 step renamed, renames the action `search` to
 * `dataset_search` in the policy and in the bindings it is handed, and logs.
 * `values.moduleMode` makes it misbehave on purpose.
 */
const MODULE_SOURCE = `
export function up({ instance, apps, definition, from, to, log }) {
  globalThis.__p3ModuleRuns = (globalThis.__p3ModuleRuns || 0) + 1;
  log('from ' + from + ' to ' + to + ' of ' + definition.id + ', auth handed: ' + ('auth' in instance));
  const mode = instance.values.moduleMode;
  if (mode === 'throw') throw new Error('the portal moved');
  if (mode === 'auth') return { ...instance, auth: { mode: 'none', credentialRef: 'stolen' } };
  if (mode === 'enabled') return { ...instance, enabled: false };
  const rename = list => list.map(name => (name === 'search' ? 'dataset_search' : name));
  for (const app of apps) {
    for (const binding of Object.values(app.integrations)) {
      if (Array.isArray(binding.actions)) binding.actions = rename(binding.actions);
    }
  }
  const overrides = {};
  for (const [name, value] of Object.entries(instance.actions.overrides)) {
    overrides[name === 'search' ? 'dataset_search' : name] = value;
  }
  const values = { ...instance.values, rows: instance.values.defaultFilter ? 50 : 10 };
  delete values.moduleMode;
  return {
    ...instance,
    values,
    actions: {
      enabled: rename(instance.actions.enabled),
      disabled: rename(instance.actions.disabled),
      overrides
    }
  };
}
`;
const MODULE_FILE = 'migrations/1.4.0.js';

/**
 * A definition at a version. 1.2.0: value `fq`, action `search`. 1.3.0:
 * renames `fq` → `defaultFilter` (declarative). 1.4.0: with `coded`, the
 * module above; without, a declarative `renameAction` and `setValue rows`.
 */
function portalDefinition(id, version, { coded = false } = {}) {
  const all = [
    { version: '1.4.0', date: '2026-11-12', summary: 'rows', migration: '1.4.0' },
    { version: '1.3.0', date: '2026-10-28', summary: 'filter', migration: '1.3.0' },
    { version: '1.2.0', date: '2026-10-01', summary: 'first' }
  ];
  const releases = all.filter(r => r.version <= version);
  const migrations = [
    { id: '1.3.0', steps: [{ renameValue: { from: 'fq', to: 'defaultFilter' } }] },
    {
      id: '1.4.0',
      steps: coded
        ? [{ module: MODULE_FILE }]
        : [
            { renameAction: { from: 'search', to: 'dataset_search' } },
            { setValue: { key: 'rows', value: 20, when: 'missing' } }
          ]
    }
  ].filter(m => m.id <= version);
  const renamedValue = version >= '1.3.0';
  const renamedAction = version >= '1.4.0';
  return {
    id,
    version,
    name: { en: `Portal ${id}` },
    protocol: { type: 'openapi', document: 'api.json', baseUrl: '{baseUrl}' },
    auth: { modes: ['none'] },
    install: [
      { key: 'baseUrl', type: 'url', title: 'URL', required: true },
      { key: renamedValue ? 'defaultFilter' : 'fq', type: 'string', title: 'Filter' },
      { key: 'rows', type: 'number', title: 'Rows', min: 1, max: 100 }
    ],
    actions: [
      {
        name: renamedAction ? 'dataset_search' : 'search',
        operationId: 'search',
        sideEffect: 'read'
      },
      { name: 'get', operationId: 'get', sideEffect: 'read' }
    ],
    releases,
    ...(migrations.length ? { migrations } : {})
  };
}

function folderOf(id) {
  return id.replace('/', '__');
}

function packageFiles(definition) {
  const files = { 'integration.json': definition, 'api.json': JSON.stringify(OPENAPI) };
  if (JSON.stringify(definition.migrations || []).includes(MODULE_FILE)) {
    files[MODULE_FILE] = MODULE_SOURCE;
  }
  return files;
}

async function writeFolder(base, definition) {
  const dir = path.join(base, folderOf(definition.id));
  await fs.rm(dir, { recursive: true, force: true });
  for (const [name, content] of Object.entries(packageFiles(definition))) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    );
  }
}

const installedDir = id => path.join(contents, 'integration-definitions', folderOf(id));

async function readFolderVersion(id) {
  const file = path.join(installedDir(id), 'integration.json');
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

/** Put an installation back to a fresh state (each case starts from 1.2.0). */
async function resetInstallation(entry) {
  const config = await readJson(INTEGRATIONS);
  const index = config.installed.findIndex(inst => inst.id === entry.id);
  if (index >= 0) config.installed[index] = entry;
  else config.installed.push(entry);
  await writeJson(INTEGRATIONS, config);
}

async function setManifestEntry(key, entry) {
  const manifest = (await readJson(MANIFEST)) || { installations: {} };
  manifest.installations[key] = entry;
  await writeJson(MANIFEST, manifest);
}

const service = { _serialize: fn => fn(), _afterChange: async () => {} };
const locks = new FilesystemLockManager({ baseDir: path.join(root, 'data') });
let clockTick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 2, 12, 0, 0, clockTick++));
let registry;

function runner(options = {}) {
  return new DefinitionMigrationRunner({
    registry,
    service,
    locks,
    clock,
    definitionVersions: async () => null,
    ...options
  });
}

const CODED = 'org.example/coded';
const CODED_KEY = 'integration:org.example__coded';
const BUILTIN = 'com.example/builtin-coded';
const MARKET = 'org.example/market';
const MARKET_KEY = 'integration:org.example__market';

before(async () => {
  await fs.mkdir(path.join(contents, 'config'), { recursive: true });
  await fs.mkdir(path.join(contents, 'apps'), { recursive: true });
  await writeFolder(shipped, portalDefinition(BUILTIN, '1.4.0', { coded: true }));
  await writeFolder(
    path.join(contents, 'integration-definitions'),
    portalDefinition(CODED, '1.4.0', { coded: true })
  );
  await writeFolder(
    path.join(contents, 'integration-definitions'),
    portalDefinition(MARKET, '1.2.0')
  );
  registry = new IntegrationRegistry({
    shippedDir: shipped,
    contentsDir: path.join(contents, 'integration-definitions')
  });
  await registry.reload();
  await writeJson('config/registries.json', {
    registries: [
      { id: 'trusted', name: 'Trusted', source: 'https://t.example/catalog.json', trustCode: true },
      { id: 'plain', name: 'Plain', source: 'https://p.example/catalog.json', trustCode: false }
    ]
  });
  await writeJson(MANIFEST, {
    installations: {
      [CODED_KEY]: {
        type: 'integration',
        itemId: 'org.example__coded',
        registryId: 'trusted',
        version: '1.4.0',
        codeIntegrity: { [MODULE_FILE]: sha256(MODULE_SOURCE) }
      },
      [MARKET_KEY]: {
        type: 'integration',
        itemId: 'org.example__market',
        registryId: 'trusted',
        version: '1.2.0'
      }
    }
  });
  await writeJson(INTEGRATIONS, {
    installed: [
      installation('coded', CODED),
      installation('builtin', BUILTIN),
      installation('market', MARKET)
    ],
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
  await writeJson('apps/coded-app.json', {
    id: 'coded-app',
    integrations: { coded: { actions: ['search', 'get'] }, other: { actions: ['x'] } }
  });
  await writeJson('apps/market-app.json', {
    id: 'market-app',
    integrations: { market: { actions: ['search'] } }
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The planner

describe('planner: module steps', () => {
  const definition = {
    id: 'org.example/p',
    version: '1.5.0',
    migrations: [
      { id: '1.5.0', steps: [{ renameAction: { from: 'search', to: 'find' } }] },
      { id: '1.3.0', steps: [{ renameValue: { from: 'fq', to: 'defaultFilter' } }] },
      {
        id: '1.4.0',
        steps: [{ module: 'migrations/1.4.0.js' }, { setValue: { key: 'rows', value: 5 } }]
      }
    ]
  };
  const inst = () => installation('p1', 'org.example/p');
  const apps = () => [
    {
      path: 'apps/a.json',
      app: { id: 'a', integrations: { p1: { actions: ['search'] }, other: { actions: ['x'] } } }
    }
  ];

  it('runs declarative and module steps in semver order, the module seeing the state before it', async () => {
    const seen = [];
    const plan = await planMigrationAsync(
      { instance: inst(), apps: apps(), definition, from: '1.2.0' },
      {
        runModule: async ({ migrationId, file, context }) => {
          seen.push({ migrationId, file, context: structuredClone(context) });
          context.apps[0].integrations.p1.pinnedScope = 'org:env';
          return {
            result: { ...context.instance, values: { ...context.instance.values, tag: 'm' } },
            logs: ['did it']
          };
        }
      }
    );
    assert.ok(plan.ok, JSON.stringify(plan.collisions));
    assert.deepEqual(plan.migrations, ['1.3.0', '1.4.0', '1.5.0']);
    assert.equal(seen.length, 1);
    const [{ migrationId, file, context }] = seen;
    assert.equal(migrationId, '1.4.0');
    assert.equal(file, 'migrations/1.4.0.js');
    assert.equal(context.from, '1.3.0');
    assert.equal(context.to, '1.4.0');
    assert.equal(context.instance.definitionVersion, '1.3.0');
    assert.equal(context.instance.values.defaultFilter, 'groups:env', '1.3.0 ran before');
    assert.equal(Object.hasOwn(context.instance, 'auth'), false, 'auth is never handed');
    assert.deepEqual(
      Object.keys(context.apps[0].integrations),
      ['p1'],
      'own and definition keys only'
    );
    assert.deepEqual(plan.instance.values, {
      baseUrl: 'https://portal.example',
      defaultFilter: 'groups:env',
      tag: 'm',
      rows: 5
    });
    assert.deepEqual(plan.instance.auth, { mode: 'none' }, 'auth as it was');
    assert.deepEqual(plan.instance.actions.enabled, ['find', 'get'], '1.5.0 ran after the module');
    assert.deepEqual(plan.apps[0].app.integrations.p1, {
      actions: ['find'],
      pinnedScope: 'org:env'
    });
    assert.deepEqual(plan.apps[0].app.integrations.other, { actions: ['x'] });
    assert.deepEqual(plan.steps, [
      '1.3.0: renameValue fq → defaultFilter',
      '1.4.0: module migrations/1.4.0.js',
      '1.4.0: module migrations/1.4.0.js: did it',
      '1.4.0: setValue rows = 5 (missing)',
      '1.5.0: renameAction search → find'
    ]);
    assert.deepEqual(plan.modules, ['1.4.0: migrations/1.4.0.js']);
    assert.deepEqual(plan.summary, { values: 3, actions: 1, apps: 1 });
    assert.equal(plan.boundaries.length, 2);
    assert.equal(plan.boundaries[1].instance.values.tag, 'm');
  });

  it('keeps the per-action approval through a module step, so a later rename moves it', async () => {
    const plan = await planMigrationAsync(
      {
        instance: inst2(),
        apps: apps(),
        definition,
        from: '1.2.0'
      },
      {
        runModule: async ({ context }) => ({
          result: {
            ...context.instance,
            actions: { ...context.instance.actions, disabled: ['get'] }
          },
          logs: []
        })
      }
    );
    assert.ok(plan.ok, JSON.stringify(plan.collisions));
    assert.deepEqual(plan.instance.actions.disabled, ['get'], 'the module changed the actions');
    assert.deepEqual(plan.instance.approval, {
      default: 'auto',
      actions: { find: 'always' }
    });
  });

  const inst2 = () =>
    installation('p1', 'org.example/p', {
      approval: { default: 'auto', actions: { search: 'always' } }
    });

  it('refuses what a module may not do, and keeps nothing of it', async () => {
    const cases = [
      [{ error: new Error('boom') }, /module migrations\/1\.4\.0\.js: failed: boom/],
      [{ result: null }, /must return the installation/],
      [{ result: ctx => ({ ...ctx.instance, auth: { mode: 'none' } }) }, /sign-in block/],
      [
        { result: ctx => ({ ...ctx.instance, enabled: false }) },
        /values and actions only; it changed enabled/
      ],
      [{ result: ctx => ({ ...ctx.instance, values: [] }) }, /values must be an object/],
      [{ result: ctx => ({ ...ctx.instance, actions: { enabled: 'all' } }) }, /actions must be/],
      [
        {
          result: ctx => {
            ctx.apps[0].integrations.other = { actions: [] };
            return ctx.instance;
          }
        },
        /changes the bindings it was handed only, not other/
      ]
    ];
    for (const [response, pattern] of cases) {
      const plan = await planMigrationAsync(
        { instance: inst(), apps: apps(), definition, from: '1.2.0', to: '1.4.0' },
        {
          runModule: async ({ context }) => {
            if (response.error) throw response.error;
            const result =
              typeof response.result === 'function' ? response.result(context) : response.result;
            return { result };
          }
        }
      );
      assert.equal(plan.ok, false, String(pattern));
      assert.equal(plan.collisions[0].kind, 'module');
      assert.match(plan.collisions[0].message, pattern);
      assert.equal(plan.instance.enabled, true);
      assert.deepEqual(plan.instance.auth, { mode: 'none' });
    }
  });

  it('keeps the collision rules of declarative steps around a module', async () => {
    const plan = await planMigrationAsync(
      {
        instance: inst(),
        apps: [],
        definition: {
          id: 'org.example/p',
          version: '1.4.0',
          migrations: [
            {
              id: '1.4.0',
              steps: [
                { module: 'migrations/1.4.0.js' },
                { renameValue: { from: 'fq', to: 'defaultFilter' } }
              ]
            }
          ]
        },
        from: '1.2.0'
      },
      {
        runModule: async ({ context }) => ({
          result: {
            ...context.instance,
            values: { ...context.instance.values, defaultFilter: 'x' }
          }
        })
      }
    );
    assert.equal(plan.ok, false);
    assert.equal(plan.collisions[0].kind, 'value');
    assert.equal(plan.collisions[0].key, 'defaultFilter');
  });

  it('a plan without running code skips the module and says so', () => {
    const plan = planMigration({ instance: inst(), apps: apps(), definition, from: '1.2.0' });
    assert.ok(plan.ok);
    assert.ok(
      plan.warnings.some(
        w =>
          w.code === MIGRATION_WARNINGS.MODULE_STEP_NOT_PLANNED && w.key === 'migrations/1.4.0.js'
      )
    );
    assert.equal(plan.instance.values.tag, undefined);
  });
});

// ---------------------------------------------------------------------------
// The loader

describe('migration module loader', () => {
  const dir = () => installedDir(CODED);

  it('loads a module of a trusted registry whose hash matches, from the hashed bytes', async () => {
    const up = await loadMigrationModule({
      definitionId: CODED,
      dir: dir(),
      file: MODULE_FILE,
      trust: { trustCode: true, integrity: { [MODULE_FILE]: sha256(MODULE_SOURCE) } }
    });
    assert.equal(typeof up, 'function');
  });

  it('refuses an untrusted registry, a missing hash, a changed file and a relative import', async () => {
    await assert.rejects(
      loadMigrationModule({ definitionId: CODED, dir: dir(), file: MODULE_FILE, trust: {} }),
      { code: MODULE_ERRORS.NOT_TRUSTED }
    );
    await assert.rejects(
      loadMigrationModule({
        definitionId: CODED,
        dir: dir(),
        file: MODULE_FILE,
        trust: { trustCode: true, integrity: {} }
      }),
      { code: MODULE_ERRORS.INTEGRITY_REQUIRED }
    );
    await assert.rejects(
      loadMigrationModule({
        definitionId: CODED,
        dir: dir(),
        file: MODULE_FILE,
        trust: { trustCode: true, integrity: { [MODULE_FILE]: sha256('something else') } }
      }),
      { code: MODULE_ERRORS.INTEGRITY_MISMATCH }
    );
    const helperDir = path.join(root, 'helper-module');
    const source = "import x from './helper.js';\nexport function up() {}\n";
    await fs.mkdir(path.join(helperDir, 'migrations'), { recursive: true });
    await fs.writeFile(path.join(helperDir, MODULE_FILE), source);
    await assert.rejects(
      loadMigrationModule({
        definitionId: CODED,
        dir: helperDir,
        file: MODULE_FILE,
        trust: { trustCode: true, integrity: { [MODULE_FILE]: sha256(source) } }
      }),
      { code: MODULE_ERRORS.RELATIVE_IMPORT }
    );
  });

  it('a definition write refuses a module step whose file is missing or imports a sibling', async () => {
    const definition = portalDefinition('org.example/broken', '1.4.0', { coded: true });
    assert.ok(validateIntegrationDefinition(definition).success);
    await assert.rejects(
      registry.stageInstalled('org.example/broken', {
        'integration.json': definition,
        'api.json': JSON.stringify(OPENAPI)
      }),
      { code: 'MIGRATION_MODULE_MISSING' }
    );
    await assert.rejects(
      registry.stageInstalled('org.example/broken', {
        'integration.json': definition,
        'api.json': JSON.stringify(OPENAPI),
        [MODULE_FILE]: "export { up } from './lib.js';"
      }),
      { code: 'MIGRATION_MODULE_RELATIVE_IMPORT' }
    );
  });
});

// ---------------------------------------------------------------------------
// The runner with module steps

describe('runner: module steps', () => {
  it('runs the module of a registry trusted for code, leaving auth untouched', async () => {
    globalThis.__p3ModuleRuns = 0;
    const outcome = await runner().migrate('coded', { notify: false });
    assert.equal(outcome.result, 'migrated');
    assert.equal(globalThis.__p3ModuleRuns, 1);
    const migrated = await entryOf('coded');
    assert.equal(migrated.definitionVersion, '1.4.0');
    assert.deepEqual(migrated.values, {
      baseUrl: 'https://portal.example',
      defaultFilter: 'groups:env',
      rows: 50
    });
    assert.deepEqual(migrated.actions.enabled, ['dataset_search', 'get']);
    assert.deepEqual(migrated.auth, { mode: 'none' });
    const app = await readJson('apps/coded-app.json');
    assert.deepEqual(app.integrations.coded.actions, ['dataset_search', 'get']);
    assert.deepEqual(app.integrations.other.actions, ['x'], 'a key the module was not handed');
    const log = migrated.migrationLog.at(-1);
    assert.ok(log.steps.includes('1.4.0: module migrations/1.4.0.js'));
    assert.ok(
      log.steps.some(line =>
        /module migrations\/1\.4\.0\.js: from 1\.3\.0 to 1\.4\.0 of org\.example\/coded, auth handed: false/.test(
          line
        )
      )
    );
  });

  it('refuses the module of a registry that is not trusted for code, before any code runs', async () => {
    await resetInstallation(installation('coded', CODED));
    await writeJson('apps/coded-app.json', {
      id: 'coded-app',
      integrations: { coded: { actions: ['search', 'get'] } }
    });
    const manifest = await readJson(MANIFEST);
    await setManifestEntry(CODED_KEY, {
      ...manifest.installations[CODED_KEY],
      registryId: 'plain'
    });
    globalThis.__p3ModuleRuns = 0;
    await assert.rejects(
      () => runner().migrate('coded', { notify: false }),
      error =>
        error.code === 'MIGRATION_FAILED' && /MIGRATION_MODULE_NOT_TRUSTED/.test(error.message)
    );
    assert.equal(globalThis.__p3ModuleRuns, 0, 'no code ran');
    const failed = await entryOf('coded');
    assert.equal(failed.status, 'migrationFailed');
    assert.equal(failed.definitionVersion, '1.2.0');
    assert.equal(failed.values.fq, 'groups:env', 'values untouched');
    await setManifestEntry(CODED_KEY, { ...manifest.installations[CODED_KEY] });
  });

  it('refuses a module file changed after it was installed (integrity mismatch)', async () => {
    await resetInstallation(installation('coded', CODED));
    const file = path.join(installedDir(CODED), MODULE_FILE);
    await fs.writeFile(file, MODULE_SOURCE.replace('rows: instance', 'rows: 99 || instance'));
    globalThis.__p3ModuleRuns = 0;
    try {
      await assert.rejects(
        () => runner().migrate('coded', { notify: false }),
        error => /MIGRATION_MODULE_INTEGRITY_MISMATCH/.test(error.message)
      );
      assert.equal(globalThis.__p3ModuleRuns, 0);
      assert.equal((await entryOf('coded')).status, 'migrationFailed');
    } finally {
      await fs.writeFile(file, MODULE_SOURCE);
    }
  });

  it('fails a module that returns an auth block or changes another field, values untouched', async () => {
    for (const mode of ['auth', 'enabled', 'throw']) {
      await resetInstallation(
        installation('coded', CODED, {
          values: { baseUrl: 'https://portal.example', fq: 'groups:env', moduleMode: mode }
        })
      );
      await assert.rejects(() => runner().migrate('coded', { notify: false }), {
        code: 'MIGRATION_FAILED'
      });
      const failed = await entryOf('coded');
      assert.equal(failed.status, 'migrationFailed', mode);
      assert.deepEqual(failed.auth, { mode: 'none' }, mode);
      assert.equal(failed.values.moduleMode, mode);
      assert.match(failed.statusReason, /module migrations\/1\.4\.0\.js/);
    }
  });

  it('always runs the module of a built-in definition', async () => {
    const outcome = await runner().migrate('builtin', { notify: false });
    assert.equal(outcome.result, 'migrated');
    assert.equal((await entryOf('builtin')).values.rows, 50);
  });

  it('a marketplace update runs the package modules only with the registry trust and the catalog hashes', async () => {
    await resetInstallation(installation('coded', CODED));
    // The installed folder goes back to 1.2.0, then the update brings 1.4.0.
    await writeFolder(
      path.join(contents, 'integration-definitions'),
      portalDefinition(CODED, '1.2.0')
    );
    await registry.reload();
    const files = packageFiles(portalDefinition(CODED, '1.4.0', { coded: true }));
    const untrusted = await runner().applyDefinitionUpdate({
      definitionId: CODED,
      files,
      manifestKey: CODED_KEY,
      manifestPatch: { version: '1.4.0' },
      moduleTrust: { trustCode: false, integrity: { [MODULE_FILE]: sha256(MODULE_SOURCE) } },
      notify: false
    });
    assert.deepEqual(
      untrusted.installations.map(r => [r.id, r.result]),
      [['coded', 'failed']]
    );
    assert.match(untrusted.installations[0].statusReason, /MIGRATION_MODULE_NOT_TRUSTED/);

    await resetInstallation(installation('coded', CODED));
    await writeFolder(
      path.join(contents, 'integration-definitions'),
      portalDefinition(CODED, '1.2.0')
    );
    await registry.reload();
    const trusted = await runner().applyDefinitionUpdate({
      definitionId: CODED,
      files,
      manifestKey: CODED_KEY,
      manifestPatch: { version: '1.4.0' },
      moduleTrust: { trustCode: true, integrity: { [MODULE_FILE]: sha256(MODULE_SOURCE) } },
      notify: false
    });
    assert.deepEqual(
      trusted.installations.map(r => [r.id, r.result]),
      [['coded', 'migrated']]
    );
    assert.equal((await entryOf('coded')).values.rows, 50);
    assert.equal(await readFolderVersion(CODED), '1.4.0');
  });
});

// ---------------------------------------------------------------------------
// Registry channel, pins and catalog versions

describe('registry version policy and catalog versions', () => {
  const item = {
    type: 'integration',
    name: 'org.example__portal',
    version: '2.0.0-rc.1',
    versions: [
      { version: '2.0.0-rc.1', ref: 'versions/x/2.0.0-rc.1.json' },
      { version: '1.4.0', ref: 'versions/x/1.4.0.json' },
      { version: '1.3.2', ref: 'versions/x/1.3.2.json' },
      { version: '1.3.0', ref: 'versions/x/1.3.0.json' }
    ]
  };

  it('stable hides pre-releases, all offers them; a pin keeps the offer inside its range', () => {
    assert.deepEqual(versionPolicy.listedVersions(item), ['2.0.0-rc.1', '1.4.0', '1.3.2', '1.3.0']);
    assert.equal(versionPolicy.offeredVersion(item, {}), '1.4.0', 'stable by default');
    assert.equal(versionPolicy.offeredVersion(item, { channel: 'all' }), '2.0.0-rc.1');
    const pinned = { pins: { 'integration:org.example__portal': '1.3.x' } };
    assert.equal(versionPolicy.offeredVersion(item, pinned), '1.3.2');
    assert.equal(
      versionPolicy.offeredVersion(item, { pins: { 'integration:org.example__portal': '>=3' } }),
      null
    );
    assert.deepEqual(versionPolicy.versionPolicyFields(item, pinned), {
      offeredVersion: '1.3.2',
      channel: 'stable',
      pin: '1.3.x',
      availableVersions: ['1.3.2', '1.3.0']
    });
    assert.equal(versionPolicy.isUpdate('1.3.2', '1.3.0'), true);
    assert.equal(versionPolicy.isUpdate('1.3.2', '1.4.0'), false, 'an older offer is no update');
    assert.equal(
      versionPolicy.offeredVersion({ type: 'app', name: 'a', version: 'v7' }, {}),
      'v7',
      'a non-semver item has no channel'
    );
  });

  it('the registry config accepts channel and pins, and refuses a pin that is no range', () => {
    const base = { id: 'r', name: 'R', source: 'https://r.example/catalog.json' };
    const ok = validateRegistryConfig({
      ...base,
      channel: 'all',
      pins: { 'integration:org.example__portal': '1.3.x' }
    });
    assert.ok(ok.success);
    assert.equal(ok.data.channel, 'all');
    assert.equal(
      validateRegistryConfig({ ...base }).data.channel,
      undefined,
      'absent reads as stable'
    );
    assert.equal(validateRegistryConfig({ ...base, channel: 'beta' }).success, false);
    assert.equal(
      validateRegistryConfig({ ...base, pins: { 'integration:x': 'not a range' } }).success,
      false
    );
    assert.equal(validateRegistryConfig({ ...base, pins: { 'x y': '1.x' } }).success, false);
  });

  it('a catalog item keeps its versions', () => {
    const result = validateCatalog({
      items: [
        {
          ...item,
          source: { type: 'relative', path: 'integrations/x/integration.json' }
        }
      ]
    });
    assert.ok(result.success, JSON.stringify(result.errors));
    assert.equal(result.data.items[0].versions[1].ref, 'versions/x/1.4.0.json');
  });
});

// ---------------------------------------------------------------------------
// Revert

describe('revert to an intermediate version', () => {
  // Whether the installation's migration lock was free while a boundary
  // package was fetched (registry I/O must not run under the lock).
  const lockFreeDuringFetch = [];
  const fetchDefinitionVersion = async version => {
    lockFreeDuringFetch.push(
      await locks
        .withLock(migrationLockName('market'), async () => true, { waitMs: 50 })
        .catch(() => false)
    );
    return {
      files: packageFiles(portalDefinition(MARKET, version)),
      manifestEntry: { version, codeIntegrity: null }
    };
  };

  async function updateMarketTo14() {
    return runner().applyDefinitionUpdate({
      definitionId: MARKET,
      files: packageFiles(portalDefinition(MARKET, '1.4.0')),
      manifestKey: MARKET_KEY,
      manifestPatch: { version: '1.4.0', updatedBy: 'admin' },
      fetchDefinitionVersion,
      notify: false
    });
  }

  it('the boundary backup of a multi-step update holds the folder and the manifest entry of its version', async () => {
    const outcome = await updateMarketTo14();
    assert.deepEqual(
      outcome.installations.map(r => [r.id, r.result]),
      [['market', 'migrated']]
    );
    const boundary = (await backups.listSnapshots({ instanceId: 'market' })).find(
      s => s.manifest.kind === 'boundary'
    );
    assert.equal(boundary.manifest.representedVersion, '1.3.0');
    assert.equal(backups.snapshotView(boundary).hasDefinition, true);
    const dir = await backups.snapshotDefinitionDir(boundary);
    const kept = JSON.parse(await fs.readFile(path.join(dir, 'integration.json'), 'utf8'));
    assert.equal(kept.version, '1.3.0');
    const manifest = await backups.readSnapshotJson(boundary, MANIFEST);
    assert.equal(manifest.installations[MARKET_KEY].version, '1.3.0');
    assert.equal(manifest.installations[MARKET_KEY].registryId, 'trusted');
    assert.deepEqual(lockFreeDuringFetch, [true], 'fetched after the lock was released');
  });

  it('puts back definition folder, installation entry, app bindings and manifest entry together', async () => {
    // Unrelated changes since the update must survive the merge.
    const app = await readJson('apps/market-app.json');
    await writeJson('apps/market-app.json', {
      ...app,
      name: 'renamed meanwhile',
      integrations: { ...app.integrations, unrelated: { actions: ['y'] } }
    });
    const boundary = (await backups.listSnapshots({ instanceId: 'market' })).find(
      s => s.manifest.kind === 'boundary'
    );
    // What `_afterCommit` does after the update when it notifies.
    await registry.reload();
    const outcome = await runner().revert('market', { backup: boundary.id, notify: false });
    assert.equal(outcome.backup.id, boundary.id);
    assert.equal(outcome.logEntry.result, 'reverted');
    assert.equal(outcome.logEntry.trigger, 'revert');

    assert.equal(await readFolderVersion(MARKET), '1.3.0', 'definition folder');
    const entry = await entryOf('market');
    assert.equal(entry.definitionVersion, '1.3.0', 'installation entry');
    assert.deepEqual(entry.values, {
      baseUrl: 'https://portal.example',
      defaultFilter: 'groups:env'
    });
    assert.deepEqual(entry.actions.enabled, ['search', 'get']);
    assert.equal(entry.status, undefined);
    const reverted = await readJson('apps/market-app.json');
    assert.deepEqual(reverted.integrations.market.actions, ['search'], 'app binding key');
    assert.deepEqual(reverted.integrations.unrelated, { actions: ['y'] }, 'other keys stay');
    assert.equal(reverted.name, 'renamed meanwhile');
    const manifest = await readJson(MANIFEST);
    assert.equal(manifest.installations[MARKET_KEY].version, '1.3.0', 'manifest entry');
    assert.ok(manifest.installations[CODED_KEY], 'other manifest entries stay');

    const preRestore = (await backups.listSnapshots({ instanceId: 'market' })).find(
      s => s.manifest.kind === 'pre-restore'
    );
    assert.equal(preRestore.manifest.representedVersion, '1.4.0');
    assert.equal(
      backups.snapshotView(preRestore).hasDefinition,
      true,
      'revert forward is possible'
    );
  });

  it('a failure mid-way rolls definition folder, entry, apps and manifest back together', async () => {
    await registry.reload();
    const preRestore = (await backups.listSnapshots({ instanceId: 'market' })).find(
      s => s.manifest.kind === 'pre-restore'
    );
    const failingStore = {
      ...configStore,
      readJson: rel => configStore.readJson(rel),
      listDocuments: ns => configStore.listDocuments(ns),
      writeJson: async (rel, data) => {
        if (rel === MANIFEST) throw new Error('read-only volume');
        return configStore.writeJson(rel, data);
      }
    };
    const before = await entryOf('market');
    const appBefore = await readJson('apps/market-app.json');
    await assert.rejects(
      () =>
        runner({ store: failingStore }).revert('market', { backup: preRestore.id, notify: false }),
      /read-only volume/
    );
    assert.equal(await readFolderVersion(MARKET), '1.3.0', 'folder back');
    const entry = await entryOf('market');
    assert.equal(entry.definitionVersion, before.definitionVersion, 'entry back');
    assert.deepEqual(entry.values, before.values);
    assert.deepEqual((await readJson('apps/market-app.json')).integrations, appBefore.integrations);
    assert.equal((await readJson(MANIFEST)).installations[MARKET_KEY].version, '1.3.0');
    const leftovers = (await fs.readdir(path.join(contents, 'integration-definitions'))).filter(n =>
      n.startsWith('.')
    );
    assert.deepEqual(leftovers, []);

    // And the same revert goes through once the volume is writable again.
    await registry.reload();
    await runner().revert('market', { backup: preRestore.id, notify: false });
    assert.equal(await readFolderVersion(MARKET), '1.4.0');
    assert.equal((await entryOf('market')).definitionVersion, '1.4.0');
    assert.equal((await readJson(MANIFEST)).installations[MARKET_KEY].version, '1.4.0');
  });

  it('refuses a backup without the definition of its version while another is loaded', async () => {
    await registry.reload();
    // The built-in's boundary backup (1.3.0) holds no folder: a shipped definition is the server's.
    const boundary = (await backups.listSnapshots({ instanceId: 'builtin' })).find(
      s => s.manifest.kind === 'boundary'
    );
    assert.equal(backups.snapshotView(boundary).hasDefinition, false);
    await assert.rejects(() => runner().revert('builtin', { backup: boundary.id, notify: false }), {
      code: 'REVERT_DEFINITION_MISSING'
    });
    await assert.rejects(() => runner().revert('builtin', { notify: false }), {
      code: 'BACKUP_REQUIRED'
    });
    await assert.rejects(() => runner().revert('builtin', { backup: 'nope', notify: false }), {
      code: 'BACKUP_NOT_FOUND'
    });
    assert.equal((await entryOf('builtin')).definitionVersion, '1.4.0', 'nothing changed');
  });
});

describe('boundary backups after the commit', () => {
  // The boundary job reads integrations.json and the manifest after the
  // commit; a failure there must not turn the committed migration into an error.
  for (const [id, unreadable] of [
    ['unread-integrations', INTEGRATIONS],
    ['unread-manifest', MANIFEST]
  ]) {
    it(`a migration whose ${unreadable} cannot be read after the commit is still migrated, without a boundary backup`, async () => {
      await resetInstallation(installation(id, BUILTIN));
      let committed = false;
      const store = {
        ...configStore,
        listDocuments: ns => configStore.listDocuments(ns),
        readJson: async rel => {
          if (committed && rel === unreadable) throw new Error('read failed');
          return configStore.readJson(rel);
        },
        writeJson: async (rel, data) => {
          const result = await configStore.writeJson(rel, data);
          if (rel === INTEGRATIONS) committed = true;
          return result;
        }
      };
      const outcome = await runner({ store }).migrate(id, { notify: false });
      assert.equal(outcome.result, 'migrated');
      assert.equal(committed, true, 'the commit wrote integrations.json');
      assert.equal((await entryOf(id)).definitionVersion, '1.4.0');
      const snapshots = await backups.listSnapshots({ instanceId: id });
      assert.ok(snapshots.length > 0, 'the pre-migration backup is kept');
      assert.equal(
        snapshots.find(s => s.manifest.kind === 'boundary'),
        undefined,
        'no boundary backup'
      );
    });
  }
});
