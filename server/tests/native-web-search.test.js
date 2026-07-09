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
import { resolveNativeWebSearchProvider, resolveAppNativeWebSearch } from '../toolLoader.js';
import AnthropicAdapter from '../adapters/anthropic.js';
import GoogleAdapter from '../adapters/google.js';
import OpenAIResponsesAdapter from '../adapters/openai-responses.js';
import { convertAnthropicResponseToGeneric } from '../adapters/toolCalling/AnthropicConverter.js';
import { WorkflowLLMHelper } from '../services/workflow/WorkflowLLMHelper.js';

describe('resolveNativeWebSearchProvider', () => {
  it('returns a provider directive for google, openai-responses, and anthropic', () => {
    assert.deepStrictEqual(resolveNativeWebSearchProvider('google'), { provider: 'google' });
    assert.deepStrictEqual(resolveNativeWebSearchProvider('openai-responses'), {
      provider: 'openai-responses'
    });
    assert.deepStrictEqual(resolveNativeWebSearchProvider('anthropic'), {
      provider: 'anthropic'
    });
  });

  it('returns null for providers without native search', () => {
    assert.strictEqual(resolveNativeWebSearchProvider('mistral'), null);
    assert.strictEqual(resolveNativeWebSearchProvider('local'), null);
    assert.strictEqual(resolveNativeWebSearchProvider('openai'), null);
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
    assert.deepStrictEqual(resolveAppNativeWebSearch(app, 'anthropic', true), {
      provider: 'anthropic'
    });
  });

  it('returns null when useNativeSearch is false, even for a native-capable provider', () => {
    const app = { websearch: { enabled: true, enabledByDefault: true, useNativeSearch: false } };
    assert.strictEqual(resolveAppNativeWebSearch(app, 'anthropic', undefined), null);
  });

  it('returns the provider directive for a native-capable provider', () => {
    assert.deepStrictEqual(resolveAppNativeWebSearch(baseApp, 'google', undefined), {
      provider: 'google'
    });
    assert.deepStrictEqual(resolveAppNativeWebSearch(baseApp, 'anthropic', undefined), {
      provider: 'anthropic'
    });
  });

  it('returns null for a provider without native search (caller falls back to braveSearch)', () => {
    assert.strictEqual(resolveAppNativeWebSearch(baseApp, 'mistral', undefined), null);
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

describe('WorkflowLLMHelper.processStreamingResponse — grounding metadata accumulation', () => {
  /** Build a fake fetch Response streaming the given events as SSE. */
  function sseResponse(events) {
    const payload = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        }
      })
    };
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

    const helper = new WorkflowLLMHelper();
    const collected = await helper.processStreamingResponse(sseResponse(events), {
      provider: 'anthropic'
    });

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

    const helper = new WorkflowLLMHelper();
    const collected = await helper.processStreamingResponse(
      sseResponse([chunk('https://g1.example', 'G1'), chunk('https://g2.example', 'G2'), finish]),
      { provider: 'google' }
    );

    assert.ok(collected.groundingMetadata);
    assert.deepStrictEqual(
      collected.groundingMetadata.groundingChunks.map(c => c.web.uri),
      ['https://g1.example', 'https://g2.example']
    );
    assert.deepStrictEqual(collected.groundingMetadata.webSearchQueries, ['q G1', 'q G2']);
  });
});
