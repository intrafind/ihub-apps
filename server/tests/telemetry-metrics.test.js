// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * recordInferenceTokens follows the inference token metrics of the GenAI
 * semantic conventions (semantic-conventions-genai v0.1.0):
 *
 * - `gen_ai.client.inference.operation.input_tokens` / `.output_tokens`
 *   histograms get one record per inference, `0` when no usage was reported
 *   (a legitimate `0` must survive: the old `a || b` pattern dropped it).
 * - `gen_ai.client.inference.usage.*` counters get only strictly positive
 *   counts, with `gen_ai.token.modality` (`unknown`) except on reasoning.
 */

import { jest } from '@jest/globals';
import { initializeMetrics, recordInferenceTokens } from '../telemetry/metrics.js';

const INPUT = 'gen_ai.client.inference.operation.input_tokens';
const OUTPUT = 'gen_ai.client.inference.operation.output_tokens';
const USAGE_IN = 'gen_ai.client.inference.usage.input_tokens';
const USAGE_OUT = 'gen_ai.client.inference.usage.output_tokens';

function makeFakeMeterProvider() {
  const recorded = {};
  const instrument = name => {
    recorded[name] = [];
    const push = jest.fn((value, attrs) => recorded[name].push([value, attrs]));
    return { record: push, add: push };
  };
  const meter = {
    createHistogram: instrument,
    createCounter: instrument,
    createUpDownCounter: () => ({ add: () => {} }),
    createObservableGauge: () => ({ addCallback: () => {} })
  };
  return { provider: { getMeter: () => meter }, recorded };
}

describe('recordInferenceTokens', () => {
  let fake;

  beforeEach(() => {
    fake = makeFakeMeterProvider();
    initializeMetrics(fake.provider);
  });

  test('records the per-operation histograms and the usage counters', () => {
    recordInferenceTokens(
      { 'gen_ai.request.model': 'gpt-4' },
      { inputTokens: 12, outputTokens: 7 }
    );

    const labels = { 'gen_ai.request.model': 'gpt-4' };
    const counterLabels = { ...labels, 'gen_ai.token.modality': 'unknown' };
    expect(fake.recorded[INPUT]).toEqual([[12, labels]]);
    expect(fake.recorded[OUTPUT]).toEqual([[7, labels]]);
    expect(fake.recorded[USAGE_IN]).toEqual([[12, counterLabels]]);
    expect(fake.recorded[USAGE_OUT]).toEqual([[7, counterLabels]]);
  });

  test('drops high-cardinality attributes that are not in the metrics allow-list', () => {
    // Token counts, conversation id, response id and message count would
    // explode Prometheus cardinality - they live on spans, not metrics.
    recordInferenceTokens(
      {
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.conversation.id': 'chat-abc-123',
        'gen_ai.response.id': 'resp-xyz',
        'gen_ai.usage.input_tokens': '12',
        'gen_ai.usage.output_tokens': '7',
        'conversation.message_count': '14',
        'user.id': 'alice',
        // Bounded by the model config: kept, so one degraded endpoint shows (#4008).
        'server.address': 'api.openai.com'
      },
      { inputTokens: 12 }
    );

    expect(fake.recorded[INPUT]).toEqual([
      [12, { 'gen_ai.request.model': 'gpt-4', 'server.address': 'api.openai.com' }]
    ]);
  });

  test('records 0 on the histograms but never adds 0 to a counter', () => {
    recordInferenceTokens({}, { inputTokens: 0, outputTokens: 5 });

    expect(fake.recorded[INPUT]).toEqual([[0, {}]]);
    expect(fake.recorded[USAGE_IN]).toEqual([]);
    expect(fake.recorded[USAGE_OUT]).toEqual([[5, { 'gen_ai.token.modality': 'unknown' }]]);
  });

  test('falls back to OpenAI-style prompt_tokens / completion_tokens', () => {
    recordInferenceTokens({}, { prompt_tokens: 9, completion_tokens: 0 });

    expect(fake.recorded[INPUT]).toEqual([[9, {}]]);
    expect(fake.recorded[OUTPUT]).toEqual([[0, {}]]);
  });

  test('a failed inference records 0 tokens with error.type and no counter', () => {
    recordInferenceTokens({}, null, Object.assign(new Error('x'), { status: 429 }));

    const labels = { 'error.type': 'rate_limit_exceeded' };
    expect(fake.recorded[INPUT]).toEqual([[0, labels]]);
    expect(fake.recorded[OUTPUT]).toEqual([[0, labels]]);
    expect(fake.recorded[USAGE_IN]).toEqual([]);
  });

  test('a non-numeric count is recorded as 0, never as the value', () => {
    recordInferenceTokens({}, { inputTokens: 'abc', outputTokens: -3 });
    expect(fake.recorded[INPUT]).toEqual([[0, {}]]);
    expect(fake.recorded[OUTPUT]).toEqual([[0, {}]]);
    expect(fake.recorded[USAGE_IN]).toEqual([]);
  });

  test('cache and reasoning counters count their subsets; reasoning has no modality', () => {
    recordInferenceTokens(
      {},
      {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        reasoningTokens: 4
      }
    );
    const modality = { 'gen_ai.token.modality': 'unknown' };
    expect(fake.recorded['gen_ai.client.inference.usage.cache_read.input_tokens']).toEqual([
      [80, modality]
    ]);
    expect(fake.recorded['gen_ai.client.inference.usage.cache_write.input_tokens']).toEqual([
      [20, modality]
    ]);
    expect(fake.recorded['gen_ai.client.inference.usage.reasoning.output_tokens']).toEqual([
      [4, {}]
    ]);
  });
});
