/**
 * recordTokenUsage must preserve a legitimate 0-token reading. The previous
 * `usage.inputTokens || usage.prompt_tokens` pattern silently dropped 0
 * because `0 || undefined === undefined`, leading to `histogram.record(undefined)`.
 *
 * These tests replace the histogram with a stub so we can assert the exact
 * arguments forwarded by recordTokenUsage.
 */

import { initializeMetrics, recordTokenUsage } from '../telemetry/metrics.js';

function makeFakeMeterProvider() {
  const recorded = [];
  const histogram = { record: jest.fn((value, attrs) => recorded.push({ value, attrs })) };
  const counter = { add: jest.fn() };
  const meter = {
    createHistogram: () => histogram,
    createCounter: () => counter,
    createObservableGauge: () => ({ addCallback: () => {} })
  };
  return {
    provider: { getMeter: () => meter },
    histogram,
    counter,
    recorded
  };
}

describe('recordTokenUsage', () => {
  let fake;

  beforeEach(() => {
    fake = makeFakeMeterProvider();
    initializeMetrics(fake.provider);
  });

  test('records both input and output tokens with type attribute', () => {
    recordTokenUsage({ 'gen_ai.request.model': 'gpt-4' }, { inputTokens: 12, outputTokens: 7 });

    expect(fake.recorded).toEqual([
      { value: 12, attrs: { 'gen_ai.request.model': 'gpt-4', 'gen_ai.token.type': 'input' } },
      { value: 7, attrs: { 'gen_ai.request.model': 'gpt-4', 'gen_ai.token.type': 'output' } }
    ]);
  });

  test('preserves 0 input tokens (regression: previous || drop)', () => {
    recordTokenUsage({}, { inputTokens: 0, outputTokens: 5 });

    expect(fake.recorded).toContainEqual({
      value: 0,
      attrs: { 'gen_ai.token.type': 'input' }
    });
  });

  test('falls back to OpenAI-style prompt_tokens / completion_tokens', () => {
    recordTokenUsage({}, { prompt_tokens: 9, completion_tokens: 0 });

    expect(fake.recorded).toEqual([
      { value: 9, attrs: { 'gen_ai.token.type': 'input' } },
      { value: 0, attrs: { 'gen_ai.token.type': 'output' } }
    ]);
  });

  test('skips recording when usage object is missing', () => {
    recordTokenUsage({}, undefined);
    recordTokenUsage({}, null);
    expect(fake.histogram.record).not.toHaveBeenCalled();
  });

  test('does not record when token field is non-numeric', () => {
    recordTokenUsage({}, { inputTokens: 'abc' });
    expect(fake.histogram.record).not.toHaveBeenCalled();
  });
});
