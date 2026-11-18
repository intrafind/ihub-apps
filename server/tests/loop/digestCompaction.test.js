// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Findings-digest compaction in the agent loop (#3819), driven through the
 * real LLMClient with a scripted provider: the summary calls go through the
 * same transport as the turn's steps and are told apart by their prompt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../../services/loop/AgentLoop.js';
import { projectLedgerEvent } from '../../services/loop/RunStream.js';
import { RUN_LOG_EVENTS, SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { RECALL_TOOL_ID } from '../../services/loop/findingsDigest.js';
import {
  makeClient,
  sseResponse,
  textResponse,
  captureRunLog,
  MODELS
} from './helpers/llmFixtures.js';

const model = { ...MODELS.openai, contextWindow: 200_000 };

function usage(prompt) {
  return { prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10 };
}

function textTurn(content, prompt = 100) {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage(prompt) },
    '[DONE]'
  ];
}

function toolTurn(id, name, args, prompt = 100) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: usage(prompt) },
    '[DONE]'
  ];
}

const isSummaryRequest = request =>
  String(request.body?.messages?.[0]?.content || '').startsWith('You extract facts');

/**
 * A loop whose steps answer with `turns` in order and whose summary calls
 * answer with `summaries` in order (a function may throw or return a Response).
 */
function makeLoop(turns, summaries = [], { runLog, onSummary } = {}) {
  const steps = [...turns];
  const answers = [...summaries];
  const stepRequests = [];
  const summaryRequests = [];
  const { client } = makeClient({
    runLog,
    maxRetries: 0,
    transport: async (request, ctx) => {
      if (isSummaryRequest(request)) {
        summaryRequests.push(request);
        await onSummary?.(request);
        const next = answers.shift();
        if (typeof next === 'function') return next(request, ctx);
        return sseResponse(textTurn(next ?? '', 500));
      }
      // A snapshot: the transcript array goes on growing after the call.
      stepRequests.push({ body: JSON.parse(JSON.stringify(request.body)) });
      const next = steps.shift();
      if (!next) throw new Error('script exhausted');
      return typeof next === 'function' ? next(request, ctx) : sseResponse(next);
    }
  });
  const loop = new AgentLoop({
    llmClient: client,
    runLog,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
  return { loop, stepRequests, summaryRequests };
}

const searchTool = {
  id: 'webSearch',
  name: 'webSearch',
  activity: { kind: 'search', origin: 'web' },
  description: 'search',
  parameters: { type: 'object', properties: { query: { type: 'string' } } }
};

const RESULTS = {
  nvidia: 'NVIDIA market cap 5.1 trillion USD on 17 Nov 2026',
  apple: 'Apple market cap 3.9 trillion USD on 17 Nov 2026',
  meta: 'Meta market cap 1.8 trillion USD on 17 Nov 2026'
};

function searchResult(query) {
  return JSON.stringify({
    results: [
      {
        title: `${query} market cap`,
        url: `https://x.test/${query}`,
        snippet: `${RESULTS[query] || query}. ${'filler text '.repeat(600)}`
      }
    ]
  });
}

const policies = {
  context: { strategy: 'digest', compactThresholdTokens: 3000, digestKeepRecentBatches: 1 }
};

const baseMessages = [
  { role: 'system', content: 'You research.' },
  { role: 'user', content: 'Compare the market caps of NVIDIA, Apple and Meta.' }
];

test('a tool loop over the threshold condenses older batches into a checked findings digest', async () => {
  const { runLog } = await captureRunLog();
  const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
  const { loop, stepRequests, summaryRequests } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      toolTurn('c3', 'webSearch', { query: 'meta' }, 500),
      textTurn('NVIDIA leads with 5.1 trillion USD.')
    ],
    [
      'FACT | r1 | NVIDIA market cap 5.1 trillion USD on 17 Nov 2026 | https://x.test/nvidia\n' +
        'FACT | r1 | NVIDIA P/E 48.2 | https://x.test/nvidia'
    ],
    { runLog }
  );
  const order = [];
  const runBudget = { input: 0, output: 0, total: 0 };
  const result = await loop.run({
    runId,
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    state: { budget: runBudget },
    seams: [
      {
        onCompactionStart: (_ctx, info) => order.push(['start', info]),
        onCompaction: (_ctx, info) => order.push(['done', info])
      }
    ],
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed');
  assert.equal(summaryRequests.length, 1, 'one summary call');
  assert.match(summaryRequests[0].body.messages[1].content, /Compare the market caps/);
  assert.match(summaryRequests[0].body.messages[1].content, /\[r1\] webSearch/);
  assert.equal(summaryRequests[0].body.thinkingEnabled, false);

  // The step after the compaction reads the digest instead of the result.
  const sent = stepRequests[2].body.messages;
  const assistantCalls = sent.filter(m => m.role === 'assistant' && m.tool_calls?.length);
  assert.equal(assistantCalls.length, 2, 'the calls stay in the transcript');
  const tools = sent.filter(m => m.role === 'tool');
  assert.deepEqual(
    tools.map(m => m.tool_call_id),
    ['c1', 'c2'],
    'every call keeps its result'
  );
  assert.match(tools[0].content, /^\[condensed result r1 of webSearch/);
  assert.match(tools[0].content, /<condensed_results digest="1" refs="r1">/);
  assert.match(
    tools[0].content,
    /NVIDIA market cap 5\.1 trillion USD on 17 Nov 2026 \(https:\/\/x\.test\/nvidia\)/
  );
  assert.doesNotMatch(tools[0].content, /48\.2/, 'the unchecked figure is not kept');
  assert.doesNotMatch(tools[0].content, /filler text filler/, 'the bulk is gone');
  assert.equal(tools[1].content, searchResult('apple'), 'the newest batch is kept');
  assert.ok(
    stepRequests[2].body.tools.some(t => (t.id || t.name) === RECALL_TOOL_ID),
    'the recall tool is offered'
  );

  assert.deepEqual(
    order.map(([phase]) => phase),
    ['start', 'done']
  );
  const done = order[1][1];
  assert.equal(done.strategy, 'digest');
  assert.equal(done.lossy, false);
  assert.equal(done.itemsSummarised, 1);
  assert.deepEqual(done.kinds, { search: 1, fetch: 0, tool: 0 });
  assert.equal(done.facts, 1);
  assert.equal(done.droppedFacts, 1);
  assert.ok(done.tokensAfter < done.tokensBefore);
  assert.ok(done.tokensBefore >= 4000, 'counted from the provider');
  assert.ok(done.freedTokens > 0);
  assert.equal(order[0][1].compactionId, done.compactionId);
  assert.ok(runBudget.input >= 500, 'the summary counts toward the run budget');

  // The ledger records it, and a re-sync shows it as the live stream did.
  await runLog.flush();
  const events = await runLog.readEvents(runId);
  const compaction = events.find(e => e.type === RUN_LOG_EVENTS.CONTEXT_COMPACTION);
  assert.equal(compaction.data.compactionId, done.compactionId);
  assert.equal(compaction.data.lossy, false);
  assert.match(compaction.data.digest, /condensed_results/);
  assert.ok(compaction.data.archiveRef?.path, 'the originals are in the spill store');
  const [frame] = projectLedgerEvent(compaction);
  assert.equal(frame.type, SSE_V2_EVENTS.CONTEXT_COMPACTED);
  assert.equal(frame.data.status, 'completed');
  assert.equal(frame.data.itemsSummarised, 1);
  assert.equal(frame.data.lossy, false);
  await runLog.stop();
});

test('a failed summary still condenses the batch, to its calls and sources, marked lossy', async () => {
  const { loop } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      textTurn('done')
    ],
    [() => textResponse('{"error":{"message":"overloaded"}}', { status: 500 })]
  );
  const infos = [];
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    seams: [{ onCompaction: (_ctx, info) => infos.push(info) }],
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed', 'the turn goes on');
  assert.equal(infos.length, 1);
  assert.equal(infos[0].lossy, true);
  assert.equal(infos[0].fallbackReason, 'summary_failed');
  const condensed = result.messages.find(m => m.tool_call_id === 'c1');
  assert.match(condensed.content, /lossy="true"/);
  assert.match(condensed.content, /nvidia market cap — https:\/\/x\.test\/nvidia/);
});

test('the model reads a condensed result again by ref instead of searching again', async () => {
  const { loop, stepRequests } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      toolTurn('c3', RECALL_TOOL_ID, { ref: 'r1' }, 1500),
      toolTurn('c4', RECALL_TOOL_ID, { ref: 'r42' }, 1500),
      textTurn('done')
    ],
    ['FACT | r1 | NVIDIA market cap 5.1 trillion USD | https://x.test/nvidia']
  );
  let executed = 0;
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    executeTool: async (_call, { args }) => {
      executed += 1;
      return searchResult(args.query);
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(executed, 2, 'the recall is answered by the loop, not the tool executor');
  const recalled = result.messages.find(m => m.tool_call_id === 'c3');
  assert.match(recalled.content, /^Result r1 of webSearch/);
  assert.ok(recalled.content.includes(RESULTS.nvidia), 'the original text');
  const unknown = result.messages.find(m => m.tool_call_id === 'c4');
  assert.match(unknown.content, /There is no condensed result r42/);
  assert.ok(stepRequests.length === 5);
});

test('a second compaction appends a digest and leaves the first one as it was', async () => {
  const { loop } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      toolTurn('c3', 'webSearch', { query: 'meta' }, 4000),
      textTurn('done')
    ],
    [
      'FACT | r1 | NVIDIA market cap 5.1 trillion USD | https://x.test/nvidia',
      'FACT | r2 | Apple market cap 3.9 trillion USD | https://x.test/apple'
    ]
  );
  const snapshots = [];
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    seams: [
      {
        onCompaction: ctx => snapshots.push(ctx.messages.find(m => m.tool_call_id === 'c1').content)
      }
    ],
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1], snapshots[0], 'digest 1 is untouched by the second compaction');
  const second = result.messages.find(m => m.tool_call_id === 'c2').content;
  assert.match(second, /<condensed_results digest="2" refs="r2">/);
  assert.match(second, /Apple market cap 3\.9 trillion USD/);
});

test('a run stopped while the digest is written ends as aborted', async () => {
  const controller = new AbortController();
  const { loop } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      textTurn('never')
    ],
    [
      () => {
        controller.abort();
        return textResponse('aborted', { status: 499 });
      }
    ]
  );
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    signal: controller.signal,
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'aborted');
});

test('under the threshold nothing is condensed; the elide strategy records its loss', async () => {
  const quiet = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 100),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 200),
      textTurn('ok')
    ],
    []
  );
  const result = await quiet.loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { context: { ...policies.context, compactThresholdTokens: 100_000 } },
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(quiet.summaryRequests.length, 0);
  assert.ok(!result.messages.some(m => String(m.content).startsWith('[condensed')));

  const elide = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      toolTurn('c3', 'webSearch', { query: 'meta' }, 4000),
      textTurn('ok')
    ],
    []
  );
  const infos = [];
  await elide.loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { context: { compactThresholdTokens: 1000, compactKeepRecent: 2 } },
    seams: [{ onCompaction: (_ctx, info) => infos.push(info) }],
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(elide.summaryRequests.length, 0, 'workflows keep the elide strategy');
  assert.ok(infos.length >= 1);
  assert.equal(infos[0].strategy, 'elide');
  assert.equal(infos[0].lossy, true);
  assert.ok(infos[0].compactionId);
});

test('the overflow path collapses once, retries, and records that it lost data', async () => {
  const { runLog } = await captureRunLog();
  const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
  const turns = [
    toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
    () =>
      textResponse(
        '{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
        { status: 400 }
      ),
    textTurn('recovered')
  ];
  const script = [...turns];
  const { client } = makeClient({
    runLog,
    maxRetries: 0,
    transport: async (request, ctx) => {
      const next = script.shift();
      return typeof next === 'function' ? next(request, ctx) : sseResponse(next);
    }
  });
  const loop = new AgentLoop({
    llmClient: client,
    runLog,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
  const result = await loop.run({
    runId,
    model,
    messages: [
      ...baseMessages,
      { role: 'assistant', content: 'x'.repeat(5000) },
      { role: 'user', content: 'go' }
    ],
    tools: [searchTool],
    policies: { context: { ...policies.context, reactiveKeepRecent: 2 } },
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed');
  await runLog.flush();
  const events = await runLog.readEvents(runId);
  const compaction = events.find(e => e.type === RUN_LOG_EVENTS.CONTEXT_COMPACTION);
  assert.equal(compaction.data.trigger, 'overflow');
  assert.equal(compaction.data.lossy, true);
  assert.equal(compaction.data.strategy, 'elide');
  assert.equal(compaction.data.fallbackReason, 'context_overflow');
  const [frame] = projectLedgerEvent(compaction);
  assert.equal(frame.data.lossy, true);
  assert.equal(frame.data.trigger, 'overflow');
  await runLog.stop();
});

test('a journal entry written before compaction ids existed projects to nothing', () => {
  assert.deepEqual(
    projectLedgerEvent({
      seq: 3,
      runId: 'r',
      ts: new Date().toISOString(),
      type: RUN_LOG_EVENTS.CONTEXT_COMPACTION,
      data: { step: 1, trigger: 'proactive', collapsed: 2, freedChars: 9000 }
    }),
    []
  );
});

test('once every real tool has failed, the recall tool does not keep the turn going', async () => {
  const { loop } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      toolTurn('c3', 'webSearch', { query: 'meta' }, 1500),
      toolTurn('c4', 'webSearch', { query: 'tesla' }, 1500),
      toolTurn('c5', 'webSearch', { query: 'amd' }, 1500),
      textTurn('answered without the tool')
    ],
    ['FACT | r1 | NVIDIA market cap 5.1 trillion USD | https://x.test/nvidia']
  );
  let calls = 0;
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    executeTool: async (_call, { args }) => {
      calls += 1;
      if (calls <= 2) return searchResult(args.query);
      throw new Error('upstream down');
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.budgetReason, 'tools_dead', 'the dead-tools gate still fires');
});

test('a turn continued under a new run id still reads what its paused run condensed', async () => {
  const { runLog } = await captureRunLog();
  const refs = { chatId: 'chat-1', appId: 'app' };
  const { runId: pausedRun } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' }, refs });
  const first = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      textTurn('paused here')
    ],
    ['FACT | r1 | NVIDIA market cap 5.1 trillion USD | https://x.test/nvidia'],
    { runLog }
  );
  const before = await first.loop.run({
    runId: pausedRun,
    refs,
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  await runLog.flush();

  const { runId: newRun } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' }, refs });
  const { runId: otherChat } = await runLog.startRun({
    kind: 'chat',
    user: { id: 'u1' },
    refs: { chatId: 'chat-2' }
  });
  const recall = (archiveRunIds, chatRefs = refs) =>
    makeLoop([toolTurn('c9', RECALL_TOOL_ID, { ref: 'r1' }), textTurn('done')], [], { runLog })
      .loop.run({
        runId: newRun,
        refs: chatRefs,
        archiveRunIds,
        model,
        messages: before.messages,
        tools: [searchTool],
        policies,
        executeTool: async () => 'never'
      })
      .then(result => result.messages.find(m => m.tool_call_id === 'c9').content);

  assert.ok((await recall([pausedRun])).includes(RESULTS.nvidia), 'read from the paused run');
  assert.match(await recall([]), /no longer available/, 'without it, the model is told');
  assert.match(
    await recall([pausedRun], { chatId: 'chat-2' }),
    /no longer available/,
    'a run of another chat is never read'
  );
  assert.ok(otherChat);
  await runLog.stop();
});

test('near the window the second kept batch is condensed too; well below it, it stays', async () => {
  const run = async contextWindow => {
    const { loop } = makeLoop(
      [
        toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
        toolTurn('c2', 'webSearch', { query: 'apple' }, 2600),
        textTurn('done')
      ],
      ['FACT | r1 | NVIDIA market cap 5.1 trillion USD | https://x.test/nvidia']
    );
    const result = await loop.run({
      model: { ...model, contextWindow },
      messages: baseMessages,
      tools: [searchTool],
      policies: { context: { strategy: 'digest', compactThresholdTokens: 3000 } },
      executeTool: async (_call, { args }) => searchResult(args.query)
    });
    return result.messages.find(m => m.tool_call_id === 'c1').content;
  };
  assert.match(await run(3500), /^\[condensed result r1/, 'urgent: only the newest batch is kept');
  assert.equal(await run(200_000), searchResult('nvidia'), 'not urgent: both batches are kept');
});

test('after an overflow a digest turn condenses to calls and sources first, without a summary call', async () => {
  const { runLog } = await captureRunLog();
  const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
  const turns = [
    toolTurn('c1', 'webSearch', { query: 'nvidia' }, 500),
    toolTurn('c2', 'webSearch', { query: 'apple' }, 900),
    () =>
      textResponse(
        '{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
        { status: 400 }
      ),
    textTurn('recovered')
  ];
  const { loop, summaryRequests } = makeLoop(turns, [], { runLog });
  const result = await loop.run({
    runId,
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { context: { strategy: 'digest', compactThresholdTokens: 100_000 } },
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(summaryRequests.length, 0, 'no summary call before the retry');
  assert.match(
    result.messages.find(m => m.tool_call_id === 'c1').content,
    /reason="context_overflow"/
  );
  assert.equal(result.messages.find(m => m.tool_call_id === 'c2').content, searchResult('apple'));
  await runLog.flush();
  const compaction = (await runLog.readEvents(runId)).find(
    e => e.type === RUN_LOG_EVENTS.CONTEXT_COMPACTION
  );
  assert.equal(compaction.data.trigger, 'overflow');
  assert.equal(compaction.data.strategy, 'digest');
  assert.equal(compaction.data.lossy, true);
  await runLog.stop();
});
