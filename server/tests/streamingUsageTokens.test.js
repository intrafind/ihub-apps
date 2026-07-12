/**
 * Regression test for GitHub issue #1721: OpenAI-compatible streaming
 * converters (OpenAI, Mistral, vLLM) marked the stream `complete` as soon as
 * a `finish_reason` chunk arrived, so BaseAdapter/StreamingHandler stopped
 * draining the SSE stream before the trailing usage-only chunk (sent because
 * `stream_options.include_usage: true` was requested) was ever read.
 * Provider-reported token usage was silently discarded in favor of a rough
 * estimate.
 *
 * These converters must defer `complete` to the `[DONE]` sentinel so the
 * usage chunk between `finish_reason` and `[DONE]` is always processed.
 *
 * Run with: node server/tests/streamingUsageTokens.test.js
 */

import assert from 'assert';
import { convertOpenAIResponseToGeneric } from '../adapters/toolCalling/OpenAIConverter.js';
import { convertMistralResponseToGeneric } from '../adapters/toolCalling/MistralConverter.js';
import { convertVLLMResponseToGeneric } from '../adapters/toolCalling/VLLMConverter.js';
import logger from '../utils/logger.js';

let passed = 0;
let failed = 0;

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

const usageChunk = JSON.stringify({
  choices: [],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
});

function assertUsage(result) {
  assert.deepStrictEqual(result.metadata.usage, {
    promptTokens: 5,
    completionTokens: 7,
    totalTokens: 12
  });
}

await (async () => {
  await runAsync(
    'OpenAI: finish_reason chunk does not complete the stream, trailing usage chunk is read, [DONE] completes it',
    async () => {
      const streamId = 'openai-usage-1';
      const finishResult = await convertOpenAIResponseToGeneric(
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        streamId
      );
      assert.strictEqual(finishResult.complete, false);
      assert.strictEqual(finishResult.finishReason, 'stop');

      const usageResult = await convertOpenAIResponseToGeneric(usageChunk, streamId);
      assert.strictEqual(usageResult.complete, false);
      assertUsage(usageResult);

      const doneResult = await convertOpenAIResponseToGeneric('[DONE]', streamId);
      assert.strictEqual(doneResult.complete, true);
    }
  );

  await runAsync(
    'OpenAI: tool calls are still finalized on finish_reason even though complete is deferred',
    async () => {
      const streamId = 'openai-usage-tools-1';
      await convertOpenAIResponseToGeneric(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }
                ]
              }
            }
          ]
        }),
        streamId
      );
      await convertOpenAIResponseToGeneric(
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }]
        }),
        streamId
      );
      const finishResult = await convertOpenAIResponseToGeneric(
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        streamId
      );
      assert.strictEqual(finishResult.complete, false);
      assert.strictEqual(finishResult.finishReason, 'tool_calls');
      assert.strictEqual(finishResult.tool_calls.length, 1);
      assert.strictEqual(finishResult.tool_calls[0].name, 'search');
      assert.deepStrictEqual(finishResult.tool_calls[0].arguments, { q: 'x' });

      const usageResult = await convertOpenAIResponseToGeneric(usageChunk, streamId);
      assertUsage(usageResult);

      const doneResult = await convertOpenAIResponseToGeneric('[DONE]', streamId);
      assert.strictEqual(doneResult.complete, true);
    }
  );

  await runAsync(
    'Mistral: finish_reason chunk does not complete the stream, trailing usage chunk is read, [DONE] completes it',
    async () => {
      const streamId = 'mistral-usage-1';
      const finishResult = await convertMistralResponseToGeneric(
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        streamId
      );
      assert.strictEqual(finishResult.complete, false);
      assert.strictEqual(finishResult.finishReason, 'stop');

      const usageResult = await convertMistralResponseToGeneric(usageChunk, streamId);
      assert.strictEqual(usageResult.complete, false);
      assertUsage(usageResult);

      const doneResult = await convertMistralResponseToGeneric('[DONE]', streamId);
      assert.strictEqual(doneResult.complete, true);
    }
  );

  await runAsync(
    'vLLM: finish_reason chunk does not complete the stream, trailing usage chunk is read, [DONE] completes it',
    async () => {
      const streamId = 'vllm-usage-1';
      const finishResult = await convertVLLMResponseToGeneric(
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        streamId
      );
      assert.strictEqual(finishResult.complete, false);
      assert.strictEqual(finishResult.finishReason, 'stop');

      const usageResult = await convertVLLMResponseToGeneric(usageChunk, streamId);
      assert.strictEqual(usageResult.complete, false);
      assertUsage(usageResult);

      const doneResult = await convertVLLMResponseToGeneric('[DONE]', streamId);
      assert.strictEqual(doneResult.complete, true);
    }
  );

  await runAsync(
    'vLLM: tool calls finalized on finish_reason are not re-finalized when [DONE] arrives afterwards',
    async () => {
      const streamId = 'vllm-usage-tools-1';
      await convertVLLMResponseToGeneric(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":"x"}' } }
                ]
              }
            }
          ]
        }),
        streamId
      );
      const finishResult = await convertVLLMResponseToGeneric(
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        streamId
      );
      assert.strictEqual(finishResult.complete, false);
      assert.strictEqual(finishResult.tool_calls.length, 1);

      const doneResult = await convertVLLMResponseToGeneric('[DONE]', streamId);
      assert.strictEqual(doneResult.complete, true);
      assert.strictEqual(doneResult.tool_calls.length, 0);
    }
  );

  logger.info(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
