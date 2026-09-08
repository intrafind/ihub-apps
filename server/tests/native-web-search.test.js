/**
 * Tests for native (provider-handled) web search: Google Search grounding,
 * OpenAI Web Search, and Anthropic's web search tool.
 *
 * Native search is never modeled as a "tool" in the generic tool-calling
 * pipeline — toolLoader resolves it into a `{ provider }` directive from the
 * app's unified `websearch` config (or a workflow node's generic `webSearch`
 * marker), and each adapter injects the provider's native tool block
 * directly when building the request. Only `braveSearch` is a real,
 * script-backed tool.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNativeWebSearchProvider,
  resolveAppNativeWebSearch,
  DEFAULT_NATIVE_WEB_SEARCH_MAX_USES
} from '../toolLoader.js';
import AnthropicAdapter, { buildAnthropicWebSearchTool } from '../adapters/anthropic.js';
import GoogleAdapter from '../adapters/google.js';
import OpenAIResponsesAdapter from '../adapters/openai-responses.js';
import { convertAnthropicResponseToGeneric } from '../adapters/toolCalling/AnthropicConverter.js';
import { LLMClient } from '../services/loop/LLMClient.js';
import { AgentLoop } from '../services/loop/AgentLoop.js';
import {
  isNativeWebSearchRejection,
  isNativeWebSearchUnavailable,
  markNativeWebSearchUnavailable,
  clearNativeWebSearchFallbackMemo
} from '../services/loop/nativeWebSearchFallback.js';
import { sseResponse, fakeResponse, makeClient, MODELS } from './loop/helpers/llmFixtures.js';

const directive = provider => ({
  provider,
  maxUses: DEFAULT_NATIVE_WEB_SEARCH_MAX_USES,
  fallback: 'braveSearch'
});

describe('resolveNativeWebSearchProvider', () => {
  it('returns a provider directive for google, openai-responses, and anthropic', () => {
    assert.deepStrictEqual(resolveNativeWebSearchProvider('google'), directive('google'));
    assert.deepStrictEqual(
      resolveNativeWebSearchProvider('openai-responses'),
      directive('openai-responses')
    );
    assert.deepStrictEqual(resolveNativeWebSearchProvider('anthropic'), directive('anthropic'));
  });

  it('returns null for providers without native search', () => {
    assert.strictEqual(resolveNativeWebSearchProvider('mistral'), null);
    assert.strictEqual(resolveNativeWebSearchProvider('local'), null);
    assert.strictEqual(resolveNativeWebSearchProvider('openai'), null);
  });

  it('honours a per-model opt-out', () => {
    const optedOut = { nativeWebSearch: { enabled: false } };
    assert.strictEqual(resolveNativeWebSearchProvider('anthropic', { model: optedOut }), null);
    assert.deepStrictEqual(
      resolveNativeWebSearchProvider('anthropic', {
        model: { nativeWebSearch: { enabled: true } }
      }),
      directive('anthropic')
    );
  });

  it('caps searches per call: a positive integer wins, anything else is the default', () => {
    assert.strictEqual(resolveNativeWebSearchProvider('anthropic', { maxUses: 12 }).maxUses, 12);
    assert.strictEqual(
      resolveNativeWebSearchProvider('anthropic', { maxUses: 0 }).maxUses,
      DEFAULT_NATIVE_WEB_SEARCH_MAX_USES
    );
    assert.strictEqual(
      resolveNativeWebSearchProvider('anthropic', { maxUses: 'lots' }).maxUses,
      DEFAULT_NATIVE_WEB_SEARCH_MAX_USES
    );
  });
});

describe('resolveAppNativeWebSearch', () => {
  const baseApp = { websearch: { enabled: true, enabledByDefault: true, useNativeSearch: true } };

  it('returns null when websearch is not enabled', () => {
    assert.strictEqual(
      resolveAppNativeWebSearch({ websearch: { enabled: false } }, 'anthropic'),
      null
    );
    assert.strictEqual(resolveAppNativeWebSearch({}, 'anthropic'), null);
  });

  it('returns null when the effective toggle is off', () => {
    const app = { websearch: { enabled: true, enabledByDefault: false, useNativeSearch: true } };
    assert.strictEqual(resolveAppNativeWebSearch(app, 'anthropic', undefined), null);
    assert.deepStrictEqual(
      resolveAppNativeWebSearch(app, 'anthropic', true),
      directive('anthropic')
    );
  });

  it('returns null when useNativeSearch is false, even for a native-capable provider', () => {
    const app = { websearch: { enabled: true, enabledByDefault: true, useNativeSearch: false } };
    assert.strictEqual(resolveAppNativeWebSearch(app, 'anthropic', undefined), null);
  });

  it('returns the provider directive for a native-capable provider', () => {
    assert.deepStrictEqual(
      resolveAppNativeWebSearch(baseApp, 'google', undefined),
      directive('google')
    );
    assert.deepStrictEqual(
      resolveAppNativeWebSearch(baseApp, 'anthropic', undefined),
      directive('anthropic')
    );
  });

  it('returns null for a provider without native search (caller falls back to braveSearch)', () => {
    assert.strictEqual(resolveAppNativeWebSearch(baseApp, 'mistral', undefined), null);
  });

  it('passes the app search cap and the model opt-out through', () => {
    const app = { websearch: { ...baseApp.websearch, maxSearches: 3 } };
    assert.strictEqual(resolveAppNativeWebSearch(app, 'anthropic', undefined).maxUses, 3);
    assert.strictEqual(
      resolveAppNativeWebSearch(app, 'anthropic', undefined, {
        nativeWebSearch: { enabled: false }
      }),
      null
    );
  });
});

describe('anthropic.js createCompletionRequest — native web search', () => {
  const model = {
    modelId: 'claude-sonnet-5',
    url: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic'
  };
  const messages = [{ role: 'user', content: 'test' }];

  it('adds the native web_search tool when requested', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
      nativeWebSearch: { provider: 'anthropic' }
    });

    assert.deepStrictEqual(req.body.tools, [{ type: 'web_search_20250305', name: 'web_search' }]);
  });

  it('combines native web search with client-defined function tools', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
      nativeWebSearch: { provider: 'anthropic' },
      tools: [
        {
          id: 'myFunctionTool',
          description: 'Does something',
          parameters: { type: 'object', properties: {} }
        }
      ]
    });

    assert.strictEqual(req.body.tools.length, 2);
    assert.strictEqual(req.body.tools[0].type, 'web_search_20250305');
    assert.strictEqual(req.body.tools[1].name, 'myFunctionTool');
  });

  it('does not add the native tool when nativeWebSearch targets a different provider', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
      nativeWebSearch: { provider: 'google' }
    });

    assert.strictEqual(req.body.tools, undefined);
  });

  it('does not add the native tool when nativeWebSearch is absent', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {});
    assert.strictEqual(req.body.tools, undefined);
  });
});

describe('google.js createCompletionRequest — native web search', () => {
  const model = {
    modelId: 'gemini-2.5-flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    provider: 'google'
  };
  const messages = [{ role: 'user', content: 'test' }];

  it('adds google_search when requested', async () => {
    const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
      nativeWebSearch: { provider: 'google' }
    });

    assert.deepStrictEqual(req.body.tools, [{ google_search: {} }]);
  });

  it('drops function tools when native search is active (Gemini API limitation)', async () => {
    const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
      nativeWebSearch: { provider: 'google' },
      tools: [
        {
          id: 'myFunctionTool',
          description: 'Does something',
          parameters: { type: 'object', properties: {} }
        }
      ]
    });

    assert.deepStrictEqual(req.body.tools, [{ google_search: {} }]);
  });

  it('uses regular function declarations when native search is not requested', async () => {
    const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
      tools: [
        {
          id: 'myFunctionTool',
          description: 'Does something',
          parameters: { type: 'object', properties: {} }
        }
      ]
    });

    assert.strictEqual(req.body.tools[0].functionDeclarations[0].name, 'myFunctionTool');
  });
});

describe('openai-responses.js createCompletionRequest — native web search', () => {
  const model = {
    modelId: 'gpt-5',
    url: 'https://api.openai.com/v1/responses',
    provider: 'openai-responses'
  };
  const messages = [{ role: 'user', content: 'test' }];

  it('adds the native web_search tool when requested', async () => {
    const req = await OpenAIResponsesAdapter.createCompletionRequest(model, messages, 'key', {
      nativeWebSearch: { provider: 'openai-responses' }
    });

    assert.deepStrictEqual(req.body.tools, [{ type: 'web_search' }]);
  });

  it('combines native web search with client-defined function tools', async () => {
    const req = await OpenAIResponsesAdapter.createCompletionRequest(model, messages, 'key', {
      nativeWebSearch: { provider: 'openai-responses' },
      tools: [
        {
          id: 'myFunctionTool',
          description: 'Does something',
          parameters: { type: 'object', properties: {} }
        }
      ]
    });

    assert.strictEqual(req.body.tools.length, 2);
    assert.strictEqual(req.body.tools[0].type, 'web_search');
    assert.strictEqual(req.body.tools[1].name, 'myFunctionTool');
  });
});

describe('convertAnthropicResponseToGeneric - native web search response handling', () => {
  it('ignores server_tool_use blocks (no client tool_call is produced)', async () => {
    const streamId = `test-${Math.random()}`;
    await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }
      }),
      streamId
    );
    await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"query":"nyc weather"}' }
      }),
      streamId
    );
    const result = await convertAnthropicResponseToGeneric(
      JSON.stringify({ type: 'content_block_stop', index: 1 }),
      streamId
    );

    assert.strictEqual(result.tool_calls.length, 0);
  });

  it('collects web_search_tool_result content delivered at content_block_start', async () => {
    const streamId = `test-${Math.random()}`;
    const result = await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://example.com',
              title: 'Example',
              encrypted_content: 'abc',
              page_age: null
            }
          ]
        }
      }),
      streamId
    );

    assert.ok(result.groundingMetadata);
    assert.strictEqual(result.groundingMetadata.searchResults.length, 1);
    assert.strictEqual(result.groundingMetadata.searchResults[0].url, 'https://example.com');
  });

  it('logs and does not crash on a web_search_tool_result error payload', async () => {
    const streamId = `test-${Math.random()}`;
    const result = await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }
        }
      }),
      streamId
    );

    assert.ok(result.groundingMetadata);
    assert.strictEqual(result.groundingMetadata.searchResults.length, 0);
  });

  it('collects citations_delta events into groundingMetadata.citations', async () => {
    const streamId = `test-${Math.random()}`;
    const result = await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'content_block_delta',
        index: 3,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://example.com',
            title: 'Example',
            encrypted_index: 'idx',
            cited_text: 'Some cited text'
          }
        }
      }),
      streamId
    );

    assert.ok(result.groundingMetadata);
    assert.strictEqual(result.groundingMetadata.citations.length, 1);
    assert.strictEqual(result.groundingMetadata.citations[0].cited_text, 'Some cited text');
  });

  it('handles a full non-streaming response with search + citations across multiple text blocks', async () => {
    const streamId = `test-${Math.random()}`;
    const result = await convertAnthropicResponseToGeneric(
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll search for that." },
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'claude shannon birth date' }
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://en.wikipedia.org/wiki/Claude_Shannon',
                title: 'Claude Shannon - Wikipedia',
                encrypted_content: 'abc',
                page_age: 'April 30, 2025'
              }
            ]
          },
          {
            type: 'text',
            text: 'Claude Shannon was born on April 30, 1916.',
            citations: [
              {
                type: 'web_search_result_location',
                url: 'https://en.wikipedia.org/wiki/Claude_Shannon',
                title: 'Claude Shannon - Wikipedia',
                encrypted_index: 'idx',
                cited_text: 'Claude Elwood Shannon (April 30, 1916 ...)'
              }
            ]
          }
        ],
        id: 'msg_1',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 }
      }),
      streamId
    );

    assert.strictEqual(
      result.content.join(''),
      "I'll search for that.Claude Shannon was born on April 30, 1916."
    );
    assert.strictEqual(result.tool_calls.length, 0);
    assert.strictEqual(result.finishReason, 'stop');
    assert.ok(result.groundingMetadata);
    assert.strictEqual(result.groundingMetadata.searchResults.length, 1);
    assert.strictEqual(result.groundingMetadata.citations.length, 1);
  });
});

describe('LLMClient.complete — grounding metadata accumulation', () => {
  /**
   * Run one completion through a client whose transport streams `events` as
   * SSE and whose request construction / API-key resolution are stubbed, so
   * only the adapter's stream parsing and the client's grounding-metadata
   * merge are exercised.
   */
  function completeWith(model, events) {
    const client = new LLMClient({
      transport: async () => sseResponse(events),
      createRequest: async () => ({ url: 'https://x', headers: {}, body: {} }),
      apiKeyVerifier: { verifyApiKey: async () => ({ success: true, apiKey: 'k' }) },
      getModels: () => ({ data: [model] })
    });
    return client.complete({
      model,
      messages: [{ role: 'user', content: 'search' }],
      telemetry: { autoRun: false }
    });
  }

  it('merges Anthropic searchResults and citations arriving across many chunks', async () => {
    // Anthropic streams one web_search_tool_result block per search and one
    // citations_delta per citation — the accumulator must merge them all, not
    // keep only the arrays from the first metadata-bearing chunk.
    const events = [
      { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: {}
        }
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            { type: 'web_search_result', url: 'https://a.example', title: 'A' },
            { type: 'web_search_result', url: 'https://b.example', title: 'B' }
          ]
        }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: 'Answer with sources.' }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://a.example',
            title: 'A',
            cited_text: 'quote a'
          }
        }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://b.example',
            title: 'B',
            cited_text: 'quote b'
          }
        }
      },
      {
        type: 'content_block_start',
        index: 3,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_2',
          content: [{ type: 'web_search_result', url: 'https://c.example', title: 'C' }]
        }
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ];

    const collected = await completeWith(
      { id: 'an', provider: 'anthropic', modelId: 'claude' },
      events
    );

    assert.strictEqual(collected.content, 'Answer with sources.');
    assert.ok(collected.groundingMetadata);
    assert.deepStrictEqual(
      collected.groundingMetadata.searchResults.map(r => r.url),
      ['https://a.example', 'https://b.example', 'https://c.example']
    );
    assert.deepStrictEqual(
      collected.groundingMetadata.citations.map(c => c.url),
      ['https://a.example', 'https://b.example']
    );
  });

  it('still merges Gemini groundingChunks split across chunks', async () => {
    const chunk = (uri, title) => ({
      candidates: [
        {
          content: { parts: [{ text: '' }], role: 'model' },
          groundingMetadata: {
            groundingChunks: [{ web: { uri, title } }],
            webSearchQueries: [`q ${title}`]
          }
        }
      ]
    });
    const finish = {
      candidates: [{ content: { parts: [{ text: 'done' }], role: 'model' }, finishReason: 'STOP' }]
    };

    const collected = await completeWith({ id: 'gm', provider: 'google', modelId: 'gemini' }, [
      chunk('https://g1.example', 'G1'),
      chunk('https://g2.example', 'G2'),
      finish
    ]);

    assert.ok(collected.groundingMetadata);
    assert.deepStrictEqual(
      collected.groundingMetadata.groundingChunks.map(c => c.web.uri),
      ['https://g1.example', 'https://g2.example']
    );
    assert.deepStrictEqual(collected.groundingMetadata.webSearchQueries, ['q G1', 'q G2']);
  });
});

describe('anthropic.js — web search tool version, search cap and caller selection', () => {
  const messages = [{ role: 'user', content: 'test' }];
  const baseModel = {
    modelId: 'claude-sonnet-4-6',
    url: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic'
  };
  const capped = { provider: 'anthropic', maxUses: 4, fallback: 'braveSearch' };

  it('defaults to the basic tool version and sends the search cap as max_uses', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(baseModel, messages, 'key', {
      nativeWebSearch: capped
    });
    assert.deepStrictEqual(req.body.tools, [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 4 }
    ]);
  });

  it('pins direct calls on a newer tool version unless dynamic filtering is enabled', async () => {
    const direct = { ...baseModel, nativeWebSearch: { toolVersion: 'web_search_20260209' } };
    const req = await AnthropicAdapter.createCompletionRequest(direct, messages, 'key', {
      nativeWebSearch: capped
    });
    assert.deepStrictEqual(req.body.tools[0], {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 4,
      allowed_callers: ['direct']
    });

    const filtering = {
      ...baseModel,
      nativeWebSearch: { toolVersion: 'web_search_20260318', dynamicFiltering: true }
    };
    const req2 = await AnthropicAdapter.createCompletionRequest(filtering, messages, 'key', {
      nativeWebSearch: capped
    });
    assert.deepStrictEqual(req2.body.tools[0], {
      type: 'web_search_20260318',
      name: 'web_search',
      max_uses: 4
    });
  });

  it('falls back to the basic version for an unknown tool version and omits a missing cap', () => {
    const tool = buildAnthropicWebSearchTool(
      { nativeWebSearch: { toolVersion: 'web_search_99991231' } },
      { provider: 'anthropic' }
    );
    assert.deepStrictEqual(tool, { type: 'web_search_20250305', name: 'web_search' });
  });

  it('replays a paused assistant turn verbatim instead of flattening it to text', () => {
    const blocks = [
      { type: 'text', text: 'Searching…' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } }
    ];
    const { messages: formatted } = AnthropicAdapter.formatMessages([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'Searching…',
        providerContent: { provider: 'anthropic', blocks }
      }
    ]);
    assert.deepStrictEqual(formatted[1], { role: 'assistant', content: blocks });
  });
});

describe('convertAnthropicResponseToGeneric — search usage and pause_turn capture', () => {
  it('reads the billable search count from usage', async () => {
    const result = await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 7, server_tool_use: { web_search_requests: 2 } }
      }),
      `test-${Math.random()}`
    );
    assert.strictEqual(result.metadata.usage.completionTokens, 7);
    assert.strictEqual(result.metadata.usage.webSearchRequests, 2);
  });

  it('mirrors the streamed content blocks of a paused turn for replay', async () => {
    const streamId = `test-${Math.random()}`;
    const searchResult = {
      type: 'web_search_result',
      url: 'https://a.example',
      title: 'A',
      encrypted_content: 'enc'
    };
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 3, output_tokens: 0 } }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' this up.' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"query":' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"berlin weather"}' }
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [searchResult]
        }
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 3 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' }
    ];
    let last;
    for (const event of events) {
      last = await convertAnthropicResponseToGeneric(JSON.stringify(event), streamId);
    }
    assert.strictEqual(last.finishReason, 'pause_turn');
    assert.deepStrictEqual(last.metadata.pausedAssistantContent, [
      { type: 'text', text: 'Looking this up.' },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'berlin weather' }
      },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [searchResult] }
    ]);
  });

  it('attaches no replay content to a turn that ended normally', async () => {
    const streamId = `test-${Math.random()}`;
    await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'Hi' }
      }),
      streamId
    );
    await convertAnthropicResponseToGeneric(
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 }
      }),
      streamId
    );
    const last = await convertAnthropicResponseToGeneric(
      JSON.stringify({ type: 'message_stop' }),
      streamId
    );
    assert.strictEqual(last.finishReason, 'stop');
    assert.strictEqual(last.metadata.pausedAssistantContent, undefined);
  });

  it('captures the content of a paused non-streaming response', async () => {
    const content = [
      { type: 'text', text: 'Partial.' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } }
    ];
    const result = await convertAnthropicResponseToGeneric(
      JSON.stringify({
        role: 'assistant',
        content,
        id: 'msg_1',
        stop_reason: 'pause_turn',
        usage: { input_tokens: 1, output_tokens: 2 }
      }),
      `test-${Math.random()}`
    );
    assert.strictEqual(result.finishReason, 'pause_turn');
    assert.deepStrictEqual(result.metadata.pausedAssistantContent, content);
  });
});

describe('LLMClient — pause_turn continuation', () => {
  const model = { id: 'an', provider: 'anthropic', modelId: 'claude' };
  const messageStart = usage => ({
    type: 'message_start',
    message: { id: 'msg', role: 'assistant', usage }
  });
  const textDelta = (index, text) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text }
  });

  it('replays the paused assistant blocks on a second request and stitches the turn together', async () => {
    const first = [
      messageStart({ input_tokens: 5, output_tokens: 0 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      textDelta(0, 'Part one. '),
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' }
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'pause_turn' },
        usage: { output_tokens: 4, server_tool_use: { web_search_requests: 1 } }
      },
      { type: 'message_stop' }
    ];
    const second = [
      messageStart({ input_tokens: 10, output_tokens: 0 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      textDelta(0, 'Part two.'),
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 6, server_tool_use: { web_search_requests: 2 } }
      },
      { type: 'message_stop' }
    ];
    const responses = [sseResponse(first), sseResponse(second)];
    const requests = [];
    const client = new LLMClient({
      transport: async () => responses.shift(),
      createRequest: async (_model, messages) => {
        requests.push(messages);
        return { url: 'https://x', headers: {}, body: {} };
      },
      apiKeyVerifier: { verifyApiKey: async () => ({ success: true, apiKey: 'k' }) },
      getModels: () => ({ data: [model] })
    });

    const result = await client.complete({
      model,
      messages: [{ role: 'user', content: 'go' }],
      telemetry: { autoRun: false }
    });

    assert.strictEqual(result.content, 'Part one. Part two.');
    assert.strictEqual(result.finishReason, 'stop');
    assert.strictEqual(requests.length, 2);
    const replayed = requests[1].at(-1);
    assert.strictEqual(replayed.role, 'assistant');
    assert.strictEqual(replayed.providerContent.provider, 'anthropic');
    assert.deepStrictEqual(
      replayed.providerContent.blocks.map(block => block.type),
      ['text', 'server_tool_use']
    );
    assert.strictEqual(replayed.providerContent.blocks[1].input.query, 'x');
    // Two billable requests: tokens and searches add up across them.
    assert.strictEqual(result.usage.promptTokens, 15);
    assert.strictEqual(result.usage.completionTokens, 10);
    assert.strictEqual(result.usage.webSearchRequests, 3);
  });
});

describe('native web search fallback', () => {
  const rejected = (message, props) => Object.assign(new Error(message), props);

  it('recognises a provider refusing web search, and nothing else', () => {
    assert.ok(
      isNativeWebSearchRejection(
        rejected('Invalid request', {
          status: 400,
          details:
            '{"type":"error","error":{"type":"invalid_request_error","message":"Web search is not enabled for this organization"}}'
        })
      )
    );
    assert.ok(
      isNativeWebSearchRejection(
        rejected('tools.0: web_search_20260209 is not supported on this model', { status: 400 })
      )
    );
    assert.ok(!isNativeWebSearchRejection(rejected('Web search is not enabled', { status: 500 })));
    assert.ok(
      !isNativeWebSearchRejection(rejected('max_tokens: must be positive', { status: 400 }))
    );
    assert.ok(!isNativeWebSearchRejection(null));
  });

  it('remembers a rejection per model until it expires', () => {
    clearNativeWebSearchFallbackMemo();
    markNativeWebSearchUnavailable('m1', { ttlMs: 1000, now: 0 });
    assert.ok(isNativeWebSearchUnavailable('m1', 500));
    assert.ok(!isNativeWebSearchUnavailable('m2', 500));
    assert.ok(!isNativeWebSearchUnavailable('m1', 1001));
    clearNativeWebSearchFallbackMemo();
  });

  it('AgentLoop retries without the directive and offers the fallback tool when the provider rejects web search', async () => {
    clearNativeWebSearchFallbackMemo();
    const braveTool = {
      id: 'braveSearch',
      name: 'braveSearch',
      description: 'Brave',
      parameters: { type: 'object', properties: { query: { type: 'string' } } }
    };
    const answer = [
      {
        type: 'message_start',
        message: { id: 'msg', role: 'assistant', usage: { input_tokens: 2, output_tokens: 0 } }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Answer via Brave.' }
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' }
    ];
    const rejection = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Web search is not enabled for this organization'
      }
    };
    const { client, calls } = makeClient({
      transport: async (_request, _ctx, n) =>
        n === 1
          ? fakeResponse({
              status: 400,
              headers: { 'content-type': 'application/json' },
              text: JSON.stringify(rejection)
            })
          : sseResponse(answer)
    });
    const loop = new AgentLoop({
      llmClient: client,
      resolveNativeWebSearchFallbackTools: async directive =>
        directive.fallback === 'braveSearch' ? [braveTool] : []
    });

    const result = await loop.run({
      model: MODELS.anthropic,
      messages: [{ role: 'user', content: 'search something' }],
      tools: [],
      options: { nativeWebSearch: { provider: 'anthropic', maxUses: 5, fallback: 'braveSearch' } },
      executeTool: async () => ({ ok: true })
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.content, 'Answer via Brave.');
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].request.body.nativeWebSearch, {
      provider: 'anthropic',
      maxUses: 5,
      fallback: 'braveSearch'
    });
    assert.strictEqual(calls[1].request.body.nativeWebSearch ?? null, null);
    assert.deepStrictEqual(
      calls[1].request.body.tools.map(tool => tool.id),
      ['braveSearch']
    );
    // The rejection is remembered, so a later run skips the doomed request.
    assert.ok(isNativeWebSearchUnavailable(MODELS.anthropic.id));
    clearNativeWebSearchFallbackMemo();
  });
});
