// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The inbound MCP gateway exposes the integrations (#3275): the actions of the
 * enabled installations the caller's groups grant, and nothing else — no
 * outbound MCP server, remote A2A agent or LDAP browser, no platform tool,
 * and nothing for a caller whose groups grant no installation.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import { buildMcpServer, isToolAllowed } from '../services/mcp/McpServerService.js';
import { MCP_SCOPES } from '../services/mcp/scopes.js';
import {
  OPEN_GROUPS,
  engine,
  grantResearchOnly,
  setUpWebSearch,
  tearDownWebSearch,
  useWebSearch
} from './helpers/webSearchEngines.js';

const platform = {
  defaultLanguage: 'en',
  mcpServer: { expose: { tools: true, apps: false, workflows: false, resources: false } }
};
const scopes = [MCP_SCOPES.TOOLS_READ, MCP_SCOPES.TOOLS_CALL];

const user = (integrations, groups = ['research']) => ({
  id: 'u',
  groups,
  scopes,
  permissions: { apps: new Set(['*']), integrations: new Set(integrations) }
});

const registered = async (caller, expose) =>
  Object.keys(
    (
      await buildMcpServer({
        user: caller,
        platform: expose ? { ...platform, mcpServer: { expose } } : platform
      })
    )._registeredTools
  ).sort();

before(async () => {
  await setUpWebSearch();
  configCache.setCacheEntry('config/platform.json', platform);
});

after(() => tearDownWebSearch());

describe('MCP gateway tools', () => {
  it('lists the actions of the installations the groups grant, under their chat tool ids', async () => {
    useWebSearch({ installed: [engine('brave'), engine('qwant')], groups: OPEN_GROUPS });
    assert.deepEqual(await registered(user(['*'])), ['braveSearch', 'qwantSearch']);
    assert.deepEqual(await registered(user(['brave'])), ['braveSearch']);
  });

  it('lists nothing without a grant, for a disabled installation, or with the tools switched off', async () => {
    useWebSearch({
      installed: [engine('brave'), engine('qwant', { enabled: false })],
      groups: grantResearchOnly('brave')
    });
    assert.deepEqual(await registered(user([])), []);
    assert.deepEqual(await registered(user(['qwant'])), []);
    assert.deepEqual(await registered(user(['brave']), { tools: false }), []);
  });

  it('offers the platform tools of workflows and agents to nobody', async () => {
    useWebSearch({ installed: [engine('brave')], groups: OPEN_GROUPS });
    const tools = await registered(user(['*']));
    for (const id of ['write_artifact', 'read_memory', 'evidence_collect', 'read_url']) {
      assert.equal(tools.includes(id), false, id);
    }
  });
});

describe('machine clients (client credentials, static key)', () => {
  const client = apps => ({
    id: 'client',
    isOAuthClient: true,
    scopes,
    allowedApps: apps,
    permissions: { apps: new Set(apps), integrations: new Set(['*']) }
  });

  it('reach an integration only through the binding of an app they may use', async () => {
    useWebSearch({ installed: [engine('brave')], groups: OPEN_GROUPS });
    configCache.setCacheEntry('config/apps.json', [
      { id: 'searching', enabled: true, integrations: { brave: {} } },
      { id: 'plain', enabled: true }
    ]);
    assert.deepEqual(await registered(client(['searching'])), ['braveSearch']);
    assert.deepEqual(await registered(client(['plain'])), []);
    assert.deepEqual(await registered(client([])), []);
  });
});

describe('user-delegated tokens (authorization code, personal API key)', () => {
  const delegated = (clientAllowedApps, apps) => ({
    ...user(['*']),
    isPersonalApiKey: true,
    clientAllowedApps,
    permissions: { apps: new Set(apps), integrations: new Set(['*']) }
  });

  it("are bounded by the client's allowedApps when it names some", async () => {
    useWebSearch({ installed: [engine('brave')], groups: OPEN_GROUPS });
    configCache.setCacheEntry('config/apps.json', [
      { id: 'searching', enabled: true, integrations: { brave: {} } },
      { id: 'plain', enabled: true }
    ]);
    // The user may use both apps; the client names only the plain one.
    assert.deepEqual(await registered(delegated(['plain'], ['plain'])), []);
    assert.deepEqual(await registered(delegated(['searching'], ['searching'])), ['braveSearch']);
  });

  it('keep every granted integration when the client names no apps', async () => {
    useWebSearch({ installed: [engine('brave')], groups: OPEN_GROUPS });
    configCache.setCacheEntry('config/apps.json', [{ id: 'plain', enabled: true }]);
    assert.deepEqual(await registered(delegated([], ['plain'])), ['braveSearch']);
    assert.deepEqual(await registered(delegated(['*'], ['plain'])), ['braveSearch']);
  });
});

describe('isToolAllowed', () => {
  const expose = { tools: true };
  const integration = { _integration: { instanceId: 'x', action: 'a' } };

  it('allows an integration action and nothing that is not one', () => {
    assert.equal(isToolAllowed({ id: 'a', ...integration }, expose), true);
    assert.equal(isToolAllowed({ id: 'write_artifact' }, expose), false);
    assert.equal(isToolAllowed({ id: 'a', ...integration }, { tools: false }), false);
  });

  it('never re-exposes an outbound MCP server, a remote A2A agent or the LDAP browser', () => {
    assert.equal(
      isToolAllowed({ id: 'a', ...integration, _mcp: { serverId: 'x' } }, expose),
      false
    );
    assert.equal(isToolAllowed({ id: 'a', ...integration, _a2a: { agentId: 'x' } }, expose), false);
    assert.equal(isToolAllowed({ id: 'a', ...integration, _ldapBrowser: {} }, expose), false);
    const ihub = {
      _integration: { instanceId: 'ihub', action: 'ask_user', definition: 'com.intrafind/ihub' }
    };
    assert.equal(isToolAllowed({ id: 'ask_user', ...ihub }, expose), false);
  });
});
