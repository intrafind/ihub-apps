/**
 * What each adapter puts on the wire when the loop asks for a tool call
 * (`options.toolChoice: 'required'`). One row of docs/tool-calling.md's
 * "Requiring a tool call" table per adapter.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAIAdapter from '../adapters/openai.js';
import OpenAIResponsesAdapter from '../adapters/openai-responses.js';
import MistralAdapter from '../adapters/mistral.js';
import VLLMAdapter from '../adapters/vllm.js';
import AnthropicAdapter from '../adapters/anthropic.js';
import GoogleAdapter from '../adapters/google.js';
import BedrockAdapter from '../adapters/bedrock.js';
import { convertAnthropicToolChoice } from '../adapters/toolCalling/AnthropicConverter.js';
import { convertGoogleToolChoice } from '../adapters/toolCalling/GoogleConverter.js';
import { convertBedrockToolChoice } from '../adapters/toolCalling/BedrockConverter.js';

const messages = [{ role: 'user', content: 'test' }];
const tools = [
  {
    id: 'lookup',
    name: 'lookup',
    description: 'Look something up',
    parameters: { type: 'object', properties: { q: { type: 'string' } } }
  }
];

describe('adapters that pass the choice straight through', () => {
  const cases = [
    [
      'openai',
      OpenAIAdapter,
      { modelId: 'gpt-4o', url: 'https://api.openai.com/v1/chat/completions', provider: 'openai' }
    ],
    [
      'openai-responses',
      OpenAIResponsesAdapter,
      { modelId: 'gpt-5', url: 'https://api.openai.com/v1/responses', provider: 'openai-responses' }
    ],
    [
      'mistral',
      MistralAdapter,
      {
        modelId: 'mistral-large-latest',
        url: 'https://api.mistral.ai/v1/chat/completions',
        provider: 'mistral'
      }
    ],
    [
      'vllm (local)',
      VLLMAdapter,
      { modelId: 'local', url: 'http://localhost:8000/v1/chat/completions', provider: 'local' }
    ]
  ];

  for (const [name, adapter, model] of cases) {
    it(`${name} sends tool_choice: required`, async () => {
      const req = await adapter.createCompletionRequest(model, messages, 'key', {
        tools,
        toolChoice: 'required'
      });
      assert.equal(req.body.tool_choice, 'required');
      assert.ok(req.body.tools.length > 0);
    });

    it(`${name} sends nothing when no choice is given`, async () => {
      const req = await adapter.createCompletionRequest(model, messages, 'key', { tools });
      assert.equal(req.body.tool_choice, undefined);
    });
  }
});

describe('Anthropic', () => {
  const model = {
    modelId: 'claude-opus-5',
    url: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic'
  };

  it('sends tool_choice: any for a required call', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
      tools,
      toolChoice: 'required'
    });
    assert.deepEqual(req.body.tool_choice, { type: 'any' });
  });

  it('sends nothing for auto or when no choice is given (the API default)', async () => {
    for (const toolChoice of [undefined, 'auto']) {
      const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
        tools,
        toolChoice
      });
      assert.equal(req.body.tool_choice, undefined);
    }
  });

  it('sends no tool_choice without tools (the API rejects it)', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
      toolChoice: 'required'
    });
    assert.equal(req.body.tool_choice, undefined);
  });

  it('keeps the structured-output json tool pinned over a requested choice', async () => {
    const req = await AnthropicAdapter.createCompletionRequest(model, messages, 'key', {
      tools,
      toolChoice: 'required',
      responseSchema: { type: 'object', properties: { a: { type: 'string' } } }
    });
    assert.deepEqual(req.body.tool_choice, { type: 'tool', name: 'json' });
  });

  it('converts the OpenAI and Anthropic shapes', () => {
    assert.deepEqual(convertAnthropicToolChoice('any'), { type: 'any' });
    assert.deepEqual(convertAnthropicToolChoice('none'), { type: 'none' });
    assert.deepEqual(
      convertAnthropicToolChoice({ type: 'function', function: { name: 'lookup' } }),
      {
        type: 'tool',
        name: 'lookup'
      }
    );
    assert.deepEqual(convertAnthropicToolChoice({ type: 'function', name: 'lookup' }), {
      type: 'tool',
      name: 'lookup'
    });
    assert.deepEqual(convertAnthropicToolChoice({ type: 'tool', name: 'lookup' }), {
      type: 'tool',
      name: 'lookup'
    });
    assert.deepEqual(convertAnthropicToolChoice({ type: 'any' }), { type: 'any' });
    assert.equal(convertAnthropicToolChoice('auto'), undefined);
    assert.equal(convertAnthropicToolChoice(undefined), undefined);
    assert.equal(convertAnthropicToolChoice('bogus'), undefined);
    assert.equal(convertAnthropicToolChoice('constructor'), undefined, 'no prototype lookups');
  });
});

describe('Google Gemini', () => {
  const model = {
    modelId: 'gemini-3-pro',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent',
    provider: 'google'
  };

  it('sets function calling mode ANY for a required call', async () => {
    const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
      tools,
      toolChoice: 'required'
    });
    assert.deepEqual(req.body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  });

  it('sends nothing for auto or when no choice is given (the API default)', async () => {
    for (const toolChoice of [undefined, 'auto']) {
      const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
        tools,
        toolChoice
      });
      assert.equal(req.body.toolConfig, undefined);
    }
  });

  it('sets no tool config without function tools', async () => {
    const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
      toolChoice: 'required'
    });
    assert.equal(req.body.toolConfig, undefined);
  });

  it('sets no tool config next to native search, which drops the function declarations', async () => {
    const req = await GoogleAdapter.createCompletionRequest(model, messages, 'key', {
      tools,
      toolChoice: 'required',
      nativeWebSearch: { provider: 'google' }
    });
    assert.deepEqual(req.body.tools, [{ google_search: {} }]);
    assert.equal(req.body.toolConfig, undefined);
  });

  it('converts the OpenAI shapes', () => {
    assert.deepEqual(convertGoogleToolChoice('any'), { functionCallingConfig: { mode: 'ANY' } });
    assert.deepEqual(convertGoogleToolChoice('none'), { functionCallingConfig: { mode: 'NONE' } });
    assert.deepEqual(convertGoogleToolChoice({ type: 'function', function: { name: 'lookup' } }), {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] }
    });
    assert.equal(convertGoogleToolChoice('auto'), undefined);
    assert.equal(convertGoogleToolChoice('bogus'), undefined);
    assert.equal(convertGoogleToolChoice('constructor'), undefined, 'no prototype lookups');
  });
});

describe('Amazon Bedrock', () => {
  const model = {
    modelId: 'anthropic.claude-sonnet-4-5',
    provider: 'bedrock',
    config: { region: 'eu-central-1' }
  };

  it('sets toolChoice any for a required call and auto otherwise', async () => {
    const required = await BedrockAdapter.createCompletionRequest(model, messages, null, {
      tools,
      toolChoice: 'required'
    });
    assert.deepEqual(required.body.toolConfig.toolChoice, { any: {} });

    const auto = await BedrockAdapter.createCompletionRequest(model, messages, null, { tools });
    assert.deepEqual(auto.body.toolConfig.toolChoice, { auto: {} });
  });

  it('converts the OpenAI shapes', () => {
    assert.deepEqual(convertBedrockToolChoice('required'), { any: {} });
    assert.deepEqual(convertBedrockToolChoice({ type: 'function', function: { name: 'lookup' } }), {
      tool: { name: 'lookup' }
    });
  });
});
