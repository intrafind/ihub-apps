// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * People directory search (#3026): who sees and may run a directory's tools.
 *
 * A directory's `groups` are ANDed with the ordinary tool grants and checked in
 * every place tools are narrowed to a user — the `/api/tools` listing, an
 * app's tools, a direct tool run, the MCP gateway — and again when the tool
 * runs. An app selects directories by id or with `peopleDirectories`.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../../configCache.js';
import { getToolsForApp, loadTools, runTool } from '../../toolLoader.js';
import { mayRunTool } from '../../routes/toolRoutes.js';
import { buildMcpServer } from '../../services/mcp/McpServerService.js';
import { MCP_SCOPES } from '../../services/mcp/scopes.js';
import {
  directoryOfToolId,
  discoverPeopleDirectoryTools,
  expandUserGroups,
  findDirectoryClaimedBy,
  findDirectoryIdConflict,
  mayUseDirectory,
  mcpServerBaseIds,
  resolveDirectory
} from '../../services/peopleDirectory/PeopleDirectoryService.js';

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

const state = {
  directories: DIRECTORIES,
  directoriesEtag: 'dirs-1',
  tools: [],
  mcpServers: [],
  a2aAgents: []
};
configCache.getPeopleDirectories = () => ({
  data: { directories: state.directories },
  etag: state.directoriesEtag
});
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
configCache.getMcpServers = () => ({ data: { servers: state.mcpServers } });
configCache.getA2aAgents = () => ({ data: { agents: state.a2aAgents } });
configCache.getApps = () => ({ data: [], etag: 'apps' });
configCache.getFeatures = () => ({ skills: false, appAsTool: false });

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

describe('people directory access', () => {
  beforeEach(() => {
    state.directories = DIRECTORIES;
    state.tools = [{ id: 'braveSearch', name: 'Brave', description: 'Search', enabled: true }];
    state.mcpServers = [];
    state.a2aAgents = [];
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
    assert.equal(search.parameters.properties.maxResults.minimum, 1);
    assert.equal(search.parameters.properties.maxResults.maximum, 25);
    assert.ok(search.parameters.properties.unit);
    assert.ok(search.parameters.properties.jobTitle);
    assert.deepEqual(search.parameters.required, ['query']);
    const corp = tools.find(tool => tool.id === 'corp__search_people');
    assert.equal(corp.parameters.properties.unit, undefined);
  });

  it('leaves out a directory whose id another tool reference already uses', async () => {
    state.tools = [{ id: 'corp_lookup', enabled: true }];
    state.mcpServers = [{ id: 'hr' }];
    const ids = directoryToolIds(await loadTools('en'));
    assert.ok(!ids.some(id => id.startsWith('corp__')));
    assert.ok(!ids.some(id => id.startsWith('hr__')));
    assert.ok(ids.includes('x500bund__search_people'));
    assert.deepEqual(findDirectoryIdConflict('jira', { a2aAgents: [{ id: 'jira' }] }), {
      kind: 'a2aAgent',
      id: 'jira'
    });
  });

  it('counts an MCP server tool prefix as a clash, in both directions', () => {
    const dio = { id: 'drawio', toolPrefix: 'corp_' };
    assert.deepEqual(mcpServerBaseIds(dio), ['drawio', 'corp']);
    assert.deepEqual(findDirectoryIdConflict('corp', { mcpServers: [dio] }), {
      kind: 'mcpServer',
      id: 'drawio'
    });
    assert.deepEqual(findDirectoryIdConflict('jira', { mcpServers: [{ id: 'JIRA' }] }), {
      kind: 'mcpServer',
      id: 'JIRA'
    });

    // A new tool, MCP server or agent may not take over a directory's id,
    // even a switched-off one.
    assert.equal(findDirectoryClaimedBy(mcpServerBaseIds(dio)), 'corp');
    assert.equal(findDirectoryClaimedBy(['X500BUND']), 'x500bund');
    assert.equal(findDirectoryClaimedBy(['off']), 'off');
    assert.equal(findDirectoryClaimedBy(['jira', null, '']), null);
  });

  it('offers only the first of two entries with the same id', () => {
    state.directories = [
      { id: 'dup', url: 'ldaps://a.example', baseDn: 'o=A', groups: ['*'] },
      { id: 'dup', url: 'ldaps://b.example', baseDn: 'o=B', groups: ['*'] }
    ];
    const ids = discoverPeopleDirectoryTools().map(tool => tool.id);
    assert.deepEqual(ids, ['dup__search_people', 'dup__get_person']);

    // A switched-off first entry still wins: its groups are the ones checked.
    state.directories = [
      { id: 'dup', enabled: false, url: 'ldaps://a.example', baseDn: 'o=A', groups: ['*'] },
      { id: 'dup', url: 'ldaps://b.example', baseDn: 'o=B', groups: ['*'] }
    ];
    assert.deepEqual(discoverPeopleDirectoryTools(), []);
  });

  it('reserves the ids whose tool ids are routed elsewhere', () => {
    for (const id of [
      'new',
      'app',
      'workflow',
      'source',
      'knowledge',
      'a2a',
      'peopleDirectories'
    ]) {
      assert.equal(findDirectoryIdConflict(id)?.kind, 'reserved', id);
    }
    // A hand-edited file may hold any JSON; a non-string id is no clash and no crash.
    assert.equal(findDirectoryIdConflict(42), null);
  });

  it('reads the directory from a tool id without loading tools', () => {
    assert.equal(directoryOfToolId('x500bund__search_people'), 'x500bund');
    assert.equal(directoryOfToolId('corp__list_units'), 'corp');
    assert.equal(directoryOfToolId('corp__other'), null);
    assert.equal(directoryOfToolId('missing__search_people'), null);
    assert.equal(directoryOfToolId('braveSearch'), null);
  });

  it('leaves out a directory whose configuration cannot work', () => {
    state.directories = [
      { id: 'noprov', authProvider: 'missing', groups: ['*'] },
      { id: 'plain', url: 'ldap://plain.example:389', baseDn: 'o=x', groups: ['*'] }
    ];
    assert.deepEqual(discoverPeopleDirectoryTools(), []);
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

    it('"*" opens a directory to every caller, an empty list to nobody', () => {
      state.directories = [
        { id: 'open', url: 'ldaps://a.example', baseDn: 'o=a', groups: ['*'] },
        { id: 'closed', url: 'ldaps://b.example', baseDn: 'o=b', groups: [] }
      ];
      assert.equal(mayUseDirectory(null, 'open'), true);
      assert.equal(mayUseDirectory(admin, 'closed'), false);
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
      state.directories = DIRECTORIES.map(directory =>
        directory.id === 'x500bund' ? { ...directory, name: { en: 'Renamed' } } : directory
      );
      state.directoriesEtag = 'dirs-2';
      const after = await configCache.getToolsForUser(member, platform, 'en');
      assert.deepEqual(
        after.data.map(tool => tool.id),
        before.data.map(tool => tool.id)
      );
      assert.notEqual(after.etag, before.etag);
      state.directoriesEtag = 'dirs-1';
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

    it('let a scheduled task switch off the directory tools an app selects by reference', async () => {
      const { toolsOfferedByApp } = await import('../../services/scheduler/tasks/taskService.js');
      const app = { id: 'people', tools: ['peopleDirectories', 'braveSearch'] };
      const offered = await toolsOfferedByApp(app, member, 'en');
      const search = offered.find(tool => tool.id === 'x500bund__search_people');
      assert.equal(search.selectedByApp, true);
      assert.equal(offered.find(tool => tool.id === 'braveSearch').selectedByApp, true);
    });

    it('narrow an app that lists a directory', async () => {
      const app = { id: 'people', tools: ['x500bund', 'hr'] };
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', { user: member })), [
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', { user: outsider })), []);
      assert.deepEqual(directoryToolIds(await getToolsForApp(app, 'en', {})), []);
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

  describe('app selection', () => {
    it('"peopleDirectories" selects every directory tool the user may use, and nothing else', async () => {
      const app = { id: 'people-directory', tools: ['peopleDirectories'] };
      const tools = await getToolsForApp(app, 'en', { user: member });
      assert.deepEqual(tools.map(tool => tool.id).sort(), [
        'corp__get_person',
        'corp__search_people',
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
    });

    it('"x500bund" selects only that directory', async () => {
      const tools = await getToolsForApp({ id: 'a', tools: ['x500bund'] }, 'en', { user: member });
      assert.deepEqual(tools.map(tool => tool.id).sort(), [
        'x500bund__get_person',
        'x500bund__list_units',
        'x500bund__search_people'
      ]);
    });

    it('a directory added later is picked up without editing the app', async () => {
      const app = { id: 'people-directory', tools: ['peopleDirectories'] };
      state.directories = [
        ...DIRECTORIES,
        {
          id: 'later',
          url: 'ldaps://later.example',
          baseDn: 'o=later',
          bind: { mode: 'anonymous' },
          groups: ['users']
        }
      ];
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
