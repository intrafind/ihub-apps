#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page reader (`read_url`) offered next to the script-backed
 * search tool.
 *
 * Without it the model can search but can't open a page: all it sees of a
 * result is the search tool's short automatic excerpt, and a URL the user
 * pastes can't be read at all. These tests pin down when the reader is offered
 * (alongside the search tool, and on the native-search fallback), when it
 * isn't (web search off, native search, reader disabled), and that the shipped
 * default definition matches the script it points at.
 *
 * Run: node --test server/tests/websearch-page-reader.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import {
  getToolsForApp,
  resolveNativeWebSearchFallbackTools,
  READ_URL_TOOL_ID
} from '../toolLoader.js';
import * as extractorModule from '../tools/webContentExtractor.js';
import websearchConnector from '../services/integrations/protocols/native/connectors/websearch/index.js';

// The web search tools belong to the built-in `websearch` connector now.
const PARAMETERS = JSON.parse(
  await readFile(
    new URL(
      '../services/integrations/protocols/native/connectors/websearch/parameters.json',
      import.meta.url
    ),
    'utf8'
  )
);
function connectorTool(action) {
  const spec = PARAMETERS[action];
  return {
    id: spec.toolId,
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    _integration: { instanceId: 'websearch', action, fixedToolId: true }
  };
}

const qwant = connectorTool('qwant');
const reader = connectorTool('readUrl');

let tools = [];
// The `websearch` installation owns the search tools and the page reader.
let installed = [{ id: 'websearch', definition: 'com.intrafind/web-search', enabled: true }];
configCache.getTools = () => ({ data: tools });
configCache.getIntegrations = () => ({ data: { installed } });
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getSources = () => ({ data: [] });
mcpClientManager.listAllTools = async () => [];

const webApp = extra => ({
  id: 'research',
  websearch: { enabled: true, provider: 'qwant', useNativeSearch: false, enabledByDefault: true },
  ...extra
});

const ids = list => list.map(t => t.id);

describe('page reader alongside web search', () => {
  beforeEach(() => {
    tools = [qwant, reader];
  });

  it('is offered next to the search tool when web search is on', async () => {
    const offered = await getToolsForApp(webApp(), 'en', { modelProvider: 'mistral' });
    assert.deepEqual(ids(offered), ['qwantSearch', READ_URL_TOOL_ID]);
  });

  it('is not offered when the user turned web search off', async () => {
    const offered = await getToolsForApp(webApp(), 'en', {
      modelProvider: 'mistral',
      websearchEnabled: false
    });
    assert.deepEqual(ids(offered), []);
  });

  it('is offered alone next to native search on Anthropic and OpenAI Responses', async () => {
    const app = webApp({ websearch: { ...webApp().websearch, useNativeSearch: true } });
    for (const modelProvider of ['anthropic', 'openai-responses']) {
      const offered = await getToolsForApp(app, 'en', { modelProvider });
      assert.deepEqual(ids(offered), [READ_URL_TOOL_ID], modelProvider);
    }
  });

  it('is not offered next to Google native search, which drops function tools', async () => {
    const app = webApp({ websearch: { ...webApp().websearch, useNativeSearch: true } });
    const offered = await getToolsForApp(app, 'en', { modelProvider: 'google' });
    assert.deepEqual(ids(offered), []);
  });

  it('is not offered next to native search when the reader is disabled', async () => {
    tools = [qwant];
    const app = webApp({ websearch: { ...webApp().websearch, useNativeSearch: true } });
    const offered = await getToolsForApp(app, 'en', { modelProvider: 'anthropic' });
    assert.deepEqual(ids(offered), []);
  });

  it('is offered once when the app also lists it in tools', async () => {
    // A leftover `read_url` reference (V195 strips them) resolves to no static
    // tool; the installation still offers the reader exactly once.
    const offered = await getToolsForApp(webApp({ tools: [READ_URL_TOOL_ID] }), 'en', {
      modelProvider: 'mistral'
    });
    assert.deepEqual(ids(offered).sort(), ['qwantSearch', READ_URL_TOOL_ID].sort());
  });

  it('is left out, with the search tool, while the websearch installation is off', async () => {
    installed = [{ id: 'websearch', enabled: false }];
    try {
      const offered = await getToolsForApp(webApp(), 'en', { modelProvider: 'mistral' });
      assert.deepEqual(ids(offered), []);
    } finally {
      installed = [{ id: 'websearch', enabled: true }];
    }
  });

  it('is left out for a user outside the installation’s groups', async () => {
    installed = [{ id: 'websearch', enabled: true, allowedGroups: ['research'] }];
    try {
      const outside = await getToolsForApp(webApp(), 'en', {
        modelProvider: 'mistral',
        user: { id: 'u', groups: ['staff'] }
      });
      assert.deepEqual(ids(outside), []);
      const inside = await getToolsForApp(webApp(), 'en', {
        modelProvider: 'mistral',
        user: { id: 'u', groups: ['research'] }
      });
      assert.deepEqual(ids(inside), ['qwantSearch', READ_URL_TOOL_ID]);
    } finally {
      installed = [{ id: 'websearch', enabled: true }];
    }
  });

  it('is offered with the search tool when native search is turned down', async () => {
    const offered = await resolveNativeWebSearchFallbackTools(
      { provider: 'anthropic', fallback: 'braveSearch' },
      { app: webApp(), language: 'en' }
    );
    assert.deepEqual(ids(offered), ['qwantSearch', READ_URL_TOOL_ID]);
  });
});

describe('default read_url definition', () => {
  it('is the web search connector’s readUrl action, run by the extractor', () => {
    assert.equal(reader.id, READ_URL_TOOL_ID);
    assert.equal(typeof websearchConnector.actions.readUrl.run, 'function');
    assert.equal(typeof extractorModule.extractForTool, 'function');
  });

  it('asks only for a url, a length and an offset, never for ignoreSSL', () => {
    assert.deepEqual(Object.keys(reader.parameters.properties).sort(), [
      'maxLength',
      'offset',
      'url'
    ]);
    assert.deepEqual(reader.parameters.required, ['url']);
  });

  it('rejects a non-http URL through the model-facing entry point', async () => {
    await assert.rejects(extractorModule.extractForTool({ url: 'file:///etc/passwd' }), {
      code: 'INVALID_URL'
    });
  });
});
