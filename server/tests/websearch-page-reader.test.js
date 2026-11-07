#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page reader (`read_url`) belongs to the web search feature, not to an
 * engine: a platform tool read from `server/defaults/tools/read_url.json`.
 *
 * Without it the model can search but can't open a page: all it sees of a
 * result is the search tool's short automatic excerpt, and a URL the user
 * pastes can't be read at all. These tests pin down when the reader is offered
 * (next to any engine's search tool, next to native search on Anthropic and
 * OpenAI Responses — with no engine installed — and on the native-search
 * fallback), when it isn't (web search off, Google native search, switched
 * off by a tool file), and that the shipped definition matches the script it
 * points at.
 *
 * Run: node --test server/tests/websearch-page-reader.test.js
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getToolsForApp, getToolsForNode } from '../services/tools/appTools.js';
import { loadTools } from '../services/tools/catalog.js';
import {
  resolveNativeWebSearchFallbackTools,
  READ_URL_TOOL_ID
} from '../services/tools/webSearchResolver.js';
import * as extractorModule from '../tools/webContentExtractor.js';
import { isPlatformTool } from '../services/tools/platformTools.js';
import { RETIRED_IHUB_TOOL_FILES } from '../utils/setupUtils.js';
import {
  STAFF,
  engine,
  setUpWebSearch,
  tearDownWebSearch,
  useWebSearch
} from './helpers/webSearchEngines.js';

const READER = JSON.parse(
  await readFile(new URL('../defaults/tools/read_url.json', import.meta.url), 'utf8')
);

const webApp = extra => ({
  id: 'research',
  websearch: { enabled: true, provider: 'qwant', useNativeSearch: false, enabledByDefault: true },
  ...extra
});
const nativeApp = () => webApp({ websearch: { ...webApp().websearch, useNativeSearch: true } });

const ids = list => list.map(t => t.id);

before(setUpWebSearch);
after(tearDownWebSearch);

describe('page reader alongside web search', () => {
  beforeEach(() => useWebSearch({ installed: [engine('qwant')] }));

  it('is offered next to the engine’s search tool when web search is on', async () => {
    const offered = await getToolsForApp(webApp(), 'en', { modelProvider: 'mistral', user: STAFF });
    assert.deepEqual(ids(offered), ['qwantSearch', READ_URL_TOOL_ID]);
  });

  it('is not offered when the user turned web search off', async () => {
    const offered = await getToolsForApp(webApp(), 'en', {
      modelProvider: 'mistral',
      user: STAFF,
      websearchEnabled: false
    });
    assert.deepEqual(ids(offered), []);
  });

  it('is offered alone next to native search on Anthropic and OpenAI Responses, engine or not', async () => {
    for (const installed of [[engine('qwant')], []]) {
      useWebSearch({ installed });
      for (const modelProvider of ['anthropic', 'openai-responses']) {
        const offered = await getToolsForApp(nativeApp(), 'en', { modelProvider, user: STAFF });
        assert.deepEqual(ids(offered), [READ_URL_TOOL_ID], `${modelProvider} ${installed.length}`);
      }
    }
  });

  it('is not offered next to Google native search, which drops function tools', async () => {
    const offered = await getToolsForApp(nativeApp(), 'en', {
      modelProvider: 'google',
      user: STAFF
    });
    assert.deepEqual(ids(offered), []);
  });

  it('is not offered when a tool file switches it off', async () => {
    useWebSearch({ installed: [engine('qwant')], tools: [{ ...READER, enabled: false }] });
    assert.equal(
      (await loadTools('en')).some(t => t.id === READ_URL_TOOL_ID),
      false
    );
    const native = await getToolsForApp(nativeApp(), 'en', {
      modelProvider: 'anthropic',
      user: STAFF
    });
    assert.deepEqual(ids(native), []);
    const engineOnly = await getToolsForApp(webApp(), 'en', {
      modelProvider: 'mistral',
      user: STAFF
    });
    assert.deepEqual(ids(engineOnly), ['qwantSearch']);
  });

  it('is offered once when a node with web search also lists it in its tools', async () => {
    const offered = await getToolsForNode([READ_URL_TOOL_ID], webApp(), 'en', {
      modelProvider: 'mistral',
      user: STAFF
    });
    assert.deepEqual(ids(offered).sort(), ['qwantSearch', READ_URL_TOOL_ID].sort());
  });

  it('is not offered with web search when no engine and no native search are available', async () => {
    useWebSearch({ installed: [] });
    const offered = await getToolsForApp(webApp(), 'en', { modelProvider: 'mistral', user: STAFF });
    assert.deepEqual(ids(offered), []);
  });

  it('is offered with the engine’s search tool when native search is turned down', async () => {
    const offered = await resolveNativeWebSearchFallbackTools(
      { provider: 'anthropic', fallback: 'auto' },
      { app: webApp(), language: 'en', user: STAFF }
    );
    assert.deepEqual(ids(offered), ['qwantSearch', READ_URL_TOOL_ID]);
  });
});

describe('default read_url definition', () => {
  it('is a platform tool, read in place and never seeded into contents/tools', async () => {
    useWebSearch({ installed: [] });
    assert.equal(isPlatformTool(READ_URL_TOOL_ID), true);
    assert.ok(RETIRED_IHUB_TOOL_FILES.includes('tools/read_url.json'));
    const reader = (await loadTools('en')).find(t => t.id === READ_URL_TOOL_ID);
    assert.ok(reader, 'the page reader is in the tool list');
    assert.equal(reader._integration, undefined, 'no engine owns it');
    assert.equal(typeof reader.description, 'string', 'localized');
  });

  it('runs the extractor’s model-facing entry point', () => {
    assert.equal(READER.script, 'webContentExtractor.js');
    assert.equal(READER.method, 'extractForTool');
    assert.equal(typeof extractorModule.extractForTool, 'function');
  });

  it('asks only for a url, a length and an offset, never for ignoreSSL', () => {
    assert.deepEqual(Object.keys(READER.parameters.properties).sort(), [
      'maxLength',
      'offset',
      'url'
    ]);
    assert.deepEqual(READER.parameters.required, ['url']);
  });

  it('rejects a non-http URL through the model-facing entry point', async () => {
    await assert.rejects(extractorModule.extractForTool({ url: 'file:///etc/passwd' }), {
      code: 'INVALID_URL'
    });
  });
});
