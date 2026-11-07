// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin LDAP browser (`com.intrafind/ldap-browser`): an installation of
 * its own that names a people directory installation and reuses its
 * connection (concept "Unified Integrations" 07 §6, migration V205).
 *
 * Who sees and runs the browse tools (the browser installation's group grant,
 * signed-in non-delegated users only, its directory enabled, never through a
 * binding of the directory, never over MCP), the deny list in results and in
 * filters, the DN scope, the limits, and the audit record. The LDAP client is
 * a fake passed as the `connect` dependency.
 */
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SizeLimitExceededError } from 'ldapts';

const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-dir-browse-'));
process.env.CONTENTS_DIR = contentsDir;

const { default: configCache } = await import('../../configCache.js');
await import('../../services/integrations/protocols/native/connectors/register.js');
const { getToolsForApp } = await import('../../services/tools/appTools.js');
const { loadTools } = await import('../../services/tools/catalog.js');
const { buildMcpServer } = await import('../../services/mcp/McpServerService.js');
const { MCP_SCOPES } = await import('../../services/mcp/scopes.js');
const { flushAuditLog } = await import('../../services/AuditLogService.js');
const { ldapBrowserSchema, peopleDirectorySchema } =
  await import('../../validators/peopleDirectorySchema.js');
const { browserToolOfId, mayUseBrowser, resolveBrowser } =
  await import('../../services/peopleDirectory/LdapBrowserService.js');
const { BROWSER_DEFINITION_ID, DEFINITION_ID, installDirectoriesAndBrowsers } =
  await import('./installations.js');
const { runLdapBrowserTool, testBrowser } =
  await import('../../services/peopleDirectory/ldapBrowserRunner.js');
const { MAX_RESPONSE_LENGTH, MAX_VALUE_LENGTH, MAX_VALUES_PER_ATTRIBUTE, parseBrowseFilter } =
  await import('../../services/peopleDirectory/LdapBrowser.js');

const BASE = 'dc=corp,dc=example';

const DIRECTORIES = [
  {
    id: 'corp',
    url: 'ldaps://dc.corp.example:636',
    baseDn: BASE,
    searchBase: `ou=people,${BASE}`,
    preset: 'activeDirectory',
    bind: { mode: 'service', dn: `cn=svc,${BASE}`, passwordRef: 'svc' },
    name: { en: 'Company directory' }
  },
  {
    // Browse-only: nobody may use its people search (V198 switches the search
    // actions off for a directory without groups).
    id: 'infra',
    url: 'ldaps://ldap.infra.example:636',
    baseDn: 'o=infra',
    bind: { mode: 'anonymous' },
    groups: []
  },
  {
    id: 'x500bund',
    url: 'ldaps://x500.bund.de:636',
    baseDn: 'o=Bund,c=DE',
    preset: 'ivbb',
    bind: { mode: 'anonymous' }
  },
  { id: 'off', enabled: false, url: 'ldaps://off.example:636', baseDn: 'o=off' }
];

const BROWSERS = [
  {
    id: 'corp-browser',
    directory: 'corp',
    maxResults: 3,
    denyAttributes: ['info'],
    name: { en: 'Company directory – LDAP browser' }
  },
  { id: 'infra-browser', directory: 'infra' },
  // Its directory is disabled, or not installed at all: no tools.
  { id: 'off-browser', directory: 'off' },
  { id: 'lost-browser', directory: 'gone' }
];

configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
// Which installations each group may use (`permissions.integrations`, #3093):
// admins the company browser, ops the infra browser, browser-team every
// browser through the definition.
configCache.getGroups = () => ({
  data: {
    groups: {
      admins: {
        inherits: ['users'],
        permissions: { adminAccess: true, integrations: ['corp-browser'] }
      },
      users: { inherits: ['authenticated'], permissions: { integrations: ['corp'] } },
      authenticated: { permissions: { integrations: ['infra', 'x500bund'] } },
      ops: { permissions: { integrations: ['infra-browser', 'off-browser', 'lost-browser'] } },
      'browser-team': { permissions: { integrations: [BROWSER_DEFINITION_ID] } }
    }
  }
});
configCache.getA2aAgents = () => ({ data: { agents: [] } });
configCache.getApps = () => ({ data: [], etag: 'apps' });
configCache.getFeatures = () => ({ skills: false, appAsTool: false });

const everything = { tools: new Set(['*']), apps: new Set(['*']) };
const admin = {
  id: 'admin',
  username: 'admin',
  groups: ['admins'],
  permissions: { ...everything, adminAccess: true }
};
const member = { id: 'member', groups: ['users'], permissions: everything };
const operator = { id: 'operator', groups: ['ops'], permissions: everything };
const browserTeam = { id: 'team', groups: ['browser-team'], permissions: everything };

const browseIds = tools =>
  tools
    .filter(tool => tool._ldapBrowser)
    .map(tool => tool.id)
    .sort();

const CORP_BROWSE_IDS = [
  'corp-browser__browse_children',
  'corp-browser__browse_read',
  'corp-browser__browse_search'
];
const INFRA_BROWSE_IDS = [
  'infra-browser__browse_children',
  'infra-browser__browse_read',
  'infra-browser__browse_search'
];

/**
 * A fake ldapts client: `entries(base, options)` answers each search.
 * Records every search; `resultCode` imitates a server-side size limit.
 */
function fakeConnect(entries, { resultCode = 0 } = {}) {
  const searches = [];
  const binds = [];
  const connections = [];
  const connect = async resolved => {
    binds.push(resolved.bind);
    connections.push(resolved);
    const client = {
      lastSearchResultCode: null,
      async search(base, options) {
        searches.push({ base, ...options });
        const result = await entries(base, options);
        client.lastSearchResultCode = resultCode;
        return { searchEntries: result };
      },
      async unbind() {}
    };
    return { client };
  };
  return { connect, searches, binds, connections };
}

function browseTool(browserId, action) {
  return {
    id: `${browserId}__${action}`,
    _ldapBrowser: { id: browserId, action }
  };
}

const run = (action, args, deps, user = admin, browserId = 'corp-browser') =>
  runLdapBrowserTool(browseTool(browserId, action), { ...args, user }, deps);

async function auditEntries() {
  await flushAuditLog();
  const dir = path.join(contentsDir, 'data', 'audit-log');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap(file =>
      fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    )
    .filter(entry => entry.resource === 'ldapBrowse');
}

after(() => fs.rmSync(contentsDir, { recursive: true, force: true }));

describe('LDAP browser', () => {
  beforeEach(() => {
    installDirectoriesAndBrowsers(configCache, DIRECTORIES, BROWSERS);
  });

  describe('schema and resolution', () => {
    it('has a result limit of 50 by default and at most 200, and no unknown fields', () => {
      const parsed = ldapBrowserSchema.parse({ id: 'b', directory: 'corp' });
      assert.equal(parsed.maxResults, 50);
      assert.equal(
        ldapBrowserSchema.safeParse({ id: 'b', directory: 'corp', maxResults: 201 }).success,
        false
      );
      for (const extra of [{ groups: ['admins'] }, { filter: 'x' }]) {
        assert.equal(
          ldapBrowserSchema.safeParse({ id: 'b', directory: 'corp', ...extra }).success,
          false,
          JSON.stringify(extra)
        );
      }
    });

    it('is not part of a directory any more', () => {
      const base = { id: 'corp', url: 'ldaps://a.example', baseDn: 'o=a' };
      assert.equal(peopleDirectorySchema.safeParse({ ...base, browse: {} }).success, false);
    });

    it('refuses a mapping onto the new AD secrets and password histories, like the old ones', () => {
      const base = { id: 'corp', url: 'ldaps://a.example', baseDn: 'o=a' };
      for (const attribute of [
        'ms-Mcs-AdmPwd',
        'msLAPS-Password',
        'msFVE-RecoveryPassword',
        'pwdHistory',
        'sambaPasswordHistory',
        'ipaNTHash'
      ]) {
        assert.equal(
          peopleDirectorySchema.safeParse({ ...base, attributeMapping: { email: attribute } })
            .success,
          false,
          attribute
        );
      }
    });

    it("reuses the directory's connection, base DN and bind unless it has its own", () => {
      const resolved = resolveBrowser(BROWSERS[0]);
      assert.deepEqual(resolved.problems, []);
      assert.equal(resolved.directoryId, 'corp');
      assert.equal(resolved.directoryEnabled, true);
      assert.equal(resolved.directory.url, 'ldaps://dc.corp.example:636');
      assert.equal(resolved.base, BASE);
      assert.deepEqual(resolved.bind, DIRECTORIES[0].bind);
      assert.equal(resolved.ownBind, false);
      assert.equal(resolved.maxResults, 3);
      assert.equal(resolved.transport, 'ldaps');

      const own = { mode: 'service', dn: `cn=reader,${BASE}`, passwordRef: 'reader' };
      const narrowed = resolveBrowser({ ...BROWSERS[0], base: `ou=groups,${BASE}`, bind: own });
      assert.equal(narrowed.base, `ou=groups,${BASE}`);
      assert.deepEqual(narrowed.bind, own);
      assert.equal(narrowed.ownBind, true);
    });

    it('reports a missing or unknown directory, and a disabled one apart from problems', () => {
      assert.match(
        resolveBrowser({ id: 'b', directory: '' }).problems.join(),
        /No people directory/
      );
      assert.match(resolveBrowser(BROWSERS[3]).problems.join(), /no People directory \(LDAP\)/);
      const off = resolveBrowser(BROWSERS[2]);
      assert.deepEqual(off.problems, []);
      assert.equal(off.directoryEnabled, false);
    });

    it('reads the browser from a tool id without loading tools', () => {
      assert.deepEqual(browserToolOfId('corp-browser__browse_read'), {
        id: 'corp-browser',
        directory: 'corp',
        action: 'browse_read'
      });
      assert.equal(browserToolOfId('corp__browse_read'), null);
      assert.equal(browserToolOfId('corp-browser__search_people'), null);
    });
  });

  describe('access', () => {
    it('offers the browse tools of every browser whose directory is enabled and installed', async () => {
      assert.deepEqual(browseIds(await loadTools('en')), [...CORP_BROWSE_IDS, ...INFRA_BROWSE_IDS]);
      const tools = await loadTools('en');
      const search = tools.find(tool => tool.id === 'corp-browser__browse_search');
      assert.equal(search._integration.instanceId, 'corp-browser');
      assert.deepEqual(search._ldapBrowser, {
        id: 'corp-browser',
        directory: 'corp',
        action: 'browse_search'
      });
      assert.equal(search._peopleDirectory, undefined);
      assert.match(
        search.description,
        /^Company directory – LDAP browser – Company directory \(dc=corp,dc=example\)/
      );
      assert.equal(search.parameters.properties.maxResults.maximum, 3);
    });

    it("checks the browser's grant, signed-in and non-delegated users only", () => {
      assert.equal(mayUseBrowser(admin, 'corp-browser'), true);
      assert.equal(mayUseBrowser(member, 'corp-browser'), false);
      assert.equal(mayUseBrowser(operator, 'infra-browser'), true);
      assert.equal(mayUseBrowser(admin, 'infra-browser'), false);
      // The definition grants every browser.
      assert.equal(mayUseBrowser(browserTeam, 'corp-browser'), true);
      assert.equal(mayUseBrowser(browserTeam, 'infra-browser'), true);
      assert.equal(mayUseBrowser({ id: 'anonymous', groups: ['admins'] }, 'corp-browser'), false);
      // Delegated and machine principals never browse, whatever their groups:
      // through an app they would reach it over MCP, A2A or the chat API.
      for (const delegated of [
        { ...admin, authMode: 'oauth_personal_key' },
        { ...admin, authMode: 'oauth_authorization_code' },
        { ...admin, authMode: 'oauth_client_credentials' },
        { ...admin, isOAuthClient: true },
        { ...admin, isAgent: true }
      ]) {
        assert.equal(mayUseBrowser(delegated, 'corp-browser'), false, JSON.stringify(delegated));
      }
      // A disabled or missing directory closes its browser.
      assert.equal(mayUseBrowser(operator, 'off-browser'), false);
      assert.equal(mayUseBrowser(operator, 'lost-browser'), false);
      assert.equal(mayUseBrowser(admin, 'corp'), false);
    });

    it('needs no grant of the directory itself', () => {
      // `ops` is not granted `infra`: the browser's grant alone counts.
      assert.equal(mayUseBrowser(operator, 'infra-browser'), true);
    });

    it('is bound like any installation, never through the directory or a tool reference', async () => {
      for (const tools of [['corp'], ['corp__search_people'], ['ldapBrowse'], ['corp-browser']]) {
        const offered = await getToolsForApp({ id: 'a', tools }, 'en', { user: admin });
        assert.deepEqual(browseIds(offered), [], tools.join());
      }
      // A binding of the directory (or of every directory, or of the type)
      // brings the people search only.
      for (const integrations of [
        { corp: {} },
        { [DEFINITION_ID]: {} },
        { 'type:people-directory': {} }
      ]) {
        const offered = await getToolsForApp({ id: 'a', integrations }, 'en', { user: admin });
        assert.deepEqual(browseIds(offered), [], JSON.stringify(integrations));
      }
      // A browser binding without actions binds all three.
      const one = await getToolsForApp({ id: 'a', integrations: { 'corp-browser': {} } }, 'en', {
        user: admin
      });
      assert.deepEqual(browseIds(one), CORP_BROWSE_IDS);
      const narrowed = await getToolsForApp(
        { id: 'a', integrations: { 'corp-browser': { actions: ['browse_read'] } } },
        'en',
        { user: admin }
      );
      assert.deepEqual(browseIds(narrowed), ['corp-browser__browse_read']);
      // The shipped LDAP browser app: every browser the user may use.
      const app = { id: 'ldap-browser', integrations: { [BROWSER_DEFINITION_ID]: {} } };
      assert.deepEqual(
        browseIds(await getToolsForApp(app, 'en', { user: admin })),
        CORP_BROWSE_IDS
      );
      assert.deepEqual(browseIds(await getToolsForApp(app, 'en', { user: browserTeam })), [
        ...CORP_BROWSE_IDS,
        ...INFRA_BROWSE_IDS
      ]);
      assert.deepEqual(await getToolsForApp(app, 'en', { user: member }), []);
    });

    it('leaves people search of a browse-only directory closed', async () => {
      const tools = await getToolsForApp({ id: 'a', integrations: { [DEFINITION_ID]: {} } }, 'en', {
        user: operator
      });
      assert.ok(!tools.some(tool => tool.id.startsWith('infra__')));
    });

    it('knows the browser tool ids and not the old directory ones', async () => {
      assert.equal(browserToolOfId('corp-browser__browse_search')?.id, 'corp-browser');
      // The old directory tool ids are gone.
      assert.equal(browserToolOfId('corp__browse_search'), null);
    });

    it('is never offered over the MCP gateway', async () => {
      const platform = {
        defaultLanguage: 'en',
        mcpServer: { expose: { tools: true, apps: false, workflows: false, resources: false } }
      };
      const scopes = [MCP_SCOPES.TOOLS_READ, MCP_SCOPES.TOOLS_CALL];
      const server = await buildMcpServer({ user: { ...admin, scopes }, platform });
      const ids = Object.keys(server._registeredTools);
      assert.ok(ids.includes('corp__search_people'));
      assert.ok(!ids.some(id => id.includes('__browse_')));
    });

    it('refuses the call itself and audits the attempt', async () => {
      const fake = fakeConnect(() => []);
      await assert.rejects(
        run('browse_search', { filter: '(cn=*)' }, fake, member),
        /not available/
      );
      assert.equal(fake.searches.length, 0);
      const refused = (await auditEntries()).filter(entry => entry.actor.id === 'member');
      assert.equal(refused.length, 1);
      assert.equal(refused[0].result, 'failure');
      assert.equal(refused[0].resourceId, 'corp-browser');
      assert.match(refused[0].summary, /access_denied/);
    });
  });

  describe('test', () => {
    it("binds with the browser's account over the directory's connection and lists the base", async () => {
      const fake = fakeConnect(() => [
        { dn: `ou=people,${BASE}`, objectClass: ['organizationalUnit'] }
      ]);
      const own = { mode: 'service', dn: `cn=reader,${BASE}`, passwordRef: 'reader' };
      const result = await testBrowser({ ...BROWSERS[0], bind: own }, { deps: fake });
      assert.equal(result.success, true, JSON.stringify(result.steps));
      assert.equal(fake.connections[0].url, 'ldaps://dc.corp.example:636');
      assert.deepEqual(fake.binds[0], own);
      assert.equal(fake.searches[0].base, BASE);
      assert.equal(fake.searches[0].scope, 'one');
      const base = result.steps.find(step => step.id === 'base');
      assert.match(base.message, /^1 entry directly under dc=corp,dc=example/);
    });

    it('fails on the configuration without connecting', async () => {
      const fake = fakeConnect(() => []);
      const result = await testBrowser(BROWSERS[3], { deps: fake });
      assert.equal(result.success, false);
      assert.equal(fake.connections.length, 0);
      assert.equal(result.steps[0].status, 'fail');
    });

    it('warns that a disabled directory offers no tools', async () => {
      const result = await testBrowser(BROWSERS[2], { deps: fakeConnect(() => []) });
      assert.equal(result.steps[0].status, 'warn');
      assert.match(result.steps[0].hints.join(' '), /disabled/);
    });
  });

  describe('filters', () => {
    const deny = new Set(['info']);

    it('parses a filter and refuses one that mentions a denied attribute anywhere', () => {
      assert.ok(parseBrowseFilter('(&(objectClass=group)(cn=*admin*))', deny));
      for (const filter of [
        '(userPassword=a*)',
        '(&(objectClass=person)(userPassword=a*))',
        '(!(unicodePwd=*))',
        '(|(cn=x)(!(ms-Mcs-AdmPwd=1*)))',
        '(info=secret*)',
        '(USERPASSWORD>=a)',
        '(pwdHistory=*)',
        '(userPassword:caseExactMatch:=a)'
      ]) {
        assert.throws(() => parseBrowseFilter(filter, deny), /never leaves the directory/, filter);
      }
    });

    it('refuses unparseable filters, typeless extensible matches and overlong filters', () => {
      for (const filter of ['', '(cn=a', '(cn=a)(cn=b)', '(:caseExactMatch:=secret)']) {
        assert.throws(() => parseBrowseFilter(filter, deny), { code: 'invalid_arguments' }, filter);
      }
      assert.throws(() => parseBrowseFilter(`(cn=${'a'.repeat(1000)})`), /longer than/);
    });
  });

  describe('operations', () => {
    const person = {
      dn: `cn=Erika,ou=people,${BASE}`,
      cn: 'Erika',
      objectClass: ['top', 'person'],
      userPassword: '{SSHA}secret',
      'unicodePwd;binary': 'x',
      info: 'site secret',
      description: 'd'.repeat(MAX_VALUE_LENGTH + 20),
      thumbnail: Buffer.from([1, 2, 3]),
      logonHours: '\u0000\u0001�'
    };

    it('returns raw entries without denied attributes, and names them', async () => {
      const fake = fakeConnect(() => [person]);
      const result = await run('browse_search', { filter: '(cn=Erika)' }, fake);
      assert.equal(fake.searches[0].base, BASE);
      assert.equal(fake.searches[0].scope, 'sub');
      assert.deepEqual(fake.searches[0].attributes, ['*']);
      // The parsed filter is sent, never the model's text.
      assert.equal(typeof fake.searches[0].filter, 'object');
      const [entry] = result.entries;
      assert.equal(entry.dn, person.dn);
      assert.deepEqual(entry.attributes.cn, ['Erika']);
      assert.deepEqual(entry.attributes.objectClass, ['top', 'person']);
      assert.deepEqual(entry.omitted.sort(), ['info', 'unicodePwd;binary', 'userPassword']);
      assert.equal(entry.attributes.userPassword, undefined);
      assert.deepEqual(entry.attributes.thumbnail, ['[binary, 3 bytes]']);
      assert.match(entry.attributes.logonHours[0], /^\[binary, \d+ bytes\]$/);
      assert.match(entry.attributes.description[0], /… \(520 characters\)$/);
      assert.equal(result.truncated, false);
      // The directory's own bind, unless the browser has its own.
      assert.deepEqual(fake.binds[0], DIRECTORIES[0].bind);
      assert.equal(result.directory, 'corp');
    });

    it("uses the browser's own account when one is set", async () => {
      const own = { mode: 'service', dn: `cn=reader,${BASE}`, passwordRef: 'reader' };
      installDirectoriesAndBrowsers(configCache, DIRECTORIES, [{ ...BROWSERS[0], bind: own }]);
      const fake = fakeConnect(() => []);
      await run('browse_read', { dn: `cn=Erika,ou=people,${BASE}` }, fake);
      assert.deepEqual(fake.binds[0], own);
      assert.equal(fake.connections[0].url, 'ldaps://dc.corp.example:636');
    });

    it('refuses requested attributes on the deny list and DNs outside the browse base', async () => {
      const fake = fakeConnect(() => []);
      const denied = await run(
        'browse_search',
        { filter: '(cn=*)', attributes: ['cn', 'msLAPS-Password'] },
        fake
      );
      assert.equal(denied.error.code, 'invalid_arguments');
      for (const [action, args] of [
        ['browse_search', { filter: '(cn=*)', base: 'dc=other,dc=example' }],
        ['browse_search', { filter: '(cn=*)', base: 'dc=example' }],
        ['browse_read', { dn: 'cn=x,dc=evilcorp,dc=example' }],
        ['browse_children', { dn: 'not a dn' }]
      ]) {
        const result = await run(action, args, fake);
        assert.equal(result.error?.code, 'invalid_arguments', JSON.stringify(args));
      }
      assert.equal(fake.searches.length, 0);
      const ok = await run('browse_search', { filter: '(cn=*)', base: `ou=people,${BASE}` }, fake);
      assert.deepEqual(ok.entries, []);
    });

    it('drops entries the server returns from outside the browse base', async () => {
      const fake = fakeConnect(() => [person, { dn: 'cn=x,o=elsewhere', cn: 'x' }]);
      const result = await run('browse_search', { filter: '(cn=*)' }, fake);
      assert.deepEqual(
        result.entries.map(entry => entry.dn),
        [person.dn]
      );
    });

    it('reports truncation by the result limit, the server limit and the response size', async () => {
      const many = Array.from({ length: 5 }, (_, i) => ({
        dn: `cn=p${i},ou=people,${BASE}`,
        cn: `p${i}`
      }));
      const byLimit = await run(
        'browse_search',
        { filter: '(cn=*)' },
        fakeConnect(() => many)
      );
      assert.equal(byLimit.entries.length, 3);
      assert.equal(byLimit.truncated, true);
      assert.match(byLimit.hint, /Narrow the filter/);

      const byServer = await run(
        'browse_search',
        { filter: '(cn=*)' },
        fakeConnect(() => many.slice(0, 2), { resultCode: 4 })
      );
      assert.equal(byServer.entries.length, 2);
      assert.equal(byServer.truncated, true);

      const thrown = await run(
        'browse_search',
        { filter: '(cn=*)' },
        fakeConnect(() => {
          throw new SizeLimitExceededError();
        })
      );
      assert.equal(thrown.truncated, true);

      const big = Array.from({ length: 3 }, (_, i) => ({
        dn: `cn=b${i},ou=people,${BASE}`,
        description: Array.from({ length: 40 }, () => 'x'.repeat(400))
      }));
      const bySize = await run(
        'browse_search',
        { filter: '(cn=*)' },
        fakeConnect(() => big)
      );
      assert.ok(bySize.entries.length < 3);
      assert.equal(bySize.truncated, true);
    });

    it('keeps one entry within the response limit, however many values an attribute has', async () => {
      const group = {
        dn: `cn=All,ou=groups,${BASE}`,
        cn: 'All',
        member: Array.from({ length: 5000 }, (_, i) => `cn=user${i},ou=people,${BASE}`)
      };
      const read = await run(
        'browse_read',
        { dn: group.dn },
        fakeConnect(() => [group])
      );
      assert.equal(read.truncated, true);
      assert.deepEqual(read.entry.cut, ['member']);
      assert.equal(read.entry.attributes.member.length, MAX_VALUES_PER_ATTRIBUTE + 1);
      assert.match(read.entry.attributes.member.at(-1), /^… \(4900 more values\)$/);
      assert.match(read.hint, /memberOf=/);
      assert.ok(JSON.stringify(read).length < MAX_RESPONSE_LENGTH + 2000);

      // Long values exhaust the entry's budget before the value count does.
      const wide = {
        dn: group.dn,
        member: Array.from({ length: 100 }, () => 'x'.repeat(MAX_VALUE_LENGTH))
      };
      const search = await run(
        'browse_search',
        { filter: '(cn=All)' },
        fakeConnect(() => [wide])
      );
      const [entry] = search.entries;
      assert.ok(entry.attributes.member.length < 100);
      assert.ok(JSON.stringify(entry).length <= MAX_RESPONSE_LENGTH + 200);
      assert.equal(search.truncated, true);
    });

    it('bounds the arguments written to the audit record', async () => {
      const longFilter = `(cn=${'a'.repeat(5000)})`;
      await run(
        'browse_search',
        { filter: longFilter, attributes: Array.from({ length: 500 }, (_, i) => `a${i}`) },
        fakeConnect(() => [])
      );
      const record = (await auditEntries()).find(entry => entry.summary.includes('(cn=aaaa'));
      const summary = JSON.parse(record.summary);
      assert.equal(summary.filter.length, 1000);
      assert.equal(summary.attributes.length, 50);
      assert.equal(record.result, 'failure');
    });

    it('reads one entry and lists children without attributes', async () => {
      const read = await run(
        'browse_read',
        { dn: person.dn, attributes: ['cn', 'memberOf'] },
        fakeConnect(() => [person])
      );
      assert.equal(read.entry.dn, person.dn);

      const notFound = await run(
        'browse_read',
        { dn: person.dn },
        fakeConnect(() => [])
      );
      assert.equal(notFound.error.code, 'not_found');

      const fake = fakeConnect(() => [
        { dn: `ou=people,${BASE}`, objectClass: ['top', 'organizationalUnit'] },
        { dn: `cn=Groups,${BASE}`, objectClass: 'container' }
      ]);
      const children = await run('browse_children', {}, fake);
      assert.equal(fake.searches[0].base, BASE);
      assert.equal(fake.searches[0].scope, 'one');
      assert.deepEqual(fake.searches[0].attributes, ['objectClass']);
      assert.deepEqual(children.children, [
        { dn: `ou=people,${BASE}`, rdn: 'ou=people', objectClass: ['top', 'organizationalUnit'] },
        { dn: `cn=Groups,${BASE}`, rdn: 'cn=Groups', objectClass: ['container'] }
      ]);
    });

    it('audits each call with the filter, never the values', async () => {
      await run(
        'browse_search',
        { filter: '(cn=Erika)' },
        fakeConnect(() => [person])
      );
      await run(
        'browse_search',
        { filter: '(userPassword=a*)' },
        fakeConnect(() => [])
      );
      const entries = (await auditEntries()).filter(entry => entry.actor.id === 'admin');
      const ok = entries.find(entry => entry.summary.includes('(cn=Erika)'));
      assert.equal(ok.action, 'read');
      assert.equal(ok.resourceId, 'corp-browser');
      assert.equal(ok.result, 'success');
      assert.deepEqual(JSON.parse(ok.summary), {
        tool: 'browse_search',
        directory: 'corp',
        filter: '(cn=Erika)',
        entries: 1,
        truncated: false
      });
      assert.ok(!ok.summary.includes('secret'));
      const refused = entries.find(entry => entry.summary.includes('userPassword'));
      assert.equal(refused.result, 'failure');
    });
  });

  it('leaves people search of the same directory as it was', async () => {
    const tools = await loadTools('en');
    const ids = tools.filter(tool => tool.id.startsWith('corp__')).map(tool => tool.id);
    assert.deepEqual(ids.sort(), ['corp__get_person', 'corp__search_people']);
  });
});
