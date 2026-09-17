/**
 * Unit tests for OpenAI reasoning/thinking support (issue #1555).
 *
 * Two halves:
 *   1. Request side — when `model.thinking.enabled`, the OpenAI adapter adds
 *      `reasoning_effort` (mapped from level/budget) and leaves `max_tokens` /
 *      `temperature` untouched (conservative: OpenAI-compatible endpoints that
 *      don't impose reasoning-model constraints must keep working).
 *   2. Response side — the OpenAI converter surfaces reasoning text into
 *      `result.thinking[]`, parsing both `reasoning_content` (DeepSeek / legacy
 *      vLLM) and `reasoning` (current vLLM), from streaming deltas and from a
 *      full (non-streaming) message.
 */

// Import the adapter through the registry rather than `../adapters/openai.js`
// directly. The OpenAI adapter pulls in ModelDiscoveryService, which imports the
// adapter registry — loading openai.js first triggers a circular-import TDZ
// (`Cannot access 'OpenAIAdapter' before initialization`). Going through the
// registry forces index.js to initialize fully first, matching app runtime.
import { getAdapter } from '../adapters/index.js';
import { convertOpenAIResponseToGeneric } from '../adapters/toolCalling/OpenAIConverter.js';

const OpenAIAdapter = getAdapter('openai');

const baseModel = {
  modelId: 'gpt-oss',
  url: 'https://api.openai.com/v1/chat/completions',
  provider: 'openai'
};
const messages = [{ role: 'user', content: 'test' }];

describe('OpenAI reasoning — request side', () => {
  test('no reasoning_effort when model.thinking is absent', async () => {
    const req = await OpenAIAdapter.createCompletionRequest(baseModel, messages, 'key', {
      temperature: 0.4,
      maxTokens: 512
    });
    expect(req.body.reasoning_effort).toBeUndefined();
    expect(req.body.temperature).toBe(0.4);
    expect(req.body.max_tokens).toBe(512);
  });

  test('explicit level maps to reasoning_effort, leaving tokens/temperature untouched', async () => {
    const model = { ...baseModel, thinking: { enabled: true, level: 'high' } };
    const req = await OpenAIAdapter.createCompletionRequest(model, messages, 'key', {
      temperature: 0.4,
      maxTokens: 512
    });
    expect(req.body.reasoning_effort).toBe('high');
    // Conservative: token/temperature semantics unchanged.
    expect(req.body.temperature).toBe(0.4);
    expect(req.body.max_tokens).toBe(512);
    expect(req.body.max_completion_tokens).toBeUndefined();
  });

  test('options.thinkingLevel overrides model level', async () => {
    const model = { ...baseModel, thinking: { enabled: true, level: 'high' } };
    const req = await OpenAIAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingLevel: 'low'
    });
    expect(req.body.reasoning_effort).toBe('low');
  });

  test('thinkingEnabled:false suppresses reasoning_effort', async () => {
    const model = { ...baseModel, thinking: { enabled: true, level: 'medium' } };
    const req = await OpenAIAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingEnabled: false
    });
    expect(req.body.reasoning_effort).toBeUndefined();
  });

  test('budget fallback when no level configured (50 → low)', async () => {
    const model = { ...baseModel, thinking: { enabled: true, budget: 50 } };
    const req = await OpenAIAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.reasoning_effort).toBe('low');
  });
});

describe('OpenAI reasoning — response side', () => {
  test('streaming delta.reasoning → thinking (not content)', async () => {
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { reasoning: 'Let me think...' } }]
    });
    const result = await convertOpenAIResponseToGeneric(chunk, 'openai-reasoning-1');
    expect(result.thinking).toEqual(['Let me think...']);
    expect(result.content).toHaveLength(0);
  });

  test('streaming delta.reasoning_content → thinking', async () => {
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { reasoning_content: 'step 1' } }]
    });
    const result = await convertOpenAIResponseToGeneric(chunk, 'openai-reasoning-2');
    expect(result.thinking).toEqual(['step 1']);
  });

  test('content delta flows to content, not thinking', async () => {
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { content: 'the answer' } }]
    });
    const result = await convertOpenAIResponseToGeneric(chunk, 'openai-reasoning-3');
    expect(result.content).toEqual(['the answer']);
    expect(result.thinking).toHaveLength(0);
  });

  test('full non-streaming message exposes reasoning_content', async () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'final', reasoning_content: 'because…' },
          finish_reason: 'stop'
        }
      ]
    });
    const result = await convertOpenAIResponseToGeneric(body, 'openai-reasoning-4');
    expect(result.content).toEqual(['final']);
    expect(result.thinking).toEqual(['because…']);
    expect(result.complete).toBe(true);
  });
});
