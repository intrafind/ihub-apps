// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Versioning phase 2 (#3090): the declarative migration steps in the
 * definition schema, the installation states in the installed schema, and
 * the pure planner — which migrations run, what each step does to values,
 * the action policy and the app bindings (own, definition and type keys),
 * collisions, the final validation and the state an installation is in.
 *
 * Run with `npm run test:integrations`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIntegrationDefinition,
  migrationStepSchema,
  validateDefinitionMigrations,
  isStrictSemver,
  MODULE_STEP_MESSAGE
} from '../../validators/integrationDefinitionSchema.js';
import {
  validateIntegrationsConfig,
  validateInstalledIntegration,
  normalizeStoredInstallation
} from '../../validators/integrationsConfigSchema.js';
import { validateCatalog } from '../../validators/catalogSchema.js';
import {
  migrationsBetween,
  planMigration,
  validateMigrationResult,
  installationMigrationState,
  describeCollisions,
  describeStep,
  withDefaults,
  MIGRATION_WARNINGS
} from '../../services/integrations/definitions/migrationPlanner.js';
import { previewDefinitionUpdate } from '../../services/integrations/definitions/migrationPreview.js';

const messages = result => result.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('\n');

/** A definition at 1.4.0 with migrations 1.3.0 and 1.4.0 (the concept's example). */
function definition(extra = {}) {
  return {
    id: 'org.ckan/portal',
    version: '1.4.0',
    type: 'people-directory',
    name: { en: 'Portal' },
    protocol: { type: 'openapi', document: 'api.json', baseUrl: '{baseUrl}' },
    auth: {
      modes: ['none', 'service-account'],
      serviceAccount: { kind: 'bearer', field: 'apiToken' }
    },
    install: [
      { key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true },
      { key: 'apiToken', type: 'secret', title: { en: 'Token' } },
      { key: 'defaultFilter', type: 'string', title: { en: 'Filter' } },
      { key: 'rows', type: 'number', title: { en: 'Rows' }, min: 1, max: 100 },
      { key: 'tags', type: 'list', title: { en: 'Tags' } },
      {
        key: 'region',
        type: 'enum',
        title: { en: 'Region' },
        choices: [
          { value: 'eu', label: 'EU' },
          { value: 'us', label: 'US' }
        ]
      }
    ],
    actions: [
      { name: 'dataset_search', operationId: 'search', sideEffect: 'read' },
      { name: 'get_dataset', operationId: 'get', sideEffect: 'read' }
    ],
    scopes: {
      action: 'dataset_search',
      label: { en: 'Publisher' },
      map: { id: 'name', name: 'title' },
      applyAs: { 'dataset_search.fq': { value: 'org:{id}', mode: 'append' } }
    },
    releases: [
      { version: '1.4.0', date: '2026-11-12', summary: 'rows default', migration: '1.4.0' },
      { version: '1.3.1', date: '2026-11-02', summary: 'fix' },
      { version: '1.3.0', date: '2026-10-28', summary: 'renames', migration: '1.3.0' },
      { version: '1.2.0', date: '2026-10-01', summary: 'first' }
    ],
    migrations: [
      {
        id: '1.3.0',
        steps: [
          { renameValue: { from: 'fq', to: 'defaultFilter' } },
          { renameAction: { from: 'search', to: 'dataset_search' } }
        ]
      },
      {
        id: '1.4.0',
        steps: [{ setValue: { key: 'rows', value: 20, when: 'missing' } }]
      }
    ],
    ...extra
  };
}

function parsedDefinition(extra) {
  const result = validateIntegrationDefinition(definition(extra));
  assert.ok(result.success, result.success ? '' : messages(result));
  return result.data;
}

function instance(extra = {}) {
  return {
    id: 'govdata',
    definition: 'org.ckan/portal',
    definitionVersion: '1.2.0',
    enabled: true,
    values: { baseUrl: 'https://govdata.de/ckan', fq: 'groups:env' },
    auth: { mode: 'none' },
    actions: { enabled: ['search'], disabled: [], overrides: { search: { sideEffect: 'read' } } },
    ...extra
  };
}

function app(id, integrations) {
  return { path: `apps/${id}.json`, app: { id, integrations } };
}

describe('definition schema: migrations', () => {
  it('accepts the seven declarative steps in their fixed shapes', () => {
    const steps = [
      { renameValue: { from: 'a', to: 'b' } },
      { setValue: { key: 'a', value: 1 } },
      { setValue: { key: 'a', value: ['x'], when: 'always' } },
      { removeValue: { key: 'a' } },
      { mapValue: { key: 'a', map: { old: 'new', 1: 2 } } },
      { renameAction: { from: 'a', to: 'b' } },
      { removeAction: { name: 'a' } },
      { renameScope: { from: 'org:a', to: 'org:b' } }
    ];
    for (const step of steps) {
      const result = migrationStepSchema.safeParse(step);
      assert.ok(result.success, JSON.stringify(step));
    }
    assert.deepEqual(migrationStepSchema.parse(steps[1]), {
      setValue: { key: 'a', value: 1, when: 'missing' }
    });
  });

  it('refuses a module step with a clear message instead of dropping it', () => {
    const result = migrationStepSchema.safeParse({ module: 'migrations/1.4.0.js' });
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].message, MODULE_STEP_MESSAGE);
    const def = validateIntegrationDefinition(
      definition({
        migrations: [{ id: '1.4.0', steps: [{ module: 'migrations/1.4.0.js' }] }],
        releases: [{ version: '1.4.0', date: '2026-11-12', summary: 'x', migration: '1.4.0' }]
      })
    );
    assert.equal(def.success, false);
    assert.match(messages(def), /migrations\.0\.steps\.0\.module: a "module" step/);
  });

  it('refuses unknown steps, two keys in one step, bad shapes and empty step lists', () => {
    const bad = [
      [{ moveValue: { from: 'a', to: 'b' } }, /unknown migration step "moveValue"/],
      [{ renameValue: { from: 'a', to: 'b' }, removeValue: { key: 'c' } }, /exactly one of/],
      [{ renameValue: { from: 'a', to: 'a' } }, /must differ/],
      [{ renameValue: { from: 'a' } }, /to/],
      [{ setValue: { key: 'a', value: { nested: true } } }, /value/],
      [{ setValue: { key: 'a', value: 1, when: 'sometimes' } }, /when/],
      [{ mapValue: { key: 'a', map: {} } }, /at least one value/],
      [{ removeAction: { action: 'a' } }, /name|Unrecognized/],
      [{ renameAction: { from: '1bad', to: 'ok' } }, /letter/]
    ];
    for (const [step, pattern] of bad) {
      const result = migrationStepSchema.safeParse(step);
      assert.equal(result.success, false, JSON.stringify(step));
      assert.match(
        result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join(' '),
        pattern
      );
    }
    const empty = validateDefinitionMigrations([{ id: '1.0.0', steps: [] }]);
    assert.equal(empty.success, false);
  });

  it('ties releases and migrations together', () => {
    assert.ok(validateIntegrationDefinition(definition()).success);
    const cases = [
      [
        { releases: [{ version: '1.4.0', date: '2026-11-12', summary: 'x', migration: '1.3.0' }] },
        /releases\.0\.migration: a release names its own version/
      ],
      [
        {
          releases: [{ version: '1.4.0', date: '2026-11-12', summary: 'x', migration: '1.4.0' }],
          migrations: []
        },
        /migration "1\.4\.0" is not listed in migrations/
      ],
      [
        { releases: [{ version: '1.4.0', date: '2026-11-12', summary: 'x' }] },
        /migration "1\.3\.0" needs the release 1\.3\.0 to name it/
      ],
      [
        {
          migrations: [
            { id: '1.3.0', steps: [{ removeValue: { key: 'a' } }] },
            { id: '1.3.0', steps: [{ removeValue: { key: 'b' } }] },
            { id: '1.4.0', steps: [{ removeValue: { key: 'c' } }] }
          ]
        },
        /duplicate migration "1\.3\.0"/
      ],
      [{ migrations: [{ id: 'one', steps: [{ removeValue: { key: 'a' } }] }] }, /semantic/]
    ];
    for (const [extra, pattern] of cases) {
      const result = validateIntegrationDefinition(definition(extra));
      assert.equal(result.success, false);
      assert.match(messages(result), pattern);
    }
  });

  it('a catalog item keeps the migrations, parsed when they pass and as they came when not', () => {
    const item = migrations => ({
      type: 'integration',
      name: 'org.ckan__portal',
      source: { type: 'relative', path: 'integrations/x/integration.json' },
      migrations
    });
    const ok = validateCatalog({ items: [item(definition().migrations)] });
    assert.ok(ok.success);
    assert.equal(ok.data.items[0].migrations[1].steps[0].setValue.when, 'missing');
    const kept = validateCatalog({ items: [item([{ id: '1.0.0', steps: [{ module: 'x.js' }] }])] });
    assert.ok(kept.success, 'one bad item does not drop the catalog');
    assert.deepEqual(kept.data.items[0].migrations, [{ id: '1.0.0', steps: [{ module: 'x.js' }] }]);
  });

  it('strict semver is the exact form a definition writes', () => {
    for (const ok of ['1.0.0', '2.10.3', '1.0.0-rc.1']) assert.ok(isStrictSemver(ok), ok);
    for (const bad of ['1.0', 'v1.0.0', '01.0.0', '1.0.0+build', '', null, 1]) {
      assert.equal(isStrictSemver(bad), false, String(bad));
    }
  });
});

describe('installed integration schema: migration state', () => {
  it('keeps status, statusReason and migrationLog through a save round trip', () => {
    const stored = instance({
      status: 'migrationFailed',
      statusReason: 'collides on defaultFilter',
      migrationLog: [
        {
          from: '1.2.0',
          to: '1.4.0',
          at: '2026-11-02T10:00:00.000Z',
          by: 'admin',
          trigger: 'manual',
          result: 'failed',
          migrations: ['1.3.0', '1.4.0'],
          steps: ['1.3.0: renameValue fq → defaultFilter'],
          warnings: [],
          reason: 'collides',
          backup: 'govdata-1.2.0-20261102T100000000Z'
        }
      ]
    });
    const once = validateIntegrationsConfig({ installed: [stored] });
    assert.ok(once.success);
    const twice = validateIntegrationsConfig(JSON.parse(JSON.stringify(once.data)));
    assert.deepEqual(twice.data, once.data);
    assert.equal(twice.data.installed[0].status, 'migrationFailed');
    assert.equal(twice.data.installed[0].statusReason, 'collides on defaultFilter');
    assert.equal(twice.data.installed[0].migrationLog[0].backup, stored.migrationLog[0].backup);
  });

  it('an invalid stored definitionVersion becomes needsReview, and the file still loads', () => {
    const result = validateIntegrationsConfig({
      installed: [
        instance({ id: 'hand', definitionVersion: '1.2' }),
        instance({ id: 'num', definitionVersion: 3 }),
        instance({ id: 'fine' })
      ]
    });
    assert.ok(result.success, 'one bad version does not empty the file');
    const [hand, num, fine] = result.data.installed;
    assert.equal(hand.definitionVersion, undefined);
    assert.equal(hand.status, 'needsReview');
    assert.match(hand.statusReason, /"1\.2" is not a semantic version/);
    assert.equal(num.status, 'needsReview');
    assert.equal(fine.status, undefined);
    assert.equal(fine.definitionVersion, '1.2.0');
    assert.equal(normalizeStoredInstallation(null), null);
  });

  it('drops a status it does not know and a damaged log instead of failing the file', () => {
    const result = validateIntegrationsConfig({
      installed: [instance({ status: 'weird', migrationLog: 'not a list' })]
    });
    assert.ok(result.success);
    assert.equal(result.data.installed[0].status, undefined);
    assert.equal(result.data.installed[0].migrationLog, undefined);
    assert.ok(validateInstalledIntegration(instance()).success);
  });
});

describe('planner: which migrations run', () => {
  const list = definition().migrations;

  it('runs every migration above the installed and up to the definition version, in order', () => {
    assert.deepEqual(
      migrationsBetween(list, '1.2.0', '1.4.0').map(m => m.id),
      ['1.3.0', '1.4.0'],
      'skips versions: 1.2.0 → 1.4.0 runs 1.3.0 and 1.4.0'
    );
    assert.deepEqual(
      migrationsBetween([...list].reverse(), '1.2.0', '1.4.0').map(m => m.id),
      ['1.3.0', '1.4.0']
    );
    assert.deepEqual(
      migrationsBetween(list, '1.3.0', '1.4.0').map(m => m.id),
      ['1.4.0']
    );
    assert.deepEqual(migrationsBetween(list, '1.3.1', '1.3.1'), []);
    assert.deepEqual(
      migrationsBetween(list, '1.2.0', '1.3.5').map(m => m.id),
      ['1.3.0']
    );
    assert.deepEqual(migrationsBetween(list, 'bad', '1.4.0'), []);
  });

  it('describes each step on one line', () => {
    assert.equal(
      describeStep('1.3.0', { renameValue: { from: 'fq', to: 'defaultFilter' } }),
      '1.3.0: renameValue fq → defaultFilter'
    );
    assert.equal(
      describeStep('1.4.0', { setValue: { key: 'rows', value: 20, when: 'missing' } }),
      '1.4.0: setValue rows = 20 (missing)'
    );
  });
});

describe('planner: the steps', () => {
  const plan = (inst, migrations, apps = [], def = {}) =>
    planMigration({
      instance: inst,
      apps,
      definition: { id: 'org.ckan/portal', version: '2.0.0', type: 'people-directory', ...def },
      from: inst.definitionVersion,
      to: '2.0.0',
      migrations: [{ id: '2.0.0', steps: migrations }]
    });

  it('renameValue moves a value; a missing source changes nothing', () => {
    const result = plan(instance(), [{ renameValue: { from: 'fq', to: 'defaultFilter' } }]);
    assert.ok(result.ok);
    assert.deepEqual(result.instance.values, {
      baseUrl: 'https://govdata.de/ckan',
      defaultFilter: 'groups:env'
    });
    assert.equal(result.instance.definitionVersion, '2.0.0');
    const nothing = plan(instance(), [{ renameValue: { from: 'absent', to: 'x' } }]);
    assert.deepEqual(nothing.instance.values, instance().values);
    assert.equal(nothing.summary.values, 0);
  });

  it('setValue honours when: missing and when: always', () => {
    const inst = instance({ values: { baseUrl: 'https://x', rows: 5, empty: '' } });
    const missing = plan(inst, [
      { setValue: { key: 'rows', value: 20, when: 'missing' } },
      { setValue: { key: 'empty', value: 'filled', when: 'missing' } },
      { setValue: { key: 'region', value: 'eu', when: 'missing' } }
    ]);
    assert.equal(missing.instance.values.rows, 5, 'a value that is set stays');
    assert.equal(missing.instance.values.empty, 'filled', 'an empty value counts as missing');
    assert.equal(missing.instance.values.region, 'eu');
    const always = plan(inst, [{ setValue: { key: 'rows', value: 20, when: 'always' } }]);
    assert.equal(always.instance.values.rows, 20);
  });

  it('removeValue drops a value', () => {
    const result = plan(instance(), [{ removeValue: { key: 'fq' } }]);
    assert.equal(Object.hasOwn(result.instance.values, 'fq'), false);
    assert.equal(result.summary.values, 1);
  });

  it('mapValue rewrites a value and each entry of a list', () => {
    const inst = instance({
      values: { baseUrl: 'https://x', region: 'EU', tags: ['a', 'b', 'c'] }
    });
    const result = plan(inst, [
      { mapValue: { key: 'region', map: { EU: 'eu', US: 'us' } } },
      { mapValue: { key: 'tags', map: { a: 'alpha', c: null } } }
    ]);
    assert.equal(result.instance.values.region, 'eu');
    assert.deepEqual(result.instance.values.tags, ['alpha', 'b'], 'null drops an entry');
    const numbers = plan(instance({ values: { rows: 10 } }), [
      { mapValue: { key: 'rows', map: { 10: 25 } } }
    ]);
    assert.equal(numbers.instance.values.rows, 25);
  });

  it('renameAction rewrites the policy lists and overrides, and the own and definition bindings', () => {
    const inst = instance({
      actions: {
        enabled: ['search', 'get'],
        disabled: ['old'],
        overrides: { search: { sideEffect: 'read' } }
      }
    });
    const apps = [
      app('own', { govdata: { actions: ['search', 'get'], required: false } }),
      app('all-portals', { 'org.ckan/portal': { actions: ['search'] } }),
      app('implicit', { govdata: {} })
    ];
    const result = plan(inst, [{ renameAction: { from: 'search', to: 'dataset_search' } }], apps);
    assert.ok(result.ok);
    assert.deepEqual(result.instance.actions.enabled, ['dataset_search', 'get']);
    assert.deepEqual(Object.keys(result.instance.actions.overrides), ['dataset_search']);
    assert.deepEqual(result.apps[0].app.integrations.govdata, {
      actions: ['dataset_search', 'get'],
      required: false
    });
    assert.deepEqual(result.apps[1].app.integrations['org.ckan/portal'].actions, [
      'dataset_search'
    ]);
    assert.equal(
      result.apps[2].changed,
      false,
      'a binding without an action list has nothing to rename'
    );
    assert.deepEqual(result.summary, { values: 0, actions: 1, apps: 2 });
  });

  it('removeAction drops the action and warns for each app that named it', () => {
    const apps = [app('own', { govdata: { actions: ['search', 'get'] } })];
    const result = plan(instance(), [{ removeAction: { name: 'search' } }], apps);
    assert.deepEqual(result.instance.actions.enabled, []);
    assert.deepEqual(result.instance.actions.overrides, {});
    assert.deepEqual(result.apps[0].app.integrations.govdata.actions, ['get']);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, MIGRATION_WARNINGS.ACTION_REMOVED_FROM_APP);
    assert.equal(result.warnings[0].appId, 'own');
    assert.equal(result.warnings[0].action, 'search');
  });

  it('renameScope rewrites the default and pinned scope of the bindings', () => {
    const apps = [
      app('pinned', { govdata: { pinnedScope: 'org:env', defaultScope: 'org:env' } }),
      app('other', { govdata: { defaultScope: 'org:transport' } })
    ];
    const result = plan(
      instance(),
      [{ renameScope: { from: 'org:env', to: 'org:environment' } }],
      apps
    );
    assert.deepEqual(result.apps[0].app.integrations.govdata, {
      pinnedScope: 'org:environment',
      defaultScope: 'org:environment'
    });
    assert.equal(result.apps[1].changed, false);
  });

  it('never rewrites a type binding, and warns when it names what changed', () => {
    const apps = [
      app('typed', {
        'type:people-directory': { actions: ['search'], defaultScope: 'org:env' }
      })
    ];
    const result = plan(
      instance(),
      [
        { renameAction: { from: 'search', to: 'dataset_search' } },
        { renameScope: { from: 'org:env', to: 'org:environment' } }
      ],
      apps
    );
    assert.ok(result.ok);
    assert.deepEqual(result.apps[0].app.integrations['type:people-directory'], {
      actions: ['search'],
      defaultScope: 'org:env'
    });
    assert.equal(result.apps[0].changed, false);
    assert.deepEqual(
      result.warnings.map(w => [w.code, w.key]),
      [
        [MIGRATION_WARNINGS.TYPE_BINDING_NOT_REWRITTEN, 'type:people-directory'],
        [MIGRATION_WARNINGS.TYPE_BINDING_NOT_REWRITTEN, 'type:people-directory']
      ]
    );
  });

  it('a shared definition binding a sibling installation already migrated is no collision', () => {
    // govdata-b migrated first and rewrote the definition binding; govdata
    // follows with the same migration.
    const apps = [app('all-portals', { 'org.ckan/portal': { actions: ['dataset_search'] } })];
    const result = plan(
      instance(),
      [{ renameAction: { from: 'search', to: 'dataset_search' } }],
      apps
    );
    assert.ok(result.ok);
    assert.equal(result.apps[0].changed, false);
    assert.deepEqual(result.apps[0].app.integrations['org.ckan/portal'].actions, [
      'dataset_search'
    ]);
  });

  it('does not touch the inputs', () => {
    const inst = instance();
    const apps = [app('own', { govdata: { actions: ['search'] } })];
    const before = JSON.stringify({ inst, apps });
    plan(
      inst,
      [{ renameAction: { from: 'search', to: 'x_search' } }, { removeValue: { key: 'fq' } }],
      apps
    );
    assert.equal(JSON.stringify({ inst, apps }), before);
  });
});

describe('planner: collisions', () => {
  const plan = (inst, steps, apps = []) =>
    planMigration({
      instance: inst,
      apps,
      definition: { id: 'org.ckan/portal', version: '2.0.0' },
      from: inst.definitionVersion,
      migrations: [{ id: '2.0.0', steps }]
    });

  it('renameValue onto a key that holds a value', () => {
    const result = plan(instance({ values: { fq: 'a', defaultFilter: 'b' } }), [
      { renameValue: { from: 'fq', to: 'defaultFilter' } }
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.collisions.map(c => [c.kind, c.key]),
      [['value', 'defaultFilter']]
    );
    assert.equal(result.instance.values.defaultFilter, 'b', 'never overwritten');
    assert.match(describeCollisions(result.collisions), /collides on defaultFilter/);
    const emptyTarget = plan(instance({ values: { fq: 'a', defaultFilter: '' } }), [
      { renameValue: { from: 'fq', to: 'defaultFilter' } }
    ]);
    assert.ok(emptyTarget.ok, 'an empty destination holds no value');
  });

  it('two renames landing on one key', () => {
    const result = plan(instance({ values: { a: '1', b: '2' } }), [
      { renameValue: { from: 'a', to: 'x' } },
      { renameValue: { from: 'b', to: 'x' } }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.collisions[0].key, 'x');
    assert.equal(result.instance.values.x, '1');
  });

  it('two mapValue entries landing on one list entry', () => {
    const result = plan(instance({ values: { tags: ['a', 'b'] } }), [
      { mapValue: { key: 'tags', map: { a: 'same', b: 'same' } } }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.collisions[0].key, 'tags');
    assert.deepEqual(result.instance.values.tags, ['a', 'b']);
  });

  it('renameAction onto a name the policy already has', () => {
    const result = plan(
      instance({ actions: { enabled: ['search'], disabled: ['dataset_search'], overrides: {} } }),
      [{ renameAction: { from: 'search', to: 'dataset_search' } }]
    );
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.collisions.map(c => [c.kind, c.key]),
      [['action', 'dataset_search']]
    );
  });

  it('renameAction onto a name an app binding already has, naming the app', () => {
    const result = plan(
      instance({ actions: { enabled: ['*'], disabled: [], overrides: {} } }),
      [{ renameAction: { from: 'search', to: 'dataset_search' } }],
      [app('both', { govdata: { actions: ['search', 'dataset_search'] } })]
    );
    assert.equal(result.ok, false);
    assert.equal(result.collisions[0].appId, 'both');
    assert.match(describeCollisions(result.collisions), /dataset_search \(app both\)/);
  });

  it('reports every collision of a plan, not just the first', () => {
    const result = plan(
      instance({
        values: { fq: 'a', defaultFilter: 'b' },
        actions: { enabled: ['search', 'dataset_search'], disabled: [], overrides: {} }
      }),
      [
        { renameValue: { from: 'fq', to: 'defaultFilter' } },
        { renameAction: { from: 'search', to: 'dataset_search' } }
      ]
    );
    assert.deepEqual(
      result.collisions.map(c => c.key),
      ['defaultFilter', 'dataset_search']
    );
  });
});

describe('planner: a span over several migrations', () => {
  it('runs 1.3.0 and 1.4.0 from 1.2.0, keeps the 1.3.0 boundary and sums the changes', () => {
    const def = parsedDefinition();
    const apps = [app('own', { govdata: { actions: ['search'] } })];
    const result = planMigration({ instance: instance(), apps, definition: def, from: '1.2.0' });
    assert.ok(result.ok);
    assert.deepEqual(result.migrations, ['1.3.0', '1.4.0']);
    assert.deepEqual(result.instance.values, {
      baseUrl: 'https://govdata.de/ckan',
      defaultFilter: 'groups:env',
      rows: 20
    });
    assert.deepEqual(result.summary, { values: 2, actions: 1, apps: 1 });
    assert.equal(result.boundaries.length, 1);
    assert.equal(result.boundaries[0].version, '1.3.0');
    assert.equal(result.boundaries[0].instance.definitionVersion, '1.3.0');
    assert.equal(result.boundaries[0].instance.values.rows, undefined, 'before 1.4.0 ran');
    assert.deepEqual(result.boundaries[0].apps[0].app.integrations.govdata.actions, [
      'dataset_search'
    ]);
    assert.deepEqual(
      validateMigrationResult({
        before: instance(),
        after: result.instance,
        apps: result.apps,
        definition: def
      }),
      []
    );
  });

  it('from 1.3.0 only 1.4.0 runs', () => {
    const def = parsedDefinition();
    const inst = instance({
      definitionVersion: '1.3.0',
      values: { baseUrl: 'https://x', rows: 7 },
      actions: { enabled: ['*'], disabled: [], overrides: {} }
    });
    const result = planMigration({ instance: inst, definition: def, from: '1.3.0' });
    assert.deepEqual(result.migrations, ['1.4.0']);
    assert.equal(result.instance.values.rows, 7);
    assert.equal(result.boundaries.length, 0);
  });
});

describe('final validation', () => {
  const def = parsedDefinition();
  const valid = instance({
    definitionVersion: '1.4.0',
    values: { baseUrl: 'https://x' },
    actions: { enabled: ['dataset_search'], disabled: [], overrides: {} }
  });

  it('accepts a result that fits the definition', () => {
    assert.deepEqual(validateMigrationResult({ before: valid, after: valid, definition: def }), []);
  });

  it('checks the values with the definition defaults filled in, without storing them', () => {
    const required = parsedDefinition({
      install: [
        ...definition().install,
        { key: 'mode', type: 'string', title: 'Mode', required: true, default: 'fast' },
        { key: 'region2', type: 'string', title: 'Region', required: true }
      ]
    });
    const errors = validateMigrationResult({ before: valid, after: valid, definition: required });
    assert.deepEqual(
      errors.map(e => e.key),
      ['region2'],
      'a new required field with a default passes; one without a default fails'
    );
    assert.equal(valid.values.mode, undefined, 'the default is not written');
    assert.deepEqual(withDefaults(required, { baseUrl: 'x', mode: '' }), {
      baseUrl: 'x',
      mode: 'fast'
    });
  });

  it('refuses unknown values, unknown actions in the policy and in app bindings', () => {
    const after = {
      ...valid,
      values: { baseUrl: 'https://x', fq: 'left over', rows: 500 },
      actions: { enabled: ['*', 'search'], disabled: ['gone'], overrides: { other: {} } }
    };
    const apps = [
      app('own', { govdata: { actions: ['dataset_search', 'search'] } }),
      app('typed', { 'type:people-directory': { actions: ['whatever'] } })
    ];
    const errors = validateMigrationResult({ before: valid, after, apps, definition: def });
    const keys = errors.map(e => `${e.kind}:${e.key}${e.appId ? `@${e.appId}` : ''}`);
    assert.deepEqual(keys.sort(), [
      'action:gone',
      'action:other',
      'action:search',
      'action:search@own',
      'value:fq',
      'value:rows'
    ]);
  });

  it('does not check action names of protocols that list them at run time', () => {
    const after = {
      ...valid,
      actions: { enabled: ['*'], disabled: ['some-mcp-tool'], overrides: {} }
    };
    assert.deepEqual(
      validateMigrationResult({ before: valid, after, definition: def, dynamicActions: true }),
      []
    );
  });

  it('refuses a static scope against a definition that declares no scopes', () => {
    const noScopes = parsedDefinition({ scopes: undefined });
    const apps = [app('own', { govdata: { pinnedScope: 'org:env' } })];
    const errors = validateMigrationResult({
      before: valid,
      after: valid,
      apps,
      definition: noScopes
    });
    assert.deepEqual(
      errors.map(e => [e.kind, e.key, e.appId]),
      [['scope', 'org:env', 'own']]
    );
    assert.deepEqual(
      validateMigrationResult({ before: valid, after: valid, apps, definition: def }),
      []
    );
  });

  it('refuses a result whose auth differs, and a sign-in mode the definition no longer offers', () => {
    const changed = {
      ...valid,
      auth: { mode: 'none', credentialRef: 'integration-govdata-apiToken' }
    };
    assert.deepEqual(
      validateMigrationResult({ before: valid, after: changed, definition: def }).map(e => e.key),
      ['auth']
    );
    const sa = { ...valid, auth: { mode: 'service-account', credentialRef: 'x' } };
    const noSa = parsedDefinition({ auth: { modes: ['none'] } });
    assert.deepEqual(
      validateMigrationResult({ before: sa, after: sa, definition: noSa }).map(e => e.key),
      ['auth.mode']
    );
  });
});

describe('installation state', () => {
  const entry = { definition: parsedDefinition(), status: 'ok' };

  it('is normal when the versions match', () => {
    const state = installationMigrationState(instance({ definitionVersion: '1.4.0' }), entry);
    assert.equal(state.status, null);
    assert.equal(state.blocked, false);
  });

  it('is pending and blocked while a migration lies between the versions', () => {
    const state = installationMigrationState(instance(), entry);
    assert.equal(state.status, 'migrationPending');
    assert.equal(state.blocked, true);
    assert.equal(state.pending, true);
    assert.deepEqual(state.migrations, ['1.3.0', '1.4.0']);
  });

  it('is pending but serves its values when no migration lies between them', () => {
    const state = installationMigrationState(instance({ definitionVersion: '1.3.0' }), {
      definition: { ...entry.definition, version: '1.3.1' }
    });
    assert.equal(state.status, 'migrationPending');
    assert.equal(state.blocked, false);
    assert.deepEqual(state.migrations, []);
  });

  it('needs a review without a version or after a downgrade', () => {
    const missing = installationMigrationState(instance({ definitionVersion: undefined }), entry);
    assert.equal(missing.status, 'needsReview');
    assert.equal(missing.blocked, true);
    const downgrade = installationMigrationState(instance({ definitionVersion: '1.5.0' }), entry);
    assert.equal(downgrade.status, 'needsReview');
    assert.equal(downgrade.downgrade, true);
  });

  it('keeps a stored failed or review state until an action clears it', () => {
    const failed = installationMigrationState(
      instance({ status: 'migrationFailed', statusReason: 'collision' }),
      entry
    );
    assert.deepEqual(
      [failed.status, failed.statusReason, failed.blocked],
      ['migrationFailed', 'collision', true]
    );
    const stored = installationMigrationState(
      instance({ definitionVersion: '1.4.0', status: 'migrationPending' }),
      entry
    );
    assert.equal(stored.status, null, 'a stored pending state is derived again');
  });

  it('an incompatible or missing definition never reports a migration', () => {
    const incompatible = installationMigrationState(instance(), {
      ...entry,
      status: 'incompatible'
    });
    assert.equal(incompatible.status, null);
    assert.equal(incompatible.pending, false);
    assert.equal(installationMigrationState(instance(), null).status, null);
  });
});

describe('marketplace update preview', () => {
  const def = definition();
  const item = {
    version: '1.4.0',
    releases: def.releases,
    migrations: def.migrations
  };
  const entry = { definition: { ...parsedDefinition(), version: '1.2.0' } };

  it('plans every installation from the catalog item, writing nothing', () => {
    const apps = [
      {
        path: 'apps/own.json',
        data: { id: 'own', integrations: { govdata: { actions: ['search'] } } }
      }
    ];
    const preview = previewDefinitionUpdate({
      definitionId: 'org.ckan/portal',
      item,
      instances: [
        instance(),
        instance({ id: 'collide', values: { fq: 'a', defaultFilter: 'b' } }),
        instance({ id: 'current', definitionVersion: '1.4.0' })
      ],
      apps,
      entry
    });
    assert.equal(preview.planFromCatalog, true);
    const [govdata, collide, current] = preview.installations;
    assert.deepEqual(govdata.summary, { values: 2, actions: 1, apps: 1 });
    assert.deepEqual(govdata.migrations, ['1.3.0', '1.4.0']);
    assert.equal(govdata.ok, true);
    assert.equal(collide.ok, false);
    assert.equal(collide.collisions[0].key, 'defaultFilter');
    assert.match(current.reason, /already at 1\.4\.0/);
    assert.deepEqual(apps[0].data.integrations.govdata.actions, ['search'], 'nothing written');
  });

  it('cannot plan an installation older than the releases the catalog lists', () => {
    const preview = previewDefinitionUpdate({
      definitionId: 'org.ckan/portal',
      item,
      instances: [instance({ definitionVersion: '1.0.0' })],
      entry
    });
    assert.equal(preview.planFromCatalog, false);
    assert.equal(preview.installations[0].planFromCatalog, false);
    assert.match(preview.installations[0].reason, /older than the oldest release/);
  });

  it('reports migrations it cannot read', () => {
    const preview = previewDefinitionUpdate({
      definitionId: 'org.ckan/portal',
      item: { ...item, migrations: [{ id: '1.4.0', steps: [{ module: 'x.js' }] }] },
      instances: [instance()],
      entry
    });
    assert.equal(preview.planFromCatalog, false);
    assert.ok(preview.errors.length > 0);
  });
});

describe('shipped default installations', () => {
  it('record a definition version, so a fresh install starts with a baseline', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const defaults = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'defaults'
    );
    const config = JSON.parse(
      await fs.readFile(path.join(defaults, 'config', 'integrations.json'), 'utf8')
    );
    for (const inst of config.installed) {
      assert.ok(isStrictSemver(inst.definitionVersion), inst.id);
      const folder = path.join(
        defaults,
        'integration-definitions',
        inst.definition.replace('/', '__'),
        'integration.json'
      );
      const shipped = JSON.parse(await fs.readFile(folder, 'utf8'));
      assert.equal(
        installationMigrationState(inst, { definition: shipped }).downgrade,
        false,
        `${inst.id} is not newer than its shipped definition`
      );
    }
  });
});
