/**
 * Tests for Anthropic's native (server-side) web search tool support.
 * See https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  convertGenericToolsToAnthropic,
  convertAnthropicResponseToGeneric
} from '../adapters/toolCalling/AnthropicConverter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolsConfigPath = join(__dirname, '../defaults/config/tools.json');

describe('tools.json anthropicWebSearch definition', () => {
  it('registers a special tool scoped to the anthropic provider', () => {
    const tools = JSON.parse(readFileSync(toolsConfigPath, 'utf8'));
    const tool = tools.find(t => t.id === 'anthropicWebSearch');

    assert.ok(tool, 'anthropicWebSearch tool definition should exist');
    assert.strictEqual(tool.provider, 'anthropic');
    assert.strictEqual(tool.isSpecialTool, true);
  });
});

describe('convertGenericToolsToAnthropic - native web search', () => {
  it('converts the anthropicWebSearch special tool into the native web_search tool type', () => {
    const tools = convertGenericToolsToAnthropic([
      { id: 'anthropicWebSearch', provider: 'anthropic', isSpecialTool: true, parameters: {} }
    ]);

    assert.strictEqual(tools.length, 1);
    assert.deepStrictEqual(tools[0], { type: 'web_search_20250305', name: 'web_search' });
  });

  it('passes through max_uses, domain filters and user_location', () => {
    const tools = convertGenericToolsToAnthropic([
      {
        id: 'anthropicWebSearch',
        provider: 'anthropic',
        isSpecialTool: true,
        parameters: {},
        max_uses: 3,
        allowed_domains: ['example.com'],
        user_location: { type: 'approximate', country: 'US' }
      }
    ]);

    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].max_uses, 3);
    assert.deepStrictEqual(tools[0].allowed_domains, ['example.com']);
    assert.deepStrictEqual(tools[0].user_location, { type: 'approximate', country: 'US' });
  });

  it('does not include both allowed_domains and blocked_domains at once', () => {
    const tools = convertGenericToolsToAnthropic([
      {
        id: 'anthropicWebSearch',
        provider: 'anthropic',
        isSpecialTool: true,
        parameters: {},
        allowed_domains: ['example.com'],
        blocked_domains: ['blocked.com']
      }
    ]);

    assert.deepStrictEqual(tools[0].allowed_domains, ['example.com']);
    assert.strictEqual(tools[0].blocked_domains, undefined);
  });

  it('can be combined with regular client-defined function tools', () => {
    const tools = convertGenericToolsToAnthropic([
      { id: 'anthropicWebSearch', provider: 'anthropic', isSpecialTool: true, parameters: {} },
      {
        id: 'myFunctionTool',
        description: 'Does something',
        parameters: { type: 'object', properties: {} }
      }
    ]);

    assert.strictEqual(tools.length, 2);
    assert.strictEqual(tools[0].type, 'web_search_20250305');
    assert.strictEqual(tools[1].name, 'myFunctionTool');
  });

  it('other providers special tools (googleSearch, webSearch) are still filtered out', () => {
    const tools = convertGenericToolsToAnthropic([
      { id: 'googleSearch', provider: 'google', isSpecialTool: true, parameters: {} },
      { id: 'webSearch', provider: 'openai-responses', isSpecialTool: true, parameters: {} }
    ]);

    assert.strictEqual(tools.length, 0);
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
