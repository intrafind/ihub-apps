#!/usr/bin/env node

/**
 * The page reader (`webContentExtractor`) offered next to the script-backed
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
  WEB_CONTENT_EXTRACTOR_TOOL_ID
} from '../toolLoader.js';
import * as extractorModule from '../tools/webContentExtractor.js';

async function readDefaultTool(id) {
  return JSON.parse(
    await readFile(new URL(`../defaults/tools/${id}.json`, import.meta.url), 'utf8')
  );
}

const qwant = await readDefaultTool('qwantSearch');
const reader = await readDefaultTool(WEB_CONTENT_EXTRACTOR_TOOL_ID);

let tools = [];
configCache.getTools = () => ({ data: tools });
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
    assert.deepEqual(ids(offered), ['qwantSearch', WEB_CONTENT_EXTRACTOR_TOOL_ID]);
  });

  it('is not offered when the user turned web search off', async () => {
    const offered = await getToolsForApp(webApp(), 'en', {
      modelProvider: 'mistral',
      websearchEnabled: false
    });
    assert.deepEqual(ids(offered), []);
  });

  it('is not offered when native search handles the request', async () => {
    const app = webApp({ websearch: { ...webApp().websearch, useNativeSearch: true } });
    const offered = await getToolsForApp(app, 'en', { modelProvider: 'anthropic' });
    assert.deepEqual(ids(offered), []);
  });

  it('is offered once when the app also lists it in tools', async () => {
    const offered = await getToolsForApp(webApp({ tools: [WEB_CONTENT_EXTRACTOR_TOOL_ID] }), 'en', {
      modelProvider: 'mistral'
    });
    assert.deepEqual(ids(offered), [WEB_CONTENT_EXTRACTOR_TOOL_ID, 'qwantSearch']);
  });

  it('is left out when it is not installed or disabled', async () => {
    tools = [qwant];
    const offered = await getToolsForApp(webApp(), 'en', { modelProvider: 'mistral' });
    assert.deepEqual(ids(offered), ['qwantSearch']);
  });

  it('is offered with the search tool when native search is turned down', async () => {
    const offered = await resolveNativeWebSearchFallbackTools(
      { provider: 'anthropic', fallback: 'braveSearch' },
      { app: webApp(), language: 'en' }
    );
    assert.deepEqual(ids(offered), ['qwantSearch', WEB_CONTENT_EXTRACTOR_TOOL_ID]);
  });
});

describe('default webContentExtractor definition', () => {
  it('points at an exported function of its script', () => {
    assert.equal(reader.script, 'webContentExtractor.js');
    assert.equal(typeof extractorModule[reader.method], 'function');
  });

  it('asks only for a url and a length, never for ignoreSSL', () => {
    assert.deepEqual(Object.keys(reader.parameters.properties).sort(), ['maxLength', 'url']);
    assert.deepEqual(reader.parameters.required, ['url']);
  });

  it('rejects a non-http URL through the model-facing entry point', async () => {
    await assert.rejects(extractorModule.extractForTool({ url: 'file:///etc/passwd' }), {
      code: 'INVALID_URL'
    });
  });
});
