/**
 * Prompt caching per model (issue #2508): the model switch, its provider
 * defaults, and the hints each adapter sends when it is on — OpenAI's
 * `prompt_cache_key`, Anthropic's `cache_control`, Bedrock's `cachePoint`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPromptCachingEnabled,
  isPromptCachingEnabled,
  supportsPromptCaching
} from '../../../shared/promptCaching.js';
import {
  buildPromptCacheKey,
  resolvePromptCache,
  PROMPT_CACHE_KEY_MAX_LENGTH
} from '../../adapters/promptCaching.js';
import OpenAIAdapter from '../../adapters/openai.js';
import OpenAIResponsesAdapter from '../../adapters/openai-responses.js';
import { applyCacheBreakpoints } from '../../adapters/anthropic.js';
import { applyCachePoints } from '../../adapters/bedrock.js';
import { makeClient, sseResponse, openaiText, MODELS } from './helpers/llmFixtures.js';

const EPHEMERAL = { type: 'ephemeral' };
const CACHE_POINT = { cachePoint: { type: 'default' } };

// ── Switch and defaults ─────────────────────────────────────────────────────

test('the switch applies to OpenAI, OpenAI Responses, Anthropic and Bedrock only', () => {
  for (const p of ['openai', 'openai-responses', 'anthropic', 'bedrock']) {
    assert.equal(supportsPromptCaching(p), true, p);
  }
  for (const p of ['google', 'mistral', 'local', 'iassistant-conversation', undefined]) {
    assert.equal(supportsPromptCaching(p), false, String(p));
    assert.equal(isPromptCachingEnabled({ provider: p, promptCaching: { enabled: true } }), false);
  }
});

test('defaults: on for api.openai.com, off for OpenAI-compatible servers, Anthropic and Bedrock', () => {
  const openai = url => ({ provider: 'openai', url });
  assert.equal(
    defaultPromptCachingEnabled(openai('https://api.openai.com/v1/chat/completions')),
    true
  );
  assert.equal(
    defaultPromptCachingEnabled({
      provider: 'openai-responses',
      url: 'https://api.openai.com/v1/responses'
    }),
    true
  );
  assert.equal(
    defaultPromptCachingEnabled(openai('http://localhost:1234/v1/chat/completions')),
    false
  );
  assert.equal(
    defaultPromptCachingEnabled(openai('https://x.openai.azure.com/openai/deployments/y')),
    false
  );
  assert.equal(defaultPromptCachingEnabled(openai(undefined)), false);
  assert.equal(
    defaultPromptCachingEnabled({ provider: 'anthropic', url: 'https://api.anthropic.com' }),
    false
  );
  assert.equal(defaultPromptCachingEnabled({ provider: 'bedrock' }), false);
});

test('an explicit setting wins over the default, both ways', () => {
  const official = { provider: 'openai', url: 'https://api.openai.com/v1/chat/completions' };
  assert.equal(isPromptCachingEnabled({ ...official, promptCaching: { enabled: false } }), false);
  assert.equal(
    isPromptCachingEnabled({ provider: 'anthropic', promptCaching: { enabled: true } }),
    true
  );
  assert.equal(isPromptCachingEnabled({ provider: 'anthropic' }), false);
});

// ── Cache key ───────────────────────────────────────────────────────────────

test('the cache key is per app and model, and never exceeds OpenAI’s 64 characters', () => {
  assert.equal(buildPromptCacheKey({ appId: 'chat', modelId: 'gpt-4o' }), 'ihub:chat:gpt-4o');
  assert.equal(buildPromptCacheKey({ modelId: 'gpt-4o' }), 'ihub:-:gpt-4o');
  const long = buildPromptCacheKey({ appId: 'a'.repeat(60), modelId: 'gpt-4o' });
  assert.ok(long.length <= PROMPT_CACHE_KEY_MAX_LENGTH);
  assert.match(long, /^ihub:[0-9a-f]{32}$/);
  assert.equal(long, buildPromptCacheKey({ appId: 'a'.repeat(60), modelId: 'gpt-4o' }), 'stable');
});

test('resolvePromptCache returns null when caching is off', () => {
  assert.equal(resolvePromptCache({ id: 'm', provider: 'anthropic' }), null);
  assert.deepEqual(
    resolvePromptCache(
      { id: 'm', provider: 'anthropic', promptCaching: { enabled: true } },
      { appId: 'x' }
    ),
    { key: 'ihub:x:m' }
  );
});

// ── OpenAI / Responses ──────────────────────────────────────────────────────

const messages = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hi' }
];

test('OpenAI Chat Completions sends prompt_cache_key only when caching is on', async () => {
  const model = { id: 'oa', provider: 'openai', modelId: 'gpt-4o', url: 'https://u' };
  const on = await OpenAIAdapter.createCompletionRequest(model, messages, 'k', {
    promptCache: { key: 'ihub:chat:oa' }
  });
  assert.equal(on.body.prompt_cache_key, 'ihub:chat:oa');
  const off = await OpenAIAdapter.createCompletionRequest(model, messages, 'k', {});
  assert.equal('prompt_cache_key' in off.body, false);
});

test('OpenAI Responses sends prompt_cache_key only when caching is on', async () => {
  const model = { id: 'or', provider: 'openai-responses', modelId: 'gpt-5', url: 'https://u' };
  const on = await OpenAIResponsesAdapter.createCompletionRequest(model, messages, 'k', {
    promptCache: { key: 'ihub:chat:or' }
  });
  assert.equal(on.body.prompt_cache_key, 'ihub:chat:or');
  const off = await OpenAIResponsesAdapter.createCompletionRequest(model, messages, 'k', {});
  assert.equal('prompt_cache_key' in off.body, false);
});

// ── Anthropic ───────────────────────────────────────────────────────────────

test('Anthropic: breakpoints on the last tool, the system prompt and the latest user message', () => {
  const body = {
    tools: [{ name: 'a' }, { name: 'b' }],
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' }
    ]
  };
  applyCacheBreakpoints(body);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools[1].cache_control, EPHEMERAL);
  assert.deepEqual(body.system, [
    { type: 'text', text: 'You are helpful.', cache_control: EPHEMERAL }
  ]);
  assert.equal(body.messages[0].content, 'first', 'earlier turns untouched');
  assert.deepEqual(body.messages[2].content, [
    { type: 'text', text: 'second', cache_control: EPHEMERAL }
  ]);
  const breakpoints = JSON.stringify(body).split('"cache_control"').length - 1;
  assert.ok(breakpoints <= 4, 'Anthropic allows at most four');
});

test('Anthropic: a tool-result turn gets the breakpoint on its last block', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'a' },
          { type: 'tool_result', tool_use_id: 't2', content: 'b' }
        ]
      }
    ]
  };
  applyCacheBreakpoints(body);
  assert.equal(body.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(body.messages[0].content[1].cache_control, EPHEMERAL);
});

test('Anthropic: no breakpoint on an assistant turn, empty text or blocks that cannot carry one', () => {
  const assistantLast = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }]
  };
  applyCacheBreakpoints(assistantLast);
  assert.equal(assistantLast.messages[0].content[0].cache_control, undefined);

  const emptyText = { messages: [{ role: 'user', content: '  ' }] };
  applyCacheBreakpoints(emptyText);
  assert.equal(emptyText.messages[0].content, '  ');

  const thinking = { messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 'x' }] }] };
  applyCacheBreakpoints(thinking);
  assert.equal(thinking.messages[0].content[0].cache_control, undefined);

  const noSystem = { system: '', messages: [] };
  applyCacheBreakpoints(noSystem);
  assert.equal(noSystem.system, '');
});

// ── Bedrock ─────────────────────────────────────────────────────────────────

const bedrockBody = () => ({
  system: [{ text: 'You are helpful.' }],
  toolConfig: { tools: [{ toolSpec: { name: 'a' } }], toolChoice: { auto: {} } },
  messages: [
    { role: 'user', content: [{ text: 'first' }] },
    { role: 'assistant', content: [{ text: 'answer' }] },
    { role: 'user', content: [{ text: 'second' }] }
  ]
});

test('Bedrock: cache points after tools (Claude), system and the latest user message', () => {
  for (const modelId of [
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
    'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'arn:aws:bedrock:eu-central-1:1:inference-profile/eu.anthropic.claude-opus-5'
  ]) {
    const body = bedrockBody();
    applyCachePoints(body, { modelId });
    assert.deepEqual(body.toolConfig.tools.at(-1), CACHE_POINT, modelId);
    assert.deepEqual(body.toolConfig.toolChoice, { auto: {} });
    assert.deepEqual(body.system.at(-1), CACHE_POINT);
    assert.deepEqual(body.messages[2].content.at(-1), CACHE_POINT);
    assert.equal(body.messages[0].content.length, 1, 'earlier turns untouched');
  }
});

test('Bedrock: no tool cache point for non-Claude models', () => {
  const body = bedrockBody();
  applyCachePoints(body, { modelId: 'amazon.nova-pro-v1:0' });
  assert.equal(body.toolConfig.tools.length, 1);
  assert.deepEqual(body.system.at(-1), CACHE_POINT);
});

// ── End to end through LLMClient ────────────────────────────────────────────

const NO_RUN = { autoRun: false, appId: 'chat' };

const ANTHROPIC_STREAM = [
  { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' }
];

async function requestFor(model) {
  const events = model.provider === 'anthropic' ? ANTHROPIC_STREAM : openaiText(['ok']);
  const { client, calls } = makeClient({
    realRequest: true,
    models: [model],
    transport: async () => sseResponse(events)
  });
  const result = await client.complete({
    modelId: model.id,
    messages: [{ role: 'user', content: 'hi' }],
    telemetry: NO_RUN
  });
  assert.equal(result.content, 'ok');
  return calls[0].request;
}

test('LLMClient passes the app-scoped key when caching is on, and nothing when it is off', async () => {
  const on = await requestFor({ ...MODELS.openai, promptCaching: { enabled: true } });
  assert.equal(on.body.prompt_cache_key, `ihub:chat:${MODELS.openai.id}`);

  // The fixture model is an OpenAI-compatible host: off by default.
  const off = await requestFor(MODELS.openai);
  assert.equal('prompt_cache_key' in off.body, false);
});

test('LLMClient adds Anthropic breakpoints only when the model opts in', async () => {
  const on = await requestFor({ ...MODELS.anthropic, promptCaching: { enabled: true } });
  assert.deepEqual(on.body.messages.at(-1).content.at(-1).cache_control, EPHEMERAL);
  const off = await requestFor(MODELS.anthropic);
  assert.equal(JSON.stringify(off.body).includes('cache_control'), false);
});

// ── Model schema ────────────────────────────────────────────────────────────

test('the model schema accepts promptCaching.enabled and rejects anything else', async () => {
  const { modelConfigSchema } = await import('../../validators/modelConfigSchema.js');
  const base = {
    id: 'claude',
    modelId: 'claude-sonnet',
    provider: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    name: { en: 'Claude' },
    description: { en: 'Claude' }
  };
  assert.equal(
    modelConfigSchema.safeParse({ ...base, promptCaching: { enabled: true } }).success,
    true
  );
  assert.equal(modelConfigSchema.safeParse(base).success, true);
  assert.equal(
    modelConfigSchema.safeParse({ ...base, promptCaching: { enabled: 'yes' } }).success,
    false
  );
  assert.equal(
    modelConfigSchema.safeParse({ ...base, promptCaching: { enabled: true, ttl: '1h' } }).success,
    false
  );
});
