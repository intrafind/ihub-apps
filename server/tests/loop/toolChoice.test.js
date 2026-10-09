/**
 * `policies.tools.choice: 'required'` — the first model call of a turn must
 * call a tool, every later call is free to answer. Driven through the real
 * AgentLoop and LLMClient with scripted provider responses (OpenAI wire).
 *
 * The stub request the fixtures build echoes the adapter options, so
 * `request.body.toolChoice` is what the loop handed to the adapter.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, resolvePolicies } from '../../services/loop/AgentLoop.js';
import {
  REQUIRE_TOOL_NUDGE,
  clearToolChoiceMemo,
  isForcedToolUseUnavailable,
  isToolChoiceRejection,
  planToolChoice,
  turnHasToolCalls
} from '../../services/loop/toolChoice.js';
import { makeClient, sseResponse, textResponse, MODELS } from './helpers/llmFixtures.js';

// ── scripted provider turns ─────────────────────────────────────────────────

function textTurn(content) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ];
}

function toolTurn(name, args) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ];
}

const noop = () => undefined;

function makeLoop(turns) {
  const script = [...turns];
  const requests = [];
  const { client } = makeClient({
    maxRetries: 0,
    transport: request => {
      requests.push(request);
      const next = script.shift();
      if (!next) throw new Error(`script exhausted after ${requests.length} calls`);
      return typeof next === 'function' ? next(request) : sseResponse(next);
    }
  });
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  return { loop: new AgentLoop({ llmClient: client, logger }), requests };
}

const model = MODELS.openai;
const messages = [
  { role: 'system', content: 'You answer questions.' },
  { role: 'user', content: 'What is new at ACME?' }
];
const fetchTool = {
  id: 'read_url',
  description: 'fetch',
  parameters: { type: 'object', properties: { url: { type: 'string' } } }
};
const run = (loop, overrides = {}) =>
  loop.run({
    model,
    messages,
    tools: [fetchTool],
    policies: { tools: { choice: 'required' } },
    executeTool: async () => ({ ok: true }),
    ...overrides
  });

/** The transcript the model saw, without the system prompt. */
const lastMessage = request => request.body.messages[request.body.messages.length - 1];
const hasNudge = request => request.body.messages.some(m => m.content === REQUIRE_TOOL_NUDGE);

beforeEach(() => clearToolChoiceMemo());

// ── the policy ──────────────────────────────────────────────────────────────

test('the policy defaults to auto', () => {
  assert.equal(resolvePolicies({}).tools.choice, 'auto');
  assert.equal(resolvePolicies({ tools: { choice: 'required' } }).tools.choice, 'required');
  assert.throws(() => resolvePolicies({ tools: { choice: 'sometimes' } }));
});

test('required: the first call forces a tool, the call after the tool result is auto', async () => {
  const { loop, requests } = makeLoop([toolTurn('read_url', { url: 'x' }), textTurn('Done.')]);

  const result = await run(loop);

  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'Done.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.toolChoice, 'required');
  assert.equal(requests[1].body.toolChoice, undefined, 'the model may answer from the result');
  assert.equal(hasNudge(requests[0]), false, 'the API is told, not the model');
});

test('auto (the default) sends no tool choice', async () => {
  const { loop, requests } = makeLoop([textTurn('From memory.')]);

  await run(loop, { policies: {} });

  assert.equal(requests[0].body.toolChoice, undefined);
  assert.equal(hasNudge(requests[0]), false);
});

test('required with no tools offered forces nothing', async () => {
  const { loop, requests } = makeLoop([textTurn('No tools here.')]);

  const result = await run(loop, { tools: [] });

  assert.equal(result.content, 'No tools here.');
  assert.equal(requests[0].body.toolChoice, undefined);
  assert.equal(hasNudge(requests[0]), false);
});

test('a turn that already holds a tool call is not forced again', async () => {
  const resumed = [
    ...messages,
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'q1', type: 'function', function: { name: 'ask_user', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'q1', name: 'ask_user', content: '"the red one"' }
  ];
  const { loop, requests } = makeLoop([textTurn('Here is the red one.')]);

  await run(loop, { messages: resumed });

  assert.equal(requests[0].body.toolChoice, undefined);
  assert.equal(hasNudge(requests[0]), false);
});

test('a tool call in an earlier turn does not count', async () => {
  const history = [
    { role: 'user', content: 'Look up ACME.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read_url', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'c0', name: 'read_url', content: '"ACME makes anvils"' },
    { role: 'assistant', content: 'ACME makes anvils.' },
    { role: 'user', content: 'And what is new there?' }
  ];
  const { loop, requests } = makeLoop([toolTurn('read_url', { url: 'x' }), textTurn('Done.')]);

  await run(loop, { messages: history });

  assert.equal(requests[0].body.toolChoice, 'required');
});

// ── a model that cannot be forced ───────────────────────────────────────────

test('supportsForcedToolUse: false asks in words, on the first call only, and keeps it out of the transcript', async () => {
  const stubborn = { ...model, id: 'no-force', supportsForcedToolUse: false };
  const { loop, requests } = makeLoop([toolTurn('read_url', { url: 'x' }), textTurn('Done.')]);

  const result = await run(loop, { model: stubborn });

  assert.equal(requests[0].body.toolChoice, undefined);
  assert.equal(lastMessage(requests[0]).content, REQUIRE_TOOL_NUDGE);
  assert.equal(hasNudge(requests[1]), false, 'only the first call is nudged');
  assert.equal(
    result.messages.some(m => m.content === REQUIRE_TOOL_NUDGE),
    false,
    'the instruction is not part of the conversation'
  );
});

test('a provider that rejects the forced call is retried in words, uncharged, and remembered', async () => {
  const picky = { ...model, id: 'picky' };
  const rejection = () =>
    textResponse(
      '{"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}',
      { status: 400 }
    );
  const first = makeLoop([rejection, toolTurn('read_url', { url: 'x' }), textTurn('Done.')]);

  const result = await run(first.loop, { model: picky });

  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'Done.');
  assert.equal(first.requests.length, 3);
  assert.equal(first.requests[0].body.toolChoice, 'required', 'tried the forced call first');
  assert.equal(first.requests[1].body.toolChoice, undefined);
  assert.equal(lastMessage(first.requests[1]).content, REQUIRE_TOOL_NUDGE);
  assert.equal(result.iterations, 2, 'the refused attempt is not charged a round');
  assert.equal(isForcedToolUseUnavailable('picky'), true);

  // The next turn on that model does not try the doomed request again.
  const second = makeLoop([toolTurn('read_url', { url: 'y' }), textTurn('Again.')]);
  await run(second.loop, { model: picky });
  assert.equal(second.requests[0].body.toolChoice, undefined);
  assert.equal(lastMessage(second.requests[0]).content, REQUIRE_TOOL_NUDGE);
});

test('another bad request is not taken for a tool choice rejection', async () => {
  const { loop, requests } = makeLoop([
    () =>
      textResponse('{"error":{"message":"temperature must be between 0 and 1"}}', { status: 400 })
  ]);

  const result = await run(loop);

  assert.equal(result.status, 'error');
  assert.equal(requests.length, 1, 'no retry');
  assert.equal(isForcedToolUseUnavailable(model.id), false);
});

// ── what is not changed ─────────────────────────────────────────────────────

test('an explicit adapter toolChoice still passes through on every call (OpenAI-compatible API)', async () => {
  const { loop, requests } = makeLoop([toolTurn('read_url', { url: 'x' }), textTurn('Done.')]);

  await run(loop, { policies: {}, options: { toolChoice: 'required' } });

  assert.equal(requests[0].body.toolChoice, 'required');
  assert.equal(requests[1].body.toolChoice, 'required');
});

// ── the pieces ──────────────────────────────────────────────────────────────

test('planToolChoice decides per call', () => {
  const tools = [fetchTool];
  const base = { choice: 'required', offeredTools: tools, iteration: 1, model };

  assert.deepEqual(planToolChoice(base), { force: true, nudge: null });
  assert.deepEqual(planToolChoice({ ...base, choice: 'auto' }), { force: false, nudge: null });
  assert.deepEqual(planToolChoice({ ...base, choice: undefined }), { force: false, nudge: null });
  assert.deepEqual(planToolChoice({ ...base, iteration: 2 }), { force: false, nudge: null });
  assert.deepEqual(planToolChoice({ ...base, priorToolUse: true }), { force: false, nudge: null });
  assert.deepEqual(planToolChoice({ ...base, offeredTools: undefined }), {
    force: false,
    nudge: null
  });
  assert.deepEqual(planToolChoice({ ...base, forcedRejected: true }), {
    force: false,
    nudge: REQUIRE_TOOL_NUDGE
  });
  assert.deepEqual(planToolChoice({ ...base, model: { ...model, supportsForcedToolUse: false } }), {
    force: false,
    nudge: REQUIRE_TOOL_NUDGE
  });
});

test('turnHasToolCalls looks only at the current turn and ignores loop-made messages', () => {
  const call = { id: 'c', type: 'function', function: { name: 't', arguments: '{}' } };
  assert.equal(turnHasToolCalls([{ role: 'user', content: 'hi' }]), false);
  assert.equal(
    turnHasToolCalls([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [call] }
    ]),
    true
  );
  assert.equal(
    turnHasToolCalls([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'c', content: '{}' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'and now?' }
    ]),
    false,
    'a later user message starts a new turn'
  );
  assert.equal(
    turnHasToolCalls([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'c', content: '{}' },
      { role: 'user', content: 'steer', _steer: true },
      { role: 'user', content: 'nudge', _nudge: true }
    ]),
    true,
    'steer and nudge messages are the loop’s, not the person’s'
  );
  assert.equal(turnHasToolCalls(undefined), false);
});

test('isToolChoiceRejection matches provider refusals of the field and nothing else', () => {
  const anthropic = Object.assign(
    new Error('tool_choice: type "tool" and "any" are not supported for this model.'),
    { status: 400 }
  );
  const openai = Object.assign(new Error('Invalid value for "tool_choice"'), { status: 422 });
  const bedrock = Object.assign(new Error('The model does not support toolChoice any'), {
    status: 400
  });
  const gemini = Object.assign(new Error('x'), {
    status: 400,
    details: { error: { message: 'Invalid function_calling_config.mode' } }
  });
  assert.equal(isToolChoiceRejection(anthropic), true);
  assert.equal(isToolChoiceRejection(openai), true);
  assert.equal(isToolChoiceRejection(bedrock), true);
  assert.equal(isToolChoiceRejection(gemini), true);
  assert.equal(
    isToolChoiceRejection(Object.assign(new Error('tool_choice problem'), { status: 500 })),
    false,
    'only client errors'
  );
  assert.equal(
    isToolChoiceRejection(Object.assign(new Error('prompt is too long'), { status: 400 })),
    false
  );
  assert.equal(isToolChoiceRejection(null), false);
});
