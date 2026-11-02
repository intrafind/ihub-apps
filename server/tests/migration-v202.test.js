// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V202: an installation's `allowedGroups` move onto the groups as `permissions.integrations`. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  description,
  reachOf,
  admits,
  grantFor,
  installationsOf
} from '../migrations/V202__integration_access_on_groups.js';

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  let writes = 0;
  return {
    logs,
    warnings,
    files,
    get writes() {
      return writes;
    },
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes += 1;
      files[rel] = structuredClone(data);
    },
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

/** Shipped-like groups: admins → users → authenticated → anonymous. */
function groupsFile(extra = {}) {
  return {
    groups: {
      admins: {
        id: 'admins',
        name: 'Admins',
        inherits: ['users'],
        permissions: { apps: ['*'], adminAccess: true }
      },
      users: {
        id: 'users',
        name: 'Users',
        inherits: ['authenticated'],
        permissions: { apps: ['*'] }
      },
      authenticated: {
        id: 'authenticated',
        name: 'Authenticated',
        inherits: ['anonymous'],
        permissions: { apps: ['*'] }
      },
      anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: ['chat'] } },
      finance: { id: 'finance', name: 'Finance', permissions: { apps: [] } },
      ...extra
    },
    metadata: { version: '1.0.0' }
  };
}

function installation(id, allowedGroups, definition = `com.example/${id}`) {
  const instance = { id, definition, enabled: true, values: {}, actions: { enabled: ['*'] } };
  if (allowedGroups !== undefined) instance.allowedGroups = allowedGroups;
  return instance;
}

function integrationsFile(installed) {
  return { installed, security: { blockPrivateIps: true, allowedHosts: [] } };
}

const integrationsOf = files => files['config/groups.json'].groups;

describe('V202 integration access on groups', () => {
  it('declares its version and description', () => {
    assert.equal(version, '202');
    assert.equal(description, 'integration_access_on_groups');
  });

  it('runs only when groups.json exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ 'config/groups.json': groupsFile() })), true);
  });

  it('resolves a group with every group it inherits, transitively and cycle-safe', () => {
    const groups = groupsFile({
      loopA: { id: 'loopA', inherits: ['loopB'] },
      loopB: { id: 'loopB', inherits: ['loopA'] }
    }).groups;
    assert.deepEqual([...reachOf('admins', groups)].sort(), [
      'admins',
      'anonymous',
      'authenticated',
      'users'
    ]);
    assert.deepEqual([...reachOf('finance', groups)], ['finance']);
    assert.deepEqual([...reachOf('loopA', groups)].sort(), ['loopA', 'loopB']);
  });

  it('reads an empty, missing or "*" allowedGroups as open to everyone', () => {
    const reach = new Set(['finance']);
    assert.equal(admits([], reach), true);
    assert.equal(admits(undefined, reach), true);
    assert.equal(admits(['*'], reach), true);
    assert.equal(admits(['finance'], reach), true);
    assert.equal(admits(['admins'], reach), false);
  });

  it('counts the always-installed ihub installation even when the file lacks it', () => {
    assert.deepEqual(installationsOf(integrationsFile([installation('websearch', [])])), [
      { id: 'websearch', allowedGroups: [] },
      { id: 'ihub', allowedGroups: [] }
    ]);
    assert.deepEqual(
      installationsOf(integrationsFile([installation('ihub', ['admins'])])).map(i => i.id),
      ['ihub']
    );
    assert.deepEqual(installationsOf(null), [{ id: 'ihub', allowedGroups: [] }]);
  });

  it('grants "*" to a group that could use every installation, else the installation ids', () => {
    const groups = groupsFile().groups;
    const installed = installationsOf(
      integrationsFile([
        installation('websearch', []),
        installation('x500bund', ['authenticated']),
        installation('ledger', ['finance'])
      ])
    );
    // admins reach authenticated through users; ledger is finance only.
    assert.deepEqual(grantFor('admins', groups, installed), ['websearch', 'x500bund', 'ihub']);
    assert.deepEqual(grantFor('authenticated', groups, installed), [
      'websearch',
      'x500bund',
      'ihub'
    ]);
    assert.deepEqual(grantFor('anonymous', groups, installed), ['websearch', 'ihub']);
    assert.deepEqual(grantFor('finance', groups, installed), ['websearch', 'ledger', 'ihub']);
  });

  it('migrates restricted and unrestricted installations, inheritance included, and strips allowedGroups', async () => {
    const files = {
      'config/groups.json': groupsFile(),
      'config/integrations.json': integrationsFile([
        installation('websearch', []),
        installation('x500bund', ['authenticated']),
        installation('drawio', undefined),
        installation('ihub', [], 'com.intrafind/ihub')
      ])
    };
    const ctx = makeCtx(files);
    await up(ctx);

    const groups = integrationsOf(files);
    // Every installation open to them, x500bund through `authenticated`.
    assert.deepEqual(groups.admins.permissions.integrations, ['*']);
    assert.deepEqual(groups.users.permissions.integrations, ['*']);
    assert.deepEqual(groups.authenticated.permissions.integrations, ['*']);
    // Not in authenticated's line: everything but x500bund, by id.
    assert.deepEqual(groups.anonymous.permissions.integrations, ['websearch', 'drawio', 'ihub']);
    assert.deepEqual(groups.finance.permissions.integrations, ['websearch', 'drawio', 'ihub']);
    // Other permissions untouched.
    assert.deepEqual(groups.admins.permissions.apps, ['*']);
    assert.equal(groups.admins.permissions.adminAccess, true);

    for (const instance of files['config/integrations.json'].installed) {
      assert.equal(Object.hasOwn(instance, 'allowedGroups'), false, instance.id);
    }
    assert.ok(ctx.logs.some(m => m.includes('Removed allowedGroups from 3')));
  });

  it('keeps the admin group on everything it could use when it inherits nothing', async () => {
    const groups = groupsFile();
    delete groups.groups.admins.inherits;
    const files = {
      'config/groups.json': groups,
      'config/integrations.json': integrationsFile([
        installation('websearch', []),
        installation('jira', ['admins']),
        installation('x500bund', ['users'])
      ])
    };
    await up(makeCtx(files));
    const migrated = integrationsOf(files);
    // admins named on jira; x500bund names users, which admins no longer inherit.
    assert.deepEqual(migrated.admins.permissions.integrations, ['websearch', 'jira', 'ihub']);
    // users reach x500bund but not jira.
    assert.deepEqual(migrated.users.permissions.integrations, ['websearch', 'x500bund', 'ihub']);
  });

  it('leaves a group that already has permissions.integrations alone', async () => {
    const groups = groupsFile();
    groups.groups.finance.permissions.integrations = ['type:people-directory'];
    const files = {
      'config/groups.json': groups,
      'config/integrations.json': integrationsFile([installation('ledger', ['admins'])])
    };
    const ctx = makeCtx(files);
    await up(ctx);
    assert.deepEqual(integrationsOf(files).finance.permissions.integrations, [
      'type:people-directory'
    ]);
    assert.ok(ctx.logs.some(m => m.includes('"finance" already has permissions.integrations')));
  });

  it('is idempotent: a second run changes and writes nothing', async () => {
    const files = {
      'config/groups.json': groupsFile(),
      'config/integrations.json': integrationsFile([
        installation('websearch', []),
        installation('x500bund', ['authenticated'])
      ])
    };
    await up(makeCtx(files));
    const after = structuredClone(files);
    const second = makeCtx(files);
    await up(second);
    assert.deepEqual(files, after);
    assert.equal(second.writes, 0);
  });

  it('warns about a group an installation names that groups.json does not define', async () => {
    const files = {
      'config/groups.json': groupsFile(),
      'config/integrations.json': integrationsFile([installation('ledger', ['controlling'])])
    };
    const ctx = makeCtx(files);
    await up(ctx);
    assert.ok(ctx.warnings.some(m => m.includes('"controlling"') && m.includes('"ledger"')));
    // Nobody defined could use it: no group gets it, everyone keeps ihub.
    assert.deepEqual(integrationsOf(files).admins.permissions.integrations, ['ihub']);
  });

  it('grants "*" to every group when there is no integrations.json', async () => {
    const files = { 'config/groups.json': groupsFile() };
    const ctx = makeCtx(files);
    await up(ctx);
    for (const group of Object.values(integrationsOf(files))) {
      assert.deepEqual(group.permissions.integrations, ['*'], group.id);
    }
    assert.equal('config/integrations.json' in files, false);
  });

  it('does nothing without groups.json', async () => {
    const files = {
      'config/integrations.json': integrationsFile([installation('x500bund', ['authenticated'])])
    };
    const ctx = makeCtx(files);
    await up(ctx);
    assert.equal(ctx.writes, 0);
    assert.deepEqual(files['config/integrations.json'].installed[0].allowedGroups, [
      'authenticated'
    ]);
  });

  it('creates the permissions object of a group that has none', async () => {
    const files = {
      'config/groups.json': { groups: { bare: { id: 'bare', name: 'Bare' } } },
      'config/integrations.json': integrationsFile([installation('websearch', [])])
    };
    await up(makeCtx(files));
    assert.deepEqual(files['config/groups.json'].groups.bare.permissions, {
      integrations: ['*']
    });
  });
});
