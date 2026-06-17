/**
 * Unit tests for vLLM reasoning/thinking support (issue #1555).
 *
 * Request side — when `model.thinking.enabled`, the vLLM adapter sends
 * `chat_template_kwargs` to toggle reasoning (default `enable_thinking`, or a
 * model-specific override) and `reasoning_effort` when a level is configured.
 *
 * Response side — the vLLM converter surfaces reasoning text into
 * `result.thinking[]`, parsing both `reasoning` (current vLLM) and
 * `reasoning_content` (legacy), from streaming deltas and full messages.
 */

import VLLMAdapter from '../adapters/vllm.js';
import { convertVLLMResponseToGeneric } from '../adapters/toolCalling/VLLMConverter.js';

const baseModel = {
  modelId: 'Qwen/Qwen3-8B',
  url: 'http://localhost:8000/v1/chat/completions',
  provider: 'local'
};
const messages = [{ role: 'user', content: 'test' }];

describe('vLLM reasoning — request side', () => {
  test('no reasoning fields without thinking config', () => {
    const req = VLLMAdapter.createCompletionRequest(baseModel, messages, 'key', {});
    expect(req.body.chat_template_kwargs).toBeUndefined();
    expect(req.body.reasoning_effort).toBeUndefined();
  });

  test('thinking enabled defaults to enable_thinking:true', () => {
    const model = { ...baseModel, thinking: { enabled: true } };
    const req = VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test('thinkingEnabled:false → enable_thinking:false', () => {
    const model = { ...baseModel, thinking: { enabled: true } };
    const req = VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingEnabled: false
    });
    expect(req.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('model-specific chatTemplateKwargs override is passed through', () => {
    const model = {
      ...baseModel,
      thinking: { enabled: true, chatTemplateKwargs: { thinking: true } }
    };
    const req = VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.chat_template_kwargs).toEqual({ thinking: true });
  });

  test('level present → reasoning_effort also sent', () => {
    const model = { ...baseModel, thinking: { enabled: true, level: 'high' } };
    const req = VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.reasoning_effort).toBe('high');
  });
});

describe('vLLM reasoning — response side', () => {
  test('streaming delta.reasoning → thinking (not content)', async () => {
    const chunk = JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'hmm' } }] });
    const result = await convertVLLMResponseToGeneric(chunk, 'vllm-reasoning-1');
    expect(result.thinking).toEqual(['hmm']);
    expect(result.content).toHaveLength(0);
  });

  test('streaming delta.reasoning_content (legacy) → thinking', async () => {
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { reasoning_content: 'legacy' } }]
    });
    const result = await convertVLLMResponseToGeneric(chunk, 'vllm-reasoning-2');
    expect(result.thinking).toEqual(['legacy']);
  });

  test('full non-streaming message exposes reasoning', async () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'answer', reasoning: 'rationale' },
          finish_reason: 'stop'
        }
      ]
    });
    const result = await convertVLLMResponseToGeneric(body, 'vllm-reasoning-3');
    expect(result.content).toEqual(['answer']);
    expect(result.thinking).toEqual(['rationale']);
    expect(result.complete).toBe(true);
  });
});
