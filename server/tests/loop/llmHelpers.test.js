/**
 * Pure helpers behind LLMClient: retry classification/backoff, usage
 * normalization, tool-call delta merging, JSON extraction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientHttpStatus,
  isTransientLlmError,
  parseRetryAfterMs,
  computeRetryDelayMs,
  runWithRetries,
  DEFAULT_TRANSIENT_RETRIES
} from '../../services/loop/llmRetry.js';
import {
  normalizeUsage,
  mergeUsage,
  addUsage,
  usageToBudget,
  usageToOpenAI
} from '../../services/loop/llmUsage.js';
import {
  mergeToolCallDelta,
  mergeToolCallDeltas,
  parseToolCallArguments
} from '../../services/loop/toolCallMerge.js';
import { extractJson, looksTruncated } from '../../services/loop/extractJson.js';
import { LLMError } from '../../services/loop/contracts/errors.js';

test('isTransientHttpStatus — only 429 and 5xx', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(isTransientHttpStatus(s), true, `${s}`);
  for (const s of [200, 400, 401, 404, 413]) assert.equal(isTransientHttpStatus(s), false, `${s}`);
  assert.equal(isTransientHttpStatus('503'), false);
});

test('isTransientLlmError — classified HTTP, network faults, never aborts', () => {
  assert.equal(isTransientLlmError({ status: 503 }), true);
  assert.equal(isTransientLlmError({ status: 429 }), true);
  assert.equal(isTransientLlmError({ status: 400 }), false);
  assert.equal(isTransientLlmError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientLlmError({ message: 'fetch failed' }), true);
  assert.equal(
    isTransientLlmError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }),
    true
  );
  assert.equal(isTransientLlmError({ message: 'boom' }), false);
  assert.equal(isTransientLlmError(null), false);
  assert.equal(isTransientLlmError({ name: 'AbortError', message: 'aborted' }), false);
  assert.equal(isTransientLlmError({ code: 'ABORT_ERR', message: 'aborted' }), false);
  assert.equal(isTransientLlmError(new LLMError('x', { code: 'ABORTED' })), false);
  assert.equal(isTransientLlmError(new LLMError('x', { code: 'NETWORK' })), true);
  assert.equal(isTransientLlmError(new LLMError('x', { code: 'RATE_LIMITED', status: 429 })), true);
  assert.equal(
    isTransientLlmError(new LLMError('x', { code: 'INVALID_REQUEST', status: 400 })),
    false
  );
});

test('parseRetryAfterMs — seconds, dates, garbage', () => {
  assert.equal(parseRetryAfterMs('5'), 5000);
  assert.equal(parseRetryAfterMs(0), 0);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs('soon'), null);
  const future = new Date(Date.now() + 30_000).toUTCString();
  const ms = parseRetryAfterMs(future);
  assert.ok(ms > 25_000 && ms <= 31_000, `date form → ~30s, got ${ms}`);
});

test('computeRetryDelayMs — exponential + jitter, cap, Retry-After precedence', () => {
  const noJitter = { jitter: () => 0 };
  assert.equal(computeRetryDelayMs(0, noJitter), 1000);
  assert.equal(computeRetryDelayMs(1, noJitter), 2000);
  assert.equal(computeRetryDelayMs(2, noJitter), 4000);
  assert.equal(computeRetryDelayMs(10, noJitter), 15000);
  assert.equal(computeRetryDelayMs(0, { ...noJitter, retryAfterMs: 40_000 }), 40_000);
  assert.equal(computeRetryDelayMs(0, { ...noJitter, retryAfterMs: 500_000 }), 60_000);
  const withJitter = computeRetryDelayMs(0, { jitter: () => 0.5 });
  assert.equal(withJitter, 1500);
});

test('runWithRetries — retries transient only, honors budget and onRetry', async () => {
  assert.equal(DEFAULT_TRANSIENT_RETRIES >= 0, true);
  let calls = 0;
  const retried = [];
  const result = await runWithRetries(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('unavailable'), { status: 503 });
      return 'ok';
    },
    { maxRetries: 3, sleep: async () => {}, onRetry: info => retried.push(info.attempt) }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(retried, [0, 1]);

  calls = 0;
  await assert.rejects(
    runWithRetries(
      async () => {
        calls += 1;
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
      { maxRetries: 3, sleep: async () => {} }
    ),
    /bad request/
  );
  assert.equal(calls, 1, 'non-transient is not retried');

  calls = 0;
  await assert.rejects(
    runWithRetries(
      async () => {
        calls += 1;
        throw Object.assign(new Error('still down'), { status: 503 });
      },
      { maxRetries: 2, sleep: async () => {} }
    ),
    /still down/
  );
  assert.equal(calls, 3, '1 + maxRetries attempts');
});

test('normalizeUsage — accepts every provider spelling, computes totals', () => {
  assert.deepEqual(normalizeUsage({ promptTokens: 3, completionTokens: 4, totalTokens: 7 }), {
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    source: 'provider'
  });
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 }).totalTokens, 15);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 5 }).promptTokens, 10);
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 2 }).completionTokens, 2);
  assert.equal(
    normalizeUsage({ promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 })
      .totalTokens,
    10
  );
  assert.equal(
    normalizeUsage({
      prompt_tokens: 1,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 7 }
    }).cacheReadTokens,
    7
  );
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({ foo: 'bar' }), null);
});

test('mergeUsage / addUsage / views', () => {
  const start = normalizeUsage({ input_tokens: 12, output_tokens: 1 });
  const delta = normalizeUsage({ output_tokens: 42 });
  const merged = mergeUsage(start, delta);
  assert.deepEqual(
    { p: merged.promptTokens, c: merged.completionTokens, t: merged.totalTokens },
    { p: 12, c: 42, t: 54 }
  );
  assert.equal(mergeUsage(null, delta).completionTokens, 42);
  assert.equal(mergeUsage(start, null), start);
  const sum = addUsage(merged, normalizeUsage({ prompt_tokens: 1, completion_tokens: 1 }));
  assert.equal(sum.totalTokens, 56);
  assert.deepEqual(usageToBudget(merged), { input: 12, output: 42, total: 54 });
  assert.equal(usageToBudget(null), null);
  assert.deepEqual(usageToOpenAI(merged), {
    prompt_tokens: 12,
    completion_tokens: 42,
    total_tokens: 54
  });
  assert.deepEqual(usageToOpenAI(null), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  });
});

test('mergeToolCallDelta — accumulates fragments, ignores placeholders, merges metadata', () => {
  const calls = [];
  mergeToolCallDelta(calls, {
    index: 0,
    id: 'call_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '' }
  });
  mergeToolCallDelta(calls, { index: 0, function: { arguments: '{}' } });
  mergeToolCallDelta(calls, { index: 0, function: { arguments: '{"ci' } });
  mergeToolCallDelta(calls, {
    index: 0,
    function: { arguments: 'ty":"B"}' },
    metadata: { thoughtSignature: 'S' }
  });
  mergeToolCallDelta(calls, {
    index: 1,
    id: 'call_2',
    function: { name: 'other', arguments: '{"a":1}' }
  });
  mergeToolCallDelta(calls, { id: 'no-index', function: { name: 'dropped', arguments: '{}' } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, 'call_1');
  assert.equal(calls[0].function.name, 'get_weather');
  assert.equal(calls[0].function.arguments, '{"city":"B"}');
  assert.deepEqual(calls[0].metadata, { thoughtSignature: 'S' });
  assert.deepEqual(parseToolCallArguments(calls[0]), { city: 'B' });
  assert.deepEqual(parseToolCallArguments(calls[1]), { a: 1 });
});

test('mergeToolCallDelta — __raw_arguments and complete deltas replace instead of append', () => {
  const calls = [];
  mergeToolCallDeltas(calls, [
    { index: 0, id: 'fc_1', function: { name: 'f', arguments: '' } },
    { index: 0, id: 'fc_1', function: { name: '', arguments: '{"ci' } },
    { index: 0, id: 'fc_1', function: { name: '', arguments: 'ty":"Berlin"}' } },
    {
      index: 0,
      id: 'fc_1',
      function: { name: '', arguments: '{"city":"Berlin"}' },
      complete: true
    },
    {
      index: 0,
      id: 'call_1',
      function: { name: 'f', arguments: '{"city":"Berlin"}' },
      complete: true
    }
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.arguments, '{"city":"Berlin"}');
  assert.equal(calls[0].id, 'call_1');

  const raw = [];
  mergeToolCallDelta(raw, {
    index: 0,
    id: 'x',
    name: 'weird',
    arguments: { __raw_arguments: '{not json' },
    function: { name: 'weird', arguments: '{not json' }
  });
  assert.deepEqual(parseToolCallArguments(raw[0]), { __raw_arguments: '{not json' });
  assert.deepEqual(parseToolCallArguments({ function: { arguments: '' } }), {});
});

test('extractJson — whole, fenced, embedded, brace slice, arrays, failure', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! ```json\n{"a":1}\n``` hope that helps'), { a: 1 });
  assert.deepEqual(extractJson('Result: {"a":{"b":[1,2]}} done.'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(looksTruncated('{"a": 1, "b": [1,', null), true);
  assert.equal(looksTruncated('oops }', 'length'), true);
  assert.equal(looksTruncated('{"a":1}', 'stop'), false);
});
