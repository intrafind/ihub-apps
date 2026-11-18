// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Findings-digest compaction in the agent loop (#3819), driven through the
 * real LLMClient with a scripted provider: the summary calls go through the
 * same transport as the turn's steps and are told apart by their prompt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, resolvePolicies } from '../../services/loop/AgentLoop.js';
import { shrinkFailedToolCalls } from '../../services/loop/contextCompaction.js';
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
  String(request.body?.messages?.[0]?.content || '').startsWith(
    'You write the notes that replace tool results'
  );

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
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
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
  const { runId: unrelatedRun } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' }, refs });
  const recall = (archiveRunIds, chatRefs = refs, runId = newRun) =>
    makeLoop([toolTurn('c9', RECALL_TOOL_ID, { ref: 'r1' }), textTurn('done')], [], { runLog })
      .loop.run({
        runId,
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
  assert.match(
    await recall([], refs, unrelatedRun),
    /no longer available/,
    'without it, the model is told'
  );
  assert.match(
    await recall([pausedRun], { chatId: 'chat-2' }),
    /no longer available/,
    'a run of another chat is never read'
  );
  assert.ok(otherChat);
  await runLog.stop();
});

test('a recall reads a spilled original only from runs of its own chat, never from a run the request merely names', async () => {
  const { runLog } = await captureRunLog();
  const refs = { chatId: 'chat-1', appId: 'app' };
  const readBack = async otherChatId => {
    const { runId: otherRun } = await runLog.startRun({
      kind: 'chat',
      user: { id: 'u1' },
      refs: { chatId: otherChatId }
    });
    const spillRef = await runLog.spill(
      otherRun,
      'tool-x',
      'SECRET OF THE OTHER RUN',
      'text/plain'
    );
    // A result in this chat that names that spill (as a carried-over result would).
    const bounded = JSON.stringify({
      truncated: true,
      bytes: 50_000,
      preview: 'p'.repeat(3000),
      spill: { path: spillRef.path }
    });
    const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' }, refs });
    let calls = 0;
    const { loop } = makeLoop(
      [
        toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
        toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
        toolTurn('c9', RECALL_TOOL_ID, { ref: 'r1' }),
        textTurn('done')
      ],
      [''],
      { runLog }
    );
    const result = await loop.run({
      runId,
      refs,
      archiveRunIds: [otherRun],
      model,
      messages: baseMessages,
      tools: [searchTool],
      policies,
      executeTool: async (_call, { args }) => (++calls === 1 ? bounded : searchResult(args.query))
    });
    return result.messages.find(m => m.tool_call_id === 'c9').content;
  };
  assert.doesNotMatch(await readBack('chat-2'), /SECRET OF THE OTHER RUN/, 'another chat');
  assert.match(await readBack('chat-1'), /SECRET OF THE OTHER RUN/, 'a checked run of this chat');
  await runLog.stop();
});

test('the summary reads a spilled original; one it cannot read is marked partly read and lossy', async () => {
  // The figure comes after the preview the transcript keeps.
  const big = `${'filler text '.repeat(1000)} LATE FIGURE 7.77 trillion USD`;
  const run = async withLedger => {
    const { runLog } = await captureRunLog();
    const { runId } = await runLog.startRun({ kind: 'chat', user: { id: 'u1' } });
    const { loop, summaryRequests } = makeLoop(
      [
        toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
        toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
        textTurn('done')
      ],
      ['FACT | r1 | LATE FIGURE 7.77 trillion USD |\nNOTFOUND | r1 | the revenue of the year'],
      { runLog }
    );
    const infos = [];
    const result = await loop.run({
      ...(withLedger ? { runId } : {}),
      model,
      messages: baseMessages,
      tools: [searchTool],
      policies: { context: { ...policies.context, spillThresholdBytes: 4096 } },
      seams: [{ onCompaction: (_ctx, info) => infos.push(info) }],
      executeTool: async (_call, { args }) =>
        args.query === 'nvidia' ? big : searchResult(args.query)
    });
    await runLog.stop();
    return { result, info: infos[0], prompt: summaryRequests[0]?.body.messages[1].content || '' };
  };

  const read = await run(true);
  assert.equal(read.result.status, 'completed', JSON.stringify(read.result.error));
  assert.match(read.prompt, /LATE FIGURE 7\.77 trillion/, 'the summary saw the whole result');
  assert.equal(read.info.lossy, false);
  assert.match(read.info.digest, /LATE FIGURE 7\.77 trillion/);

  const unread = await run(false);
  assert.doesNotMatch(unread.prompt, /LATE FIGURE/, 'only the preview was there to read');
  assert.equal(unread.info.fallbackReason, 'summary_partial');
  assert.match(unread.info.digest, /partly read for these notes/);
});

test('a recall follows a chain of pauses back: same id (A, B, B) and new ids (A, B, C)', async () => {
  const { runLog } = await captureRunLog();
  const refs = { chatId: 'chat-1', appId: 'app' };
  const start = () => runLog.startRun({ kind: 'chat', user: { id: 'u1' }, refs });
  const { runId: runA } = await start();
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
    runId: runA,
    refs,
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies,
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  // B continues A under a new id and pauses again without condensing anything.
  const { runId: runB } = await start();
  await makeLoop([textTurn('paused again')], [], { runLog }).loop.run({
    runId: runB,
    refs,
    archiveRunIds: [runA],
    model,
    messages: before.messages,
    tools: [searchTool],
    policies,
    executeTool: async () => 'never'
  });
  await runLog.flush();
  const recallIn = runId =>
    makeLoop([toolTurn('c9', RECALL_TOOL_ID, { ref: 'r1' }), textTurn('done')], [], { runLog })
      .loop.run({
        runId,
        refs,
        archiveRunIds: runId === runB ? [] : [runB],
        model,
        messages: before.messages,
        tools: [searchTool],
        policies,
        executeTool: async () => 'never'
      })
      .then(result => result.messages.find(m => m.tool_call_id === 'c9').content);

  assert.ok((await recallIn(runB)).includes(RESULTS.nvidia), 'A, B, B: B continued under its id');
  const { runId: runC } = await start();
  assert.ok((await recallIn(runC)).includes(RESULTS.nvidia), 'A, B, C: C reaches A through B');
  await runLog.stop();
});

test('results too short to leave room for a digest are left as they are', async () => {
  const { loop, summaryRequests } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'a' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'b' }, 1600),
      toolTurn('c3', 'webSearch', { query: 'c' }, 1600),
      textTurn('done')
    ],
    ['FACT | r1 | nothing']
  );
  const short = 'y'.repeat(1100);
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    // Enough to free for a compaction, too little room for a digest.
    policies: { context: { ...policies.context, compactThresholdTokens: 1500 } },
    executeTool: async () => short
  });
  assert.equal(result.status, 'completed');
  assert.equal(summaryRequests.length, 0, 'no summary call');
  assert.equal(result.messages.find(m => m.tool_call_id === 'c1').content, short);
});

test('notes that would count more tokens than the results they replace are never committed', async () => {
  // Long common words: few tokens for many characters, so even the smallest
  // notes (calls and sources) count more than the result. After an overflow
  // no 10 % progress guard holds the digest back; this one must.
  const sparse = ' international'.repeat(160);
  const turns = [
    toolTurn('c1', 'webSearch', { query: 'a' }, 500),
    toolTurn('c2', 'webSearch', { query: 'b' }, 900),
    () =>
      textResponse(
        '{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
        { status: 400 }
      ),
    textTurn('recovered')
  ];
  const { loop, summaryRequests } = makeLoop(turns, []);
  const compactions = [];
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    // The fallback shortens what is older than the last two messages, so the retry fits.
    policies: {
      context: { strategy: 'digest', compactThresholdTokens: 100_000, reactiveKeepRecent: 2 }
    },
    seams: [{ onCompaction: (_ctx, info) => compactions.push(info.strategy) }],
    executeTool: async () => sparse
  });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.content, 'recovered', 'the loop recovered from the overflow');
  assert.equal(summaryRequests.length, 0);
  assert.deepEqual(compactions, ['elide'], 'shortened instead of a digest that grows the prompt');
  assert.doesNotMatch(
    result.messages.find(m => m.tool_call_id === 'c1').content,
    /condensed_results/
  );
});

test('near the window the newest batch is condensed too; still full, the run wraps up with its producing tools', async () => {
  const xlsxTool = {
    id: 'create_xlsx',
    name: 'create_xlsx',
    description: 'make a spreadsheet',
    parameters: { type: 'object', properties: { rows: { type: 'array' } } }
  };
  // Window 9,000 less 2,000 output: 7,000 of input, the answer line at 5,600.
  const small = { ...model, contextWindow: 9000, maxOutputTokens: 2000 };
  const run = async lastPrompt => {
    const { loop, stepRequests } = makeLoop(
      [
        toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
        toolTurn('c2', 'webSearch', { query: 'apple' }, lastPrompt),
        textTurn('done')
      ],
      ['FACT | r1 | NVIDIA market cap 5.1 trillion USD | https://x.test/nvidia']
    );
    const infos = [];
    const result = await loop.run({
      model: small,
      messages: baseMessages,
      tools: [searchTool, xlsxTool],
      policies,
      seams: [{ onCompaction: (_ctx, info) => infos.push(info) }],
      executeTool: async (_call, { args }) => searchResult(args.query)
    });
    const last = stepRequests.at(-1).body;
    return {
      result,
      infos,
      tools: (last.tools || []).map(t => t.function?.name || t.id || t.name),
      nudges: last.messages.filter(m => String(m.content).includes('The context is nearly full'))
    };
  };

  const condensed = await run(6000);
  assert.equal(condensed.result.status, 'completed', JSON.stringify(condensed.result.error));
  assert.match(
    condensed.result.messages.find(m => m.tool_call_id === 'c2').content,
    /^\[condensed result r2/,
    'the newest batch is condensed too'
  );
  assert.equal(condensed.infos[0].wrapUp, undefined, 'room left: no wrap-up');
  assert.ok(condensed.tools.includes('webSearch'), 'searching goes on');

  const full = await run(9500);
  assert.equal(full.result.status, 'completed', JSON.stringify(full.result.error));
  assert.equal(full.infos[0].wrapUp, true);
  assert.ok(!full.tools.includes('webSearch'), 'no more searching');
  assert.ok(full.tools.includes('create_xlsx'), 'the file can still be made');
  assert.ok(full.tools.includes(RECALL_TOOL_ID), 'a result can still be read back');
  assert.equal(full.nudges.length, 1, 'told once');
});

test('when the digest comes out larger than projected, the newest batch is condensed before any wrap-up', async () => {
  // Window 9,000 less 2,000 output: the answer line at 5,600. The projection
  // lets the newest batch stay; a long digest leaves the prompt above the line.
  const small = { ...model, contextWindow: 9000, maxOutputTokens: 2000 };
  const many = Array.from(
    { length: 60 },
    (_, i) =>
      `FACT | r1 | NVIDIA statement ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} about the market cap | https://x.test/nvidia`
  ).join('\n');
  const { loop, summaryRequests, stepRequests } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 5200),
      textTurn('done')
    ],
    [many, 'FACT | r2 | Apple market cap | https://x.test/apple']
  );
  const infos = [];
  const result = await loop.run({
    model: small,
    messages: baseMessages,
    tools: [searchTool],
    policies: { context: { strategy: 'digest', compactThresholdTokens: 3000 } },
    seams: [{ onCompaction: (_ctx, info) => infos.push(info) }],
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(infos.length, 2, 'a second pass for the newest batch');
  assert.equal(infos[0].wrapUp, undefined, 'no wrap-up while the newest batch was kept');
  assert.equal(summaryRequests.length, 2);
  assert.match(
    result.messages.find(m => m.tool_call_id === 'c2').content,
    /^\[condensed result r2/
  );
  const tools = (stepRequests.at(-1).body.tools || []).map(t => t.function?.name || t.id || t.name);
  assert.ok(tools.includes('webSearch'), 'room again: searching goes on');
});

test('past the per-run cap a compaction keeps calls and sources without a summary call; the default cap is 12', async () => {
  assert.equal(resolvePolicies({}).context.maxCompactionsPerRun, 12);
  const { loop, summaryRequests } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      toolTurn('c3', 'webSearch', { query: 'meta' }, 4000),
      textTurn('done')
    ],
    ['FACT | r1 | NVIDIA market cap 5.1 trillion USD | https://x.test/nvidia']
  );
  const infos = [];
  const result = await loop.run({
    model,
    messages: baseMessages,
    tools: [searchTool],
    policies: { context: { ...policies.context, maxCompactionsPerRun: 1 } },
    seams: [{ onCompaction: (_ctx, info) => infos.push(info) }],
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(summaryRequests.length, 1, 'one summary call, the cap');
  assert.deepEqual(
    infos.map(i => i.fallbackReason || null),
    [null, 'compaction_limit']
  );
});

test('the notes of a run are bounded: once their share is used up, digests keep calls only and the run wraps up', async () => {
  const many = Array.from(
    { length: 40 },
    (_, i) =>
      `FACT | r1 | NVIDIA statement ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} about the market cap | https://x.test/nvidia`
  ).join('\n');
  const { loop, summaryRequests, stepRequests } = makeLoop(
    [
      toolTurn('c1', 'webSearch', { query: 'nvidia' }, 1000),
      toolTurn('c2', 'webSearch', { query: 'apple' }, 4000),
      toolTurn('c3', 'webSearch', { query: 'meta' }, 6000),
      textTurn('done')
    ],
    [many, many]
  );
  const infos = [];
  const result = await loop.run({
    model: { ...model, contextWindow: 30_000, maxOutputTokens: 2000 },
    messages: baseMessages,
    tools: [searchTool],
    // 5 % of 28,000 tokens of input: 1,400 tokens of notes for the whole run.
    policies: { context: { ...policies.context, maxNotesShare: 0.05 } },
    seams: [{ onCompaction: (_ctx, info) => infos.push(info) }],
    executeTool: async (_call, { args }) => searchResult(args.query)
  });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(infos.length, 2);
  assert.equal(summaryRequests.length, 1, 'no summary call once the notes are full');
  assert.equal(infos[1].fallbackReason, 'compaction_limit');
  assert.equal(infos[1].wrapUp, true);
  const tools = (stepRequests.at(-1).body.tools || []).map(t => t.function?.name || t.id || t.name);
  assert.ok(!tools.includes('webSearch'), 'no more searching');
});

test('shrinkFailedToolCalls shortens long arguments of failed calls, keeping the newest and every successful one', () => {
  const long = JSON.stringify({ sheets: 'x'.repeat(5000) });
  const call = id => ({ id, type: 'function', function: { name: 'create_xlsx', arguments: long } });
  const messages = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [call('a')] },
    { role: 'tool', tool_call_id: 'a', content: '{"success":false,"error":"bad sheets"}' },
    { role: 'assistant', content: '', tool_calls: [call('b')] },
    { role: 'tool', tool_call_id: 'b', content: '{"success":true,"file":{}}' },
    { role: 'assistant', content: '', tool_calls: [call('c')] },
    { role: 'tool', tool_call_id: 'c', content: 'Error: bad sheets' }
  ];
  const { messages: out, shortened, freedChars } = shrinkFailedToolCalls(messages);
  assert.equal(shortened, 1);
  assert.ok(freedChars > 4000);
  assert.match(out[1].tool_calls[0].function.arguments, /were removed to free context/);
  assert.equal(out[3].tool_calls[0].function.arguments, long, 'a successful call is kept');
  assert.equal(out[5].tool_calls[0].function.arguments, long, 'the newest failed call is kept');
  assert.equal(messages[1].tool_calls[0].function.arguments, long, 'the input is not changed');
});

test('an overflow that nothing can condense shortens failed calls, then answers without tools', async () => {
  const xlsxTool = {
    id: 'create_xlsx',
    name: 'create_xlsx',
    description: 'make a spreadsheet',
    parameters: { type: 'object', properties: { sheets: { type: 'string' } } }
  };
  const overflow = () =>
    textResponse(
      '{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
      { status: 400 }
    );
  const run = async turns => {
    const { loop, stepRequests } = makeLoop(turns, []);
    const result = await loop.run({
      model,
      messages: baseMessages,
      tools: [searchTool, xlsxTool],
      policies: { context: { strategy: 'digest', compactThresholdTokens: 100_000 } },
      executeTool: async () => '{"success":false,"error":"\\"sheets\\" must be a JSON array"}'
    });
    return { result, stepRequests };
  };
  const sheets = 'y'.repeat(5000);
  // Two refused workbooks: the older one's arguments go, the retry fits.
  const shortened = await run([
    toolTurn('c1', 'create_xlsx', { sheets }),
    toolTurn('c2', 'create_xlsx', { sheets }),
    overflow,
    textTurn('recovered')
  ]);
  assert.equal(shortened.result.status, 'completed', JSON.stringify(shortened.result.error));
  assert.equal(shortened.result.content, 'recovered');
  const retry = shortened.stepRequests.at(-1).body.messages;
  const callArgs = id =>
    retry.flatMap(m => m.tool_calls || []).find(c => c.id === id).function.arguments;
  assert.match(callArgs('c1'), /were removed to free context/);
  assert.ok(callArgs('c2').length > 4000, 'the newest failed call keeps its arguments');

  // Nothing to condense or shorten: the answer comes without tools.
  const answered = await run([
    toolTurn('c1', 'create_xlsx', { sheets: 'short' }),
    overflow,
    textTurn('the answer')
  ]);
  assert.equal(answered.result.status, 'completed', JSON.stringify(answered.result.error));
  assert.equal(answered.result.content, 'the answer');
  const last = answered.stepRequests.at(-1).body;
  assert.ok(!(last.tools || []).length, 'no tools');
  assert.ok(last.messages.some(m => String(m.content).includes('The context is full')));
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
