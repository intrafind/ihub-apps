/**
 * Tests for the shared provider/operation resolver used by both
 * NonStreamingHandler / llmInstrumentation and StreamingHandler.
 * The two paths must agree on `gen_ai.provider.name` and
 * `gen_ai.operation.name` so dashboards aren't fragmented.
 */

import { resolveProviderName, resolveOperation } from '../telemetry/providerMap.js';

describe('resolveProviderName', () => {
  test.each([
    ['openai', 'openai'],
    ['openai-responses', 'openai'],
    ['anthropic', 'anthropic'],
    ['google', 'google'],
    ['mistral', 'mistral_ai'],
    ['local', 'openai'],
    ['vllm', 'openai'],
    ['iassistant-conversation', 'iassistant']
  ])('maps iHub provider %s to gen-ai %s', (input, expected) => {
    expect(resolveProviderName(input)).toBe(expected);
  });

  test('unknown provider passes through unchanged', () => {
    expect(resolveProviderName('something-else')).toBe('something-else');
  });

  test('undefined / empty provider falls back to "unknown"', () => {
    expect(resolveProviderName(undefined)).toBe('unknown');
    expect(resolveProviderName('')).toBe('unknown');
  });
});

describe('resolveOperation', () => {
  test('google → generate_content', () => {
    expect(resolveOperation('google')).toBe('generate_content');
  });

  test('openai / anthropic / mistral / etc. default to chat', () => {
    expect(resolveOperation('openai')).toBe('chat');
    expect(resolveOperation('anthropic')).toBe('chat');
    expect(resolveOperation('mistral')).toBe('chat');
    expect(resolveOperation('local')).toBe('chat');
    expect(resolveOperation(undefined)).toBe('chat');
  });
});
