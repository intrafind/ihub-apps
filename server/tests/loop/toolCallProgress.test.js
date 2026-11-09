// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Early tool-call progress at the converters (issue #3534, AC-12).
 *
 * While a tool call's arguments stream, the converters that can see the call
 * being built add `toolCallProgress: [{ index, id?, name?, argBytes }]` to the
 * chunk they return: absolute values, only when something changed, and never a
 * change to the finished `tool_calls`. A provider that sends the call whole (a
 * parser that buffers upstream, Google, Mistral) produces no signal.
 *
 * Every spec feeds recorded-style stream events through the real converter (or
 * the Bedrock adapter's stream parser) and reads the chunk the loop would see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertResponseToGeneric,
  clearStreamingState,
  createGenericToolCall
} from '../../adapters/toolCalling/index.js';
import BedrockAdapter from '../../adapters/bedrock.js';
import { normalizeChunk, ResultAccumulator } from '../../services/loop/LLMClient.js';
import { bedrockResponse } from './helpers/llmFixtures.js';
import {
  arrivedWhole,
  progressEntry,
  utf8Bytes
} from '../../adapters/toolCalling/toolCallProgress.js';

const ARGS = JSON.stringify({ filename: 'a.html', content: '<p>Grüße</p>' });

let streamCounter = 0;
/** Feed events through a converter on a fresh stream; returns the chunk of each event. */
async function feed(provider, events) {
  const streamId = `progress-${streamCounter++}`;
  const chunks = [];
  try {
    for (const event of events) {
      const data = typeof event === 'string' ? event : JSON.stringify(event);
      chunks.push(await convertResponseToGeneric(data, provider, streamId));
    }
  } finally {
    clearStreamingState(provider, streamId);
  }
  return chunks;
}

const progressOf = chunks => chunks.map(c => c.toolCallProgress);

// ── helpers ─────────────────────────────────────────────────────────────────

test('utf8Bytes counts bytes, not characters; arrivedWhole needs a parsing JSON object', () => {
  assert.equal(utf8Bytes('Grüße'), 7);
  assert.equal(utf8Bytes(''), 0);
  assert.equal(utf8Bytes(undefined), 0);
  assert.equal(arrivedWhole('{"a":1}'), true);
  assert.equal(arrivedWhole('{"a":'), false);
  assert.equal(arrivedWhole(''), false);
  assert.equal(arrivedWhole('"text"'), false);
});

test('progressEntry reports a call once per change and nothing for a call that arrived whole', () => {
  const holder = {};
  assert.deepEqual(progressEntry(holder, { index: 0, id: 'a', name: 'n', argBytes: 0 }), {
    index: 0,
    id: 'a',
    name: 'n',
    argBytes: 0
  });
  assert.equal(progressEntry(holder, { index: 0, id: 'a', name: 'n', argBytes: 0 }), null);
  assert.equal(progressEntry(holder, { index: 0, id: 'a', name: 'n', argBytes: 5 }).argBytes, 5);
  assert.equal(progressEntry({}, { index: 0, id: '', name: '', argBytes: 0 }), null);
  assert.equal(
    progressEntry({ progressSuppressed: true }, { index: 0, id: 'a', name: 'n', argBytes: 9 }),
    null
  );
});

// ── OpenAI chat completions and vLLM (same wire format) ─────────────────────

const openaiDelta = (toolCalls, extra = {}) => ({
  choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null, ...extra }]
});

for (const [label, provider, originalFormat] of [
  ['OpenAI', 'openai', 'openai'],
  ['vLLM', 'local', 'vllm']
]) {
  test(`${label}: the name is reported before the id; the arguments grow; the finished call is unchanged`, async () => {
    const half = Math.floor(ARGS.length / 2);
    const chunks = await feed(provider, [
      { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      // The name comes first, the id only with a later fragment (risk R2).
      openaiDelta([{ index: 0, function: { name: 'create_web_artifact', arguments: '' } }]),
      openaiDelta([{ index: 0, id: 'call_7', type: 'function', function: { arguments: '' } }]),
      openaiDelta([{ index: 0, function: { arguments: ARGS.slice(0, half) } }]),
      openaiDelta([{ index: 0, function: { arguments: ARGS.slice(half) } }]),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ]);

    assert.equal('toolCallProgress' in chunks[0], false, 'a chunk without a call carries no field');
    assert.deepEqual(chunks[1].toolCallProgress, [
      { index: 0, name: 'create_web_artifact', argBytes: 0 }
    ]);
    assert.deepEqual(chunks[2].toolCallProgress, [
      { index: 0, id: 'call_7', name: 'create_web_artifact', argBytes: 0 }
    ]);
    const grown = [chunks[3], chunks[4]].map(c => c.toolCallProgress[0].argBytes);
    assert.equal(grown[0], utf8Bytes(ARGS.slice(0, half)));
    assert.equal(grown[1], utf8Bytes(ARGS), 'absolute: the bytes of everything received so far');
    assert.ok(grown[1] > grown[0], 'argBytes never decreases');
    assert.ok(chunks[3].toolCallProgress[0].id, 'every entry repeats what is known (absolute)');

    const finished = chunks[5];
    assert.equal(
      'toolCallProgress' in finished,
      false,
      'the finishing chunk carries the call itself'
    );
    assert.deepEqual(finished.tool_calls, [
      createGenericToolCall('call_7', 'create_web_artifact', JSON.parse(ARGS), 0, {
        originalFormat,
        type: 'function'
      })
    ]);
    assert.equal(finished.finishReason, 'tool_calls');
  });

  test(`${label}: two calls are reported by their own index`, async () => {
    const chunks = await feed(provider, [
      openaiDelta([
        { index: 0, id: 'a', function: { name: 'create_file', arguments: '{"x"' } },
        { index: 1, id: 'b', function: { name: 'create_zip', arguments: '{' } }
      ]),
      openaiDelta([{ index: 1, function: { arguments: '"y":1' } }])
    ]);
    assert.deepEqual(chunks[0].toolCallProgress, [
      { index: 0, id: 'a', name: 'create_file', argBytes: 4 },
      { index: 1, id: 'b', name: 'create_zip', argBytes: 1 }
    ]);
    // Only the call this chunk touched is reported again.
    assert.deepEqual(chunks[1].toolCallProgress, [
      { index: 1, id: 'b', name: 'create_zip', argBytes: 6 }
    ]);
  });

  test(`${label}: a parser that buffers upstream gives no signal`, async () => {
    // The whole call arrives in one delta, then the finish: nothing says what is coming.
    const buffered = await feed(provider, [
      openaiDelta([
        { index: 0, id: 'call_1', function: { name: 'create_web_artifact', arguments: ARGS } }
      ]),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ]);
    assert.deepEqual(progressOf(buffered), [undefined, undefined]);
    assert.equal(buffered[1].tool_calls.length, 1, 'the call still finishes as before');

    // The whole call together with the finish frame.
    const atFinish = await feed(provider, [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'create_file', arguments: ARGS } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      }
    ]);
    assert.equal('toolCallProgress' in atFinish[0], false);
    assert.equal(atFinish[0].tool_calls.length, 1);
  });

  test(`${label}: an empty placeholder fragment reports nothing`, async () => {
    const chunks = await feed(provider, [
      openaiDelta([{ index: 0, id: 'a', function: { name: 'create_file', arguments: '' } }]),
      openaiDelta([{ index: 0, function: { arguments: '' } }])
    ]);
    assert.ok(chunks[0].toolCallProgress);
    assert.equal('toolCallProgress' in chunks[1], false);
  });
}

// ── Anthropic ───────────────────────────────────────────────────────────────

test('Anthropic: content_block_start gives name and id, input_json_delta the size; the finished call is unchanged', async () => {
  const half = Math.floor(ARGS.length / 2);
  const chunks = await feed('anthropic', [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'create_web_artifact', input: {} }
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: ARGS.slice(0, half) }
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: ARGS.slice(half) }
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' }
  ]);

  assert.deepEqual(progressOf(chunks.slice(0, 4)), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(chunks[4].toolCallProgress, [
    { index: 0, id: 'toolu_1', name: 'create_web_artifact', argBytes: 0 }
  ]);
  assert.equal(chunks[5].toolCallProgress[0].argBytes, utf8Bytes(ARGS.slice(0, half)));
  assert.equal(chunks[6].toolCallProgress[0].argBytes, utf8Bytes(ARGS));
  assert.equal(chunks[6].toolCallProgress[0].id, 'toolu_1');

  const stop = chunks[7];
  assert.equal('toolCallProgress' in stop, false);
  assert.deepEqual(stop.tool_calls, [
    createGenericToolCall('toolu_1', 'create_web_artifact', JSON.parse(ARGS), 0, {
      originalFormat: 'anthropic',
      type: 'tool_use'
    })
  ]);
});

test('Anthropic: a second tool_use block is reported under the index its finished call gets', async () => {
  const chunks = await feed('anthropic', [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't1', name: 'a' }
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' }
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 't2', name: 'b' }
    }
  ]);
  assert.equal(chunks[2].tool_calls[0].index, 0);
  assert.deepEqual(chunks[3].toolCallProgress, [{ index: 1, id: 't2', name: 'b', argBytes: 0 }]);
});

// ── OpenAI Responses ────────────────────────────────────────────────────────

test('OpenAI Responses: progress is derived from the existing events and keeps the call_id', async () => {
  const half = Math.floor(ARGS.length / 2);
  const chunks = await feed('openai-responses', [
    { type: 'response.created', response: {} },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_9',
        call_id: 'call_x',
        name: 'create_web_artifact',
        arguments: ''
      }
    },
    // Argument deltas name the item (`fc_…`), not the call.
    {
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_9',
      delta: ARGS.slice(0, half)
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_9',
      delta: ARGS.slice(half)
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 1,
      item_id: 'fc_9',
      arguments: ARGS
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_9',
        call_id: 'call_x',
        name: 'create_web_artifact',
        arguments: ARGS
      }
    },
    { type: 'response.completed', response: { output: [{ type: 'function_call' }] } }
  ]);

  assert.equal('toolCallProgress' in chunks[0], false);
  assert.deepEqual(chunks[1].toolCallProgress, [
    { index: 1, id: 'call_x', name: 'create_web_artifact', argBytes: 0 }
  ]);
  assert.deepEqual(chunks[2].toolCallProgress, [
    {
      index: 1,
      id: 'call_x',
      name: 'create_web_artifact',
      argBytes: utf8Bytes(ARGS.slice(0, half))
    }
  ]);
  assert.equal(chunks[3].toolCallProgress[0].argBytes, utf8Bytes(ARGS));
  // The done events add nothing the deltas had not said.
  assert.equal('toolCallProgress' in chunks[4], false);
  assert.equal('toolCallProgress' in chunks[5], false);

  // The loop merges the existing deltas as before; the field is ignored there
  // and the call the early signal named is the call that finishes.
  const acc = new ResultAccumulator({});
  for (const chunk of chunks) acc.push(normalizeChunk(chunk));
  assert.equal(acc.toolCalls.length, 1);
  assert.equal(acc.toolCalls[0].id, 'call_x');
  assert.equal(acc.toolCalls[0].index, 1);
  assert.equal(acc.toolCalls[0].function.arguments, ARGS);
  assert.equal('toolCallProgress' in acc.snapshot(), false);
});

// ── Bedrock (the adapter's event-stream parser) ─────────────────────────────

test('Bedrock: toolUse start and input fragments report progress; the finished call is unchanged', async () => {
  const half = Math.floor(ARGS.length / 2);
  const frames = [
    { eventType: 'messageStart', payload: { role: 'assistant' } },
    {
      eventType: 'contentBlockStart',
      payload: {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: 'tu_1', name: 'create_web_artifact' } }
      }
    },
    {
      eventType: 'contentBlockDelta',
      payload: { contentBlockIndex: 1, delta: { toolUse: { input: ARGS.slice(0, half) } } }
    },
    {
      eventType: 'contentBlockDelta',
      payload: { contentBlockIndex: 1, delta: { toolUse: { input: ARGS.slice(half) } } }
    },
    { eventType: 'contentBlockStop', payload: { contentBlockIndex: 1 } },
    { eventType: 'messageStop', payload: { stopReason: 'tool_use' } },
    {
      eventType: 'metadata',
      payload: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
    }
  ];
  const chunks = [];
  for await (const chunk of BedrockAdapter.parseResponseStream(bedrockResponse(frames))) {
    chunks.push(chunk);
  }
  const progress = chunks.filter(c => c.toolCallProgress).map(c => c.toolCallProgress[0]);
  assert.deepEqual(progress, [
    { index: 1, id: 'tu_1', name: 'create_web_artifact', argBytes: 0 },
    { index: 1, id: 'tu_1', name: 'create_web_artifact', argBytes: utf8Bytes(ARGS.slice(0, half)) },
    { index: 1, id: 'tu_1', name: 'create_web_artifact', argBytes: utf8Bytes(ARGS) }
  ]);
  const finished = chunks.filter(c => c.tool_calls);
  assert.deepEqual(finished, [
    {
      tool_calls: [
        {
          index: 1,
          id: 'tu_1',
          type: 'function',
          function: { name: 'create_web_artifact', arguments: JSON.stringify(JSON.parse(ARGS)) }
        }
      ]
    }
  ]);
});

// ── Google and Mistral: calls arrive whole, no early signal ─────────────────

test('Google and Mistral give no early signal and their output is unchanged', async () => {
  const [google] = await feed('google', [
    {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'create_file', args: { content: 'x' } } }] } }
      ]
    }
  ]);
  assert.equal('toolCallProgress' in google, false);
  assert.equal(google.tool_calls[0].name, 'create_file');

  const [mistral] = await feed('mistral', [
    openaiDelta([{ index: 0, id: 'abc', function: { name: 'create_file', arguments: '{"a":1}' } }])
  ]);
  assert.equal('toolCallProgress' in mistral, false);
  assert.equal(mistral.tool_calls[0].id, 'abc');
});

// ── on the way to the loop ──────────────────────────────────────────────────

test('normalizeChunk passes the field through and ResultAccumulator ignores it', () => {
  const entry = { index: 0, id: 'a', name: 'n', argBytes: 3 };
  const chunk = normalizeChunk({ content: ['x'], toolCallProgress: [entry] });
  assert.deepEqual(chunk.toolCallProgress, [entry]);
  assert.deepEqual(chunk.tool_calls, []);
  const acc = new ResultAccumulator({});
  acc.push(chunk);
  const snapshot = acc.snapshot();
  assert.equal(snapshot.content, 'x');
  assert.deepEqual(snapshot.toolCalls, []);
  assert.equal('toolCallProgress' in snapshot, false);
});
