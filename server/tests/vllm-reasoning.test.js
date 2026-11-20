// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

import VLLMAdapter, {
  THINKING_LEVEL_BUDGETS,
  resolveThinkingTokenBudget
} from '../adapters/vllm.js';
import { convertVLLMResponseToGeneric } from '../adapters/toolCalling/VLLMConverter.js';

const baseModel = {
  modelId: 'Qwen/Qwen3-8B',
  url: 'http://localhost:8000/v1/chat/completions',
  provider: 'local'
};
const messages = [{ role: 'user', content: 'test' }];

describe('vLLM reasoning — request side', () => {
  test('no reasoning fields without thinking config', async () => {
    const req = await VLLMAdapter.createCompletionRequest(baseModel, messages, 'key', {});
    expect(req.body.chat_template_kwargs).toBeUndefined();
    expect(req.body.reasoning_effort).toBeUndefined();
  });

  test('thinking enabled defaults to enable_thinking:true', async () => {
    const model = { ...baseModel, thinking: { enabled: true } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test('thinkingEnabled:false → enable_thinking:false', async () => {
    const model = { ...baseModel, thinking: { enabled: true } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingEnabled: false
    });
    expect(req.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('single-boolean chatTemplateKwargs override defaults to its configured value', async () => {
    const model = {
      ...baseModel,
      thinking: { enabled: true, chatTemplateKwargs: { thinking: true } }
    };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.chat_template_kwargs).toEqual({ thinking: true });
  });

  test('per-request toggle overrides a single-boolean chatTemplateKwargs key (Granite)', async () => {
    const model = {
      ...baseModel,
      thinking: { enabled: true, chatTemplateKwargs: { thinking: true } }
    };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingEnabled: false
    });
    // Honors the app/user toggle even for a non-`enable_thinking` toggle key.
    expect(req.body.chat_template_kwargs).toEqual({ thinking: false });
  });

  test('multi-key chatTemplateKwargs override is passed through unchanged', async () => {
    const model = {
      ...baseModel,
      thinking: {
        enabled: true,
        chatTemplateKwargs: { enable_thinking: true, reasoning_format: 'parsed' }
      }
    };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingEnabled: false
    });
    expect(req.body.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_format: 'parsed'
    });
  });

  test('level present → reasoning_effort also sent', async () => {
    const model = { ...baseModel, thinking: { enabled: true, level: 'high' } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.reasoning_effort).toBe('high');
  });

  test('include_reasoning omitted by default', async () => {
    const model = { ...baseModel, thinking: { enabled: true } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.include_reasoning).toBeUndefined();
  });

  test('model default thoughts:false → include_reasoning:false', async () => {
    const model = { ...baseModel, thinking: { enabled: true, thoughts: false } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {});
    expect(req.body.include_reasoning).toBe(false);
    // Reasoning still runs — only its text is hidden.
    expect(req.body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test('user thinkingThoughts:true overrides model default thoughts:false', async () => {
    const model = { ...baseModel, thinking: { enabled: true, thoughts: false } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingThoughts: true
    });
    expect(req.body.include_reasoning).toBeUndefined();
  });

  test('user thinkingThoughts:false hides reasoning on a model that shows it', async () => {
    const model = { ...baseModel, thinking: { enabled: true, thoughts: true } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingThoughts: false
    });
    expect(req.body.include_reasoning).toBe(false);
  });

  test('include_reasoning not sent with structured output (vLLM returns empty content)', async () => {
    const model = { ...baseModel, thinking: { enabled: true, thoughts: false } };
    const withSchema = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      responseSchema: { type: 'object', properties: {} }
    });
    expect(withSchema.body.include_reasoning).toBeUndefined();
    const withJson = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      responseFormat: 'json'
    });
    expect(withJson.body.include_reasoning).toBeUndefined();
  });

  test('include_reasoning not sent when thinking is turned off', async () => {
    const model = { ...baseModel, thinking: { enabled: true, thoughts: false } };
    const req = await VLLMAdapter.createCompletionRequest(model, messages, 'key', {
      thinkingEnabled: false
    });
    expect(req.body.include_reasoning).toBeUndefined();
  });
});

describe('vLLM reasoning — thinking_token_budget', () => {
  const request = (thinking, options = {}) =>
    VLLMAdapter.createCompletionRequest({ ...baseModel, thinking }, messages, 'key', {
      maxTokens: 32768,
      ...options
    });

  test('no budget without thinking config', async () => {
    const req = await VLLMAdapter.createCompletionRequest(baseModel, messages, 'key', {});
    expect(req.body.thinking_token_budget).toBeUndefined();
  });

  test('no budget unless the model opts in: vLLM answers 400 without a reasoning config', async () => {
    const plain = await request({ enabled: true });
    expect(plain.body.thinking_token_budget).toBeUndefined();
    const withLevel = await request({ enabled: true, level: 'low' });
    expect(withLevel.body.thinking_token_budget).toBeUndefined();
    expect(withLevel.body.reasoning_effort).toBe('low');
    const off = await request({ enabled: true, level: 'low', tokenBudget: false });
    expect(off.body.thinking_token_budget).toBeUndefined();
  });

  test('tokenBudget: each level maps to its budget', async () => {
    for (const [level, budget] of Object.entries(THINKING_LEVEL_BUDGETS)) {
      const req = await request({ enabled: true, level, tokenBudget: true });
      expect(req.body.thinking_token_budget).toBe(budget);
    }
  });

  test('a per-request level wins over the model level', async () => {
    const req = await request(
      { enabled: true, level: 'high', tokenBudget: true },
      { thinkingLevel: 'low' }
    );
    expect(req.body.thinking_token_budget).toBe(THINKING_LEVEL_BUDGETS.low);
  });

  test('budgetTokens turns the budget on and wins over the level', async () => {
    const req = await request({ enabled: true, level: 'low', budgetTokens: 4000 });
    expect(req.body.thinking_token_budget).toBe(4000);
  });

  test('tokenBudget without level or budgetTokens: the medium budget, like reasoning_effort', async () => {
    const req = await request({ enabled: true, tokenBudget: true });
    expect(req.body.thinking_token_budget).toBe(THINKING_LEVEL_BUDGETS.medium);
    const unknown = await request({ enabled: true, level: 'max', tokenBudget: true });
    expect(unknown.body.thinking_token_budget).toBe(THINKING_LEVEL_BUDGETS.medium);
    expect(unknown.body.reasoning_effort).toBe('medium');
  });

  test('the budget never leaves less than half of max_tokens for the answer', async () => {
    const req = await request({ enabled: true, budgetTokens: 100000 }, { maxTokens: 8000 });
    expect(req.body.thinking_token_budget).toBe(4000);
    const high = await request(
      { enabled: true, level: 'high', tokenBudget: true },
      { maxTokens: 4096 }
    );
    expect(high.body.thinking_token_budget).toBe(2048);
  });

  test('every level up to high fits the default output limit of 16,384 uncapped', () => {
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      expect(resolveThinkingTokenBudget({}, level, 16384)).toBe(THINKING_LEVEL_BUDGETS[level]);
    }
  });

  test('xhigh: 16,384 tokens, sent as reasoning_effort high, capped at half of max_tokens', async () => {
    const req = await request({ enabled: true, level: 'xhigh', tokenBudget: true });
    expect(req.body.thinking_token_budget).toBe(16384);
    expect(req.body.reasoning_effort).toBe('high');
    const capped = await request(
      { enabled: true, level: 'xhigh', tokenBudget: true },
      { maxTokens: 16384 }
    );
    expect(capped.body.thinking_token_budget).toBe(8192);
  });

  test('no budget when thinking is turned off for the request', async () => {
    const req = await request(
      { enabled: true, level: 'low', tokenBudget: true },
      { thinkingEnabled: false }
    );
    expect(req.body.thinking_token_budget).toBeUndefined();
  });

  test('resolveThinkingTokenBudget accepts uppercase levels', () => {
    expect(resolveThinkingTokenBudget({}, 'MEDIUM', 32768)).toBe(THINKING_LEVEL_BUDGETS.medium);
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
