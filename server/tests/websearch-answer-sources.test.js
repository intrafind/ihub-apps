#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a web search answer that cites nothing still shows: the pages that were
 * read for it.
 *
 * Reported: after a web search, "Cited in this answer" was empty although the
 * answer was written from the pages the search had read. A model that writes
 * no `[n](url)` links (seen with local models) leaves nothing cited, so the
 * sources panel showed an empty "Cited in this answer" and every page under
 * "Also considered".
 *
 * The server already says which pages went to the model: the web source
 * producer marks a page the search read (`extractContent`) or the page reader
 * read with `read: { ok: true }` on the run's `sources/added` frame and on the
 * stored answer. `resolveCitations` lists those pages as `read` when the answer
 * cites nothing, so the chat shows "Read for this answer" instead of an empty
 * cited list.
 *
 * The turn runs end to end on the real loop and tool path: a scripted model
 * calls the shipped Brave engine's search action, whose script runs against a
 * stub search provider and reads the result pages from the page reader's cache
 * (no network).
 *
 * Run: node --test server/tests/websearch-answer-sources.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import ChatService from '../services/chat/ChatService.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import { setEnvelopeDelivery, stampSeq } from '../services/loop/RunStream.js';
import { routeEnvelope } from '../sse.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';
import { resolveCitations } from '../../shared/sources/index.js';
import { boundStoredSources } from '../services/chat/chatSources.js';
import braveSearch from '../tools/braveSearch.js';
import { acceptLanguageFor } from '../tools/lib/pageContent.js';
import { resolveSearchLanguage } from '../services/search/searchLanguage.js';
import { makePageCacheKey, setCachedPage } from '../services/pageCache.js';
import webSearchService, { SearchProvider } from '../services/WebSearchService.js';
import { makeClient, sseResponse, MODELS } from './loop/helpers/llmFixtures.js';

// ── the search provider and the pages behind its results ───────────────────

const WEATHER = 'https://weather.example/berlin';
const NEWS = 'https://news.example/berlin-today';
// A private address the page reader refuses at once: a result that was found
// but never read.
const INTRANET = 'http://10.20.30.40/berlin';

/** Stands in for Brave: what the search found, without a request. */
class StubBraveProvider extends SearchProvider {
  getName() {
    return 'brave';
  }
  isConfigured() {
    return true;
  }
  async search() {
    return {
      results: [
        { title: 'Berlin weather', url: WEATHER, description: 'Forecast for Berlin' },
        { title: 'Berlin today', url: NEWS, description: 'News from Berlin' },
        { title: 'Intranet: Berlin office', url: INTRANET, description: 'Office page' }
      ]
    };
  }
}
webSearchService.registerProvider(new StubBraveProvider());

/** Puts a page in the reader's cache, so the search reads it without a request. */
function cachePage(url, title, text) {
  const doc = {
    finalUrl: url,
    contentType: 'html',
    format: 'markdown',
    title,
    description: '',
    author: '',
    siteName: '',
    publishedDate: '',
    language: 'en',
    text,
    thin: false
  };
  const key = makePageCacheKey(
    new URL(url).toString(),
    acceptLanguageFor(resolveSearchLanguage('en'))
  );
  setCachedPage(key, doc, text.length, 60_000);
}
cachePage(WEATHER, 'Berlin weather', 'Sunny, 24 degrees, light wind from the west.');
cachePage(NEWS, 'Berlin today', 'The city opens its outdoor pools this weekend.');

/**
 * The shipped Brave engine's search action as the tool loader offers it, with
 * the app's `websearch` defaults (`extractContent`, `maxResults`) on its
 * parameters.
 */
const braveSearchTool = {
  id: 'braveSearch',
  name: 'braveSearch',
  description: 'Search the web',
  _integration: { definition: 'com.intrafind/brave-search', action: 'search', instanceId: 'brave' },
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      extractContent: { type: 'boolean', default: true },
      maxResults: { type: 'integer', default: 3 },
      contentMaxLength: { type: 'integer', default: 3000 }
    },
    required: ['query']
  }
};

// ── the scripted model and the chat turn ────────────────────────────────────

const frames = new Map();
test.before(() => {
  setEnvelopeDelivery((streamId, envelope) => {
    frames.get(streamId)?.push(stampSeq(streamId, envelope));
  });
});
test.after(() => {
  setEnvelopeDelivery(routeEnvelope);
});

function toolTurn(name, args) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

function textTurn(content) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ];
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * One chat turn: the model searches the web, then answers with `answer`.
 * @returns {Promise<{summary: Object, frames: Object[]}>}
 */
async function searchAndAnswer(answer) {
  const script = [toolTurn('braveSearch', { query: 'berlin weather' }), textTurn(answer)];
  const { client } = makeClient({
    maxRetries: 0,
    transport: async () => sseResponse(script.shift())
  });
  const service = new ChatService({
    agentLoop: new AgentLoop({ llmClient: client, logger: silent }),
    logInteraction: async () => {},
    // The tool runner hands the script the model's arguments with the chat context.
    runTool: async (toolId, args) => {
      assert.equal(toolId, 'braveSearch');
      return braveSearch(args);
    },
    telemetry: {
      recordChatCallStart: async () => ({ promptTokens: 0 }),
      recordChatCallEnd: async () => {}
    },
    runLog: { startRun: async () => ({}), endRun: () => {} }
  });
  const chatId = `websearch-sources-${crypto.randomUUID().slice(0, 8)}`;
  const captured = [];
  frames.set(chatId, captured);
  try {
    const summary = await service.runTurn({
      prep: {
        app: { id: 'web-chat' },
        model: MODELS.openai,
        llmMessages: [{ role: 'user', content: 'What is the weather in Berlin?' }],
        tools: [braveSearchTool],
        maxTokens: 512,
        llmOptions: {},
        userFileData: null
      },
      chatId,
      streaming: true,
      buildLogData: () => ({ appId: 'web-chat', sessionId: chatId, streaming: true }),
      language: 'en',
      user: { id: 'u1', groups: ['users'] },
      getLocalizedError: async () => null
    });
    return { summary, frames: captured };
  } finally {
    frames.delete(chatId);
  }
}

const ids = sources => sources.map(source => source.id);

// ── specs ───────────────────────────────────────────────────────────────────

test('a web search reports every page it found, and which of them it read', async () => {
  const { summary, frames: sent } = await searchAndAnswer('It is sunny and 24 degrees.');

  assert.equal(summary.status, 'completed');
  const found = sent.find(frame => frame.type === SSE_V2_EVENTS.SOURCES_ADDED);
  assert.ok(found, 'the search reports its sources on the stream');
  assert.equal(found.data.callId, 'call_1');
  assert.deepEqual(found.data.queries, ['berlin weather']);
  assert.deepEqual(
    found.data.items.map(source => [source.url, source.title, source.read, source.private]),
    [
      [WEATHER, 'Berlin weather', { ok: true }, false],
      [NEWS, 'Berlin today', { ok: true }, false],
      [INTRANET, 'Intranet: Berlin office', { ok: false }, false]
    ]
  );
  // The model got the pages it read: their content is in the tool result.
  const toolMessage = summary.messages.find(message => message.role === 'tool');
  assert.match(String(toolMessage?.content), /Sunny, 24 degrees/);

  // The stored answer keeps the same pages and what was read of them.
  const stored = boundStoredSources(summary.sources);
  assert.deepEqual(
    stored.items.map(source => [source.url, source.read?.ok]),
    [
      [WEATHER, true],
      [NEWS, true],
      [INTRANET, false]
    ]
  );
});

test('an answer that cites none of the pages lists the pages read for it, not an empty cited list', async () => {
  const { summary } = await searchAndAnswer(
    'It is sunny and 24 degrees in Berlin, and the outdoor pools open this weekend.'
  );

  const view = resolveCitations(summary.content, boundStoredSources(summary.sources));
  assert.deepEqual(view.cited, [], 'the answer links no page');
  assert.deepEqual(ids(view.read), ['url:weather.example/berlin', 'url:news.example/berlin-today']);
  assert.deepEqual(ids(view.considered), ['url:10.20.30.40/berlin']);
});

test('an answer that cites a page names its sources itself: nothing is listed as only read', async () => {
  const { summary } = await searchAndAnswer(`It is sunny and 24 degrees [1](${WEATHER}).`);

  const view = resolveCitations(summary.content, boundStoredSources(summary.sources));
  assert.deepEqual(
    view.cited.map(source => [source.n, source.id]),
    [[1, 'url:weather.example/berlin']]
  );
  assert.deepEqual(view.read, []);
  // The other page it read stays with the rest it found.
  assert.deepEqual(ids(view.considered), [
    'url:news.example/berlin-today',
    'url:10.20.30.40/berlin'
  ]);
});
