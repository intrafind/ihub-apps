#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool search (#2889) on the tools a real app is offered: the installed
 * integrations an app binds become tools (`getToolsForApp`), and
 * `prepareToolSearch` decides which of them are sent in full.
 *
 * Pins what is app and installation business: the app's own switch and
 * budget, the binding that keeps an integration loaded (by installation id or
 * by definition id), the web search engine that is never left out, and that
 * an app without tool search is offered exactly what it was before.
 *
 * Run: node --test server/tests/tool-search-app.test.js
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import a2aClientManager from '../services/a2a/A2aClientManager.js';
import { getToolsForApp } from '../services/tools/appTools.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { alwaysLoadedInstanceIds } from '../services/integrations/integrationTools.js';
import { appConfigSchema } from '../validators/appConfigSchema.js';
import { isDeferrable, prepareToolSearch } from '../services/tools/toolSearch.js';
import {
  FIXTURE_OPEN_GROUPS,
  fixtureDefinitionId,
  fixtureIntegrations,
  fixtureTool,
  registerFixtureTools,
  unregisterFixtureTools
} from './helpers/integrationToolFixture.js';

configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getSources = () => ({ data: [] });
configCache.getFeatures = () => ({ skills: false, toolSearch: true });
mcpClientManager.listAllTools = async () => [];
a2aClientManager.listAllTools = async () => [];

const ids = list => list.map(t => t.id).sort();

/** A tool with a long description and many parameters: about a thousand tokens. */
function heavy(id) {
  const properties = {};
  for (let i = 0; i < 12; i++) {
    properties[`field${i}`] = {
      type: 'string',
      description: `Field ${i} of the ${id} record. It holds one value that the system stores for it.`
    };
  }
  return fixtureTool(id, {
    description: `The ${id} tool. ${'It reads and changes the records of the system. '.repeat(14)}`,
    parameters: { type: 'object', properties, required: [] }
  });
}

const user = { id: 'u', groups: ['users'] };
const model = { id: 'm', contextWindow: 128000 };
const on = { toolSearch: true };
const tight = { maxToolTokens: 500 };

describe('tool search on the tools of a real app', () => {
  before(async () => {
    await integrationRegistry.ensureLoaded();
    await registerFixtureTools([
      heavy('alpha'),
      heavy('beta'),
      fixtureTool('gamma', { description: 'Small tool' }),
      fixtureTool('engine', { action: 'search', type: 'web-search', description: 'Search the web' })
    ]);
  });
  after(() => unregisterFixtureTools());
  beforeEach(() => {
    configCache.setCacheEntry(
      'config/integrations.json',
      fixtureIntegrations('alpha', 'beta', 'gamma', 'engine')
    );
    configCache.setCacheEntry('config/groups.json', { groups: { ...FIXTURE_OPEN_GROUPS } });
  });

  /** What the app is offered, and what tool search makes of it for `model`. */
  const prepare = async (app, { features = on, model: forModel = model } = {}) => {
    const offered = await getToolsForApp(app, 'en', { user, websearchEnabled: false });
    const result = await prepareToolSearch({ tools: offered, app, model: forModel, features });
    return { offered, ...result };
  };

  const three = { alpha: {}, beta: {}, gamma: {} };

  it('leaves out the integrations that do not fit, and lists them', async () => {
    const { offered, toolSearch, indexText } = await prepare({
      id: 'many',
      integrations: three,
      toolSearch: tight
    });
    assert.deepEqual(ids(offered), ['alpha', 'beta', 'gamma']);
    assert.ok(toolSearch, 'something was left out');
    assert.deepEqual(ids(toolSearch.deferred), ['alpha', 'beta']);
    assert.match(indexText, /<integration name="alpha" id="alpha">/);
    assert.match(indexText, /<integration name="beta" id="beta">/);
    assert.doesNotMatch(indexText, /gamma/, 'what is loaded is not listed');
  });

  it('sends the request the loaded tools and the search tool, nothing of the rest', async () => {
    const { tools } = await prepare({ id: 'many', integrations: three, toolSearch: tight });
    assert.deepEqual(ids(tools), ['gamma', 'search_tools']);
  });

  it('keeps an integration loaded when the app binds it with alwaysLoaded', async () => {
    const app = {
      id: 'pinned',
      integrations: { alpha: { alwaysLoaded: true }, beta: {}, gamma: {} },
      toolSearch: { maxToolTokens: 1000 }
    };
    assert.deepEqual([...alwaysLoadedInstanceIds(app)], ['alpha']);
    const { tools, toolSearch } = await prepare(app);
    assert.ok(ids(tools).includes('alpha'));
    assert.deepEqual(ids(toolSearch.deferred), ['beta']);
  });

  it('leaves everything else to the search when what is kept loaded fills the budget alone', async () => {
    const { tools, toolSearch } = await prepare({
      id: 'pinned-big',
      integrations: { alpha: { alwaysLoaded: true }, beta: {}, gamma: {} },
      toolSearch: tight
    });
    assert.ok(ids(tools).includes('alpha'), 'the admin’s choice stands, over budget');
    assert.deepEqual(ids(toolSearch.deferred), ['beta', 'gamma']);
  });

  it('keeps every installation loaded that a definition binding with alwaysLoaded names', () => {
    const app = {
      id: 'by-definition',
      integrations: { [fixtureDefinitionId('beta')]: { alwaysLoaded: true }, alpha: {}, gamma: {} }
    };
    assert.deepEqual([...alwaysLoadedInstanceIds(app)], ['beta']);
  });

  it('leaves nothing out under the budget', async () => {
    const { offered, tools, toolSearch } = await prepare({ id: 'roomy', integrations: three });
    assert.equal(toolSearch, null);
    assert.equal(tools, offered, 'the very same list');
  });

  it('leaves nothing out for an app that switched tool search off', async () => {
    const { tools, toolSearch } = await prepare({
      id: 'off',
      integrations: three,
      toolSearch: { mode: 'off', ...tight }
    });
    assert.equal(toolSearch, null);
    assert.deepEqual(ids(tools), ['alpha', 'beta', 'gamma'], 'every tool, in full');
  });

  it('offers exactly what it offered before when the platform feature is off', async () => {
    const { offered, tools, toolSearch, indexText } = await prepare(
      { id: 'many', integrations: three, toolSearch: tight },
      { features: {} }
    );
    assert.equal(tools, offered, 'the same list');
    assert.equal(toolSearch, null);
    assert.equal(indexText, '');
  });

  it('never leaves out the search of a web search engine', async () => {
    const { offered, tools } = await prepare({
      id: 'web',
      integrations: { engine: {}, alpha: {} },
      toolSearch: tight
    });
    const engineTool = offered.find(tool => tool.id === 'engine');
    assert.ok(engineTool, 'the engine is offered');
    assert.equal(isDeferrable(engineTool), false);
    assert.ok(ids(tools).includes('engine'));
  });

  it('counts the model’s context window: a big app does not fit a small model', async () => {
    const app = { id: 'many', integrations: three };
    assert.equal((await prepare(app)).toolSearch, null);
    const small = await prepare(app, { model: { id: 'local', contextWindow: 4000 } });
    assert.deepEqual(ids(small.toolSearch.deferred), ['alpha', 'beta']);
  });
});

describe('the app config accepts the tool search settings', () => {
  const base = {
    id: 'a',
    name: { en: 'A' },
    description: { en: 'd' },
    color: '#4F46E5',
    icon: 'x'
  };
  const parse = extra => appConfigSchema.safeParse({ ...base, ...extra });

  it('takes toolSearch and the binding flag', () => {
    const result = parse({
      toolSearch: { mode: 'auto', maxToolTokens: 4000 },
      integrations: { jira: { alwaysLoaded: true } }
    });
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('refuses a mode, a budget or a flag it does not know', () => {
    assert.equal(parse({ toolSearch: { mode: 'always' } }).success, false);
    assert.equal(parse({ toolSearch: { maxToolTokens: 10 } }).success, false);
    assert.equal(parse({ toolSearch: { threshold: 3 } }).success, false);
    assert.equal(parse({ integrations: { jira: { alwaysLoaded: 'yes' } } }).success, false);
  });
});
