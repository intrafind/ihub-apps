// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V198: people directories become installations of `com.intrafind/ldap-directory`. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  instanceFrom,
  migrateApp,
  plainPasswordsOf,
  valuesFromDirectory
} from '../migrations/V198__people_directories_installed_integrations.js';
import { directoryFromInstance } from '../services/integrations/ldapDirectoryConfig.js';
import { peopleDirectorySchema } from '../validators/peopleDirectorySchema.js';

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  return {
    logs,
    warnings,
    files,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      files[rel] = structuredClone(data);
    },
    deleteFile: async rel => {
      delete files[rel];
    },
    listFiles: async (dir, pattern) =>
      Object.keys(files)
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith(pattern.replaceAll('*', '')))
        .map(rel => rel.slice(dir.length + 1)),
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

const CORP = {
  id: 'corp',
  enabled: true,
  type: 'ldap',
  authProvider: 'corp-ad',
  name: { en: 'Company directory', de: 'Firmenverzeichnis' },
  description: { en: 'Employees.' },
  groups: ['authenticated'],
  attributeMapping: { department: 'ou', location: ['dn:l', 'l'] },
  tlsOptions: { minVersion: 'TLSv1.2' },
  browse: {
    enabled: true,
    groups: ['admins'],
    bind: { mode: 'service', dn: 'cn=reader,dc=corp', passwordRef: 'ldap-reader' },
    denyAttributes: ['info']
  }
};

const X500 = {
  id: 'x500bund',
  enabled: false,
  type: 'ldap',
  url: 'ldaps://x500.bund.de:636',
  tlsCa: ['pca-1-verwaltung-23'],
  baseDn: 'o=Bund,c=DE',
  preset: 'ivbb',
  bind: { mode: 'anonymous' },
  dataFlow: 'external',
  name: { en: 'Federal directory (IVBB)' },
  units: true,
  maxResults: 25,
  timeoutMs: 8000,
  groups: ['*']
};

describe('V198 people directories → installed integrations', () => {
  it('declares its version', () => assert.equal(version, '198'));

  it('turns a directory into an installation under the same id', () => {
    const instance = instanceFrom(CORP);
    assert.equal(instance.id, 'corp');
    assert.equal(instance.definition, 'com.intrafind/ldap-directory');
    assert.equal(instance.enabled, true);
    assert.deepEqual(instance.allowedGroups, ['authenticated']);
    assert.deepEqual(instance.label, CORP.name);
    assert.deepEqual(instance.description, CORP.description);
    assert.deepEqual(instance.values, {
      authProvider: 'corp-ad',
      tlsMinVersion: 'TLSv1.2',
      mapping_department: ['ou'],
      mapping_location: ['dn:l', 'l'],
      browse: true,
      browseGroups: ['admins'],
      browseBindMode: 'service',
      browseBindDn: 'cn=reader,dc=corp',
      browseBindPasswordRef: 'ldap-reader',
      browseDenyAttributes: ['info']
    });
    // "*" opens a directory to every caller; an installation says that with no groups.
    const open = instanceFrom(X500);
    assert.deepEqual(open.allowedGroups, []);
    assert.deepEqual(open.actions.disabled, []);
    // A browse-only directory (no groups) keeps its people search closed.
    const browseOnly = instanceFrom({ ...CORP, groups: [] });
    assert.deepEqual(browseOnly.allowedGroups, []);
    assert.deepEqual(browseOnly.actions.disabled, ['search_people', 'get_person', 'list_units']);
    assert.equal(open.enabled, false);
    assert.equal(open.values.dataFlow, 'external');
    assert.equal(open.values.bindMode, 'anonymous');
  });

  it('round-trips through the installation reader into a valid directory', () => {
    for (const directory of [CORP, X500]) {
      const back = directoryFromInstance(instanceFrom(directory));
      const parsed = peopleDirectorySchema.safeParse(back);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
      assert.equal(back.id, directory.id);
      assert.deepEqual(back.groups, directory.groups);
      assert.deepEqual(back.name, directory.name);
      if (directory.bind) assert.deepEqual(back.bind, directory.bind);
      if (directory.browse) {
        assert.deepEqual(back.browse.bind, directory.browse.bind);
        assert.deepEqual(back.browse.denyAttributes, directory.browse.denyAttributes);
      }
      if (directory.attributeMapping) {
        assert.deepEqual(back.attributeMapping, { department: ['ou'], location: ['dn:l', 'l'] });
      }
    }
    assert.deepEqual(valuesFromDirectory({ id: 'min' }), {});
  });

  it('finds plain-text passwords a hand-edited file may hold', () => {
    assert.deepEqual(plainPasswordsOf(CORP), []);
    assert.deepEqual(
      plainPasswordsOf({
        id: 'x',
        bind: { mode: 'service', dn: 'cn=a', password: 'pw' },
        browse: { enabled: true, bind: { mode: 'service', dn: 'cn=b', password: 'pw2' } }
      }),
      [
        { field: 'bindPasswordRef', value: 'pw' },
        { field: 'browseBindPasswordRef', value: 'pw2' }
      ]
    );
  });

  it('rewrites app references into bindings', () => {
    const ids = ['corp', 'x500bund'];
    // The shipped People search app: every directory, including later ones.
    assert.deepEqual(
      migrateApp(
        { id: 'people', requiredIntegrations: ['peopleDirectories'], tools: ['peopleDirectories'] },
        ids
      ).app,
      { id: 'people', integrations: { 'com.intrafind/ldap-directory': {} } }
    );
    // The shipped LDAP browser app: visible while a directory exists, tools through ldapBrowse.
    assert.deepEqual(
      migrateApp(
        { id: 'browser', requiredIntegrations: ['peopleDirectories'], tools: ['ldapBrowse'] },
        ids
      ).app,
      {
        id: 'browser',
        tools: ['ldapBrowse'],
        integrations: { 'com.intrafind/ldap-directory': { actions: [] } }
      }
    );
    // One directory, and one action of another.
    assert.deepEqual(
      migrateApp(
        { id: 'a', tools: ['corp', 'x500bund__search_people', 'knowledge', 'corp__browse_read'] },
        ids
      ).app,
      {
        id: 'a',
        tools: ['knowledge', 'corp__browse_read'],
        integrations: { corp: {}, x500bund: { actions: ['search_people'] } }
      }
    );
    // Every search action named: the binding is unnarrowed.
    assert.deepEqual(
      migrateApp(
        { id: 'b', tools: ['corp__search_people', 'corp__get_person', 'corp__list_units'] },
        ids
      ).app.integrations,
      { corp: {} }
    );
    // Other requirements and an existing binding are kept.
    const mixed = migrateApp(
      {
        id: 'c',
        requiredIntegrations: ['peopleDirectories'],
        integrations: { ifinder: {} }
      },
      ids
    ).app;
    assert.deepEqual(mixed.integrations, { ifinder: {}, 'com.intrafind/ldap-directory': {} });
    assert.equal('requiredIntegrations' in mixed, false);
    const untouched = { id: 'd', tools: ['knowledge'] };
    assert.equal(migrateApp(untouched, ids).changed, false);
    assert.equal(migrateApp(untouched, ids).app, untouched);
  });

  it('creates the installations, rewrites apps and removes the file', async () => {
    const ctx = makeCtx({
      'config/peopleDirectories.json': { directories: [CORP, X500] },
      'config/integrations.json': {
        installed: [{ id: 'jira', definition: 'com.intrafind/jira' }],
        security: { blockPrivateIps: true, allowedHosts: [] }
      },
      'apps/people-directory.json': {
        id: 'people-directory',
        requiredIntegrations: ['peopleDirectories'],
        tools: ['peopleDirectories']
      },
      'apps/plain.json': { id: 'plain', tools: ['knowledge'] }
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const { installed } = ctx.files['config/integrations.json'];
    assert.deepEqual(
      installed.map(i => i.id),
      ['jira', 'corp', 'x500bund']
    );
    assert.ok(installed[1].installedAt);
    assert.equal('config/peopleDirectories.json' in ctx.files, false);
    assert.equal('config/peopleDirectories.unmigrated.json' in ctx.files, false);
    assert.deepEqual(ctx.files['apps/people-directory.json'], {
      id: 'people-directory',
      integrations: { 'com.intrafind/ldap-directory': {} }
    });
    assert.deepEqual(ctx.files['apps/plain.json'], { id: 'plain', tools: ['knowledge'] });
    assert.equal(ctx.warnings.length, 0);
  });

  it('keeps a directory whose id another installation holds in a side file', async () => {
    const ctx = makeCtx({
      'config/peopleDirectories.json': { directories: [CORP, { ...X500, id: 'drawio' }] },
      'config/integrations.json': {
        installed: [{ id: 'drawio', definition: 'mcp/drawio' }],
        security: {}
      },
      'apps/a.json': { id: 'a', tools: ['drawio__search_people'] }
    });
    await up(ctx);
    assert.deepEqual(
      ctx.files['config/integrations.json'].installed.map(i => i.id),
      ['drawio', 'corp']
    );
    assert.deepEqual(
      ctx.files['config/peopleDirectories.unmigrated.json'].directories.map(d => d.id),
      ['drawio']
    );
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0], /"drawio"/);
    // The app's reference becomes the binding the admin completes by installing.
    assert.deepEqual(ctx.files['apps/a.json'].integrations, {
      drawio: { actions: ['search_people'] }
    });
    assert.equal('config/peopleDirectories.json' in ctx.files, false);
  });

  it('moves a plain-text password into the credential store', async () => {
    const ctx = makeCtx({
      'config/peopleDirectories.json': {
        directories: [
          {
            id: 'hr',
            url: 'ldaps://hr.example:636',
            baseDn: 'o=HR',
            bind: { mode: 'service', dn: 'cn=svc,o=HR', password: 'secret' }
          }
        ]
      },
      'config/credentials.json': { credentials: { other: { id: 'other', type: 'secret' } } }
    });
    await up(ctx, { encrypt: value => `enc(${value})` });
    const [instance] = ctx.files['config/integrations.json'].installed;
    assert.equal(instance.values.bindPasswordRef, 'integration-hr-bindPasswordRef');
    const credential =
      ctx.files['config/credentials.json'].credentials['integration-hr-bindPasswordRef'];
    assert.equal(credential.type, 'secret');
    assert.equal(credential.value, 'enc(secret)');
    assert.ok(ctx.files['config/credentials.json'].credentials.other);
    assert.equal(JSON.stringify(instance).includes('secret'), false);
  });

  it('is idempotent and works without the file', async () => {
    const ctx = makeCtx({ 'apps/x.json': { id: 'x' } });
    await up(ctx);
    await up(ctx);
    assert.equal('config/integrations.json' in ctx.files, false);
    assert.deepEqual(ctx.files['apps/x.json'], { id: 'x' });
    const once = makeCtx({ 'config/peopleDirectories.json': { directories: [CORP] } });
    await up(once);
    await up(once);
    assert.equal(once.files['config/integrations.json'].installed.length, 1);
  });
});
