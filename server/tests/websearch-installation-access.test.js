#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which web search a request gets, whichever way it asks for it, now that
 * every engine is its own installation of type `web-search`:
 *
 * - `app.websearch` offers native search on Google, OpenAI Responses and
 *   Anthropic models without any engine and without an integration grant,
 *   with the page reader next to it where the provider takes function tools;
 *   on other models it offers the search tool of the app's engine (`auto` or
 *   a named one) with the page reader, or nothing while no engine is available;
 * - a workflow node (or an app) that lists `braveSearch` / `qwantSearch` /
 *   `read_url` in `tools` gets the engine tool only while that engine is
 *   installed, enabled and granted, and the page reader always (a platform
 *   tool); a node's generic `webSearch` falls back to the first engine the
 *   user may use;
 * - the tools offered when a provider turns native search down follow the
 *   app's engine and the engine's grant.
 *
 * Run: node --test server/tests/websearch-installation-access.test.js
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  getToolsForApp,
  resolveAppNativeWebSearch,
  resolveNativeWebSearchFallbackTools,
  resolveWebSearchEngineToolId,
  READ_URL_TOOL_ID
} from '../toolLoader.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';
import {
  RESEARCHER,
  STAFF,
  engine,
  grantResearchOnly,
  setUpWebSearch,
  tearDownWebSearch,
  thirdPartyEngineTool,
  useWebSearch
} from './helpers/webSearchEngines.js';

const ids = list => list.map(t => t.id).sort();

before(setUpWebSearch);
after(tearDownWebSearch);

describe('an app with web search on', () => {
  const app = (websearch = {}, extra = {}) => ({
    id: 'web-chat',
    websearch: { enabled: true, enabledByDefault: true, provider: 'auto', ...websearch },
    ...extra
  });

  it('searches natively with no engine installed, and gets the page reader where it fits', async () => {
    useWebSearch({ installed: [] });
    for (const provider of ['google', 'openai-responses', 'anthropic']) {
      assert.equal(resolveAppNativeWebSearch(app(), provider, undefined)?.provider, provider);
    }
    for (const modelProvider of ['anthropic', 'openai-responses']) {
      const offered = await getToolsForApp(app(), 'en', { modelProvider, user: STAFF });
      assert.deepEqual(ids(offered), [READ_URL_TOOL_ID], modelProvider);
    }
    // Gemini drops function tools next to google_search: no reader there.
    const google = await getToolsForApp(app(), 'en', { modelProvider: 'google', user: STAFF });
    assert.deepEqual(ids(google), []);
  });

  it('searches natively without any integration grant', async () => {
    useWebSearch({ installed: [engine('qwant')], groups: grantResearchOnly() });
    assert.equal(
      resolveAppNativeWebSearch(app(), 'anthropic', undefined, undefined)?.provider,
      'anthropic'
    );
    const offered = await getToolsForApp(app(), 'en', { modelProvider: 'anthropic', user: STAFF });
    assert.deepEqual(ids(offered), [READ_URL_TOOL_ID]);
  });

  it('gets nothing on a model without native search while no engine is installed', async () => {
    useWebSearch({ installed: [] });
    const offered = await getToolsForApp(app(), 'en', { modelProvider: 'mistral', user: STAFF });
    assert.deepEqual(ids(offered), []);
  });

  it('gets the auto engine with the page reader on a model without native search', async () => {
    useWebSearch({ installed: [engine('qwant'), engine('staan')] });
    const offered = await getToolsForApp(app(), 'en', { modelProvider: 'mistral', user: STAFF });
    assert.deepEqual(ids(offered), [READ_URL_TOOL_ID, 'staanSearch']);
  });

  it('gets the engine instead of native search when the app turns native search off', async () => {
    useWebSearch({ installed: [engine('qwant')] });
    const offered = await getToolsForApp(app({ useNativeSearch: false }), 'en', {
      modelProvider: 'anthropic',
      user: STAFF
    });
    assert.deepEqual(ids(offered), ['qwantSearch', READ_URL_TOOL_ID]);
  });

  it('with a named engine that is missing, gets no tool search but keeps native search', async () => {
    useWebSearch({ installed: [engine('qwant')] });
    const named = app({ provider: 'brave' });
    const mistral = await getToolsForApp(named, 'en', { modelProvider: 'mistral', user: STAFF });
    assert.deepEqual(ids(mistral), []);
    assert.equal(resolveAppNativeWebSearch(named, 'anthropic', undefined)?.provider, 'anthropic');
    const anthropic = await getToolsForApp(named, 'en', {
      modelProvider: 'anthropic',
      user: STAFF
    });
    assert.deepEqual(ids(anthropic), [READ_URL_TOOL_ID]);
  });

  it('gets the engine only when the user’s groups grant it', async () => {
    useWebSearch({ installed: [engine('qwant')], groups: grantResearchOnly('type:web-search') });
    const outside = await getToolsForApp(app(), 'en', { modelProvider: 'mistral', user: STAFF });
    assert.deepEqual(ids(outside), []);
    const inside = await getToolsForApp(app(), 'en', {
      modelProvider: 'mistral',
      user: RESEARCHER
    });
    assert.deepEqual(ids(inside), ['qwantSearch', READ_URL_TOOL_ID]);
  });

  it('applies its settings to the engine tool’s parameter defaults', async () => {
    useWebSearch({ installed: [engine('qwant')] });
    const [search] = (
      await getToolsForApp(app({ maxResults: 50, contentMaxLength: 1000 }), 'en', {
        modelProvider: 'mistral',
        user: STAFF
      })
    ).filter(t => t.id === 'qwantSearch');
    // Clamped to what Qwant accepts.
    assert.equal(search.parameters.properties.maxResults.default, 10);
    assert.equal(search.parameters.properties.contentMaxLength.default, 1000);
    assert.equal(search._integration.instanceId, 'qwant');
    assert.equal(search._integration.action, 'search');
  });

  it('gets a third-party engine’s search tool', async () => {
    useWebSearch({ installed: [engine('acme')], tools: [thirdPartyEngineTool('acme')] });
    const offered = await getToolsForApp(app(), 'en', { modelProvider: 'mistral', user: STAFF });
    assert.deepEqual(ids(offered), ['acme__search', READ_URL_TOOL_ID]);
    const search = offered.find(t => t.id === 'acme__search');
    assert.equal(search.parameters.properties.maxResults.default, 5);
  });

  it('gets nothing while the user turned web search off', async () => {
    useWebSearch({ installed: [engine('qwant')] });
    const offered = await getToolsForApp(app(), 'en', {
      modelProvider: 'mistral',
      user: STAFF,
      websearchEnabled: false
    });
    assert.deepEqual(ids(offered), []);
    assert.equal(resolveAppNativeWebSearch(app(), 'anthropic', false), null);
  });
});

describe('tools that name a web search tool', () => {
  const executor = new PromptNodeExecutor({ llmClient: { complete: async () => ({}) } });
  const nodeTools = (toolIds, user) =>
    executor.getAgentTools(toolIds, 'en', { user, chatId: 'c1', _skillIds: [] });

  it('get an engine tool by its id while that engine is installed, enabled and granted', async () => {
    // The shape of claude-style-agent.json / research-assistant.json.
    useWebSearch({ installed: [engine('brave')] });
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], RESEARCHER)), [
      'braveSearch',
      READ_URL_TOOL_ID
    ]);
    const [tool] = await nodeTools(['braveSearch'], RESEARCHER);
    assert.equal(tool._integration.instanceId, 'brave');
    assert.equal(tool.parameters.properties.query.type, 'string');
  });

  it('get no engine tool while it is missing, off or not granted, and the reader regardless', async () => {
    useWebSearch({ installed: [engine('qwant')] });
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], RESEARCHER)), [
      READ_URL_TOOL_ID
    ]);
    useWebSearch({ installed: [engine('brave', { enabled: false })] });
    assert.deepEqual(ids(await nodeTools(['braveSearch'], RESEARCHER)), []);
    useWebSearch({ installed: [engine('brave')], groups: grantResearchOnly('brave') });
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], STAFF)), [READ_URL_TOOL_ID]);
    assert.deepEqual(ids(await nodeTools(['braveSearch', 'read_url'], RESEARCHER)), [
      'braveSearch',
      READ_URL_TOOL_ID
    ]);
  });

  it('select nothing by the installation id or the retired websearch id', async () => {
    useWebSearch({ installed: [engine('qwant')] });
    assert.deepEqual(ids(await nodeTools(['qwant', 'websearch'], RESEARCHER)), []);
  });

  it('get a third-party engine’s search tool by its exact id', async () => {
    useWebSearch({ installed: [engine('acme')], tools: [thirdPartyEngineTool('acme')] });
    assert.deepEqual(ids(await nodeTools(['acme__search'], RESEARCHER)), ['acme__search']);
    assert.deepEqual(ids(await nodeTools(['acme'], RESEARCHER)), []);
  });

  it('in an app: the engine tool by id even without app.websearch, narrowed like any tool', async () => {
    useWebSearch({ installed: [engine('qwant')] });
    const offered = await getToolsForApp({ id: 'a', tools: ['qwantSearch', 'read_url'] }, 'en', {
      modelProvider: 'mistral',
      user: STAFF,
      enabledTools: ['read_url']
    });
    assert.deepEqual(ids(offered), [READ_URL_TOOL_ID]);
  });

  it('a workflow node’s generic webSearch falls back to the first engine the user may use', async () => {
    useWebSearch({ installed: [engine('qwant'), engine('staan')] });
    assert.equal(await resolveWebSearchEngineToolId('auto', { user: STAFF }), 'staanSearch');
    useWebSearch({ installed: [] });
    assert.equal(await resolveWebSearchEngineToolId('auto', { user: STAFF }), null);
  });
});

describe('the fallback tools when a provider turns native search down', () => {
  const directive = { provider: 'anthropic', fallback: 'auto' };

  beforeEach(() => useWebSearch({ installed: [engine('brave'), engine('qwant')] }));

  it('are the app’s engine with the page reader', async () => {
    const app = { id: 'web-chat', websearch: { enabled: true, provider: 'qwant' } };
    const offered = await resolveNativeWebSearchFallbackTools(directive, {
      app,
      language: 'en',
      user: STAFF
    });
    assert.deepEqual(ids(offered), ['qwantSearch', READ_URL_TOOL_ID]);
  });

  it('are the first engine the user may use without an app', async () => {
    const offered = await resolveNativeWebSearchFallbackTools(directive, {
      language: 'en',
      user: STAFF
    });
    assert.deepEqual(ids(offered), ['braveSearch', READ_URL_TOOL_ID]);
  });

  it('are nothing when the engine is not granted, or none is installed', async () => {
    useWebSearch({
      installed: [engine('brave'), engine('qwant')],
      groups: grantResearchOnly('qwant')
    });
    const app = { id: 'web-chat', websearch: { enabled: true, provider: 'brave' } };
    assert.deepEqual(
      await resolveNativeWebSearchFallbackTools(directive, {
        app,
        language: 'en',
        user: RESEARCHER
      }),
      []
    );
    useWebSearch({ installed: [] });
    assert.deepEqual(
      await resolveNativeWebSearchFallbackTools(directive, { language: 'en', user: STAFF }),
      []
    );
  });
});
