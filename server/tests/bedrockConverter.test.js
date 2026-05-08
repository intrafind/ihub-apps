/**
 * Tests for BedrockConverter (non-streaming Converse response → generic format).
 *
 * Run with: node server/tests/bedrockConverter.test.js
 */

import assert from 'assert';
import {
  convertBedrockResponseToGeneric,
  convertGenericToolsToBedrock,
  convertBedrockToolUseToGeneric,
  convertBedrockToolChoice
} from '../adapters/toolCalling/BedrockConverter.js';
import logger from '../utils/logger.js';

let passed = 0;
let failed = 0;
function runTest(name, fn) {
  try {
    fn();
    logger.info(`✓ ${name}`);
    passed++;
  } catch (err) {
    logger.error(`✗ ${name}\n${err.stack || err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// (1) Plain text output
// ---------------------------------------------------------------------------
await (async () => {
  await runAsync('plain text output → generic content + stop reason + usage', async () => {
    const body = JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: 'Hello world' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }
    });
    const result = await convertBedrockResponseToGeneric(body);
    assert.deepStrictEqual(result.content, ['Hello world']);
    assert.strictEqual(result.finishReason, 'stop');
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.error, false);
    assert.deepStrictEqual(result.metadata.usage, {
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12
    });
    assert.deepStrictEqual(result.tool_calls, []);
  });

  // -------------------------------------------------------------------------
  // (2) toolUse blocks
  // -------------------------------------------------------------------------
  await runAsync('toolUse block → generic tool_calls with tool_calls finish reason', async () => {
    const body = JSON.stringify({
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'Looking up the weather…' },
            {
              toolUse: {
                toolUseId: 'tu_42',
                name: 'get_weather',
                input: { city: 'Frankfurt' }
              }
            }
          ]
        }
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 }
    });
    const result = await convertBedrockResponseToGeneric(body);
    assert.deepStrictEqual(result.content, ['Looking up the weather…']);
    assert.strictEqual(result.finishReason, 'tool_calls');
    assert.strictEqual(result.tool_calls.length, 1);
    const call = result.tool_calls[0];
    assert.strictEqual(call.id, 'tu_42');
    assert.strictEqual(call.name, 'get_weather');
    assert.deepStrictEqual(call.arguments, { city: 'Frankfurt' });
  });

  // -------------------------------------------------------------------------
  // (3) reasoningContent blocks
  // -------------------------------------------------------------------------
  await runAsync('reasoningContent → thinking[]', async () => {
    const body = JSON.stringify({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              reasoningContent: {
                reasoningText: { text: 'Step 1: parse query. Step 2: respond.' }
              }
            },
            { text: 'Answer.' }
          ]
        }
      },
      stopReason: 'end_turn'
    });
    const result = await convertBedrockResponseToGeneric(body);
    assert.deepStrictEqual(result.thinking, ['Step 1: parse query. Step 2: respond.']);
    assert.deepStrictEqual(result.content, ['Answer.']);
    assert.strictEqual(result.finishReason, 'stop');
  });

  // -------------------------------------------------------------------------
  // (4) Usage mapping (totalTokens computed when missing)
  // -------------------------------------------------------------------------
  await runAsync('usage with no totalTokens → computed total', async () => {
    const body = JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: 'Hi' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 4 }
    });
    const result = await convertBedrockResponseToGeneric(body);
    assert.strictEqual(result.metadata.usage.promptTokens, 3);
    assert.strictEqual(result.metadata.usage.completionTokens, 4);
    assert.strictEqual(result.metadata.usage.totalTokens, 7);
  });

  await runAsync('max_tokens stop reason → length', async () => {
    const body = JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: 'Truncated' }] } },
      stopReason: 'max_tokens'
    });
    const result = await convertBedrockResponseToGeneric(body);
    assert.strictEqual(result.finishReason, 'length');
  });

  await runAsync('guardrail_intervened stop reason → content_filter', async () => {
    const body = JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: '' }] } },
      stopReason: 'guardrail_intervened'
    });
    const result = await convertBedrockResponseToGeneric(body);
    assert.strictEqual(result.finishReason, 'content_filter');
  });

  // -------------------------------------------------------------------------
  // (5) Error envelope parsing
  // -------------------------------------------------------------------------
  await runAsync('error envelope (top-level "message" without "output") → error=true', async () => {
    const body = JSON.stringify({
      message:
        'Invocation of model ID amazon.nova-micro-v1:0 with on-demand throughput isn’t supported.'
    });
    const result = await convertBedrockResponseToGeneric(body);
    assert.strictEqual(result.error, true);
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.finishReason, 'error');
    assert.match(result.errorMessage, /on-demand throughput/);
    assert.deepStrictEqual(result.content, []);
  });

  await runAsync('malformed JSON → error envelope', async () => {
    const result = await convertBedrockResponseToGeneric('{not-json');
    assert.strictEqual(result.error, true);
    assert.match(result.errorMessage, /Error parsing Bedrock response/);
  });

  await runAsync('empty input → empty result without error', async () => {
    const result = await convertBedrockResponseToGeneric('');
    assert.strictEqual(result.error, false);
    assert.deepStrictEqual(result.content, []);
  });

  // -------------------------------------------------------------------------
  // Tool helpers
  // -------------------------------------------------------------------------
  runTest('convertGenericToolsToBedrock wraps tools in toolSpec envelope', () => {
    const generic = [
      {
        id: 'get_weather',
        name: 'get_weather',
        description: 'Look up current weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    ];
    const bedrockTools = convertGenericToolsToBedrock(generic);
    assert.strictEqual(bedrockTools.length, 1);
    assert.strictEqual(bedrockTools[0].toolSpec.name, 'get_weather');
    assert.strictEqual(bedrockTools[0].toolSpec.description, 'Look up current weather');
    assert.strictEqual(bedrockTools[0].toolSpec.inputSchema.json.type, 'object');
    assert.deepStrictEqual(bedrockTools[0].toolSpec.inputSchema.json.required, ['city']);
  });

  runTest('convertGenericToolsToBedrock filters provider-mismatched tools', () => {
    const generic = [
      { id: 'a', name: 'a', description: '', parameters: {}, provider: 'anthropic' },
      { id: 'b', name: 'b', description: '', parameters: {}, provider: 'bedrock' },
      { id: 'c', name: 'c', description: '', parameters: {} },
      { id: 'd', name: 'd', description: '', parameters: {}, isSpecialTool: true }
    ];
    const out = convertGenericToolsToBedrock(generic);
    const names = out.map(t => t.toolSpec.name).sort();
    assert.deepStrictEqual(names, ['b', 'c']);
  });

  runTest('convertBedrockToolUseToGeneric maps to GenericToolCall', () => {
    const tu = [{ toolUseId: 'id1', name: 'lookup', input: { q: 1 } }];
    const out = convertBedrockToolUseToGeneric(tu);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'id1');
    assert.strictEqual(out[0].name, 'lookup');
    assert.deepStrictEqual(out[0].arguments, { q: 1 });
  });

  runTest('convertBedrockToolChoice handles auto/any/named/object inputs', () => {
    assert.deepStrictEqual(convertBedrockToolChoice(undefined), { auto: {} });
    assert.deepStrictEqual(convertBedrockToolChoice('auto'), { auto: {} });
    assert.deepStrictEqual(convertBedrockToolChoice('required'), { any: {} });
    assert.deepStrictEqual(convertBedrockToolChoice('any'), { any: {} });
    assert.deepStrictEqual(convertBedrockToolChoice({ function: { name: 'f' } }), {
      tool: { name: 'f' }
    });
    assert.deepStrictEqual(convertBedrockToolChoice({ tool: { name: 'g' } }), {
      tool: { name: 'g' }
    });
    assert.deepStrictEqual(convertBedrockToolChoice({ auto: {} }), { auto: {} });
  });

  logger.info(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

async function runAsync(name, fn) {
  try {
    await fn();
    logger.info(`✓ ${name}`);
    passed++;
  } catch (err) {
    logger.error(`✗ ${name}\n${err.stack || err.message}`);
    failed++;
  }
}
