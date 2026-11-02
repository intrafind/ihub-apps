// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V205: the admin LDAP browser of a people directory becomes its own installation. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  up,
  precondition,
  version,
  description,
  browserIdFor,
  browserLabelOf,
  browserValuesOf,
  splitActionPolicy,
  mergeBrowseActions,
  migrateApp,
  migrateToolGrants,
  wildcardGainers,
  BROWSE_ACTIONS,
  BROWSER_DEFINITION,
  DIRECTORY_DEFINITION,
  PEOPLE_DIRECTORY_TYPE_KEY
} from '../migrations/V205__ldap_browser_installations.js';

const INTEGRATIONS = 'config/integrations.json';
const GROUPS = 'config/groups.json';

function makeCtx(files) {
  const logs = [];
  const warnings = [];
  const writes = [];
  return {
    logs,
    warnings,
    files,
    writes,
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes.push(rel);
      files[rel] = structuredClone(data);
    },
    listFiles: async (dir, pattern) => {
      const suffix = pattern.replace('*', '');
      return Object.keys(files)
        .filter(rel => rel.startsWith(`${dir}/`) && rel.endsWith(suffix))
        .map(rel => rel.slice(dir.length + 1));
    },
    log: m => logs.push(m),
    warn: m => warnings.push(m)
  };
}

/** Shipped-like groups (after V202) plus two custom ones. */
function groupsFile() {
  return {
    groups: {
      admins: {
        id: 'admins',
        inherits: ['users'],
        permissions: { apps: ['*'], integrations: ['*'], adminAccess: true }
      },
      users: {
        id: 'users',
        inherits: ['authenticated'],
        permissions: { apps: ['*'], integrations: ['*'] }
      },
      authenticated: {
        id: 'authenticated',
        inherits: ['anonymous'],
        permissions: { apps: ['*'], integrations: ['*'] }
      },
      anonymous: { id: 'anonymous', permissions: { apps: ['chat'], integrations: ['ihub'] } },
      'it-ops': {
        id: 'it-ops',
        permissions: { apps: ['ldap-browser'], integrations: ['corp'], tools: ['ldapBrowse'] }
      },
      auditors: {
        id: 'auditors',
        permissions: { integrations: [], tools: ['corp__browse_read', 'mcp1__browse_search'] }
      }
    },
    metadata: { version: '1.0.0' }
  };
}

function directory(id, values, extra = {}) {
  return {
    id,
    definition: DIRECTORY_DEFINITION,
    definitionVersion: '1.0.0',
    enabled: true,
    values,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    ...extra
  };
}

function integrationsFile(installed) {
  return { installed, security: { blockPrivateIps: true, allowedHosts: [] } };
}

const corpValues = {
  authProvider: 'corp-ad',
  browse: true,
  browseGroups: ['it-ops', 'ghosts'],
  browseBase: 'ou=people,dc=corp,dc=example',
  browseMaxResults: 20,
  browseBindMode: 'service',
  browseBindDn: 'cn=reader,dc=corp,dc=example',
  browseBindPasswordRef: 'ldap-reader',
  browseDenyAttributes: ['info']
};

/** The shipped LDAP browser app as V198 left it. */
const ldapBrowserApp = {
  id: 'ldap-browser',
  enabled: false,
  integrations: {
    [DIRECTORY_DEFINITION]: { actions: ['browse_search', 'browse_read', 'browse_children'] }
  }
};

/** The shipped People search app as V198 left it. */
const peopleSearchApp = {
  id: 'people-directory',
  enabled: true,
  integrations: { [DIRECTORY_DEFINITION]: {} }
};

function fullFiles() {
  return {
    [INTEGRATIONS]: integrationsFile([
      { id: 'websearch', definition: 'com.intrafind/web-search', enabled: true, values: {} },
      directory('corp', structuredClone(corpValues), {
        label: { en: 'Company directory', de: 'Firmenverzeichnis' },
        actions: {
          enabled: ['*'],
          disabled: ['list_units', 'browse_children'],
          overrides: { browse_search: { title: 'Search raw' } }
        }
      }),
      // Taken by another installation: the browser gets a suffix.
      { id: 'infra-browser', definition: 'mcp/drawio', enabled: false, values: {} },
      directory(
        'infra',
        { url: 'ldaps://ldap.infra.example', baseDn: 'o=infra', browse: true },
        { enabled: false, actions: { enabled: ['*'], disabled: ['search_people'], overrides: {} } }
      ),
      // Browser off, settings kept: they go.
      directory('x500bund', {
        url: 'ldaps://x500.bund.de:636',
        baseDn: 'o=Bund,c=DE',
        browse: false,
        browseGroups: ['admins']
      }),
      directory('plain', { url: 'ldaps://plain.example', baseDn: 'o=plain' })
    ]),
    [GROUPS]: groupsFile(),
    'apps/ldap-browser.json': structuredClone(ldapBrowserApp),
    'apps/people-directory.json': structuredClone(peopleSearchApp),
    'apps/custom.json': {
      id: 'custom',
      tools: ['corp__browse_read', 'x500bund__browse_search', 'mcp1__browse_search', 'other'],
      integrations: {
        corp: { actions: ['search_people', 'browse_search'], required: false },
        mcp1: { actions: ['browse_search'] }
      }
    },
    'apps/v198-browse-only.json': {
      id: 'v198-browse-only',
      tools: ['ldapBrowse'],
      integrations: { [DIRECTORY_DEFINITION]: { actions: [] } }
    },
    'apps/chat.json': { id: 'chat', tools: ['braveSearch'] }
  };
}

const byId = (files, id) => files[INTEGRATIONS].installed.find(entry => entry.id === id);

describe('V205 LDAP browser installations', () => {
  it('declares its version and description', () => {
    assert.equal(version, '205');
    assert.equal(description, 'ldap_browser_installations');
  });

  it('runs when integrations.json, groups.json or an app exists', async () => {
    assert.equal(await precondition(makeCtx({})), false);
    assert.equal(await precondition(makeCtx({ [INTEGRATIONS]: integrationsFile([]) })), true);
    assert.equal(await precondition(makeCtx({ [GROUPS]: groupsFile() })), true);
    assert.equal(await precondition(makeCtx({ 'apps/a.json': { id: 'a' } })), true);
  });

  describe('helpers', () => {
    it('picks <id>-browser, a numbered suffix when taken, at most 64 characters', () => {
      const taken = new Set(['infra-browser', 'infra-browser-2']);
      assert.equal(browserIdFor('corp', taken), 'corp-browser');
      assert.equal(browserIdFor('infra', taken), 'infra-browser-3');
      assert.ok(taken.has('corp-browser'));
      const long = browserIdFor('d'.repeat(64), new Set());
      assert.equal(long.length, 64);
      assert.ok(long.endsWith('-browser'));
    });

    it('labels the browser after the directory, per language', () => {
      assert.deepEqual(browserLabelOf({ id: 'corp', label: { en: 'Company', de: 'Firma' } }), {
        en: 'Company – LDAP browser',
        de: 'Firma – LDAP-Browser'
      });
      assert.deepEqual(browserLabelOf({ id: 'corp', label: 'Company' }), {
        en: 'Company – LDAP browser'
      });
      assert.deepEqual(browserLabelOf({ id: 'corp' }), {
        en: 'corp – LDAP browser',
        de: 'corp – LDAP-Browser'
      });
    });

    it('maps the browse values, the credential reference included', () => {
      assert.deepEqual(browserValuesOf('corp', corpValues), {
        directory: 'corp',
        baseDn: 'ou=people,dc=corp,dc=example',
        maxResults: 20,
        bindMode: 'service',
        bindDn: 'cn=reader,dc=corp,dc=example',
        bindPasswordRef: 'ldap-reader',
        denyAttributes: ['info']
      });
      assert.deepEqual(browserValuesOf('x', { browse: true, browseBindMode: 'anonymous' }), {
        directory: 'x',
        bindMode: 'anonymous'
      });
    });

    it('splits the action policy between directory and browser', () => {
      const { directory: dir, browser } = splitActionPolicy({
        enabled: ['search_people', 'browse_search'],
        disabled: ['browse_read', 'list_units'],
        overrides: { browse_search: { title: 'x' }, get_person: { title: 'y' } }
      });
      assert.deepEqual(dir, {
        enabled: ['search_people'],
        disabled: ['list_units'],
        overrides: { get_person: { title: 'y' } }
      });
      assert.deepEqual(browser, {
        enabled: ['browse_search'],
        disabled: ['browse_read'],
        overrides: { browse_search: { title: 'x' } }
      });
      assert.deepEqual(splitActionPolicy(undefined).browser, {
        enabled: ['*'],
        disabled: [],
        overrides: {}
      });
    });

    it('merges browse actions: all three bind without a list', () => {
      assert.deepEqual(mergeBrowseActions({ actions: [] }, ['browse_read']), {
        actions: ['browse_read']
      });
      assert.deepEqual(mergeBrowseActions({ actions: ['browse_read'] }, ['browse_search']), {
        actions: ['browse_search', 'browse_read']
      });
      assert.deepEqual(mergeBrowseActions({ actions: [], required: false }, [...BROWSE_ACTIONS]), {
        required: false
      });
      assert.deepEqual(mergeBrowseActions({}, ['browse_read']), {});
      assert.deepEqual(mergeBrowseActions({ actions: ['browse_read'] }, null), {});
    });

    it('names the groups a "*" grant opens the browser to', () => {
      const groups = groupsFile().groups;
      assert.deepEqual(wildcardGainers(groups, ['it-ops']).sort(), [
        'admins',
        'authenticated',
        'users'
      ]);
      // `admins` inherits `users`: browse groups ["users"] already reached it.
      assert.deepEqual(wildcardGainers(groups, ['users']).sort(), ['authenticated']);
    });

    it('rewrites group tool grants to the browser ids', () => {
      const browserOf = new Map([['corp', 'corp-browser']]);
      assert.deepEqual(
        migrateToolGrants(['ldapBrowse', 'corp__browse_read', 'x__browse_read', 'a'], browserOf),
        {
          tools: ['corp-browser', 'corp-browser__browse_read', 'x__browse_read', 'a'],
          changed: true
        }
      );
      assert.deepEqual(migrateToolGrants(['a'], browserOf), { tools: ['a'], changed: false });
      assert.deepEqual(migrateToolGrants(undefined, browserOf), {
        tools: undefined,
        changed: false
      });
    });
  });

  describe('apps', () => {
    const context = {
      browserOf: new Map([['corp', 'corp-browser']]),
      directoryIds: new Set(['corp', 'x500bund'])
    };

    it('moves the LDAP browser app from the directory definition to the browser definition', () => {
      const { app, changed } = migrateApp(structuredClone(ldapBrowserApp), context);
      assert.equal(changed, true);
      assert.deepEqual(app.integrations, { [BROWSER_DEFINITION]: {} });
    });

    it('moves the People search app onto type:people-directory', () => {
      const { app } = migrateApp(structuredClone(peopleSearchApp), context);
      assert.deepEqual(app.integrations, { [PEOPLE_DIRECTORY_TYPE_KEY]: {} });
      // A customised binding, or another app with the same binding, stays.
      const narrowed = migrateApp(
        { ...peopleSearchApp, integrations: { [DIRECTORY_DEFINITION]: { required: false } } },
        context
      );
      assert.equal(narrowed.changed, false);
      const other = migrateApp({ ...peopleSearchApp, id: 'mine' }, context);
      assert.equal(other.changed, false);
    });

    it('drops the V198 definition binding next to the shipped type binding (fresh install)', () => {
      // A fresh install copies the shipped app (type binding); V185 and V198
      // then add the definition binding, which would hide the app while no
      // LDAP directory is enabled, Entra or not.
      const { app, changed } = migrateApp(
        {
          ...peopleSearchApp,
          integrations: { [PEOPLE_DIRECTORY_TYPE_KEY]: {}, [DIRECTORY_DEFINITION]: {} }
        },
        context
      );
      assert.equal(changed, true);
      assert.deepEqual(app.integrations, { [PEOPLE_DIRECTORY_TYPE_KEY]: {} });
    });

    it('moves the browse actions of a directory binding to its browser and keeps the rest', () => {
      const { app, warnings } = migrateApp(
        {
          id: 'a',
          integrations: {
            corp: { actions: ['search_people', 'browse_search'], required: false },
            x500bund: { actions: ['browse_read'] },
            mcp1: { actions: ['browse_search'] }
          }
        },
        context
      );
      assert.deepEqual(app.integrations, {
        corp: { actions: ['search_people'], required: false },
        'corp-browser': { required: false, actions: ['browse_search'] },
        mcp1: { actions: ['browse_search'] }
      });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /"x500bund" has no LDAP browser/);
    });

    it('turns tools references into browser bindings and leaves other tools alone', () => {
      const { app, warnings } = migrateApp(
        {
          id: 'a',
          tools: [
            'ldapBrowse',
            'corp__browse_read',
            'x500bund__browse_search',
            'mcp1__browse_search'
          ]
        },
        context
      );
      assert.deepEqual(app.tools, ['mcp1__browse_search']);
      assert.deepEqual(app.integrations, {
        [BROWSER_DEFINITION]: {},
        'corp-browser': { actions: ['browse_read'] }
      });
      assert.equal(warnings.length, 1);
    });

    it('removes the V198 visibility binding of an app that browsed through ldapBrowse', () => {
      const { app } = migrateApp(
        {
          id: 'a',
          tools: ['ldapBrowse'],
          integrations: { [DIRECTORY_DEFINITION]: { actions: [] } }
        },
        context
      );
      assert.equal(app.tools, undefined);
      assert.deepEqual(app.integrations, { [BROWSER_DEFINITION]: {} });
    });

    it('leaves an app without browse references unchanged', () => {
      const app = { id: 'chat', tools: ['braveSearch'], integrations: { corp: {} } };
      assert.equal(migrateApp(app, context).changed, false);
    });
  });

  describe('up', () => {
    it('creates the browsers, grants them, rewrites apps and cleans the directories', async () => {
      const ctx = makeCtx(fullFiles());
      await up(ctx);
      const { files } = ctx;

      const corpBrowser = byId(files, 'corp-browser');
      assert.equal(corpBrowser.definition, BROWSER_DEFINITION);
      assert.equal(corpBrowser.definitionVersion, '1.0.0');
      assert.equal(corpBrowser.enabled, true);
      assert.deepEqual(corpBrowser.label, {
        en: 'Company directory – LDAP browser',
        de: 'Firmenverzeichnis – LDAP-Browser'
      });
      assert.deepEqual(corpBrowser.values, {
        directory: 'corp',
        baseDn: 'ou=people,dc=corp,dc=example',
        maxResults: 20,
        bindMode: 'service',
        bindDn: 'cn=reader,dc=corp,dc=example',
        bindPasswordRef: 'ldap-reader',
        denyAttributes: ['info']
      });
      assert.deepEqual(corpBrowser.actions, {
        enabled: ['*'],
        disabled: ['browse_children'],
        overrides: { browse_search: { title: 'Search raw' } }
      });
      // Right after its directory.
      const ids = files[INTEGRATIONS].installed.map(entry => entry.id);
      assert.equal(ids.indexOf('corp-browser'), ids.indexOf('corp') + 1);

      const infraBrowser = byId(files, 'infra-browser-2');
      assert.equal(infraBrowser.enabled, false, 'enabled like its directory');
      assert.deepEqual(infraBrowser.values, { directory: 'infra' });

      // The directories keep no browse value and no browse action entry.
      for (const id of ['corp', 'infra', 'x500bund', 'plain']) {
        const values = byId(files, id).values;
        assert.ok(!Object.keys(values).some(key => key.startsWith('browse')), id);
      }
      assert.deepEqual(byId(files, 'corp').values, { authProvider: 'corp-ad' });
      assert.deepEqual(byId(files, 'corp').actions, {
        enabled: ['*'],
        disabled: ['list_units'],
        overrides: {}
      });
      assert.deepEqual(byId(files, 'infra').actions.disabled, ['search_people']);
      assert.ok(
        !files[INTEGRATIONS].installed.some(entry => entry.values?.directory === 'x500bund')
      );

      // Grants: the browse groups; unknown groups warned; default admins.
      const groups = files[GROUPS].groups;
      assert.deepEqual(groups['it-ops'].permissions.integrations, ['corp', 'corp-browser']);
      assert.deepEqual(groups.admins.permissions.integrations, ['*'], 'already "*"');
      assert.ok(ctx.warnings.some(w => /"ghosts"/.test(w)));
      assert.ok(
        ctx.warnings.some(w => /"corp-browser".*"users".*hold "\*"/.test(w)),
        'warns about "*" holders that could not browse before'
      );
      // Tool grants follow the browser.
      assert.deepEqual(groups['it-ops'].permissions.tools, ['corp-browser', 'infra-browser-2']);
      assert.deepEqual(groups.auditors.permissions.tools, [
        'corp-browser__browse_read',
        'mcp1__browse_search'
      ]);

      // Apps.
      assert.deepEqual(files['apps/ldap-browser.json'].integrations, { [BROWSER_DEFINITION]: {} });
      assert.deepEqual(files['apps/people-directory.json'].integrations, {
        [PEOPLE_DIRECTORY_TYPE_KEY]: {}
      });
      assert.deepEqual(files['apps/custom.json'], {
        id: 'custom',
        tools: ['mcp1__browse_search', 'other'],
        integrations: {
          corp: { actions: ['search_people'], required: false },
          mcp1: { actions: ['browse_search'] },
          'corp-browser': { required: false, actions: ['browse_search', 'browse_read'] }
        }
      });
      assert.deepEqual(files['apps/v198-browse-only.json'], {
        id: 'v198-browse-only',
        integrations: { [BROWSER_DEFINITION]: {} }
      });
      assert.ok(!ctx.writes.includes('apps/chat.json'));
      // integrations.json is written last.
      assert.equal(ctx.writes.at(-1), INTEGRATIONS);
    });

    it('is idempotent', async () => {
      const ctx = makeCtx(fullFiles());
      await up(ctx);
      const after = structuredClone(ctx.files);
      const again = makeCtx(ctx.files);
      await up(again);
      assert.deepEqual(again.writes, []);
      assert.deepEqual(again.files, after);
    });

    it('does nothing without files and copes with missing groups.json', async () => {
      const empty = makeCtx({});
      await up(empty);
      assert.deepEqual(empty.writes, []);

      const files = fullFiles();
      delete files[GROUPS];
      const ctx = makeCtx(files);
      await up(ctx);
      assert.ok(byId(ctx.files, 'corp-browser'));
      assert.ok(ctx.warnings.some(w => /No groups\.json/.test(w)));
    });

    it('rewrites the apps when there is no integrations.json', async () => {
      const ctx = makeCtx({
        'apps/ldap-browser.json': structuredClone(ldapBrowserApp),
        'apps/people-directory.json': structuredClone(peopleSearchApp)
      });
      await up(ctx);
      assert.deepEqual(ctx.files['apps/ldap-browser.json'].integrations, {
        [BROWSER_DEFINITION]: {}
      });
      assert.deepEqual(ctx.files['apps/people-directory.json'].integrations, {
        [PEOPLE_DIRECTORY_TYPE_KEY]: {}
      });
      assert.ok(!(INTEGRATIONS in ctx.files));
    });
  });
});
