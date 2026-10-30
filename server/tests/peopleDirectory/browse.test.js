// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin LDAP browser of a people directory (`browse`, concept
 * "People Directory Organization Search and LDAP Browser", part 2).
 *
 * Who sees and runs the browse tools (`browse.groups`, never the directory's
 * `groups`, never through `peopleDirectories` or the directory id, never over
 * MCP), the deny list in results and in filters, the DN scope, the limits, and
 * the audit record. The LDAP client is a fake passed as the `connect`
 * dependency.
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
const { getToolsForApp, loadTools } = await import('../../toolLoader.js');
const { mayRunTool } = await import('../../routes/toolRoutes.js');
const { buildMcpServer } = await import('../../services/mcp/McpServerService.js');
const { MCP_SCOPES } = await import('../../services/mcp/scopes.js');
const { flushAuditLog } = await import('../../services/AuditLogService.js');
const { peopleDirectorySchema } = await import('../../validators/peopleDirectorySchema.js');
const { discoverPeopleDirectoryTools, mayBrowseDirectory, resolveDirectory } =
  await import('../../services/peopleDirectory/PeopleDirectoryService.js');
const { runPeopleDirectoryTool } =
  await import('../../services/peopleDirectory/peopleDirectoryRunner.js');
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
    name: { en: 'Company directory' },
    groups: ['users'],
    browse: { enabled: true, maxResults: 3, denyAttributes: ['info'] }
  },
  {
    // Browse-only: nobody may use its people search.
    id: 'infra',
    url: 'ldaps://ldap.infra.example:636',
    baseDn: 'o=infra',
    bind: { mode: 'anonymous' },
    groups: [],
    browse: { enabled: true, groups: ['ops'] }
  },
  {
    id: 'x500bund',
    url: 'ldaps://x500.bund.de:636',
    baseDn: 'o=Bund,c=DE',
    preset: 'ivbb',
    bind: { mode: 'anonymous' },
    groups: ['authenticated']
  }
];

const state = { directories: DIRECTORIES };
configCache.getPeopleDirectories = () => ({
  data: { directories: state.directories },
  etag: 'dirs'
});
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getGroups = () => ({
  data: {
    groups: {
      admins: { inherits: ['users'], permissions: { adminAccess: true } },
      users: { inherits: ['authenticated'] },
      authenticated: {},
      ops: {}
    }
  }
});
configCache.getTools = () => ({ data: [], etag: 'tools' });
configCache.getMcpServers = () => ({ data: { servers: [] } });
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

const browseIds = tools =>
  tools
    .filter(tool => tool._peopleDirectory?.browse)
    .map(tool => tool.id)
    .sort();

/**
 * A fake ldapts client: `entries(base, options)` answers each search.
 * Records every search; `resultCode` imitates a server-side size limit.
 */
function fakeConnect(entries, { resultCode = 0 } = {}) {
  const searches = [];
  const binds = [];
  const connect = async resolved => {
    binds.push(resolved.bind);
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
  return { connect, searches, binds };
}

function browseTool(directoryId, action) {
  return {
    id: `${directoryId}__${action}`,
    _peopleDirectory: { id: directoryId, action, browse: true }
  };
}

const run = (action, args, deps, user = admin, directoryId = 'corp') =>
  runPeopleDirectoryTool(browseTool(directoryId, action), { ...args, user }, deps);

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
    state.directories = DIRECTORIES;
  });

  describe('schema', () => {
    const base = { id: 'corp', url: 'ldaps://a.example', baseDn: 'o=a' };

    it('is off unless switched on, for admins by default, never for "*"', () => {
      const parsed = peopleDirectorySchema.parse({ ...base, browse: {} });
      assert.equal(parsed.browse.enabled, false);
      assert.deepEqual(parsed.browse.groups, ['admins']);
      assert.equal(parsed.browse.maxResults, 50);
      assert.equal(
        peopleDirectorySchema.safeParse({ ...base, browse: { enabled: true, groups: ['*'] } })
          .success,
        false
      );
      assert.equal(
        peopleDirectorySchema.safeParse({ ...base, browse: { enabled: true, filter: 'x' } })
          .success,
        false
      );
    });

    it('refuses a mapping onto the new AD secrets and password histories, like the old ones', () => {
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

    it('defaults the base to the base DN and the bind to the directory bind', () => {
      const resolved = resolveDirectory(DIRECTORIES[0]);
      assert.equal(resolved.browse.base, BASE);
      assert.deepEqual(resolved.browse.bind, DIRECTORIES[0].bind);
      assert.deepEqual(resolved.browse.problems, []);
      assert.equal(resolveDirectory(DIRECTORIES[2]).browse, null);
    });
  });

  describe('access', () => {
    it('offers the browse tools only where browse is on', () => {
      assert.deepEqual(browseIds(discoverPeopleDirectoryTools()), [
        'corp__browse_children',
        'corp__browse_read',
        'corp__browse_search',
        'infra__browse_children',
        'infra__browse_read',
        'infra__browse_search'
      ]);
    });

    it('checks browse.groups, never the directory groups', () => {
      assert.equal(mayBrowseDirectory(admin, 'corp'), true);
      assert.equal(mayBrowseDirectory(member, 'corp'), false);
      assert.equal(mayBrowseDirectory(operator, 'infra'), true);
      assert.equal(mayBrowseDirectory(admin, 'infra'), false);
      assert.equal(mayBrowseDirectory({ id: 'anonymous', groups: ['admins'] }, 'corp'), false);
      // Delegated and machine principals never browse, whatever their groups:
      // through an app they would reach it over MCP, A2A or the chat API.
      for (const delegated of [
        { ...admin, authMode: 'oauth_personal_key' },
        { ...admin, authMode: 'oauth_authorization_code' },
        { ...admin, authMode: 'oauth_client_credentials' },
        { ...admin, isOAuthClient: true },
        { ...admin, isAgent: true }
      ]) {
        assert.equal(mayBrowseDirectory(delegated, 'corp'), false, JSON.stringify(delegated));
      }
      assert.equal(mayBrowseDirectory(admin, 'x500bund'), false);
    });

    it('narrows the /api/tools listing, even with a "*" tool grant', async () => {
      const platform = { defaultLanguage: 'en' };
      const forAdmin = await configCache.getToolsForUser(admin, platform, 'en');
      assert.deepEqual(browseIds(forAdmin.data), [
        'corp__browse_children',
        'corp__browse_read',
        'corp__browse_search'
      ]);
      const forMember = await configCache.getToolsForUser(member, platform, 'en');
      assert.deepEqual(browseIds(forMember.data), []);
      assert.ok(forMember.data.some(tool => tool.id === 'corp__search_people'));
    });

    it('is selected only by "ldapBrowse", not by the directory id or "peopleDirectories"', async () => {
      for (const tools of [['peopleDirectories'], ['corp'], ['corp__search_people']]) {
        const offered = await getToolsForApp({ id: 'a', tools }, 'en', { user: admin });
        assert.deepEqual(browseIds(offered), [], tools.join());
      }
      const browser = await getToolsForApp({ id: 'ldap-browser', tools: ['ldapBrowse'] }, 'en', {
        user: admin
      });
      assert.deepEqual(browser.map(tool => tool.id).sort(), [
        'corp__browse_children',
        'corp__browse_read',
        'corp__browse_search'
      ]);
      const forMember = await getToolsForApp({ id: 'ldap-browser', tools: ['ldapBrowse'] }, 'en', {
        user: member
      });
      assert.deepEqual(forMember, []);
    });

    it('leaves people search of a browse-only directory closed', async () => {
      const tools = await getToolsForApp({ id: 'a', tools: ['peopleDirectories'] }, 'en', {
        user: operator
      });
      assert.ok(!tools.some(tool => tool.id.startsWith('infra__')));
    });

    it('refuses a direct run to admins outside browse.groups', async () => {
      const platform = { defaultLanguage: 'en' };
      assert.equal(await mayRunTool(admin, platform, 'corp__browse_search'), true);
      assert.equal(await mayRunTool(member, platform, 'corp__browse_search'), false);
      assert.equal(await mayRunTool(admin, platform, 'infra__browse_read'), false);
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
      assert.match(refused[0].summary, /access_denied/);
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
      // The directory's own bind, unless browse.bind is set.
      assert.deepEqual(fake.binds[0], DIRECTORIES[0].bind);
    });

    it('uses browse.bind when one is set', async () => {
      const own = { mode: 'service', dn: `cn=reader,${BASE}`, passwordRef: 'reader' };
      state.directories = [{ ...DIRECTORIES[0], browse: { ...DIRECTORIES[0].browse, bind: own } }];
      const fake = fakeConnect(() => []);
      await run('browse_read', { dn: `cn=Erika,ou=people,${BASE}` }, fake);
      assert.deepEqual(fake.binds[0], own);
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
      assert.equal(ok.resourceId, 'corp');
      assert.equal(ok.result, 'success');
      assert.deepEqual(JSON.parse(ok.summary), {
        tool: 'browse_search',
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
    assert.deepEqual(ids.filter(id => !id.includes('browse')).sort(), [
      'corp__get_person',
      'corp__search_people'
    ]);
  });
});
