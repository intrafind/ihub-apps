/**
 * T3 — AgentLoop behaviour specs. Every loop behaviour is asserted ONCE here,
 * against the one loop, driven through the real LLMClient with scripted
 * provider responses (OpenAI wire) so the whole path is exercised.
 *
 * Ported from: agent-budget-loop, agent-tool-circuit-breaker, agent-tool-loop-abort,
 * agent-loop-proactive-compaction, agent-context-management (reactive recovery),
 * toolExecutor-usage-telemetry (one LLM call per iteration), chat-side behaviours
 * (argument repair, parameter defaults, image lift, passthrough, clarification cap,
 * knowledge sources), plus the degenerate-run contract and segment planner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, resolvePolicies } from '../../services/loop/AgentLoop.js';
import {
  imageLiftSeam,
  knowledgeSourceSeam,
  passthroughSeam,
  questionSeam
} from '../../services/loop/seams/index.js';
import { LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { planToolBatches } from '../../services/loop/segmentPlanner.js';
import { steerRun, takeSteers, STEER_MARKER } from '../../services/loop/steering.js';
import {
  makeClient,
  sseResponse,
  textResponse,
  captureRunLog,
  MODELS
} from './helpers/llmFixtures.js';

// ── scripted provider turns ─────────────────────────────────────────────────

function textTurn(content, { usage, finishReason = 'stop' } = {}) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    ...(content ? [{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }] : []),
    {
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      ...(usage ? { usage } : {})
    },
    '[DONE]'
  ];
}

function toolTurn(calls, { content = '', usage } = {}) {
  return [
    ...(content
      ? [{ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }]
      : []),
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: c.id || `call_${i + 1}`,
              type: 'function',
              function: {
                name: c.name,
                arguments:
                  c.args === undefined
                    ? '{}'
                    : typeof c.args === 'string'
                      ? c.args
                      : JSON.stringify(c.args)
              }
            }))
          },
          finish_reason: null
        }
      ]
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      ...(usage ? { usage } : {})
    },
    '[DONE]'
  ];
}

/** Build a loop whose provider answers with the scripted turns in order. */
function makeLoop(turns, { runLog, seams, maxRetries = 0, onRequest } = {}) {
  const script = [...turns];
  const requests = [];
  const { client } = makeClient({
    runLog,
    maxRetries,
    transport: async (request, ctx) => {
      requests.push({ request, ctx });
      onRequest?.(request, ctx, requests.length);
      const next = script.shift();
      if (!next) throw new Error(`script exhausted after ${requests.length} calls`);
      if (typeof next === 'function') return next(request, ctx);
      return sseResponse(next);
    }
  });
  const loop = new AgentLoop({ llmClient: client, runLog, logger: silentLogger(), seams });
  return { loop, requests, client };
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

const model = MODELS.openai;
const baseMessages = [
  { role: 'system', content: 'You are a research agent.' },
  { role: 'user', content: 'Find the weather in Berlin.' }
];
const searchTool = {
  id: 'webSearch',
  name: 'webSearch',
  description: 'search',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, maxResults: { type: 'number', default: 5 } }
  },
  readOnly: true
};
const fetchTool = {
  id: 'webContentExtractor',
  description: 'fetch',
  parameters: { type: 'object', properties: { url: { type: 'string' } } }
};

const okTool = async (call, { toolId, args }) => ({ ok: true, toolId, args });

// ── degenerate-run contract ────────────────────────────────────────────────

test('degenerate: no tools → exactly one model call, result ≡ completion', async () => {
  const { loop, requests } = makeLoop([
    textTurn('Sunny.', { usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })
  ]);
  const result = await loop.run({ model, messages: baseMessages, tools: [] });
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'Sunny.');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.iterations, 1);
  assert.equal(requests.length, 1);
  assert.equal(result.usage.totalTokens, 22);
  assert.equal(result.usage.source, 'provider');
  assert.equal(requests[0].request.body.tools, undefined, 'no tools offered');
  assert.equal(result.messages.length, baseMessages.length, 'transcript unchanged');
});

test('degenerate: caller-executed toolset terminates with parsed tool calls and never executes', async () => {
  let executed = 0;
  const seams = [
    {
      preTool: () => {
        executed += 1;
      }
    }
  ];
  const { loop, requests } = makeLoop(
    [
      toolTurn([
        { name: 'webSearch', args: { query: 'berlin' } },
        { name: 'webContentExtractor', args: '{"url":"x"}{"a":1}' }
      ])
    ],
    { seams }
  );
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool, fetchTool],
    toolExecution: 'caller',
    policies: { context: { compactThresholdTokens: 1 } },
    executeTool: async () => {
      executed += 1;
      return {};
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(requests.length, 1);
  assert.equal(executed, 0, 'no seam, no executor, no compaction ran');
  assert.deepEqual(
    result.toolCalls.map(c => [c.name, c.arguments]),
    [
      ['webSearch', { query: 'berlin' }],
      ['webContentExtractor', { url: 'x', a: 1 }]
    ]
  );
  assert.equal(result.toolCalls[0].id, 'call_1');
});

// ── tool rounds ─────────────────────────────────────────────────────────────

test('one model call per round; tool results appended in call order; final answer ends the segment', async () => {
  const { loop, requests } = makeLoop([
    toolTurn([{ name: 'webSearch', args: { query: 'berlin weather' } }], {
      content: 'Let me search.'
    }),
    textTurn('It is sunny in Berlin.')
  ]);
  const calls = [];
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: async (call, info) => {
      calls.push(info);
      return { results: ['sunny'] };
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.iterations, 2);
  assert.equal(requests.length, 2);
  assert.equal(result.content, 'Let me search.It is sunny in Berlin.');
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].args,
    { query: 'berlin weather', maxResults: 5 },
    'parameter defaults applied'
  );
  const transcript = result.messages;
  assert.equal(transcript[2].role, 'assistant');
  assert.equal(transcript[2].tool_calls[0].function.name, 'webSearch');
  assert.equal(transcript[3].role, 'tool');
  assert.equal(transcript[3].tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(transcript[3].content), { results: ['sunny'] });
  const secondRequestMessages = requests[1].request.body.messages;
  assert.equal(secondRequestMessages.length, 4, 'follow-up request carries the tool round');
  assert.ok(Array.isArray(requests[0].request.body.tools), 'tools offered on the first call');
});

test('argument repair: glued objects and unquoted fragments still reach the tool', async () => {
  const { loop } = makeLoop([
    toolTurn([
      { name: 'webSearch', args: '{"query":"a"}{"maxResults":3}' },
      { name: 'webContentExtractor', args: '"url":"https://x"' },
      { name: 'webContentExtractor', args: 'not json at all' }
    ]),
    textTurn('done')
  ]);
  const seen = [];
  await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool, fetchTool],
    executeTool: async (call, { args }) => {
      seen.push(args);
      return 'ok';
    }
  });
  assert.deepEqual(seen, [{ query: 'a', maxResults: 3 }, { url: 'https://x' }, {}]);
});

test('hallucinated tool → error envelope for the model, seam notified, no executor call', async () => {
  const hallucinated = [];
  const { loop } = makeLoop([toolTurn([{ name: 'make_coffee', args: {} }]), textTurn('ok')], {
    seams: [{ onHallucinated: (_ctx, info) => hallucinated.push(info) }]
  });
  let executed = 0;
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: async () => {
      executed += 1;
      return {};
    }
  });
  assert.equal(executed, 0);
  assert.equal(hallucinated.length, 1);
  assert.deepEqual(hallucinated[0].availableTools, ['webSearch']);
  const toolMsg = result.messages.find(m => m.role === 'tool');
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.error, true);
  assert.equal(payload.reason, 'tool_not_registered');
  assert.match(payload.message, /Available tools: webSearch/);
});

test('tool exceptions are fed back to the model as error results, never thrown', async () => {
  const { loop } = makeLoop([toolTurn([{ name: 'webSearch', args: {} }]), textTurn('recovered')]);
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: async () => {
      throw new Error('provider down');
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'recovered');
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.match(JSON.parse(toolMsg.content).message, /Tool execution failed: provider down/);
});

// ── budgets ─────────────────────────────────────────────────────────────────

test('token budget: exhausted → tools withdrawn, wrap-up nudge, final answer', async () => {
  const usage = { prompt_tokens: 600, completion_tokens: 50, total_tokens: 650 };
  const { loop, requests } = makeLoop([
    toolTurn([{ name: 'webSearch', args: { query: 'a' } }], { usage }),
    toolTurn([{ name: 'webSearch', args: { query: 'b' } }], { usage }),
    textTurn('Final answer with what I have.', { usage })
  ]);
  const state = { budget: { input: 0, output: 0, total: 0 } };
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxTokensPerRun: 1000, maxToolRounds: 10 } },
    state,
    executeTool: okTool
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].request.body.tools, undefined, 'tools withheld on the wrap-up turn');
  assert.equal(result.status, 'completed');
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.budgetReason, 'tokens');
  assert.equal(result.content, 'Final answer with what I have.');
  assert.equal(state.budget.total, 1950, 'run-level budget accumulates across calls');
  const nudge = result.messages.filter(m => m._nudge).pop();
  assert.match(nudge.content, /Token budget for this run is exhausted \(1300\/1000\)/);
});

test('token budget: model keeps calling tools on the forced turn → budget_exhausted', async () => {
  const usage = { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 };
  const { loop } = makeLoop([
    toolTurn([{ name: 'webSearch', args: {} }], { usage }),
    toolTurn([{ name: 'webSearch', args: {} }], { usage })
  ]);
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxTokensPerRun: 500 } },
    executeTool: okTool
  });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.finishReason, 'budget_exhausted');
  assert.equal(result.iterations, 2);
});

test('unlimited budget (0) never forces a finish before the round cap', async () => {
  const usage = { prompt_tokens: 100000, completion_tokens: 1000, total_tokens: 101000 };
  const { loop } = makeLoop([
    toolTurn([{ name: 'webSearch', args: {} }], { usage }),
    textTurn('ok', { usage })
  ]);
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: okTool
  });
  assert.equal(result.budgetExhausted, false);
  assert.equal(result.status, 'completed');
});

test('round cap: last round is spent on a tool-less final answer; budget_exhausted when the model never answers', async () => {
  const { loop, requests } = makeLoop([
    toolTurn([{ name: 'webSearch', args: {} }]),
    toolTurn([{ name: 'webSearch', args: {} }]),
    textTurn('Best effort answer.')
  ]);
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxToolRounds: 3 } },
    executeTool: okTool
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].request.body.tools, undefined);
  assert.equal(result.content, 'Best effort answer.');
  assert.equal(result.budgetReason, 'rounds');
  assert.match(result.messages.filter(m => m._nudge).pop().content, /tool-use round limit/);

  const { loop: stubborn } = makeLoop([
    toolTurn([{ name: 'webSearch', args: {} }]),
    toolTurn([{ name: 'webSearch', args: {} }])
  ]);
  const r2 = await stubborn.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxToolRounds: 2 } },
    executeTool: okTool
  });
  assert.equal(r2.finishReason, 'budget_exhausted');
  assert.equal(r2.status, 'budget_exhausted');
  assert.equal(r2.iterations, 2);
});

test('round cap of 1: the single tool round is followed by one extra tool-less call for the final answer', async () => {
  const { loop, requests } = makeLoop([
    toolTurn([{ name: 'webSearch', args: {} }]),
    textTurn('Answer from one round.')
  ]);
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxToolRounds: 1 } },
    executeTool: okTool
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].request.body.tools, undefined);
  assert.equal(result.content, 'Answer from one round.');
  assert.equal(result.status, 'completed');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.iterations, 2);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.budgetReason, 'rounds');

  // A model that still calls tools on that extra call ends as budget_exhausted.
  const { loop: stubborn, requests: stubbornRequests } = makeLoop([
    toolTurn([{ name: 'webSearch', args: {} }]),
    toolTurn([{ name: 'webSearch', args: {} }])
  ]);
  const r2 = await stubborn.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxToolRounds: 1 } },
    executeTool: okTool
  });
  assert.equal(stubbornRequests.length, 2);
  assert.equal(r2.status, 'budget_exhausted');
  assert.equal(r2.finishReason, 'budget_exhausted');
});

// ── circuit breakers ────────────────────────────────────────────────────────

test('circuit breaker: two rate-limit failures disable the tool, nudge forbids invented URLs, all-dead forces finish', async () => {
  const broken = [];
  const { loop, requests } = makeLoop(
    [
      toolTurn([{ name: 'webSearch', args: { query: 'a' } }]),
      toolTurn([{ name: 'webSearch', args: { query: 'b' } }]),
      textTurn('I could not verify anything.')
    ],
    { seams: [{ onCircuitBroken: (_ctx, info) => broken.push(info) }] }
  );
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxToolRounds: 8 } },
    executeTool: async () => ({ error: true, message: 'HTTP 429 Too Many Requests' })
  });
  assert.deepEqual(result.disabledTools, ['webSearch']);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].reason, 'rate_limited');
  assert.equal(broken[0].failures, 2);
  const nudges = result.messages.filter(m => m._nudge).map(m => m.content);
  assert.match(
    nudges[0],
    /"webSearch" is unavailable for the rest of this step \(rate-limited, failed 2×/
  );
  assert.match(nudges[0], /do NOT invent or guess URLs/);
  assert.match(nudges[1], /All tools are currently unavailable/);
  assert.equal(requests[2].request.body.tools, undefined, 'dead tool not offered');
  assert.equal(result.budgetReason, 'tools_dead');
  assert.equal(result.status, 'completed');
});

test('circuit breaker: three consecutive failures trip; a success resets the streak', async () => {
  const { loop } = makeLoop([
    toolTurn([{ name: 'webContentExtractor', args: { url: '1' } }]),
    toolTurn([{ name: 'webContentExtractor', args: { url: '2' } }]),
    toolTurn([{ name: 'webContentExtractor', args: { url: '3' } }]),
    toolTurn([{ name: 'webContentExtractor', args: { url: '4' } }]),
    toolTurn([{ name: 'webContentExtractor', args: { url: '5' } }]),
    textTurn('done')
  ]);
  let n = 0;
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [fetchTool, searchTool],
    policies: { budgets: { maxToolRounds: 10 } },
    executeTool: async () => {
      n += 1;
      // fail, fail, success (reset), fail, fail → never trips with limit 3
      return n === 3 ? { ok: true } : { error: true, message: 'HTTP 404 not found' };
    }
  });
  assert.deepEqual(result.disabledTools, []);
  assert.equal(result.content, 'done');

  const { loop: trip } = makeLoop([
    toolTurn([{ name: 'webContentExtractor', args: { url: '1' } }]),
    toolTurn([{ name: 'webContentExtractor', args: { url: '2' } }]),
    toolTurn([{ name: 'webContentExtractor', args: { url: '3' } }]),
    textTurn('done')
  ]);
  const r2 = await trip.run({
    model,
    messages: baseMessages,
    tools: [fetchTool, searchTool],
    executeTool: async () => ({ error: true, message: 'HTTP 404 not found' })
  });
  assert.deepEqual(r2.disabledTools, ['webContentExtractor']);
  const nudge = r2.messages.filter(m => m._nudge)[0].content;
  assert.match(nudge, /failed 3× in a row/);
  assert.equal(r2.budgetExhausted, false, 'search tool still alive, no forced finish');
});

// ── abort ───────────────────────────────────────────────────────────────────

test('abort: pre-aborted signal → aborted before any model call', async () => {
  const { loop, requests } = makeLoop([textTurn('never')]);
  const controller = new AbortController();
  controller.abort();
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [],
    signal: controller.signal
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.finishReason, 'aborted');
  assert.equal(result.error.code, LLM_ERROR_CODES.ABORTED);
  assert.equal(requests.length, 0);
});

test('abort mid-batch: remaining calls get synthetic results, no further model call', async () => {
  const controller = new AbortController();
  const { loop, requests } = makeLoop([
    toolTurn([
      { name: 'webContentExtractor', args: { url: 'a' } },
      { name: 'webContentExtractor', args: { url: 'a' } },
      { name: 'webContentExtractor', args: { url: 'a' } }
    ]),
    textTurn('never')
  ]);
  let executed = 0;
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [fetchTool],
    signal: controller.signal,
    executeTool: async () => {
      executed += 1;
      controller.abort();
      return { ok: true };
    }
  });
  assert.equal(result.status, 'aborted');
  assert.equal(executed, 1, 'overlapping targets run sequentially; abort stops the batch');
  assert.equal(requests.length, 1);
  const toolMsgs = result.messages.filter(m => m.role === 'tool');
  assert.equal(toolMsgs.length, 3, 'every call has a result in the transcript');
  assert.deepEqual(JSON.parse(toolMsgs[1].content), { error: true, message: 'aborted' });
});

test('abort between iterations → aborted with partial content preserved', async () => {
  const controller = new AbortController();
  const { loop, requests } = makeLoop([
    toolTurn([{ name: 'webSearch', args: {} }], { content: 'partial ' }),
    textTurn('never')
  ]);
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    signal: controller.signal,
    seams: [{ stepEnd: () => controller.abort() }],
    executeTool: okTool
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.content, 'partial ');
  assert.equal(requests.length, 1);
});

// ── compaction ──────────────────────────────────────────────────────────────

test('wall clock: the deadline aborts an in-flight tool and a hanging model call', async () => {
  // A tool that never settles and ignores the signal is abandoned at the deadline.
  const { loop, requests } = makeLoop([toolTurn([{ name: 'webSearch', args: { query: 'x' } }])]);
  let started = Date.now();
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxWallClockMs: 60 } },
    executeTool: () => new Promise(() => {})
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error.providerCode, 'WALL_CLOCK');
  assert.equal(result.error.code, LLM_ERROR_CODES.TIMEOUT);
  assert.ok(Date.now() - started < 2000, 'did not wait for the tool');
  assert.equal(requests.length, 1, 'no follow-up model call after the deadline');

  // A model call that only settles when its signal aborts is cut short too.
  const { loop: hanging } = makeLoop([
    (request, ctx) =>
      new Promise((_, reject) =>
        ctx.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      )
  ]);
  started = Date.now();
  const cut = await hanging.run({
    model,
    messages: baseMessages,
    policies: { budgets: { maxWallClockMs: 60 } }
  });
  assert.equal(cut.status, 'error');
  assert.equal(cut.error.providerCode, 'WALL_CLOCK');
  assert.ok(Date.now() - started < 2000);

  // The tool executor receives the combined signal so it can stop early itself.
  const seen = [];
  const { loop: cooperative } = makeLoop([
    toolTurn([{ name: 'webSearch', args: { query: 'x' } }]),
    textTurn('done')
  ]);
  const done = await cooperative.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { budgets: { maxWallClockMs: 5000 } },
    executeTool: async (call, { signal }) => {
      seen.push(signal instanceof AbortSignal && !signal.aborted);
      return { ok: true };
    }
  });
  assert.equal(done.status, 'completed');
  assert.deepEqual(seen, [true]);
});

test('steer: a queued human message reaches the next model call inside the trust marker and the ledger', async () => {
  const { runLog, events } = await captureRunLog();
  const { runId } = await runLog.startRun({ kind: 'agent', user: { id: 'u1' } });
  const { loop, requests } = makeLoop(
    [toolTurn([{ name: 'webSearch', args: { query: 'x' } }]), textTurn('done')],
    { runLog }
  );
  const result = await loop.run({
    runId,
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: async () => {
      // the human steers while the tool runs: delivered at the next step boundary
      assert.equal(
        steerRun(runId, { message: 'Focus on 2025 figures only', by: 'alice' }, { runLog }),
        'queued'
      );
      return { ok: true };
    }
  });
  assert.equal(result.status, 'completed');
  const second = requests[1].request.body.messages;
  const steer = second.find(m => m.role === 'user' && String(m.content).startsWith(STEER_MARKER));
  assert.ok(steer, 'the steer is in the second request');
  assert.match(steer.content, /Focus on 2025 figures only/);
  assert.equal(
    second.indexOf(steer),
    second.length - 1,
    'appended at the step boundary, after the tool result'
  );
  const ledgered = events.find(
    e => e.type === RUN_LOG_EVENTS.MESSAGE_USER && e.data.synthetic === 'steer'
  );
  assert.ok(ledgered);
  assert.equal(ledgered.data.step, 2);
  assert.deepEqual(takeSteers(runId), [], 'drained');
  await runLog.stop();
});

test('spill: a tool result above the threshold is spilled and previewed, never sent in full', async () => {
  const { runLog } = await captureRunLog();
  const { runId } = await runLog.startRun({ kind: 'agent', user: { id: 'u1' } });
  const big = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => `row-${i}`) });
  assert.ok(big.length > 20_000);
  const { loop, requests } = makeLoop(
    [toolTurn([{ name: 'webSearch', args: { query: 'x' } }]), textTurn('summarised')],
    { runLog }
  );
  const result = await loop.run({
    runId,
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { context: { spillThresholdBytes: 4096 } },
    executeTool: async () => big
  });
  assert.equal(result.status, 'completed');

  const toolMessage = result.messages.find(m => m.role === 'tool');
  // the preview is 4096 raw characters; JSON-encoding escapes its quotes
  assert.ok(toolMessage.content.length < 2 * 4096 + 1024, 'the transcript holds a bounded preview');
  const bounded = JSON.parse(toolMessage.content);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.bytes, Buffer.byteLength(big, 'utf8'));
  assert.equal(bounded.preview.length, 4096);
  assert.equal(bounded.preview, big.slice(0, 4096));
  assert.match(bounded.spill.path, /^spill\//);
  // the second model call saw the preview, not the full result
  const sent = requests[1].request.body.messages.find(m => m.role === 'tool');
  assert.equal(sent.content, toolMessage.content);
  // the full result is in the run's spill store and referenced from the ledger
  assert.equal(await runLog.readSpill(runId, { path: bounded.spill.path }), big);
  await runLog.flush();
  const events = await runLog.readEvents(runId);
  const toolResult = events.find(e => e.type === RUN_LOG_EVENTS.TOOL_RESULT);
  assert.equal(toolResult.data.resultBytes, Buffer.byteLength(big, 'utf8'));
  assert.equal(toolResult.data.spillRef.path, bounded.spill.path);

  // below the threshold nothing changes
  const { loop: small } = makeLoop([
    toolTurn([{ name: 'webSearch', args: { query: 'x' } }]),
    textTurn('ok')
  ]);
  const plain = await small.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: async () => ({ ok: true })
  });
  assert.equal(plain.messages.find(m => m.role === 'tool').content, '{"ok":true}');
  await runLog.stop();
});

test('proactive compaction bounds the prompt across tool rounds', async () => {
  const HUGE = 'y'.repeat(20000);
  let largestPrompt = 0;
  const { loop } = makeLoop(
    [
      toolTurn([{ name: 'webContentExtractor', args: { url: '1' } }]),
      toolTurn([{ name: 'webContentExtractor', args: { url: '2' } }]),
      toolTurn([{ name: 'webContentExtractor', args: { url: '3' } }]),
      textTurn('final')
    ],
    {
      onRequest: request => {
        const chars = JSON.stringify(request.body.messages).length;
        largestPrompt = Math.max(largestPrompt, chars);
      }
    }
  );
  const compactions = [];
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [fetchTool],
    policies: { context: { compactThresholdTokens: 1000, compactKeepRecent: 2 } },
    seams: [{ onCompaction: (_ctx, info) => compactions.push(info) }],
    executeTool: async () => HUGE
  });
  assert.equal(result.content, 'final');
  assert.ok(compactions.length >= 1, 'compaction ran');
  assert.equal(compactions[0].trigger, 'proactive');
  assert.ok(largestPrompt < 3 * HUGE.length, `prompt stays bounded (${largestPrompt})`);
  const elided = result.messages.filter(
    m => typeof m.content === 'string' && m.content.startsWith('[older tool output elided')
  );
  assert.ok(elided.length >= 1);
});

test('reactive recovery: a context-window error microcompacts and retries once without charging the round cap', async () => {
  const HUGE = 'z'.repeat(5000);
  let calls = 0;
  const { loop } = makeLoop([
    toolTurn([{ name: 'webContentExtractor', args: { url: '1' } }]),
    () => {
      calls += 1;
      return textResponse(
        '{"error":{"code":"context_length_exceeded","message":"This model maximum context length is 8192 tokens"}}',
        { status: 400 }
      );
    },
    textTurn('recovered')
  ]);
  const result = await loop.run({
    model,
    messages: [
      ...baseMessages,
      { role: 'assistant', content: HUGE },
      { role: 'user', content: 'go' }
    ],
    tools: [fetchTool],
    policies: { budgets: { maxToolRounds: 2 } },
    executeTool: async () => HUGE
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'recovered');
  assert.equal(result.iterations, 2, 'the failed attempt is not charged');
  assert.equal(calls, 1);
});

test('reactive recovery gives up when nothing can be freed', async () => {
  const { loop } = makeLoop([
    () => textResponse('prompt is too long', { status: 400 }),
    textTurn('never')
  ]);
  const result = await loop.run({ model, messages: baseMessages, tools: [] });
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED);
});

// ── structured output ───────────────────────────────────────────────────────

test('structured output: Anthropic-style synthetic json tool is lifted into content and not executed', async () => {
  const { loop, requests } = makeLoop([toolTurn([{ name: 'json', args: { verdict: 'PASS' } }])]);
  let executed = 0;
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    options: { responseSchema: { type: 'object' } },
    executeTool: async () => {
      executed += 1;
      return {};
    }
  });
  assert.equal(executed, 0);
  assert.equal(result.content, '{"verdict":"PASS"}');
  assert.equal(result.status, 'completed');
  assert.equal(requests[0].request.body.responseFormat, 'json');
});

// ── seams ───────────────────────────────────────────────────────────────────

test('image lift seam: an image in the tool result becomes a vision tool message', async () => {
  const { loop } = makeLoop(
    [toolTurn([{ name: 'webContentExtractor', args: { url: 'img' } }]), textTurn('nice picture')],
    {
      seams: [imageLiftSeam]
    }
  );
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [fetchTool],
    executeTool: async () => ({
      nested: {
        imageData: { type: 'image', base64: 'AAAA', format: 'image/png', filename: 'x.png' }
      }
    })
  });
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.equal(toolMsg.content, 'Retrieved image: x.png');
  assert.deepEqual(toolMsg.imageData, {
    type: 'image',
    format: 'image/png',
    base64: 'AAAA',
    filename: 'x.png'
  });
});

test('knowledge-source seam classifies tools and grounding', async () => {
  const { loop } = makeLoop(
    [
      toolTurn([
        { name: 'webSearch', args: {} },
        { name: 'source_docs', args: {} },
        { name: 'people_search', args: {} }
      ]),
      textTurn('done')
    ],
    { seams: [knowledgeSourceSeam] }
  );
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [
      searchTool,
      { id: 'source_docs', parameters: {} },
      { id: 'people_search', parameters: {} }
    ],
    executeTool: okTool
  });
  assert.deepEqual(result.knowledgeSources.sort(), ['sources', 'websearch']);
});

test('passthrough seam streams the tool answer and ends the turn without a model follow-up', async () => {
  const chunks = [];
  const wf = { id: 'workflow_report', passthrough: true, parameters: {} };
  const { loop, requests } = makeLoop(
    [toolTurn([{ name: 'workflow_report', args: { topic: 'x' } }]), textTurn('never')],
    {
      seams: [
        passthroughSeam({
          runTool: async function* () {
            yield 'Hello ';
            yield 'world';
          },
          onChunk: text => chunks.push(text)
        })
      ]
    }
  );
  let executed = 0;
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [wf],
    refs: { chatId: 'c1' },
    executeTool: async () => {
      executed += 1;
      return {};
    }
  });
  assert.equal(executed, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(chunks, ['Hello ', 'world']);
  assert.equal(result.status, 'completed');
  assert.equal(result.finishReason, 'tool_passthrough_complete');
  const last = result.messages[result.messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, 'Hello world');
  assert.equal(last.tool_source, 'workflow_report');
});

test('question seam pauses the segment with a pending interaction and enforces the cap', async () => {
  const askUser = { id: 'ask_user', interactive: true, parameters: {} };
  const raised = [];
  const seam = questionSeam({
    raise: async info => {
      const interaction = {
        id: `q-${info.ordinal}`,
        kind: 'question',
        prompt: { message: info.args.question }
      };
      raised.push(interaction);
      return interaction;
    },
    validate: args =>
      args.question ? { valid: true } : { valid: false, error: 'question required' },
    maxQuestions: 1
  });
  const { loop, requests } = makeLoop(
    [toolTurn([{ name: 'ask_user', args: { question: 'Which city?' } }])],
    {
      seams: [seam]
    }
  );
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [askUser],
    refs: { chatId: 'c1' }
  });
  assert.equal(result.status, 'paused');
  assert.equal(result.finishReason, 'clarification');
  assert.equal(result.pendingInteraction.id, 'q-1');
  assert.equal(requests.length, 1);
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.equal(JSON.parse(toolMsg.content).status, 'awaiting_user_response');

  // second question in the same conversation exceeds the cap → error result, loop continues
  const counts = new Map([['c1', 1]]);
  const capped = questionSeam({
    raise: async () => ({ id: 'never' }),
    getCount: key => counts.get(key) || 0,
    incrementCount: key => counts.set(key, (counts.get(key) || 0) + 1),
    maxQuestions: 1
  });
  const { loop: loop2 } = makeLoop(
    [toolTurn([{ name: 'ask_user', args: { question: 'again?' } }]), textTurn('proceeding')],
    {
      seams: [capped]
    }
  );
  const r2 = await loop2.run({
    model,
    messages: baseMessages,
    tools: [askUser],
    refs: { chatId: 'c1' }
  });
  assert.equal(r2.status, 'completed');
  assert.equal(r2.content, 'proceeding');
  assert.equal(
    JSON.parse(r2.messages.find(m => m.role === 'tool').content).code,
    'CLARIFICATION_LIMIT_REACHED'
  );

  const { loop: loop3 } = makeLoop([toolTurn([{ name: 'ask_user', args: {} }]), textTurn('ok')], {
    seams: [seam]
  });
  const r3 = await loop3.run({ model, messages: baseMessages, tools: [askUser] });
  assert.equal(
    JSON.parse(r3.messages.find(m => m.role === 'tool').content).code,
    'INVALID_CLARIFICATION_PARAMS'
  );
});

// ── segment planner ─────────────────────────────────────────────────────────

test('segment planner: read-only calls run in parallel, overlapping writes run sequentially, results keep model order', async () => {
  const batches = planToolBatches([
    { call: {}, toolDef: { id: 'r', readOnly: true }, args: { q: 'a' } },
    { call: {}, toolDef: { id: 'r', readOnly: true }, args: { q: 'b' } },
    { call: {}, toolDef: { id: 'w' }, args: { path: 'same' } },
    { call: {}, toolDef: { id: 'w' }, args: { path: 'same' } },
    { call: {}, toolDef: { id: 'w' }, args: { path: 'other' } },
    { call: {}, toolDef: { id: 'p', passthrough: true }, args: {} }
  ]);
  assert.deepEqual(
    batches.map(b => b.map(i => i.position)),
    [[0, 1, 2], [3, 4], [5]]
  );
  assert.deepEqual(
    planToolBatches(
      [
        { call: {}, toolDef: { id: 'a', readOnly: true }, args: {} },
        { call: {}, toolDef: { id: 'b', readOnly: true }, args: {} }
      ],
      { parallel: false }
    ).map(b => b.length),
    [1, 1]
  );

  const { loop } = makeLoop([
    toolTurn([
      { name: 'webSearch', args: { query: 'a' } },
      { name: 'webSearch', args: { query: 'b' } }
    ]),
    textTurn('done')
  ]);
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: async (call, { args }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, args.query === 'a' ? 20 : 1));
      inFlight -= 1;
      order.push(args.query);
      return args.query;
    }
  });
  assert.equal(maxInFlight, 2, 'both read-only searches ran concurrently');
  assert.deepEqual(order, ['b', 'a'], 'b finished first');
  const toolMsgs = result.messages.filter(m => m.role === 'tool');
  assert.deepEqual(
    toolMsgs.map(m => m.content),
    ['a', 'b'],
    'transcript keeps the model call order'
  );
});

// ── ledger ──────────────────────────────────────────────────────────────────

test('ledger: segment, request/header, assistant, tool call/result, budget checkpoints and disabled tools are recorded', async () => {
  const { runLog, events } = await captureRunLog();
  const { runId } = await runLog.startRun({ kind: 'agent', user: { id: 'u1' } });
  const { loop } = makeLoop(
    [
      toolTurn([{ name: 'webSearch', args: { query: 'a' } }], {
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }),
      toolTurn([{ name: 'webSearch', args: { query: 'b' } }]),
      textTurn('done')
    ],
    { runLog }
  );
  await loop.run({
    runId,
    model,
    messages: baseMessages,
    tools: [searchTool],
    executeTool: async () => ({ error: true, message: 'rate limit exceeded' })
  });
  const types = events.map(e => e.type);
  assert.equal(types[0], RUN_LOG_EVENTS.RUN_START);
  assert.equal(types[1], RUN_LOG_EVENTS.SEGMENT_START);
  assert.equal(events.filter(e => e.type === RUN_LOG_EVENTS.REQUEST_HEADER).length, 3);
  assert.equal(events.filter(e => e.type === RUN_LOG_EVENTS.MESSAGE_ASSISTANT).length, 3);
  assert.equal(events.filter(e => e.type === RUN_LOG_EVENTS.TOOL_CALL).length, 2);
  const results = events.filter(e => e.type === RUN_LOG_EVENTS.TOOL_RESULT);
  assert.equal(results.length, 2);
  assert.equal(results[0].data.error.rateLimited, true);
  assert.equal(events.filter(e => e.type === RUN_LOG_EVENTS.BUDGET_CHECKPOINT).length, 3);
  const disabled = events.find(e => e.type === RUN_LOG_EVENTS.TOOL_DISABLED);
  assert.equal(disabled.data.toolId, 'webSearch');
  assert.equal(disabled.data.reason, 'rate_limited');
  const exhausted = events.find(e => e.type === RUN_LOG_EVENTS.BUDGET_EXHAUSTED);
  assert.equal(exhausted.data.reason, 'tools_dead');
  const assistant = events.find(e => e.type === RUN_LOG_EVENTS.MESSAGE_ASSISTANT);
  assert.equal(assistant.data.toolCalls[0].name, 'webSearch');
  assert.equal(assistant.data.usage.totalTokens, 7);
  await runLog.stop();
});

test('resolvePolicies applies contract defaults', () => {
  const p = resolvePolicies({});
  assert.equal(p.budgets.maxToolRounds, 10);
  assert.equal(p.tools.maxRateLimitFailures, 2);
  assert.equal(p.tools.maxConsecutiveFailures, 3);
  assert.equal(p.context.compactThresholdTokens, 16000);
  assert.equal(p.interactions.maxQuestions, 10);
});
