// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `streamEnd` seam hook of `AgentLoop` and the tool lookup it hands to
 * `onChunk` (issue #3534).
 *
 * `streamEnd(ctx, { outcome, result? })` closes every model call `preStep`
 * opened: `completed` with the accumulated result, `error` when the provider
 * (or a later hook) fails, `aborted` on Stop. The loop returns from its `catch`
 * on the last two without ever calling `stepEnd`, which is why `stepEnd` alone
 * cannot close anything. Driven like agentLoop.test.js: the real loop and
 * LLMClient with scripted OpenAI-wire provider responses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import {
  fakeResponse,
  makeClient,
  sseResponse,
  textResponse,
  MODELS
} from './helpers/llmFixtures.js';

const encoder = new TextEncoder();
const model = MODELS.openai;
const messages = [{ role: 'user', content: 'Make me a calculator.' }];

const quietLogger = () => {
  const warnings = [];
  return {
    debug() {},
    info() {},
    error() {},
    warn: (message, data) => warnings.push({ message, data }),
    warnings
  };
};

const textTurn = content => [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  '[DONE]'
];

const toolTurn = (name, args, id = 'call_1') => [
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }]
        },
        finish_reason: null
      }
    ]
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]'
];

/** A loop that answers with the scripted provider turns in order. */
function makeLoop(turns, { seams = [], logger = quietLogger() } = {}) {
  const script = [...turns];
  const { client } = makeClient({
    maxRetries: 0,
    transport: async (request, ctx) => {
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      if (typeof next === 'function') return next(request, ctx);
      return sseResponse(next);
    }
  });
  return { loop: new AgentLoop({ llmClient: client, logger, seams }), logger };
}

/** A body that sends `events` and then stays open; errors when the request is aborted. */
function heldResponse(events, signal) {
  const wire = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  return fakeResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          try {
            controller.error(err);
          } catch {
            /* already closed */
          }
        });
      }
    }),
    text: wire
  });
}

/** A seam that writes the order of its hooks to `log`. */
const recordingSeam = log => ({
  name: 'recorder',
  preStep: ctx => log.push(['preStep', ctx.iteration]),
  onChunk: () => {
    if (log.at(-1)?.[0] !== 'onChunk') log.push(['onChunk']);
  },
  streamEnd: (ctx, info) => log.push(['streamEnd', ctx.iteration, info.outcome, !!info.result]),
  stepEnd: (ctx, step) => log.push(['stepEnd', step.iteration]),
  preTool: (ctx, info) => {
    log.push(['preTool', info.toolId]);
  }
});

const tool = {
  id: 'create_file',
  name: 'create_file',
  description: 'x',
  parameters: { type: 'object' }
};
const run = (loop, extra = {}) =>
  loop.run({
    model,
    messages,
    tools: [tool],
    executeTool: async () => ({ ok: true }),
    ...extra
  });

test('a completed model call: streamEnd carries the result, before stepEnd and before the tool', async () => {
  const log = [];
  const { loop } = makeLoop([toolTurn('create_file', '{"a":1}'), textTurn('Done.')], {
    seams: [recordingSeam(log)]
  });
  const result = await run(loop);
  assert.equal(result.status, 'completed');
  assert.deepEqual(log, [
    ['preStep', 1],
    ['onChunk'],
    ['streamEnd', 1, 'completed', true],
    ['stepEnd', 1],
    ['preTool', 'create_file'],
    ['preStep', 2],
    ['onChunk'],
    ['streamEnd', 2, 'completed', true],
    ['stepEnd', 2]
  ]);
});

test('streamEnd receives the accumulated result of the model call', async () => {
  let seen;
  const { loop } = makeLoop([textTurn('Hello')], {
    seams: [
      {
        streamEnd: (ctx, info) => {
          seen = info;
        }
      }
    ]
  });
  await run(loop, { tools: [] });
  assert.equal(seen.outcome, 'completed');
  assert.equal(seen.result.content, 'Hello');
  assert.equal(seen.result.finishReason, 'stop');
});

test('a provider error: streamEnd(error) once, no stepEnd, the run ends as an error', async () => {
  const log = [];
  const { loop } = makeLoop([() => textResponse('boom', { status: 500 })], {
    seams: [recordingSeam(log)]
  });
  const result = await run(loop);
  assert.equal(result.status, 'error');
  assert.deepEqual(log, [
    ['preStep', 1],
    ['streamEnd', 1, 'error', false]
  ]);
});

test('an error in the middle of the stream: streamEnd(error) after the chunks that did arrive', async () => {
  const log = [];
  const { loop } = makeLoop(
    [
      [
        { choices: [{ index: 0, delta: { content: 'Half' }, finish_reason: null }] },
        { error: { message: 'upstream failed' } }
      ]
    ],
    { seams: [recordingSeam(log)] }
  );
  const result = await run(loop, { tools: [] });
  assert.equal(result.status, 'error');
  assert.deepEqual(log, [['preStep', 1], ['onChunk'], ['streamEnd', 1, 'error', false]]);
});

test('Stop in the middle of the arguments: streamEnd(aborted), stepEnd never runs', async () => {
  const log = [];
  const controller = new AbortController();
  const partialCall = [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'create_file', arguments: '{"content":"<html>' }
              }
            ]
          },
          finish_reason: null
        }
      ]
    }
  ];
  const stop = { onChunk: () => queueMicrotask(() => controller.abort()) };
  const { loop } = makeLoop([(request, ctx) => heldResponse(partialCall, ctx.signal)], {
    seams: [recordingSeam(log), stop]
  });
  const result = await run(loop, { signal: controller.signal });
  assert.equal(result.status, 'aborted');
  assert.deepEqual(log, [['preStep', 1], ['onChunk'], ['streamEnd', 1, 'aborted', false]]);
});

test('an aborted signal before the request is sent still pairs streamEnd with preStep', async () => {
  const log = [];
  const controller = new AbortController();
  const { loop } = makeLoop([() => textResponse('never', { status: 500 })], {
    seams: [recordingSeam(log), { preStep: () => controller.abort() }]
  });
  const result = await run(loop, { signal: controller.signal });
  assert.equal(result.status, 'aborted');
  assert.deepEqual(
    log.filter(([hook]) => hook !== 'onChunk'),
    [
      ['preStep', 1],
      ['streamEnd', 1, 'aborted', false]
    ]
  );
});

test('a preStep that fails after an earlier seam armed something still ends that seam’s model call', async () => {
  const log = [];
  const { loop } = makeLoop([textTurn('never asked')], {
    seams: [
      recordingSeam(log),
      {
        preStep: () => {
          throw new Error('telemetry down');
        }
      }
    ]
  });
  const result = await run(loop, { tools: [] });
  assert.equal(result.status, 'error');
  assert.deepEqual(log, [
    ['preStep', 1],
    ['streamEnd', 1, 'error', false]
  ]);
});

test('a throwing streamEnd is logged and never replaces the outcome', async () => {
  const { loop, logger } = makeLoop([textTurn('fine')], {
    seams: [
      {
        streamEnd: () => {
          throw new Error('display bug');
        }
      }
    ]
  });
  const result = await run(loop, { tools: [] });
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'fine');
  assert.ok(logger.warnings.some(w => /streamEnd seam failed/.test(w.message)));

  const failing = makeLoop([() => textResponse('boom', { status: 500 })], {
    seams: [
      {
        streamEnd: () => {
          throw new Error('display bug');
        }
      }
    ]
  });
  const failed = await run(failing.loop, { tools: [] });
  assert.equal(failed.status, 'error', 'the provider error is still the outcome');
  assert.doesNotMatch(String(failed.error?.message), /display bug/);
});

test('a throwing streamEnd does not stop the seams after it from learning the call ended', async () => {
  const seen = [];
  const { loop, logger } = makeLoop([textTurn('fine')], {
    seams: [
      {
        name: 'first',
        streamEnd: () => {
          throw new Error('display bug');
        }
      },
      { name: 'second', streamEnd: (_ctx, info) => seen.push(info.outcome) }
    ]
  });
  const result = await run(loop, { tools: [] });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, ['completed'], 'the later seam still got its streamEnd');
  const warning = logger.warnings.find(w => /streamEnd seam failed/.test(w.message));
  assert.equal(warning?.data?.seam, 'first', 'the failing seam is named in the log');
});

test('seams without a streamEnd hook are unaffected', async () => {
  const { loop } = makeLoop([textTurn('plain')], { seams: [{ name: 'other', stepEnd: () => {} }] });
  const result = await run(loop, { tools: [] });
  assert.equal(result.status, 'completed');
});

// ── ctx.resolveTool: the lookup a seam uses while the call streams ──────────

test('ctx.resolveTool finds the offered tool by id or by the name the provider saw, and nothing else', async () => {
  const seen = [];
  const mcpTool = { id: 'mcp a/do it', name: 'mcp a/do it', parameters: { type: 'object' } };
  const { loop } = makeLoop([textTurn('x')], {
    seams: [
      {
        onChunk: ctx => {
          seen.push(
            ctx.resolveTool('create_file')?.id,
            ctx.resolveTool('mcp_a_do_it')?.id,
            ctx.resolveTool('hallucinated'),
            ctx.resolveTool('')
          );
        }
      }
    ]
  });
  await run(loop, { tools: [tool, mcpTool] });
  assert.deepEqual(seen.slice(0, 4), ['create_file', 'mcp a/do it', null, null]);
});

test('ctx.resolveTool does not offer a circuit-broken tool', async () => {
  let resolved;
  const { loop } = makeLoop([textTurn('x')], {
    seams: [
      {
        preStep: ctx => ctx.disabledTools.add('create_file'),
        onChunk: ctx => {
          resolved = ctx.resolveTool('create_file');
        }
      }
    ]
  });
  await run(loop, {
    tools: [tool, { id: 'other', name: 'other', parameters: { type: 'object' } }]
  });
  assert.equal(resolved, null);
});
