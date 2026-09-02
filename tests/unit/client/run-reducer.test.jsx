/**
 * Unit tests for client/src/shared/run/runReducer.js — the one client-side
 * interpretation of SSE v2 envelopes.
 */
import {
  createStreamState,
  reduceRunEvent,
  reduceRunEvents,
  rebuildRunFromLedger,
  getRun,
  getRuns,
  getPendingInteraction,
  getStreamProgress,
  isRunFinished
} from '../../../client/src/shared/run/runReducer';

const ts = seq => `2026-09-02T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, runId, type, data = {}) => ({ v: 2, seq, runId, ts: ts(seq), type, data });

function fold(envelopes, state = createStreamState('stream')) {
  return reduceRunEvents(state, envelopes);
}

describe('runReducer — chat turn', () => {
  const turn = [
    env(1, 'chat-1', 'stream/connected', { runId: 'chat-1', lastSeq: 0, protocol: 2 }),
    env(2, 'run-a', 'run/started', {
      kind: 'chat',
      model: 'gpt-x',
      refs: { chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' }
    }),
    env(3, 'run-a', 'step/delta', { step: 0, kind: 'text', content: 'Hel' }),
    env(4, 'run-a', 'step/delta', { step: 0, kind: 'text', content: 'lo ' }),
    env(5, 'run-a', 'step/delta', {
      step: 0,
      kind: 'thinking',
      content: 'let me think',
      meta: { name: 'planning' }
    }),
    env(6, 'run-a', 'tool/started', {
      step: 0,
      callId: 'c1',
      toolId: 'webSearch',
      name: 'webSearch',
      args: { q: 'x' },
      execution: 'server'
    }),
    env(7, 'run-a', 'tool/completed', {
      step: 0,
      callId: 'c1',
      toolId: 'webSearch',
      name: 'webSearch',
      resultPreview: { hits: 3 },
      durationMs: 42,
      knowledgeSource: 'websearch'
    }),
    env(8, 'run-a', 'step/delta', { step: 0, kind: 'text', content: 'world' }),
    env(9, 'run-a', 'step/completed', {
      step: 0,
      content: 'Hello world',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 }
    }),
    env(10, 'run-a', 'run/ended', {
      status: 'completed',
      finishReason: 'stop',
      knowledgeSources: ['websearch']
    })
  ];

  test('accumulates text, thinking, tools, sources and lifecycle', () => {
    const state = fold(turn);
    expect(state.connected).toBe(true);
    expect(state.protocol).toBe(2);
    expect(state.lastSeq).toBe(10);
    expect(state.gap).toBeNull();
    expect(state.activeRunId).toBe('run-a');
    expect(state.order).toEqual(['run-a']);

    const run = getRun(state, 'run-a');
    expect(run.kind).toBe('chat');
    expect(run.model).toBe('gpt-x');
    expect(run.refs).toEqual({ chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' });
    // deltas accumulate; step/completed must not duplicate streamed text
    expect(run.text).toBe('Hello world');
    expect(run.thinking).toEqual([{ name: 'planning', content: 'let me think' }]);
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({
      callId: 'c1',
      status: 'completed',
      result: { hits: 3 },
      durationMs: 42,
      knowledgeSource: 'websearch'
    });
    expect(run.knowledgeSources).toEqual(['websearch']); // deduped with run/ended
    expect(run.steps[0].completed).toBe(true);
    expect(run.steps[0].finishReason).toBe('stop');
    expect(run.status).toBe('completed');
    expect(run.finishReason).toBe('stop');
    expect(run.endedAt).toBe(ts(10));
    expect(run.lastLifecycleAt).toBe(ts(10));
    expect(isRunFinished(run)).toBe(true);
  });

  test('a re-sync page (no deltas) adopts step/completed content as the answer text', () => {
    const state = fold([turn[1], turn[8], turn[9]]);
    expect(getRun(state, 'run-a').text).toBe('Hello world');
  });

  test('step/completed content is authoritative: lost deltas cannot leave the text truncated', () => {
    const state = fold([
      turn[1],
      env(2, 'run-a', 'step/delta', { step: 0, kind: 'text', content: 'Hello' }),
      // the " wor" delta never arrived
      env(4, 'run-a', 'step/completed', { step: 0, content: 'Hello world', toolCalls: [] })
    ]);
    const run = getRun(state, 'run-a');
    expect(run.text).toBe('Hello world');
    expect(run.steps[0].text).toBe('Hello world');

    // a tool-call step without content keeps the streamed text of earlier steps
    const twoSteps = fold([
      turn[1],
      env(2, 'run-a', 'step/delta', { step: 0, kind: 'text', content: 'A' }),
      env(3, 'run-a', 'step/completed', { step: 0, content: 'A', toolCalls: [] }),
      env(4, 'run-a', 'step/delta', { step: 1, kind: 'text', content: 'B' }),
      env(5, 'run-a', 'step/completed', {
        step: 1,
        content: '',
        toolCalls: [{ id: 'c', name: 't', args: {} }]
      })
    ]);
    expect(getRun(twoSteps, 'run-a').text).toBe('AB');
  });

  test('ignores malformed envelopes and run-scoped frames without a runId', () => {
    const base = createStreamState('s');
    expect(reduceRunEvent(base, null)).toBe(base);
    expect(reduceRunEvent(base, { v: 1, type: 'run/started' })).toBe(base);
    const next = reduceRunEvent(base, { v: 2, seq: 1, type: 'step/delta', data: { content: 'x' } });
    expect(Object.keys(next.runs)).toHaveLength(0);
  });
});

describe('runReducer — clarification', () => {
  const interaction = {
    id: 'q-1',
    runId: 'run-b',
    step: 1,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which year?', inputType: 'text', allowSkip: true, allowOther: false },
    policy: {},
    status: 'pending',
    source: { toolCallId: 'call-1', toolId: 'ask_user', chatId: 'chat-1' },
    createdAt: ts(3),
    ordinal: 1
  };

  test('interaction/raised + run/paused exposes the pending interaction', () => {
    const state = fold([
      env(1, 'run-b', 'run/started', { kind: 'chat', refs: {} }),
      env(2, 'run-b', 'step/delta', { step: 0, kind: 'text', content: 'Sure.' }),
      env(3, 'run-b', 'interaction/raised', { interaction }),
      env(4, 'run-b', 'run/paused', { reason: 'interaction', interactionId: 'q-1' })
    ]);
    const run = getRun(state, 'run-b');
    expect(run.status).toBe('paused');
    expect(run.pendingInteractionId).toBe('q-1');
    expect(getPendingInteraction(run)).toMatchObject({ id: 'q-1', kind: 'question' });
    expect(isRunFinished(run)).toBe(false);
  });

  test('interaction/answered clears the pending interaction; run/resumed resumes', () => {
    let state = fold([
      env(1, 'run-b', 'run/started', { kind: 'chat', refs: {} }),
      env(2, 'run-b', 'interaction/raised', { interaction }),
      env(3, 'run-b', 'run/paused', { reason: 'interaction', interactionId: 'q-1' })
    ]);
    state = reduceRunEvent(
      state,
      env(4, 'run-b', 'interaction/answered', {
        interactionId: 'q-1',
        kind: 'question',
        answer: { value: '2024', by: 'user', at: ts(4), channel: 'chat' }
      })
    );
    let run = getRun(state, 'run-b');
    expect(getPendingInteraction(run)).toBeNull();
    expect(run.interactions['q-1'].status).toBe('answered');
    expect(run.interactions['q-1'].answer.value).toBe('2024');

    state = reduceRunEvent(state, env(5, 'run-b', 'run/resumed', { interactionId: 'q-1' }));
    run = getRun(state, 'run-b');
    expect(run.status).toBe('running');
    expect(run.pendingInteractionId).toBeNull();
  });
});

describe('runReducer — workflow stream with two runs', () => {
  const stream = [
    env(1, 'wf-1', 'stream/connected', { runId: 'wf-1', lastSeq: 0, protocol: 2 }),
    env(2, 'wf-1', 'run/started', { kind: 'workflow', refs: { executionId: 'wf-1' } }),
    env(3, 'wf-1', 'progress/node', { nodeId: 'plan', nodeType: 'planner', status: 'running' }),
    env(4, 'wf-2', 'run/started', { kind: 'workflow', parentRunId: 'wf-1', refs: {} }),
    env(5, 'wf-2', 'progress/node', { nodeId: 'task-1', status: 'running' }),
    env(6, 'wf-1', 'tool/progress', {
      phase: 'agent.task.created',
      data: { taskId: 't1', title: 'Do it' }
    }),
    env(7, 'wf-2', 'progress/node', { nodeId: 'task-1', status: 'completed', output: { ok: 1 } }),
    env(8, 'wf-2', 'run/ended', { status: 'completed', finishReason: null }),
    env(9, 'wf-1', 'progress/node', { nodeId: 'plan', status: 'completed', output: { done: 1 } }),
    env(10, 'wf-1', 'run/ended', { status: 'completed', finishReason: 'approved' })
  ];

  test('keeps both runs, tags progress with seq/runId and interleaves by sequence', () => {
    const state = fold(stream);
    expect(state.order).toEqual(['wf-1', 'wf-2']);
    expect(getRuns(state).map(r => r.runId)).toEqual(['wf-1', 'wf-2']);
    expect(getRun(state, 'wf-2').parentRunId).toBe('wf-1');

    const progress = getStreamProgress(state);
    expect(progress.map(p => p.seq)).toEqual([3, 5, 6, 7, 9]);
    expect(progress.map(p => p.runId)).toEqual(['wf-1', 'wf-2', 'wf-1', 'wf-2', 'wf-1']);
    expect(progress[2]).toMatchObject({ kind: 'tool/progress', phase: 'agent.task.created' });

    const root = getRun(state, 'wf-1');
    expect(root.nodes.plan).toMatchObject({ status: 'completed', output: { done: 1 } });
    expect(root.status).toBe('completed');
    expect(root.finishReason).toBe('approved');
    expect(getRun(state, 'wf-2').status).toBe('completed');
  });
});

describe('runReducer — sequence gaps and re-sync', () => {
  const base = [
    env(1, 'run-c', 'run/started', { kind: 'chat', refs: {} }),
    env(2, 'run-c', 'step/delta', { step: 0, kind: 'text', content: 'A' })
  ];

  test('flags a gap when a seq is skipped and keeps lastSeq at the highest seen', () => {
    const state = fold([
      ...base,
      env(5, 'run-c', 'step/delta', { step: 0, kind: 'text', content: 'D' })
    ]);
    expect(state.gap).toEqual({ expected: 3, received: 5, runId: 'run-c' });
    expect(state.lastSeq).toBe(5);
    // the first envelope of a stream never flags a gap (server counters persist)
    expect(fold([env(7, 'r', 'run/started', { kind: 'chat', refs: {} })]).gap).toBeNull();
  });

  test('stream/connected starts a new sequence epoch', () => {
    const live = fold([
      env(1, 'wf-e', 'stream/connected', { runId: 'wf-e', lastSeq: 0, protocol: 2 }),
      env(2, 'wf-e', 'run/started', { kind: 'workflow', refs: { executionId: 'wf-e' } }),
      env(3, 'wf-e', 'progress/node', { nodeId: 'n1', status: 'running' })
    ]);
    expect(live.lastSeq).toBe(3);

    // the same worker keeps counting: nothing was missed
    const continued = reduceRunEvent(
      live,
      env(4, 'wf-e', 'stream/connected', { runId: 'wf-e', lastSeq: 3, protocol: 2 })
    );
    expect(continued.connected).toBe(true);
    expect(continued.gap).toBeNull();
    expect(continued.lastSeq).toBe(4);

    // frames were delivered while disconnected: rebuild the run
    const missed = reduceRunEvent(
      live,
      env(9, 'wf-e', 'stream/connected', { runId: 'wf-e', lastSeq: 8, protocol: 2 })
    );
    expect(missed.gap).toEqual({ expected: 4, received: 9, runId: 'wf-e' });
    expect(missed.lastSeq).toBe(9);

    // the counter restarted (eviction, failover): low seqs are live again
    const restarted = reduceRunEvent(
      live,
      env(1, 'wf-e', 'stream/connected', { runId: 'wf-e', lastSeq: 0, protocol: 2 })
    );
    expect(restarted.gap).toEqual({ expected: 4, received: 1, runId: 'wf-e' });
    expect(restarted.lastSeq).toBe(1);
    const after = reduceRunEvent(
      restarted,
      env(2, 'wf-e', 'progress/node', { nodeId: 'n2', status: 'running' })
    );
    expect(after.lastSeq).toBe(2);
    expect(after.gap).toEqual(restarted.gap); // the pending rebuild is kept
  });

  test('rebuildRunFromLedger replaces the run from its ledger (own seq space) and clears the gap', () => {
    const live = [...base, env(5, 'run-c', 'step/delta', { step: 0, kind: 'text', content: 'D' })];
    const state = fold(live);
    expect(state.gap).not.toBeNull();

    // the ledger projection: its seq starts at 1 and has nothing to do with the stream's
    const page = [
      env(3, 'run-c', 'step/completed', {
        step: 0,
        content: 'ABCD',
        toolCalls: [],
        finishReason: 'stop'
      }),
      env(1, 'run-c', 'run/started', { kind: 'chat', refs: { chatId: 'chat-c' } }),
      env(2, 'run-c', 'tool/started', { step: 0, callId: 'c1', toolId: 't', name: 't', args: {} }),
      env(4, 'run-c', 'run/ended', { status: 'completed', finishReason: 'stop' }),
      env(9, 'other-run', 'step/delta', { step: 0, kind: 'text', content: 'ignored' }),
      { v: 1, seq: 6, type: 'step/delta' }
    ];
    const next = rebuildRunFromLedger(state, 'run-c', page);
    expect(next.gap).toBeNull();
    expect(next.lastSeq).toBe(5); // the stream's own cursor is untouched
    const run = getRun(next, 'run-c');
    expect(run.text).toBe('ABCD');
    expect(run.status).toBe('completed');
    expect(run.tools).toHaveLength(1);
    expect(next.runs['other-run']).toBeUndefined();

    // an empty page (failed re-sync) only clears the gap
    const cleared = rebuildRunFromLedger(state, 'run-c', []);
    expect(cleared.gap).toBeNull();
    expect(getRun(cleared, 'run-c').text).toBe(getRun(state, 'run-c').text);
  });
});
