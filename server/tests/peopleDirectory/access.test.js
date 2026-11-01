// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directory search (#3026): who sees and may run a directory's tools.
 *
 * A directory is an installation of `com.intrafind/ldap-directory`. Its
 * groups (the installation's `allowedGroups`) are ANDed with the ordinary tool
 * grants and checked in every place tools are narrowed to a user — the
 * `/api/tools` listing, an app's tools, a direct tool run, the MCP gateway —
 * and again when the tool runs. An app binds one directory by its id, or
 * every directory by binding the definition.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../../configCache.js';
import '../../services/integrations/protocols/native/connectors/register.js';
import { getToolsForApp, loadTools, runTool } from '../../toolLoader.js';
import { mayRunTool } from '../../routes/toolRoutes.js';
import { buildMcpServer } from '../../services/mcp/McpServerService.js';
import { MCP_SCOPES } from '../../services/mcp/scopes.js';
import {
  directoryOfToolId,
  expandUserGroups,
  mayUseDirectory,
  resolveDirectory
} from '../../services/peopleDirectory/PeopleDirectoryService.js';
import { DEFINITION_ID, installDirectories } from './installations.js';

const DIRECTORIES = [
  {
    id: 'corp',
    url: 'ldaps://dc.corp.example:636',
    baseDn: 'dc=corp,dc=example',
    preset: 'activeDirectory',
    bind: { mode: 'service', dn: 'cn=svc,dc=corp,dc=example', passwordRef: 'svc' },
    name: { en: 'Company directory', de: 'Firmenverzeichnis' },
    description: { en: 'Employees of our company.', de: 'Mitarbeitende.' },
    groups: ['users']
  },
  {
    id: 'x500bund',
    url: 'ldaps://x500.bund.de:636',
    baseDn: 'o=Bund,c=DE',
    preset: 'ivbb',
    bind: { mode: 'anonymous' },
    units: true,
    maxResults: 25,
    dataFlow: 'external',
    name: { en: 'Federal directory (IVBB)' },
    description: { en: 'Staff of German federal authorities.' },
    groups: ['authenticated']
  },
  { id: 'off', enabled: false, url: 'ldaps://off.example:636', baseDn: 'o=Off', groups: ['*'] },
  {
    id: 'hr',
    url: 'ldaps://hr.example:636',
    baseDn: 'o=HR',
    bind: { mode: 'anonymous' },
    groups: ['hr']
  }
];

const state = { tools: [] };
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getGroups = () => ({
  data: {
    groups: {
      admins: { inherits: ['users'], permissions: { adminAccess: true } },
      users: { inherits: ['authenticated'] },
      authenticated: {},
      hr: {},
      guests: {}
    }
  }
});
configCache.getTools = () => ({ data: state.tools, etag: 'tools' });
configCache.getA2aAgents = () => ({ data: { agents: [] } });
configCache.getApps = () => ({ data: [], etag: 'apps' });
configCache.getFeatures = () => ({ skills: false, appAsTool: false });
configCache.setCacheEntry('config/tools.json', []);
configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });

const everything = { tools: new Set(['*']), apps: new Set(['*']) };
const member = { id: 'member', groups: ['users'], permissions: everything };
const admin = {
  id: 'admin',
  groups: ['admins'],
  permissions: { ...everything, adminAccess: true }
};
const outsider = { id: 'outsider', groups: ['guests'], permissions: everything };

const directoryToolIds = tools =>
  tools
    .filter(tool => tool._peopleDirectory)
    .map(tool => tool.id)
    .sort();

/** The shipped People search app's binding: every directory, including later ones. */
const ALL_DIRECTORIES = { [DEFINITION_ID]: {} };

describe('people directory access', () => {
  beforeEach(() => {
    installDirectories(configCache, DIRECTORIES);
    state.tools = [{ id: 'braveSearch', name: 'Brave', description: 'Search', enabled: true }];
  });

  it('offers tools for every enabled, usable directory, named after the directory', async () => {
    const tools = await loadTools('en');
    assert.deepEqual(directoryToolIds(tools), [
      'corp__get_person',
      'corp__search_people',
      'hr__get_person',
      'hr__search_people',
      'x500bund__get_person',
      'x500bund__list_units',
      'x500bund__search_people'
    ]);
    const search = tools.find(tool => tool.id === 'x500bund__search_people');
    assert.match(search.name, /^Federal directory \(IVBB\)/);
    assert.match(
      search.description,
      /^Federal directory \(IVBB\) – Staff of German federal authorities\./
    );
    assert.equal(search.dataFlow, 'external');
    assert.equal(search.readOnly, true);
    assert.deepEqual(search._integration.instanceId, 'x500bund');
    assert.deepEqual(search._peopleDirectory, { id: 'x500bund', action: 'search_people' });
    assert.equal(search.parameters.properties.maxResults.minimum, 1);
    assert.equal(search.parameters.properties.maxResults.maximum, 25);
    assert.ok(search.parameters.properties.unit);
    assert.ok(search.parameters.properties.jobTitle);
    assert.deepEqual(search.parameters.required, ['query']);
    const corp = tools.find(tool => tool.id === 'corp__search_people');
    assert.equal(corp.parameters.properties.unit, undefined);
    assert.equal(corp.dataFlow, 'internal');
  });

  it('reads the directory from a tool id without loading tools', () => {
    assert.equal(directoryOfToolId('x500bund__search_people'), 'x500bund');
    assert.equal(directoryOfToolId('corp__list_units'), 'corp');
    assert.equal(directoryOfToolId('corp__other'), null);
    assert.equal(directoryOfToolId('missing__search_people'), null);
    assert.equal(directoryOfToolId('braveSearch'), null);
  });

  it('leaves out a directory whose configuration cannot work', async () => {
    installDirectories(configCache, [
      { id: 'noprov', authProvider: 'missing', groups: ['*'] },
      { id: 'plain', url: 'ldap://plain.example:389', baseDn: 'o=x', groups: ['*'] }
    ]);
    assert.deepEqual(directoryToolIds(await loadTools('en')), []);
  });

  describe('groups', () => {
    it('resolve inherited groups', () => {
      assert.deepEqual([...expandUserGroups(['admins'])].sort(), [
        'admins',
        'authenticated',
        'users'
      ]);
      assert.equal(mayUseDirectory(admin, 'corp'), true);
      assert.equal(mayUseDirectory(member, 'x500bund'), true);
      assert.equal(mayUseDirectory(member, 'hr'), false);
      assert.equal(mayUseDirectory(outsider, 'x500bund'), false);
      assert.equal(mayUseDirectory(null, 'x500bund'), false);
      assert.equal(mayUseDirectory(member, 'off'), false);
      assert.equal(mayUseDirectory(member, 'unknown'), false);
    });

    it('no groups on the installation opens a directory to every caller', () => {
      installDirectories(configCache, [
        { id: 'open', url: 'ldaps://a.example', baseDn: 'o=a', groups: ['*'] }
      ]);
      assert.equal(mayUseDirectory(null, 'open'), true);
    });

    it('narrow the /api/tools listing, even with a "*" tool grant', async () => {
      const forMember = await configCache.getToolsForUser(member, { defaultLanguage: 'en' }, 'en');
      assert.deepEqual(directoryToolIds(forMember.data), [
        'corp__get_person',
        'corp__search_people',
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
      assert.ok(forMember.data.some(tool => tool.id === 'braveSearch'));
      const forOutsider = await configCache.getToolsForUser(
        outsider,
        { defaultLanguage: 'en' },
        'en'
      );
      assert.deepEqual(directoryToolIds(forOutsider.data), []);
    });

    it('change the /api/tools ETag when the directories change, even with the same tool ids', async () => {
      const platform = { defaultLanguage: 'en' };
      const before = await configCache.getToolsForUser(member, platform, 'en');
      installDirectories(
        configCache,
        DIRECTORIES.map(directory =>
          directory.id === 'x500bund' ? { ...directory, name: { en: 'Renamed' } } : directory
        )
      );
      const after = await configCache.getToolsForUser(member, platform, 'en');
      assert.deepEqual(
        after.data.map(tool => tool.id),
        before.data.map(tool => tool.id)
      );
      assert.notEqual(after.etag, before.etag);
    });

    it('keep a quoted tools ETag a single valid entity tag', async () => {
      const getTools = configCache.getTools;
      configCache.getTools = () => ({ data: state.tools, etag: '"tools-1"' });
      try {
        const { etag } = await configCache.getToolsForUser(member, { defaultLanguage: 'en' }, 'en');
        assert.match(etag, /^"[^"]+"$/);
      } finally {
        configCache.getTools = getTools;
      }
    });

    it('let a scheduled task pick the directory tools an app binds', async () => {
      const { toolsOfferedByApp } = await import('../../services/scheduler/tasks/taskService.js');
      const app = { id: 'people', integrations: ALL_DIRECTORIES, tools: ['braveSearch'] };
      const offered = await toolsOfferedByApp(app, member, 'en');
      const search = offered.find(tool => tool.id === 'x500bund__search_people');
      assert.equal(search.selectedByApp, true);
      assert.equal(offered.find(tool => tool.id === 'braveSearch').selectedByApp, true);
    });

    it('narrow an app that binds a directory', async () => {
      const app = { id: 'people', integrations: { x500bund: {}, hr: {} } };
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', { user: member })), [
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', { user: outsider })), []);
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', {})), []);
    });

    it('narrow an app that still lists a directory in `tools`', async () => {
      const app = { id: 'people', tools: ['x500bund', 'hr'] };
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', { user: member })), [
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', { user: outsider })), []);
    });

    it('refuse a direct tool run, for admins too', async () => {
      const platform = { defaultLanguage: 'en' };
      assert.equal(await mayRunTool(member, platform, 'corp__search_people'), true);
      assert.equal(await mayRunTool(outsider, platform, 'x500bund__search_people'), false);
      assert.equal(await mayRunTool(admin, platform, 'hr__search_people'), false);
      assert.equal(await mayRunTool(admin, platform, 'braveSearch'), true);
    });

    it('narrow the MCP gateway', async () => {
      const platform = {
        defaultLanguage: 'en',
        mcpServer: { expose: { tools: true, apps: false, workflows: false, resources: false } }
      };
      const scopes = [MCP_SCOPES.TOOLS_READ, MCP_SCOPES.TOOLS_CALL];
      const registered = async user =>
        Object.keys(
          (await buildMcpServer({ user: { ...user, scopes }, platform }))._registeredTools
        )
          .filter(id => id.includes('__'))
          .sort();
      assert.deepEqual(await registered(member), [
        'corp__get_person',
        'corp__search_people',
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
      assert.deepEqual(await registered(outsider), []);
    });

    it('refuse the tool when it is called anyway', async () => {
      await assert.rejects(
        runTool('hr__search_people', { query: 'Muster', user: member }),
        /not available/
      );
      await assert.rejects(
        runTool('x500bund__search_people', { query: 'Muster', user: outsider }),
        /not available/
      );
    });
  });

  describe('app binding', () => {
    it('binding the definition selects every directory tool the user may use, and nothing else', async () => {
      const app = { id: 'people-directory', integrations: ALL_DIRECTORIES };
      const tools = await getToolsForApp(app, 'en', { user: member });
      assert.deepEqual(tools.map(tool => tool.id).sort(), [
        'corp__get_person',
        'corp__search_people',
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
    });

    it('a definition binding narrowed to actions, and an installation binding on top', async () => {
      const app = {
        id: 'a',
        integrations: {
          [DEFINITION_ID]: { actions: ['search_people'] },
          x500bund: {}
        }
      };
      const tools = await getToolsForApp(app, 'en', { user: member });
      assert.deepEqual(tools.map(tool => tool.id).sort(), [
        'corp__search_people',
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
    });

    it('binding one installation selects only that directory', async () => {
      const tools = await getToolsForApp({ id: 'a', integrations: { x500bund: {} } }, 'en', {
        user: member
      });
      assert.deepEqual(tools.map(tool => tool.id).sort(), [
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
    });

    it('a directory added later is picked up without editing the app', async () => {
      const app = { id: 'people-directory', integrations: ALL_DIRECTORIES };
      installDirectories(configCache, [
        ...DIRECTORIES,
        {
          id: 'later',
          url: 'ldaps://later.example',
          baseDn: 'o=later',
          bind: { mode: 'anonymous' },
          groups: ['users']
        }
      ]);
      const ids = (await getToolsForApp(app, 'en', { user: member })).map(tool => tool.id);
      assert.ok(ids.includes('later__search_people'));
    });
  });

  describe('configuration resolution', () => {
    const platform = {
      ldapAuth: {
        providers: [
          {
            name: 'corp-ad',
            url: 'ldaps://dc1.corp.example:636',
            preset: 'activeDirectory',
            baseDn: 'dc=corp,dc=example',
            userSearchBase: 'ou=Staff,dc=corp,dc=example',
            adminDn: 'cn=svc,dc=corp,dc=example',
            adminPasswordRef: 'ldap-svc',
            tlsOptions: { minVersion: 'TLSv1.2' }
          },
          { name: 'nobind', url: 'ldaps://dc2.corp.example:636', baseDn: 'dc=corp,dc=example' }
        ]
      }
    };

    it('inherits URL, preset, search base, TLS settings and bind account from the sign-in provider', () => {
      const resolved = resolveDirectory({ id: 'corp', authProvider: 'corp-ad' }, platform);
      assert.deepEqual(resolved.problems, []);
      assert.equal(resolved.url, 'ldaps://dc1.corp.example:636');
      assert.equal(resolved.preset, 'activeDirectory');
      assert.equal(resolved.searchBase, 'ou=Staff,dc=corp,dc=example');
      assert.deepEqual(resolved.tlsOptions, { minVersion: 'TLSv1.2' });
      assert.deepEqual(resolved.bind, {
        mode: 'service',
        dn: 'cn=svc,dc=corp,dc=example',
        passwordRef: 'ldap-svc'
      });
      assert.equal(resolved.providerHost, 'dc1.corp.example');
      assert.match(resolved.personFilter, /userAccountControl/);
    });

    it('lets fields on the directory override the inherited ones', () => {
      const resolved = resolveDirectory(
        {
          id: 'corp',
          authProvider: 'corp-ad',
          url: 'ldaps://gc.corp.example:3269',
          baseDn: 'ou=People,dc=corp,dc=example',
          preset: 'openldap',
          bind: { mode: 'anonymous' },
          tlsOptions: { minVersion: 'TLSv1.3' }
        },
        platform
      );
      assert.equal(resolved.url, 'ldaps://gc.corp.example:3269');
      assert.equal(resolved.searchBase, 'ou=People,dc=corp,dc=example');
      assert.equal(resolved.preset, 'openldap');
      assert.deepEqual(resolved.bind, { mode: 'anonymous' });
      assert.deepEqual(resolved.tlsOptions, { minVersion: 'TLSv1.3' });
    });

    it('reports a missing provider and a provider without a bind account', () => {
      assert.match(
        resolveDirectory({ id: 'corp', authProvider: 'missing' }, platform).problems.join(' '),
        /No LDAP sign-in provider named "missing"/
      );
      assert.match(
        resolveDirectory({ id: 'corp', authProvider: 'nobind' }, platform).problems.join(' '),
        /has no bind account/
      );
      assert.deepEqual(
        resolveDirectory(
          { id: 'corp', authProvider: 'nobind', bind: { mode: 'anonymous' } },
          platform
        ).problems,
        []
      );
    });

    it('rejects an inline password through the schema', () => {
      const resolved = resolveDirectory(
        {
          id: 'corp',
          url: 'ldaps://a.example',
          baseDn: 'o=a',
          bind: { mode: 'service', dn: 'cn=svc', password: 'secret' }
        },
        platform
      );
      assert.ok(resolved.problems.some(problem => problem.includes('password')));
    });
  });
});
