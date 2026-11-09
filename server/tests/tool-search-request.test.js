#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Tool search (#2889) in the prepared chat request (`prepareChatRequest`): with
 * the platform feature on and an app over its budget, the request carries
 * only the loaded tools plus `search_tools`, the left-out tools are in the
 * system prompt as a list (name and description, no schemas), and their
 * guidance stays out of the prompt until the model searches. With the feature off, under the budget, or for a model that does
 * not call tools, the request is what it was without the feature.
 *
 * Run: node --test server/tests/tool-search-request.test.js
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import a2aClientManager from '../services/a2a/A2aClientManager.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import RequestBuilder from '../services/chat/RequestBuilder.js';
import {
  FIXTURE_OPEN_GROUPS,
  fixtureIntegrations,
  fixtureTool,
  registerFixtureTools,
  unregisterFixtureTools
} from './helpers/integrationToolFixture.js';

mcpClientManager.listAllTools = async () => [];
a2aClientManager.listAllTools = async () => [];

const ids = list => list.map(tool => tool.id).sort();

/** A tool of about 560 tokens: a long description and twelve parameters. */
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

const USER = { id: 'u1', groups: ['users'] };
const APP = {
  id: 'many',
  name: { en: 'Many' },
  description: { en: 'An app with many integrations' },
  system: { en: 'You help.' },
  enabled: true,
  integrations: { alpha: {}, beta: {}, gamma: {} },
  toolSearch: { maxToolTokens: 500 }
};

describe('prepareChatRequest with tool search', () => {
  before(async () => {
    await integrationRegistry.ensureLoaded();
    await registerFixtureTools([
      heavy('alpha'),
      heavy('beta'),
      fixtureTool('gamma', { description: 'Small tool' })
    ]);
  });
  after(() => unregisterFixtureTools());

  /** Prepare a one-message turn of `app` on a model; the config cache holds the rest. */
  async function prepare({ app = APP, features = { toolSearch: true } } = {}) {
    configCache.setCacheEntry('config/features.json', features);
    configCache.setCacheEntry('config/platform.json', { defaultLanguage: 'en' });
    configCache.setCacheEntry('config/groups.json', { groups: { ...FIXTURE_OPEN_GROUPS } });
    configCache.setCacheEntry(
      'config/integrations.json',
      fixtureIntegrations('alpha', 'beta', 'gamma')
    );
    configCache.setCacheEntry('config/apps.json', [app]);
    configCache.setCacheEntry('config/models.json', [
      {
        id: 'm',
        name: 'M',
        provider: 'openai',
        enabled: true,
        default: true,
        contextWindow: 128000,
        supportsTools: 'auto'
      }
    ]);
    const builder = new RequestBuilder();
    builder.apiKeyVerifier = { verifyApiKey: async () => ({ success: true, apiKey: 'k' }) };
    const result = await builder.prepareChatRequest({
      appId: app.id,
      modelId: 'm',
      messages: [{ role: 'user', content: 'Hello' }],
      language: 'en',
      processMessageTemplates: async messages => messages,
      user: USER,
      chatId: 'chat-tool-search-request'
    });
    assert.equal(result.success, true, result.error?.message);
    return result.data;
  }

  const systemPrompt = data =>
    data.llmMessages.find(message => message.role === 'system')?.content ?? '';

  beforeEach(() => configCache.setCacheEntry('config/features.json', {}));

  it('sends the loaded tools and the search tool, and lists what was left out', async () => {
    const data = await prepare();
    assert.deepEqual(ids(data.tools), ['gamma', 'search_tools']);
    assert.deepEqual(ids(data.toolSearch.deferred), ['alpha', 'beta']);

    const prompt = systemPrompt(data);
    assert.match(prompt, /<available_tools>/);
    assert.match(prompt, /<integration name="alpha" id="alpha">/);
    assert.match(prompt, /<tool name="alpha">The alpha tool\./);
    assert.doesNotMatch(prompt, /field0/, 'the list carries no parameter schemas');
    assert.doesNotMatch(
      JSON.stringify(data.tools),
      /alpha/,
      'the request carries none of the left-out tools'
    );
  });

  it('is the request it was without the feature when the feature is off', async () => {
    const off = await prepare({ features: {} });
    assert.deepEqual(ids(off.tools), ['alpha', 'beta', 'gamma']);
    assert.equal(off.toolSearch, null);
    assert.doesNotMatch(systemPrompt(off), /available_tools/);
  });

  it('is the request it was without the feature when the app switched tool search off', async () => {
    const off = await prepare({ app: { ...APP, toolSearch: { mode: 'off' } } });
    assert.deepEqual(ids(off.tools), ['alpha', 'beta', 'gamma']);
    assert.equal(off.toolSearch, null);
  });

  it('is the request it was without the feature when the tools fit the budget', async () => {
    const roomy = await prepare({ app: { ...APP, toolSearch: undefined } });
    assert.deepEqual(ids(roomy.tools), ['alpha', 'beta', 'gamma']);
    assert.equal(roomy.toolSearch, null);
    assert.doesNotMatch(systemPrompt(roomy), /available_tools/);
  });

  it('keeps the system prompt the same from turn to turn', async () => {
    assert.equal(systemPrompt(await prepare()), systemPrompt(await prepare()));
  });
});
