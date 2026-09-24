/**
 * Prompt-cache usage capture (issue #2508, phase 1) — every provider's usage
 * payload, driven through the public LLMClient with wire-level fixtures shaped
 * like the real provider responses.
 *
 * Canonical shape: `promptTokens` is the whole input with cached tokens
 * included, `completionTokens` the whole output with reasoning included;
 * `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` are set only when
 * the provider reported them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeClient,
  sseResponse,
  jsonResponse,
  bedrockResponse,
  fakeResponse,
  openaiText
} from './helpers/llmFixtures.js';
import { TRAILING_USAGE_WAIT_MS } from '../../adapters/BaseAdapter.js';
import {
  normalizeUsage,
  mergeUsage,
  addUsage,
  usageToOpenAI
} from '../../services/loop/llmUsage.js';

const messages = [{ role: 'user', content: 'hello' }];
const NO_RUN = { autoRun: false };

async function run(modelId, response, extra = {}) {
  const { client } = makeClient({ transport: async () => response });
  return client.complete({ modelId, messages, telemetry: NO_RUN, ...extra });
}

/** Real adapter request building, so `stream_options.include_usage` is set. */
async function runReal(modelId, response, extra = {}) {
  const { client, calls } = makeClient({ realRequest: true, transport: async () => response });
  const result = await client.complete({ modelId, messages, telemetry: NO_RUN, ...extra });
  return { result, request: calls[0]?.request };
}

// ── OpenAI Chat Completions ─────────────────────────────────────────────────

const OPENAI_USAGE = {
  prompt_tokens: 2006,
  completion_tokens: 300,
  total_tokens: 2306,
  prompt_tokens_details: { cached_tokens: 1920, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 128, audio_tokens: 0 }
};

test('[oa] the trailing include_usage frame after finish_reason is read (real OpenAI order)', async () => {
  const { result, request } = await runReal(
    'oa',
    sseResponse([
      ...openaiText(['Hel', 'lo']).slice(0, -1),
      { choices: [], usage: OPENAI_USAGE },
      '[DONE]'
    ])
  );
  assert.deepEqual(request.body.stream_options, { include_usage: true });
  assert.equal(result.content, 'Hello');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.complete, true);
  assert.equal(result.usage.promptTokens, 2006);
  assert.equal(result.usage.completionTokens, 300);
  assert.equal(result.usage.totalTokens, 2306);
  assert.equal(result.usage.cacheReadTokens, 1920);
  assert.equal(result.usage.reasoningTokens, 128);
  assert.equal(result.usage.cacheWriteTokens, undefined);
  assert.equal(result.usage.source, 'provider');
});

test('[oa] the finish chunk is delivered exactly once, carrying the trailing usage', async () => {
  const { client } = makeClient({
    realRequest: true,
    transport: async () =>
      sseResponse([
        ...openaiText(['x']).slice(0, -1),
        { choices: [], usage: OPENAI_USAGE },
        '[DONE]'
      ])
  });
  const chunks = [];
  await client.complete({
    modelId: 'oa',
    messages,
    telemetry: NO_RUN,
    onChunk: c => chunks.push(c)
  });
  const finishing = chunks.filter(c => c.complete);
  assert.equal(finishing.length, 1);
  assert.equal(finishing[0].finishReason, 'stop');
  assert.equal(finishing[0].usage.cacheReadTokens, 1920);
});

test('[oa] include_usage requested but the server sends no usage frame: the stream still completes', async () => {
  const { result } = await runReal('oa', sseResponse(openaiText(['ok'])));
  assert.equal(result.content, 'ok');
  assert.equal(result.complete, true);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage, null);
});

test('[oa] include_usage requested and the body ends right after finish_reason: still completes', async () => {
  const { result } = await runReal('oa', sseResponse(openaiText(['ok']).slice(0, -1)));
  assert.equal(result.content, 'ok');
  assert.equal(result.complete, true);
});

test('[oa] finish frame then an open body with nothing more: completes after the grace period', async () => {
  const wire = openaiText(['ok'])
    .slice(0, -1)
    .map(e => `data: ${JSON.stringify(e)}\n\n`)
    .join('');
  // A body that never closes and never sends usage or [DONE].
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
    }
  });
  const started = Date.now();
  const { result } = await runReal(
    'oa',
    fakeResponse({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body,
      text: wire
    })
  );
  assert.equal(result.content, 'ok');
  assert.equal(result.complete, true);
  assert.equal(result.usage, null);
  assert.ok(Date.now() - started >= TRAILING_USAGE_WAIT_MS - 50, 'waited for the usage frame');
});

test('[oa] non-streaming body keeps cached and reasoning tokens', async () => {
  const result = await run(
    'oa',
    jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: OPENAI_USAGE
    }),
    { stream: false }
  );
  assert.equal(result.usage.cacheReadTokens, 1920);
  assert.equal(result.usage.reasoningTokens, 128);
});

test('[oa] no cache details reported → no cache fields (not reported ≠ zero)', async () => {
  const result = await run(
    'oa',
    sseResponse(openaiText(['x'], { usage: { prompt_tokens: 4, completion_tokens: 1 } }))
  );
  assert.equal(result.usage.promptTokens, 4);
  assert.equal('cacheReadTokens' in result.usage, false);
  assert.equal('reasoningTokens' in result.usage, false);
});

// ── vLLM (provider `local`) ─────────────────────────────────────────────────

test('[vl] vLLM trailing usage frame with prefix-cache hits', async () => {
  const { result } = await runReal(
    'vl',
    sseResponse([
      ...openaiText(['x']).slice(0, -1),
      {
        choices: [],
        usage: {
          prompt_tokens: 900,
          completion_tokens: 12,
          total_tokens: 912,
          prompt_tokens_details: { cached_tokens: 768 }
        }
      },
      '[DONE]'
    ])
  );
  assert.equal(result.usage.promptTokens, 900);
  assert.equal(result.usage.cacheReadTokens, 768);
});

test('[vl] vLLM non-streaming body usage', async () => {
  const result = await run(
    'vl',
    jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
    }),
    { stream: false }
  );
  assert.equal(result.usage.totalTokens, 4);
});

// ── Mistral ─────────────────────────────────────────────────────────────────

test('[ms] mistral cached prompt tokens', async () => {
  const result = await run(
    'ms',
    sseResponse(
      openaiText(['x'], {
        usage: {
          prompt_tokens: 50,
          completion_tokens: 2,
          total_tokens: 52,
          prompt_tokens_details: { cached_tokens: 32 }
        }
      })
    )
  );
  assert.equal(result.usage.promptTokens, 50);
  assert.equal(result.usage.cacheReadTokens, 32);
});

// ── Anthropic ───────────────────────────────────────────────────────────────

test('[an] cache read/write are added back into promptTokens (input_tokens excludes them)', async () => {
  const result = await run(
    'an',
    sseResponse([
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          usage: {
            input_tokens: 21,
            cache_creation_input_tokens: 188,
            cache_read_input_tokens: 1800,
            cache_creation: { ephemeral_5m_input_tokens: 188, ephemeral_1h_input_tokens: 0 },
            output_tokens: 1
          }
        }
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        // Cumulative usage on message_delta repeats the input counters.
        usage: {
          input_tokens: 21,
          cache_creation_input_tokens: 188,
          cache_read_input_tokens: 1800,
          output_tokens: 57
        }
      },
      { type: 'message_stop' }
    ])
  );
  assert.equal(result.usage.promptTokens, 21 + 188 + 1800);
  assert.equal(result.usage.cacheReadTokens, 1800);
  assert.equal(result.usage.cacheWriteTokens, 188);
  assert.equal(result.usage.completionTokens, 57);
  assert.equal(result.usage.totalTokens, 21 + 188 + 1800 + 57);
});

test('[an] non-streaming message body with cache counters', async () => {
  const result = await run(
    'an',
    jsonResponse({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'A' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1200,
        output_tokens: 6
      }
    }),
    { stream: false }
  );
  assert.equal(result.usage.promptTokens, 1205);
  assert.equal(result.usage.cacheReadTokens, 1200);
  assert.equal(result.usage.cacheWriteTokens, 0);
  assert.equal(result.usage.totalTokens, 1211);
});

// ── Google Gemini ───────────────────────────────────────────────────────────

test('[gm] cachedContentTokenCount and thinking tokens', async () => {
  const result = await run(
    'gm',
    sseResponse([
      {
        candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' } }],
        usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 1, totalTokenCount: 4001 }
      },
      {
        candidates: [{ content: { parts: [{ text: '!' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 4000,
          cachedContentTokenCount: 3072,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 80,
          totalTokenCount: 4100
        }
      }
    ])
  );
  assert.equal(result.usage.promptTokens, 4000);
  assert.equal(result.usage.cacheReadTokens, 3072);
  // Thinking is billed as output: completionTokens covers it.
  assert.equal(result.usage.completionTokens, 100);
  assert.equal(result.usage.reasoningTokens, 80);
  assert.equal(result.usage.totalTokens, 4100);
});

// ── OpenAI Responses ────────────────────────────────────────────────────────

const RESPONSES_USAGE = {
  input_tokens: 5000,
  input_tokens_details: { cached_tokens: 4864 },
  output_tokens: 250,
  output_tokens_details: { reasoning_tokens: 200 },
  total_tokens: 5250
};

test('[or] response.completed usage keeps cached and reasoning tokens', async () => {
  const result = await run(
    'or',
    sseResponse([
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_text.delta', delta: 'Hi' },
      { type: 'response.completed', response: { id: 'r1', output: [], usage: RESPONSES_USAGE } }
    ])
  );
  assert.equal(result.usage.promptTokens, 5000);
  assert.equal(result.usage.cacheReadTokens, 4864);
  assert.equal(result.usage.reasoningTokens, 200);
  assert.equal(result.usage.totalTokens, 5250);
});

test('[or] non-streaming response body usage is captured', async () => {
  const result = await run(
    'or',
    jsonResponse({
      id: 'r1',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi', annotations: [] }]
        }
      ],
      usage: RESPONSES_USAGE
    }),
    { stream: false }
  );
  assert.equal(result.content, 'Hi');
  assert.equal(result.usage.promptTokens, 5000);
  assert.equal(result.usage.cacheReadTokens, 4864);
});

// ── Bedrock Converse ────────────────────────────────────────────────────────

test('[br] streaming metadata usage: cache read/write added back into promptTokens', async () => {
  const result = await run(
    'br',
    bedrockResponse([
      { eventType: 'messageStart', payload: { role: 'assistant' } },
      { eventType: 'contentBlockDelta', payload: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
      { eventType: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
      { eventType: 'messageStop', payload: { stopReason: 'end_turn' } },
      {
        eventType: 'metadata',
        payload: {
          usage: {
            inputTokens: 4,
            outputTokens: 180,
            totalTokens: 1650,
            cacheReadInputTokens: 1466,
            cacheWriteInputTokens: 0
          }
        }
      }
    ])
  );
  assert.equal(result.usage.promptTokens, 1470);
  assert.equal(result.usage.cacheReadTokens, 1466);
  assert.equal(result.usage.cacheWriteTokens, 0);
  assert.equal(result.usage.completionTokens, 180);
  assert.equal(result.usage.totalTokens, 1650);
});

test('[br] non-streaming Converse body with cache counters', async () => {
  const result = await run(
    'br',
    jsonResponse({
      output: { message: { role: 'assistant', content: [{ text: 'Hi' }] } },
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 1012,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 1000
      }
    }),
    { stream: false }
  );
  assert.equal(result.usage.promptTokens, 1010);
  assert.equal(result.usage.cacheWriteTokens, 1000);
  assert.equal(result.usage.totalTokens, 1012);
});

test('[br] metadata frame without token counts reports no usage', async () => {
  const result = await run(
    'br',
    bedrockResponse([
      { eventType: 'contentBlockDelta', payload: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
      { eventType: 'messageStop', payload: { stopReason: 'end_turn' } },
      { eventType: 'metadata', payload: { metrics: { latencyMs: 12 } } }
    ])
  );
  assert.equal(result.usage, null);
});

// ── llmUsage helpers ────────────────────────────────────────────────────────

test('normalizeUsage maps raw Bedrock cache fields', () => {
  const usage = normalizeUsage({
    inputTokens: 4,
    outputTokens: 1,
    cacheReadInputTokens: 10,
    cacheWriteInputTokens: 2
  });
  assert.equal(usage.cacheReadTokens, 10);
  assert.equal(usage.cacheWriteTokens, 2);
  assert.deepEqual(normalizeUsage({ cacheWriteTokens: 5 }).cacheWriteTokens, 5);
});

test('mergeUsage keeps cache counters a later frame omits, and never lowers them', () => {
  const start = normalizeUsage({ promptTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 20 });
  const delta = normalizeUsage({ completionTokens: 7 });
  const merged = mergeUsage(start, delta);
  assert.equal(merged.cacheReadTokens, 80);
  assert.equal(merged.cacheWriteTokens, 20);
  assert.equal(merged.promptTokens, 100);
  assert.equal(merged.completionTokens, 7);
  const lower = mergeUsage(merged, normalizeUsage({ completionTokens: 7, cacheReadTokens: 0 }));
  assert.equal(lower.cacheReadTokens, 80);
  const reasoning = mergeUsage(
    normalizeUsage({ completionTokens: 5, reasoningTokens: 3 }),
    normalizeUsage({ completionTokens: 9, reasoningTokens: 6 })
  );
  assert.equal(reasoning.reasoningTokens, 6);
});

test('addUsage sums cache counters across calls', () => {
  const sum = addUsage(
    normalizeUsage({ promptTokens: 100, cacheReadTokens: 80 }),
    normalizeUsage({ promptTokens: 50, cacheWriteTokens: 50 })
  );
  assert.equal(sum.promptTokens, 150);
  assert.equal(sum.cacheReadTokens, 80);
  assert.equal(sum.cacheWriteTokens, 50);
});

test('usageToOpenAI carries cached and reasoning tokens as OpenAI detail objects', () => {
  assert.deepEqual(
    usageToOpenAI(
      normalizeUsage({
        promptTokens: 10,
        completionTokens: 5,
        cacheReadTokens: 8,
        reasoningTokens: 2
      })
    ),
    {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 2 }
    }
  );
});
