// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The generators of tool definitions set what a tool is (`activity`), and an
 * admin can correct it in an installation's `actions.overrides`: no consumer
 * reads it from the tool id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolFromAction } from '../services/integrations/integrationTools.js';
import { categoryOf } from '../services/tools/toolCategory.js';
import { actionOverrideSchema } from '../validators/integrationsConfigSchema.js';
import { integrationActionSchema } from '../validators/integrationDefinitionSchema.js';
import { readShippedToolDefinitions } from '../services/tools/shippedToolDefinitions.js';
import { platformToolDefinitions } from '../services/tools/platformTools.js';
import { toolDisplayOf } from '../utils/toolDisplay.js';
import ifinderConnector from '../services/integrations/protocols/native/connectors/ifinder/index.js';
import entraConnector from '../services/integrations/protocols/native/connectors/entra/index.js';
import ldapDirectoryConnector from '../services/integrations/protocols/native/connectors/ldapDirectory/index.js';
import ldapBrowserConnector from '../services/integrations/protocols/native/connectors/ldapBrowser/index.js';

const action = (name, extra = {}) => ({
  name,
  toolId: `inst__${name}`,
  title: name,
  description: name,
  parameters: { type: 'object', properties: {} },
  sideEffect: 'read',
  dataFlow: 'external',
  ...extra
});

const resolved = (definitionId, overrides = {}) => ({
  instance: { id: 'inst', definition: definitionId, actions: { overrides } },
  definition: { id: definitionId },
  label: 'Inst'
});

test('the search action of a built-in web search engine is declared a web search', () => {
  const tool = toolFromAction(resolved('com.intrafind/brave-search'), action('search'), 'en');
  assert.deepEqual(tool.activity, { kind: 'search', origin: 'web' });
  assert.deepEqual(categoryOf(tool), { kind: 'search', origin: 'web' });
  // Another action of the same definition declares nothing: a plain call of a connected system.
  const other = toolFromAction(resolved('com.intrafind/brave-search'), action('other'), 'en');
  assert.equal(other.activity, undefined);
  assert.deepEqual(categoryOf(other), { kind: 'tool', origin: 'integration' });
});

test('an action of any other definition is a plain call, whatever its name says', () => {
  for (const name of ['search', 'jira_searchIssues', 'search_people']) {
    const tool = toolFromAction(resolved('org.example/crm'), action(name), 'en');
    assert.deepEqual(categoryOf(tool), { kind: 'tool', origin: 'integration' }, name);
  }
});

test('the action’s own declaration is carried; the admin’s override wins over it', () => {
  const declared = action('search_people', { activity: { kind: 'search', origin: 'integration' } });
  assert.deepEqual(
    categoryOf(toolFromAction(resolved('com.intrafind/ldap-directory'), declared, 'en')),
    { kind: 'search', origin: 'integration' }
  );
  const corrected = toolFromAction(
    resolved('com.intrafind/ldap-directory', {
      search_people: { activity: { kind: 'tool' } }
    }),
    declared,
    'en'
  );
  assert.deepEqual(categoryOf(corrected), { kind: 'tool', origin: 'integration' });
  // An admin turns a mislabelled action into what it is.
  const docs = toolFromAction(
    resolved('org.example/wiki', {
      find: { activity: { kind: 'search', origin: 'documents' } }
    }),
    action('find'),
    'en'
  );
  assert.deepEqual(categoryOf(docs), { kind: 'search', origin: 'documents' });
});

test('the admin override and a definition action validate `activity`', () => {
  assert.ok(
    actionOverrideSchema.safeParse({ activity: { kind: 'search', origin: 'web' } }).success
  );
  assert.equal(
    actionOverrideSchema.parse({ activity: { kind: 'tool' } }).activity.kind,
    'tool',
    'it is kept, not stripped'
  );
  assert.ok(
    !actionOverrideSchema.safeParse({ activity: { kind: 'search', origin: 'tickets' } }).success
  );
  assert.ok(!actionOverrideSchema.safeParse({ activity: { kind: 'lookup' } }).success);
  assert.ok(
    integrationActionSchema.safeParse({
      name: 'find',
      activity: { kind: 'fetch', origin: 'documents' }
    }).success
  );
  assert.ok(!integrationActionSchema.safeParse({ name: 'find', activity: { kind: 'x' } }).success);
});

test('the built-in connectors declare their actions; a directory search is a search of the connected system', () => {
  assert.deepEqual(ifinderConnector.activity.search, { kind: 'search', origin: 'ifinder' });
  assert.deepEqual(ifinderConnector.activity.getContent, { kind: 'fetch', origin: 'ifinder' });
  assert.deepEqual(ifinderConnector.activity.listProfiles, { kind: 'tool', origin: 'ifinder' });
  for (const name of Object.keys(ifinderConnector.actions)) {
    assert.equal(ifinderConnector.activity[name]?.origin, 'ifinder', `iFinder ${name}`);
  }
  const lookup = { kind: 'search', origin: 'integration' };
  assert.deepEqual(entraConnector.activity.findUser, lookup);
  assert.deepEqual(ldapDirectoryConnector.activity.search_people, lookup);
  assert.deepEqual(ldapBrowserConnector.activity.browse_search, lookup);
  // Looking up one person, or a manager, is a plain call.
  assert.equal(entraConnector.activity.getUserManager, undefined);
  assert.equal(ldapDirectoryConnector.activity.get_person, undefined);
});

test('the shipped project knowledge tools and the page reader declare what they are', () => {
  const knowledge = readShippedToolDefinitions(['knowledge']);
  assert.deepEqual(categoryOf(knowledge.get('knowledge_search')), {
    kind: 'search',
    origin: 'project'
  });
  assert.deepEqual(categoryOf(knowledge.get('knowledge_read')), {
    kind: 'fetch',
    origin: 'project'
  });
  assert.deepEqual(categoryOf(knowledge.get('knowledge_list')), {
    kind: 'search',
    origin: 'project'
  });
  const reader = platformToolDefinitions().find(tool => tool.id === 'read_url');
  assert.deepEqual(categoryOf(reader), { kind: 'fetch', origin: 'web' });
  // Every other platform tool is a plain call without an origin.
  for (const tool of platformToolDefinitions().filter(tool => tool.id !== 'read_url')) {
    assert.deepEqual(categoryOf(tool), { kind: 'tool' }, tool.id);
  }
});

test('people, ticket and MCP tools called "search" are never shown as a web search', () => {
  const tools = [
    // A people directory declares itself a search of the connected system.
    {
      id: 'entraPeopleSearch_findUser',
      activity: { kind: 'search', origin: 'integration' },
      _integration: { definition: 'com.intrafind/entra-directory' }
    },
    {
      id: 'muc-ad__search_people',
      activity: { kind: 'search', origin: 'integration' },
      _integration: { definition: 'com.intrafind/ldap-directory' }
    },
    { id: 'jira_searchIssues', _integration: { definition: 'com.intrafind/jira' } },
    { id: 'foo_search', _mcp: { serverId: 'foo' } }
  ];
  for (const tool of tools) {
    const display = toolDisplayOf(tool);
    assert.equal(display.activityOrigin, 'integration', tool.id);
    assert.notEqual(display.activityOrigin, 'web', tool.id);
  }
  assert.deepEqual(
    tools.map(tool => toolDisplayOf(tool).activityKind),
    ['search', 'search', 'tool', 'tool']
  );
});

test('only the shipped web search engines say their hits are public', () => {
  const engine = id =>
    toolFromAction(resolved(`com.intrafind/${id}-search`), action('search'), 'en');
  for (const id of ['brave', 'staan']) {
    assert.equal(toolDisplayOf(engine(id)).publicHits, true, id);
  }
  // A third-party engine, a tool named like one and the page reader are not public.
  const thirdParty = {
    ...engine('brave'),
    _integration: { definition: 'org.acme/search', action: 'search' }
  };
  assert.equal(toolDisplayOf(thirdParty).publicHits, undefined);
  assert.equal(
    toolDisplayOf({ id: 'braveSearch', activity: { kind: 'search', origin: 'web' } }).publicHits,
    undefined
  );
  assert.equal(
    toolDisplayOf({ id: 'read_url', activity: { kind: 'fetch', origin: 'web' } }).publicHits,
    undefined
  );
});

test('the admin override endpoint sets and removes `activity`', async () => {
  const { InstalledIntegrationService } =
    await import('../services/integrations/InstalledIntegrationService.js');
  const config = { installed: [{ id: 'tavily', definition: 'mcp/tavily', actions: {} }] };
  const service = new InstalledIntegrationService({
    registry: { list: () => [], get: () => null }
  });
  service._updateConfig = async mutate => mutate(config);
  service._afterChange = async () => {};

  const set = await service.setActionOverride('tavily', 'tavily_search', {
    activity: { kind: 'search', origin: 'web' }
  });
  assert.deepEqual(set.override, { activity: { kind: 'search', origin: 'web' } });
  assert.deepEqual(config.installed[0].actions.overrides.tavily_search.activity, {
    kind: 'search',
    origin: 'web'
  });
  // An invalid declaration is refused, and null removes the override.
  await assert.rejects(
    service.setActionOverride('tavily', 'tavily_search', { activity: { kind: 'lookup' } }),
    error => error.code === 'INVALID_OVERRIDE'
  );
  const cleared = await service.setActionOverride('tavily', 'tavily_search', { activity: null });
  assert.equal(cleared.override, null);
});
