/**
 * Adapter conformance matrix — every registered provider driven through the
 * public LLMClient with wire-level fixtures. Scenarios (concept R14):
 *
 *   1. text stream           5. thinking            8e. in-band provider error
 *   2. tool-call accumulation 7. usage frames        8f. malformed JSON
 *   3. parallel tool calls   8d. empty response      9. abort mid-stream
 *  10. collect ≡ stream (non-streaming body through the same client)
 *
 * Known provider gaps are asserted deliberately (marked GAP) so they flip
 * when fixed instead of silently changing behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';
import {
  makeClient,
  sseResponse,
  jsonResponse,
  bedrockResponse,
  bytesStream,
  fakeResponse,
  openaiText
} from './helpers/llmFixtures.js';

const messages = [{ role: 'user', content: 'weather in Berlin?' }];
const NO_RUN = { autoRun: false };

async function run(modelId, response, extra = {}) {
  const { client } = makeClient({ transport: async () => response });
  return client.complete({ modelId, messages, telemetry: NO_RUN, ...extra });
}

async function runChunks(modelId, response) {
  const { client } = makeClient({ transport: async () => response });
  const chunks = [];
  const result = await client.complete({
    modelId,
    messages,
    telemetry: NO_RUN,
    onChunk: c => chunks.push(c)
  });
  return { chunks, result };
}

function expectSingleCall(result, { name, args, id }) {
  assert.equal(
    result.toolCalls.length,
    1,
    `exactly one tool call, got ${JSON.stringify(result.toolCalls)}`
  );
  const call = result.toolCalls[0];
  assert.equal(call.function.name, name);
  assert.deepEqual(JSON.parse(call.function.arguments), args);
  if (id) assert.equal(call.id, id);
  assert.equal(call.type, 'function');
  assert.equal(typeof call.index, 'number');
}

// ── openai / local (vLLM) / mistral: OpenAI-compatible chat completions ─────

const openaiToolStream = [
  {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '' }
            }
          ]
        },
        finish_reason: null
      }
    ]
  },
  {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] },
        finish_reason: null
      }
    ]
  },
  {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Berlin"}' } }] },
        finish_reason: null
      }
    ]
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]'
];

for (const provider of ['oa', 'vl', 'ms']) {
  test(`[${provider}] 1. text stream — ordered content, complete once, finishReason stop`, async () => {
    const { chunks, result } = await runChunks(
      provider,
      sseResponse(openaiText(['Hel', 'lo', '!']), { chunkSize: 5 })
    );
    assert.equal(result.content, 'Hello!');
    assert.equal(result.finishReason, 'stop');
    assert.equal(chunks.filter(c => c.complete).length, 1);
    assert.equal(chunks[chunks.length - 1].complete, true, 'parser stops at complete');
  });

  test(`[${provider}] 2. tool-call deltas accumulate into one finalized call`, async () => {
    const result = await run(provider, sseResponse(openaiToolStream));
    expectSingleCall(result, { name: 'get_weather', args: { city: 'Berlin' }, id: 'call_1' });
    assert.equal(result.finishReason, 'tool_calls');
  });

  test(`[${provider}] 3. parallel tool calls keep distinct indexes`, async () => {
    const result = await run(
      provider,
      sseResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'c0',
                    type: 'function',
                    function: { name: 'a', arguments: '{"x":1}' }
                  },
                  { index: 1, id: 'c1', type: 'function', function: { name: 'b', arguments: '' } }
                ]
              },
              finish_reason: null
            }
          ]
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 1, function: { arguments: '{"y":2}' } }] },
              finish_reason: null
            }
          ]
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]'
      ])
    );
    assert.equal(result.toolCalls.length, 2);
    const byName = Object.fromEntries(result.toolCalls.map(c => [c.function.name, c]));
    assert.deepEqual(JSON.parse(byName.a.function.arguments), { x: 1 });
    assert.deepEqual(JSON.parse(byName.b.function.arguments), { y: 2 });
    assert.notEqual(byName.a.index, byName.b.index);
    assert.equal(result.finishReason, 'tool_calls');
  });

  test(`[${provider}] 8d. empty response — complete, no content`, async () => {
    const result = await run(
      provider,
      sseResponse([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
    );
    assert.equal(result.content, '');
    assert.equal(result.complete, true);
    assert.equal(result.finishReason, 'stop');
  });

  test(`[${provider}] 8f. malformed JSON event → PROVIDER_ERROR`, async () => {
    await assert.rejects(run(provider, sseResponse(['{not json', ...openaiText(['x'])])), {
      code: LLM_ERROR_CODES.PROVIDER_ERROR
    });
  });

  test(`[${provider}] 10. collect ≡ stream for the non-streaming body`, async () => {
    const result = await run(
      provider,
      jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Berlin"}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
      }),
      { stream: false }
    );
    expectSingleCall(result, { name: 'get_weather', args: { city: 'Berlin' }, id: 'call_1' });
    assert.equal(result.finishReason, 'tool_calls');
    if (provider !== 'vl') assert.equal(result.usage?.totalTokens, 10);
  });
}

test('[oa] 7. usage on the finish chunk is captured; trailing usage frame after finish is unreachable (documented)', async () => {
  const result = await run(
    'oa',
    sseResponse([
      ...openaiText(['x']).slice(0, -2),
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
      },
      { choices: [], usage: { prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998 } },
      '[DONE]'
    ])
  );
  assert.equal(result.usage.totalTokens, 5);
});

test('[oa] 5. reasoning deltas land in thinking, not content', async () => {
  const result = await run(
    'oa',
    sseResponse([
      { choices: [{ index: 0, delta: { reasoning_content: 'thinking…' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]'
    ])
  );
  assert.equal(result.content, 'answer');
  assert.deepEqual(result.thinking, ['thinking…']);
});

test('[oa] 8e. in-band error frame → PROVIDER_ERROR with provider message', async () => {
  await assert.rejects(
    run('oa', sseResponse([{ error: { message: 'overloaded', type: 'server_error' } }])),
    err => {
      assert.equal(err.code, LLM_ERROR_CODES.PROVIDER_ERROR);
      assert.match(err.message, /overloaded/);
      return true;
    }
  );
});

test('[vl] 7. GAP: vLLM converter reports no usage', async () => {
  const result = await run(
    'vl',
    sseResponse(openaiText(['x'], { usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  );
  assert.equal(result.usage, null);
});

test('[ms] 8e. GAP: mistral ignores {"error"} frames — stream ends without completion', async () => {
  const result = await run('ms', sseResponse([{ error: { message: 'boom' } }]));
  assert.equal(result.complete, false);
  assert.equal(result.content, '');
});

// ── anthropic ───────────────────────────────────────────────────────────────

const anthropicText = [
  {
    type: 'message_start',
    message: { id: 'msg_1', usage: { input_tokens: 12, output_tokens: 1 } }
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' }
];

test('[an] 1+7. text stream with split usage delivery merges to {12, 42}', async () => {
  const { chunks, result } = await runChunks('an', sseResponse(anthropicText, { chunkSize: 11 }));
  assert.equal(result.content, 'Hi there');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.promptTokens, 12);
  assert.equal(result.usage.completionTokens, 42);
  assert.equal(chunks.filter(c => c.complete).length, 1);
});

test('[an] 2. tool_use with input_json_delta fragments → one call at content_block_stop', async () => {
  const result = await run(
    'an',
    sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"city"' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: ':"Berlin"}' }
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' }
    ])
  );
  expectSingleCall(result, { name: 'get_weather', args: { city: 'Berlin' }, id: 'toolu_1' });
  assert.equal(result.finishReason, 'tool_calls');
});

test('[an] 3. sequential tool_use blocks → two calls with distinct indexes', async () => {
  const result = await run(
    'an',
    sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'a' }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"x":1}' }
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 't2', name: 'b' }
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"y":2}' }
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' }
    ])
  );
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls.map(c => c.id).sort(), ['t1', 't2']);
  assert.notEqual(result.toolCalls[0].index, result.toolCalls[1].index);
});

test('[an] 8d. empty response completes with no content', async () => {
  const result = await run(
    'an',
    sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' }
    ])
  );
  assert.equal(result.content, '');
  assert.equal(result.complete, true);
});

test('[an] 8e. GAP: {"type":"error"} events are ignored — stream ends incomplete', async () => {
  const result = await run(
    'an',
    sseResponse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
  );
  assert.equal(result.complete, false);
});

test('[an] 10. non-streaming body (tool_use) ≡ stream view', async () => {
  const result = await run(
    'an',
    jsonResponse({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'A' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 6 }
    }),
    { stream: false }
  );
  assert.equal(result.content, 'A');
  expectSingleCall(result, { name: 'get_weather', args: { city: 'Berlin' }, id: 'toolu_1' });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.usage.totalTokens, 11);
});

// ── google ──────────────────────────────────────────────────────────────────

test('[gm] 1+7. text chunks with cumulative usageMetadata', async () => {
  const result = await run(
    'gm',
    sseResponse([
      {
        candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 }
      },
      {
        candidates: [{ content: { parts: [{ text: '!' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 }
      }
    ])
  );
  assert.equal(result.content, 'Hi!');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 10);
  assert.equal(result.usage.completionTokens, 2);
});

test('[gm] 2. whole functionCall part with thoughtSignature → tool_calls + signature metadata', async () => {
  const result = await run(
    'gm',
    sseResponse([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'get_weather', args: { city: 'Berlin' } },
                  thoughtSignature: 'SIG'
                }
              ],
              role: 'model'
            },
            finishReason: 'STOP'
          }
        ]
      }
    ])
  );
  expectSingleCall(result, { name: 'get_weather', args: { city: 'Berlin' } });
  assert.equal(result.toolCalls[0].metadata.thoughtSignature, 'SIG');
  assert.deepEqual(result.thoughtSignatures, ['SIG']);
  assert.equal(
    result.finishReason,
    'tool_calls',
    'Gemini STOP with function calls is a tool_calls finish'
  );
});

test('[gm] 3. parallel functionCall parts across chunks', async () => {
  const result = await run(
    'gm',
    sseResponse([
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'a', args: { x: 1 } } }], role: 'model' } }
        ]
      },
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'b', args: { y: 2 } } }], role: 'model' },
            finishReason: 'STOP'
          }
        ]
      }
    ])
  );
  assert.equal(result.toolCalls.length, 2);
  assert.notEqual(result.toolCalls[0].index, result.toolCalls[1].index);
});

test('[gm] 5. thought parts are thinking, not content', async () => {
  const result = await run(
    'gm',
    sseResponse([
      {
        candidates: [
          { content: { parts: [{ text: 'let me think', thought: true }], role: 'model' } }
        ]
      },
      {
        candidates: [
          { content: { parts: [{ text: 'Berlin: sunny' }], role: 'model' }, finishReason: 'STOP' }
        ]
      }
    ])
  );
  assert.equal(result.content, 'Berlin: sunny');
  assert.deepEqual(result.thinking, ['let me think']);
});

test('[gm] 8c. SAFETY → content_filter; MALFORMED_FUNCTION_CALL passes through raw', async () => {
  const safety = await run(
    'gm',
    sseResponse([{ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }] }])
  );
  assert.equal(safety.finishReason, 'content_filter');
  const malformed = await run(
    'gm',
    sseResponse([
      {
        candidates: [
          { content: { parts: [{ text: '' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' }
        ]
      }
    ])
  );
  assert.equal(malformed.finishReason, 'MALFORMED_FUNCTION_CALL');
});

test('[gm] 8f. malformed JSON with recoverable text is salvaged', async () => {
  const result = await run(
    'gm',
    sseResponse(['{"candidates":[{"content":{"parts":[{"text":"ok"}]}, "finishReason": "STOP"'])
  );
  assert.equal(result.content, 'ok');
  assert.equal(result.complete, true);
});

test('[gm] 10. non-streaming body ≡ stream view', async () => {
  const result = await run(
    'gm',
    jsonResponse({
      candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 }
    }),
    { stream: false }
  );
  assert.equal(result.content, 'Hi');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 9);
});

// ── openai-responses ────────────────────────────────────────────────────────

test('[or] 1+7. output_text deltas + completed usage', async () => {
  const result = await run(
    'or',
    sseResponse([
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      {
        type: 'response.completed',
        response: {
          id: 'r1',
          output: [],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
        }
      }
    ])
  );
  assert.equal(result.content, 'Hello');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 6);
});

test('[or] 2. function_call item events accumulate into ONE call with final arguments', async () => {
  const result = await run(
    'or',
    sseResponse([
      { type: 'response.created', response: { id: 'r1' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: ''
        }
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_1',
        delta: '{"ci'
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_1',
        delta: 'ty":"Berlin"}'
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_1',
        arguments: '{"city":"Berlin"}'
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"Berlin"}'
        }
      },
      {
        type: 'response.completed',
        response: {
          id: 'r1',
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'get_weather',
              arguments: '{"city":"Berlin"}'
            }
          ]
        }
      }
    ])
  );
  expectSingleCall(result, { name: 'get_weather', args: { city: 'Berlin' }, id: 'call_1' });
  assert.equal(result.finishReason, 'tool_calls');
});

test('[or] 8e. GAP: response.failed is ignored — stream ends incomplete', async () => {
  const result = await run(
    'or',
    sseResponse([
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'x' } } }
    ])
  );
  assert.equal(result.complete, false);
});

// ── bedrock (binary EventStream) ────────────────────────────────────────────

test('[br] 1+7. text frames + metadata usage (lifted from the top-level usage field)', async () => {
  const { chunks, result } = await runChunks(
    'br',
    bedrockResponse([
      { eventType: 'messageStart', payload: { role: 'assistant' } },
      { eventType: 'contentBlockDelta', payload: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
      {
        eventType: 'contentBlockDelta',
        payload: { contentBlockIndex: 0, delta: { text: ' there' } }
      },
      { eventType: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
      { eventType: 'messageStop', payload: { stopReason: 'end_turn' } },
      {
        eventType: 'metadata',
        payload: { usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }
      }
    ])
  );
  assert.equal(result.content, 'Hi there');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 13);
  assert.equal(result.usage.promptTokens, 10);
  for (const c of chunks)
    assert.ok(Array.isArray(c.tool_calls), 'ad-hoc bedrock chunks are normalized');
});

test('[br] 2. toolUse frames with split input → one finalized call', async () => {
  const result = await run(
    'br',
    bedrockResponse([
      { eventType: 'messageStart', payload: { role: 'assistant' } },
      {
        eventType: 'contentBlockStart',
        payload: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'tu_1', name: 'get_weather' } }
        }
      },
      {
        eventType: 'contentBlockDelta',
        payload: { contentBlockIndex: 1, delta: { toolUse: { input: '{"ci' } } }
      },
      {
        eventType: 'contentBlockDelta',
        payload: { contentBlockIndex: 1, delta: { toolUse: { input: 'ty":"Ber' } } }
      },
      {
        eventType: 'contentBlockDelta',
        payload: { contentBlockIndex: 1, delta: { toolUse: { input: 'lin"}' } } }
      },
      { eventType: 'contentBlockStop', payload: { contentBlockIndex: 1 } },
      { eventType: 'messageStop', payload: { stopReason: 'tool_use' } },
      { eventType: 'metadata', payload: { usage: { inputTokens: 1, outputTokens: 1 } } }
    ])
  );
  expectSingleCall(result, { name: 'get_weather', args: { city: 'Berlin' }, id: 'tu_1' });
  assert.equal(result.finishReason, 'tool_calls');
});

test('[br] 8e. exception frame → PROVIDER_ERROR', async () => {
  await assert.rejects(
    run(
      'br',
      bedrockResponse([
        {
          messageType: 'exception',
          eventType: 'throttlingException',
          payload: { message: 'Too many requests' }
        }
      ])
    ),
    err => {
      assert.equal(err.code, LLM_ERROR_CODES.PROVIDER_ERROR);
      assert.match(err.message, /Too many requests/);
      return true;
    }
  );
});

test('[br] 8b. GAP: context-window stopReason yields finishReason error without an error flag', async () => {
  const result = await run(
    'br',
    bedrockResponse([
      { eventType: 'messageStop', payload: { stopReason: 'model_context_window_exceeded' } },
      { eventType: 'metadata', payload: { usage: { inputTokens: 1, outputTokens: 0 } } }
    ])
  );
  assert.equal(result.finishReason, 'error');
  assert.equal(result.complete, true);
});

test('[br] 10. non-streaming Converse body through the same client', async () => {
  const result = await run(
    'br',
    jsonResponse({
      output: { message: { role: 'assistant', content: [{ text: 'Hi' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
    }),
    { stream: false }
  );
  assert.equal(result.content, 'Hi');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 5);
});

// ── iassistant-conversation (block protocol) ────────────────────────────────

const block = (event, data) => ({ __raw: `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` });

test('[ia] 1. answer deltas + done; extras (citations, message ids) are kept on the result', async () => {
  const result = await run(
    'ia',
    sseResponse([
      block('response_message_id', { id: 'm-42' }),
      block('answer', { delta: 'Hal' }),
      block('answer', { delta: 'lo' }),
      block('references', [{ id: 'ref-1', title: 'Doc' }]),
      block('done', {})
    ])
  );
  assert.equal(result.content, 'Hallo');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.complete, true);
  assert.equal(result.responseMessageId, 'm-42');
  assert.ok(result.citations, 'citations passthrough');
});

test('[ia] 8e. TECHNICAL error → PROVIDER_ERROR; REFUSAL → completes with content', async () => {
  await assert.rejects(
    run('ia', sseResponse([block('error', { type: 'TECHNICAL', message: 'boom' })])),
    err => {
      assert.equal(err.code, LLM_ERROR_CODES.PROVIDER_ERROR);
      assert.match(err.message, /boom/);
      return true;
    }
  );
  const refusal = await run(
    'ia',
    sseResponse([block('error', { type: 'REFUSAL', message: 'cannot help' })])
  );
  assert.equal(refusal.complete, true);
  assert.equal(refusal.finishReason, 'stop');
});

// ── cross-provider ──────────────────────────────────────────────────────────

test('9. abort mid-stream → ABORTED, later stream on the same client is clean', async () => {
  const controller = new AbortController();
  let reads = 0;
  const body = new ReadableStream({
    pull(ctrl) {
      reads += 1;
      if (reads === 1) {
        ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiToolStream[0])}\n\n`));
        return;
      }
      // hang until aborted
      return new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      );
    }
  });
  const { client } = makeClient({
    transport: async (_r, ctx) =>
      ctx.signal?.aborted
        ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        : fakeResponse({ status: 200, headers: {}, body, text: '' })
  });
  const stream = await client.execute({ modelId: 'oa', messages, signal: controller.signal });
  const consume = (async () => {
    for await (const _chunk of stream) {
      controller.abort();
    }
  })();
  await assert.rejects(consume, { code: LLM_ERROR_CODES.ABORTED });

  const { client: fresh } = makeClient({
    transport: async () =>
      sseResponse([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  });
  const clean = await fresh.complete({ modelId: 'oa', messages, telemetry: NO_RUN });
  assert.deepEqual(clean.toolCalls, [], 'no stale pending tool call leaks into another stream');
});

test('8g. connection closed without completion → result incomplete, no throw', async () => {
  const result = await run(
    'oa',
    fakeResponse({
      status: 200,
      headers: {},
      body: bytesStream([`data: ${JSON.stringify(openaiText(['partial'])[1])}\n\n`]),
      text: ''
    })
  );
  assert.equal(result.content, 'partial');
  assert.equal(result.complete, false);
  assert.equal(result.finishReason, null);
});
