/**
 * Unit tests for client/src/features/workflows/workflowRunProjection.js — the
 * pure projection of a StreamState (root run + child runs) onto the execution
 * page state.
 */
import { createStreamState, reduceRunEvents } from '../../../client/src/shared/run/runReducer';
import {
  projectWorkflowState,
  deriveWorkflowStatus,
  isActiveWorkflowStatus
} from '../../../client/src/features/workflows/workflowRunProjection';

const ROOT = 'wf-exec-root';
const CHILD = 'wf-exec-child';
const ts = seq => `2026-09-02T11:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}, runId = ROOT) => ({ v: 2, seq, runId, ts: ts(seq), type, data });
const started = env(1, 'run/started', { kind: 'workflow', refs: { executionId: ROOT } });

function streamOf(envelopes) {
  return reduceRunEvents(createStreamState(ROOT), envelopes);
}

const baseState = {
  executionId: ROOT,
  workflowId: 'research',
  status: 'running',
  canReconnect: true,
  startedAt: ts(0),
  currentNodes: [],
  completedNodes: ['start'],
  failedNodes: [],
  errors: [],
  history: [{ type: 'node_complete', nodeId: 'start' }],
  pendingCheckpoint: null,
  data: { nodeInvocations: 1, nodeResults: { start: { output: {} } }, _workflowDefinition: {} }
};

describe('projectWorkflowState — node progress', () => {
  test('without any stream frames the REST state passes through', () => {
    const state = projectWorkflowState(createStreamState(ROOT), ROOT, baseState);
    expect(state).toMatchObject({
      status: 'running',
      canReconnect: true,
      completedNodes: ['start'],
      history: baseState.history,
      pendingCheckpoint: null,
      data: baseState.data
    });
    expect(projectWorkflowState(createStreamState(ROOT), ROOT, null).status).toBeNull();
  });

  test('node start/complete/error, iterations, metrics and results (both keys)', () => {
    const stream = streamOf([
      started,
      env(2, 'progress/node', {
        executionId: ROOT,
        nodeId: 'plan',
        nodeType: 'planner',
        status: 'running'
      }),
      env(3, 'progress/node', {
        executionId: ROOT,
        nodeId: 'plan',
        status: 'completed',
        iteration: 1,
        output: {
          output: { plan: 'x' },
          metrics: { duration: 120 },
          tokens: { input: 10, output: 5 },
          iteration: 1
        }
      }),
      env(4, 'progress/node', {
        executionId: ROOT,
        nodeId: '__loop__',
        status: 'running',
        iteration: 2
      }),
      env(5, 'progress/node', {
        executionId: ROOT,
        nodeId: 'verify',
        nodeType: 'prompt',
        status: 'running'
      }),
      env(6, 'progress/node', {
        executionId: ROOT,
        nodeId: 'verify',
        status: 'failed',
        error: 'verification failed'
      }),
      env(7, 'progress/node', {
        executionId: ROOT,
        nodeId: 'verify',
        status: 'running',
        progress: { message: 'retrying…' }
      })
    ]);
    const state = projectWorkflowState(stream, ROOT, baseState);

    expect(state.status).toBe('running');
    expect(state.currentNodes).toEqual(['verify']);
    expect(state.completedNodes).toEqual(['start', 'plan']);
    expect(state.failedNodes).toEqual(['verify']);
    expect(state.errors).toEqual(['verification failed']);
    expect(state._lastIteration).toBe(2);
    expect(state.history).toEqual([
      { type: 'node_complete', nodeId: 'start' },
      { event: 'workflow.node.start', nodeId: 'plan', executionId: ROOT, at: ts(2) },
      {
        event: 'workflow.node.complete',
        executionId: ROOT,
        nodeId: 'plan',
        result: {
          output: { plan: 'x' },
          metrics: { duration: 120 },
          tokens: { input: 10, output: 5 },
          iteration: 1
        },
        iteration: 1,
        at: ts(3)
      },
      // the node progress message (seq 7) is not a start — but the second start of verify is
      { event: 'workflow.node.start', nodeId: 'verify', executionId: ROOT, at: ts(5) }
    ]);
    expect(state.data.nodeResults.plan).toEqual(state.data.nodeResults.plan_iter1);
    expect(state.data.nodeResults.start).toEqual({ output: {} });
    expect(state.data.nodeInvocations).toBe(2);
    expect(state.data.executionMetrics).toEqual({
      totalDuration: 120,
      totalTokens: { input: 10, output: 5, total: 15 },
      nodeCount: 1
    });
    expect(state.data._workflowDefinition).toEqual({});
  });

  test('child runs on the same stream are folded into the same state, in sequence order', () => {
    const stream = streamOf([
      started,
      env(2, 'progress/node', { executionId: ROOT, nodeId: 'planner', status: 'running' }),
      env(3, 'progress/node', {
        executionId: ROOT,
        nodeId: `sub:${CHILD}`,
        nodeType: 'subworkflow',
        status: 'running',
        progress: { executionId: CHILD, depth: 1, taskCount: 2 }
      }),
      env(
        4,
        'run/started',
        { kind: 'workflow', parentRunId: ROOT, refs: { executionId: CHILD } },
        CHILD
      ),
      env(5, 'progress/node', { executionId: CHILD, nodeId: 'task-1', status: 'running' }, CHILD),
      env(
        6,
        'progress/node',
        { executionId: CHILD, nodeId: 'task-1', status: 'completed', output: { ok: true } },
        CHILD
      ),
      env(7, 'run/ended', { status: 'completed', finishReason: null }, CHILD),
      env(8, 'progress/node', {
        executionId: ROOT,
        nodeId: `sub:${CHILD}`,
        nodeType: 'subworkflow',
        status: 'completed',
        progress: { executionId: CHILD }
      })
    ]);
    const state = projectWorkflowState(stream, ROOT, baseState);
    expect(state.history.map(h => h.event || h.type)).toEqual([
      'node_complete',
      'workflow.node.start',
      'workflow.node.start',
      'workflow.node.complete'
    ]);
    expect(state.history[2]).toMatchObject({ nodeId: 'task-1', executionId: CHILD });
    expect(state.data.nodeResults['task-1']).toEqual({ ok: true });
    expect(state.data.subworkflows).toEqual({
      [CHILD]: { status: 'completed', depth: 1, taskCount: 2, completedAt: ts(8) }
    });
    expect(state.status).toBe('running'); // the child ending does not end the root
    // legacy semantics: a node start REPLACES currentNodes, a completion removes the node
    expect(state.currentNodes).toEqual([]);
  });
});

describe('projectWorkflowState — agent tool/progress phases', () => {
  const tp = (seq, phase, data) => env(seq, 'tool/progress', { phase, data });

  test('task queue, plan snapshot, timings, artifacts, tool errors, inbox, skills and the tape', () => {
    const stream = streamOf([
      started,
      tp(2, 'agent.task.created', { taskId: 't1', title: 'First', depth: 1, parentTaskId: 'p' }),
      tp(3, 'agent.plan.updated', {
        tasks: [
          {
            id: 't1',
            title: 'First',
            status: 'in_progress',
            activeForm: 'Doing first',
            priority: 1
          },
          { id: 't2', title: 'Second' }
        ]
      }),
      tp(4, 'agent.task.completed', {
        taskId: 't1',
        startedAt: ts(2),
        completedAt: ts(4),
        durationMs: 2000
      }),
      tp(5, 'agent.task.failed', { taskId: 't2' }),
      tp(6, 'agent.artifact.written', { artifactName: 'report.md', bytes: 120 }),
      tp(7, 'agent.tool.hallucinated', { requestedName: 'nope', availableTools: ['a'] }),
      tp(8, 'agent.inbox.read', {
        inboxId: 'inbox-1',
        picked: { line: 3, text: 'Do X', priority: 'high', raw: '- Do X' }
      }),
      tp(9, 'agent.step.completed', {
        nodeId: 'planner',
        startedAt: ts(1),
        completedAt: ts(9),
        durationMs: 8000
      }),
      tp(10, 'agent.skill.activated', {
        skillName: 'research',
        description: 'Deep',
        activatedBy: 'planner'
      }),
      tp(11, 'agent.inbox.marked_done', { inboxId: 'inbox-1', line: 3 }),
      tp(12, 'agent.memory.read', { key: 'k' }),
      tp(13, 'agent.hitl.requested', { reason: 'approval' }),
      tp(14, 'agent.tool.circuit_broken', { toolId: 'x' })
    ]);
    const state = projectWorkflowState(stream, ROOT, baseState);

    expect(state.data._taskQueue).toEqual([
      {
        id: 't1',
        title: 'First',
        activeForm: 'Doing first',
        status: 'done',
        depth: 0,
        priority: 1,
        parentTaskId: null
      },
      {
        id: 't2',
        title: 'Second',
        activeForm: undefined,
        status: 'failed',
        depth: 0,
        priority: undefined,
        parentTaskId: null
      }
    ]);
    expect(state.data._taskTimings).toEqual({
      t1: { startedAt: ts(2), completedAt: ts(4), durationMs: 2000 },
      planner: { startedAt: ts(1), completedAt: ts(9), durationMs: 8000 }
    });
    expect(state.data._agent.artifacts).toEqual([{ name: 'report.md', bytes: 120, at: ts(6) }]);
    expect(state.data._toolErrors).toEqual([
      { ts: ts(7), requestedName: 'nope', availableTools: ['a'], reason: 'not_registered' }
    ]);
    expect(state.data.currentInboxItem).toEqual({
      id: 'line-3',
      line: 3,
      text: 'Do X',
      priority: 'high',
      raw: '- Do X',
      _markedDone: true
    });
    expect(state.data._inboxMeta).toEqual({ inboxId: 'inbox-1' });
    expect(state.data._activatedSkills).toEqual({
      research: { description: 'Deep', activatedAt: ts(10), activatedBy: 'planner' }
    });
    expect(state.history.slice(1).map(h => h.event)).toEqual([
      'agent.inbox.read',
      'agent.skill.activated',
      'agent.inbox.marked_done',
      'agent.memory.read',
      'agent.hitl.requested'
    ]);
    expect(state.history[1]).toMatchObject({ inboxId: 'inbox-1', at: ts(8) });
  });
});

describe('projectWorkflowState — checkpoints', () => {
  const interaction = {
    id: 'ckpt-42',
    runId: ROOT,
    step: 0,
    kind: 'review',
    origin: 'node',
    prompt: {
      message: 'Review the draft',
      inputType: 'single_select',
      options: [{ value: 'ok', label: 'OK' }],
      inputSchema: { properties: { note: { type: 'string' } } },
      showData: ['$.data.draft'],
      displayData: { data_draft: 'text' },
      allowSkip: false,
      allowOther: false
    },
    policy: { expiresAt: ts(59), timeoutMs: 60000, onTimeout: 'fail', fallback: 'park' },
    status: 'pending',
    source: { nodeId: 'review', nodeName: 'Review', executionId: ROOT, checkpointId: 'ckpt-42' },
    createdAt: ts(2)
  };

  test('interaction/raised + run/paused → paused with the rebuilt checkpoint as current node', () => {
    const stream = streamOf([
      started,
      env(2, 'interaction/raised', { interaction }),
      env(3, 'run/paused', { reason: 'interaction', interactionId: 'ckpt-42' })
    ]);
    const state = projectWorkflowState(stream, ROOT, baseState);
    expect(state.status).toBe('paused');
    expect(state.currentNodes).toEqual(['review']);
    expect(state.pendingCheckpoint).toEqual({
      id: 'ckpt-42',
      nodeId: 'review',
      nodeName: 'Review',
      type: 'review',
      message: 'Review the draft',
      options: [{ value: 'ok', label: 'OK' }],
      inputSchema: { properties: { note: { type: 'string' } } },
      showData: ['$.data.draft'],
      displayData: { data_draft: 'text' },
      expiresAt: ts(59),
      timeout: 60000,
      createdAt: ts(2)
    });
  });

  test('interaction/answered or run/resumed clears the checkpoint; the REST checkpoint is kept while the stream is silent', () => {
    const answered = streamOf([
      started,
      env(2, 'interaction/raised', { interaction }),
      env(3, 'run/paused', { reason: 'interaction', interactionId: 'ckpt-42' }),
      env(4, 'interaction/answered', {
        interactionId: 'ckpt-42',
        kind: 'review',
        answer: { value: 'ok', by: 'user', at: ts(4), channel: 'run_page' }
      })
    ]);
    expect(projectWorkflowState(answered, ROOT, baseState).pendingCheckpoint).toBeNull();

    const restCheckpoint = { id: 'ckpt-rest', nodeId: 'review', message: 'From REST' };
    const pausedBase = { ...baseState, status: 'paused', pendingCheckpoint: restCheckpoint };
    expect(
      projectWorkflowState(createStreamState(ROOT), ROOT, pausedBase).pendingCheckpoint
    ).toEqual(restCheckpoint);
    // an inferred run (progress only, no lifecycle frame) does not override REST
    const inferred = streamOf([env(2, 'progress/node', { nodeId: 'review', status: 'running' })]);
    const inferredState = projectWorkflowState(inferred, ROOT, pausedBase);
    expect(inferredState.pendingCheckpoint).toEqual(restCheckpoint);
    expect(inferredState.status).toBe('paused');

    const resumed = streamOf([env(2, 'run/resumed', { interactionId: 'ckpt-rest' })]);
    const resumedState = projectWorkflowState(resumed, ROOT, pausedBase);
    expect(resumedState.pendingCheckpoint).toBeNull();
    expect(resumedState.status).toBe('running');
  });
});

describe('projectWorkflowState — terminal statuses and meta', () => {
  test('completed with a custom finishReason, output merged into data, completedAt from the frame', () => {
    const stream = streamOf([
      started,
      env(2, 'run/ended', {
        status: 'completed',
        finishReason: 'approved',
        output: { verdict: 'yes' }
      })
    ]);
    const state = projectWorkflowState(stream, ROOT, baseState);
    expect(state.status).toBe('approved');
    expect(state.completedAt).toBe(ts(2));
    expect(state.data.verdict).toBe('yes');
    expect(state.data.nodeInvocations).toBe(1);
  });

  test('error → failed (error recorded), aborted → cancelled, plain completed → completed', () => {
    const failed = projectWorkflowState(
      streamOf([
        started,
        env(2, 'run/ended', {
          status: 'error',
          finishReason: 'error',
          error: { message: 'Kaboom' }
        })
      ]),
      ROOT,
      baseState
    );
    expect(failed.status).toBe('failed');
    expect(failed.errors).toEqual([{ message: 'Kaboom' }]);
    expect(failed.completedAt).toBeUndefined();

    const cancelled = projectWorkflowState(
      streamOf([started, env(2, 'run/ended', { status: 'aborted', finishReason: 'cancelled' })]),
      ROOT,
      baseState
    );
    expect(cancelled.status).toBe('cancelled');

    const completed = projectWorkflowState(
      streamOf([started, env(2, 'run/ended', { status: 'completed', finishReason: null })]),
      ROOT,
      baseState
    );
    expect(completed.status).toBe('completed');
  });

  test('meta.extra.planCreated lands in data.planCreated', () => {
    const plan = { tasks: [{ id: 't1', title: 'First' }], reasoning: 'because' };
    const stream = streamOf([
      started,
      env(2, 'meta', { executionId: ROOT, extra: { planCreated: plan } })
    ]);
    expect(projectWorkflowState(stream, ROOT, baseState).data.planCreated).toEqual(plan);
  });

  test('status helpers', () => {
    expect(deriveWorkflowStatus(null, 'paused')).toBe('paused');
    expect(isActiveWorkflowStatus('running')).toBe(true);
    expect(isActiveWorkflowStatus('paused')).toBe(true);
    expect(isActiveWorkflowStatus('approved')).toBe(false);
  });
});
