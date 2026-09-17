/**
 * Checkpoint resume specs — an answered `human` node interaction resumes its
 * execution through the one answer path (InteractionService.onAnswer), and a
 * rejected resume leaves the interaction pending.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import {
  resumeWorkflowFromAnswer,
  registerCheckpointResume,
  isCheckpointInteraction,
  CheckpointResumeError,
  AGENT_NODE_TIMEOUT_MS
} from '../../services/workflow/checkpointResume.js';
import { checkpointToInteraction } from '../../services/loop/RunStream.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';

const EXECUTION_ID = 'wf-exec-11111111-2222-3333-4444-555555555555';

function fakeCheckpoint(overrides = {}) {
  return {
    id: 'ckpt-1',
    nodeId: 'approval',
    nodeName: 'Manager approval',
    type: 'approval',
    message: 'Approve the plan?',
    options: [
      { value: 'approve', label: 'Approve', style: 'primary' },
      { value: 'reject', label: 'Reject', style: 'danger' }
    ],
    inputSchema: null,
    showData: null,
    timeout: null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides
  };
}

/** Minimal engine/registry/executor doubles recording what the resume did. */
function fakeEngine({ state, agent = false } = {}) {
  const calls = { update: [], resume: [], getNextNodes: [] };
  const workflow = {
    id: 'wf-1',
    nodes: [
      { id: 'approval', type: 'human', config: { message: 'Approve?' } },
      { id: 'publish', type: 'prompt' }
    ],
    edges: [{ from: 'approval', to: 'publish' }]
  };
  const paused = state ?? {
    executionId: EXECUTION_ID,
    status: 'paused',
    completedNodes: ['plan'],
    currentNodes: ['approval'],
    data: {
      pendingCheckpoint: fakeCheckpoint(),
      _workflowDefinition: workflow,
      nodeResults: { plan: { ok: true } },
      ...(agent ? { _agent: { profileId: 'p1', triggeredBy: { userId: 'u1' } } } : {})
    }
  };
  const engine = {
    async getState(id) {
      return id === EXECUTION_ID ? paused : null;
    },
    scheduler: {
      getNextNodes(nodeId, result, wf, st) {
        calls.getNextNodes.push({ nodeId, result, wf, st });
        return result.branch === 'approve' ? ['publish'] : [];
      }
    },
    stateManager: {
      async update(id, patch) {
        calls.update.push({ id, patch });
      }
    },
    async resume(id, data, options) {
      calls.resume.push({ id, data, options });
      return { executionId: id, status: 'running' };
    }
  };
  const registry = {
    cleared: [],
    restored: [],
    clearPendingCheckpoint(id) {
      this.cleared.push(id);
    },
    setPendingCheckpoint(id, checkpoint) {
      this.restored.push({ id, checkpoint });
    }
  };
  const executor = {
    calls: [],
    async resume(node, st, humanResponse, ctx) {
      this.calls.push({ node, humanResponse, ctx });
      if (humanResponse.response === 'bogus') {
        return { status: 'failed', error: `Invalid response '${humanResponse.response}'` };
      }
      return {
        status: 'completed',
        branch: humanResponse.response,
        output: { checkpointId: humanResponse.checkpointId, response: humanResponse.response },
        stateUpdates: { humanResponse_approval: { response: humanResponse.response } }
      };
    }
  };
  return { engine, registry, executor, calls, workflow, paused };
}

async function setup() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-resume-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const svc = new InteractionService({ runLog, saveIntervalMs: 10 });
  await runLog.startRun({ runId: EXECUTION_ID, kind: 'workflow', user: { id: 'u1' } });
  return { runLog, svc };
}

test('isCheckpointInteraction: source.checkpointId + executionId, from a human node or an ask_user call', () => {
  const it = checkpointToInteraction(fakeCheckpoint(), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  assert.equal(isCheckpointInteraction(it), true);
  assert.equal(isCheckpointInteraction({ ...it, source: {} }), false);
  assert.equal(
    isCheckpointInteraction({ ...it, origin: 'tool' }),
    true,
    'an ask_user question inside a node pauses the execution too'
  );
  assert.equal(
    isCheckpointInteraction({ ...it, source: { checkpointId: 'ckpt-1' } }),
    false,
    'a chat clarification (no execution) is not a checkpoint'
  );
  assert.equal(isCheckpointInteraction(null), false);
});

test('answer → executor.resume → route on branch → state update → engine.resume → run/resumed', async () => {
  const { runLog, svc } = await setup();
  const { engine, registry, executor, calls } = fakeEngine();
  const unregister = registerCheckpointResume(svc, { engine, registry, executor, runLog });
  const types = [];
  runLog.subscribe(EXECUTION_ID, e => types.push(e.type));

  const template = checkpointToInteraction(fakeCheckpoint(), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  const raised = await svc.raise({
    id: template.id,
    runId: EXECUTION_ID,
    kind: template.kind,
    origin: 'node',
    prompt: template.prompt,
    source: template.source
  });
  assert.equal(raised.id, 'ckpt-1');

  const answered = await svc.answer(
    'ckpt-1',
    { value: 'approve', data: { note: 'go' } },
    { user: { id: 'alice', groups: ['managers'] }, channel: 'run_page' }
  );
  assert.equal(answered.status, 'answered');

  // executor got the legacy checkpoint response shape and the answering user
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls[0].humanResponse, {
    checkpointId: 'ckpt-1',
    response: 'approve',
    data: { note: 'go' },
    note: undefined
  });
  assert.equal(executor.calls[0].ctx.executionId, EXECUTION_ID);
  assert.equal(executor.calls[0].ctx.user.id, 'alice');

  // registry cleared, scheduler routed on the branch, state updated
  assert.deepEqual(registry.cleared, [EXECUTION_ID]);
  assert.equal(calls.getNextNodes[0].result.branch, 'approve');
  const { patch } = calls.update[0];
  assert.deepEqual(patch.completedNodes, ['plan', 'approval']);
  assert.deepEqual(patch.currentNodes, ['publish']);
  assert.deepEqual(patch.data.humanResponse_approval, { response: 'approve' });
  assert.equal(patch.data._humanResult_approval.branch, 'approve');
  assert.deepEqual(patch.data.nodeResults.plan, { ok: true });
  assert.equal(patch.data.nodeResults.approval.response, 'approve');

  // engine resumed as the answering user with the stored definition; no agent timeout
  assert.equal(calls.resume.length, 1);
  assert.equal(calls.resume[0].options.user.id, 'alice');
  assert.equal(calls.resume[0].options.workflow.id, 'wf-1');
  assert.equal(calls.resume[0].options.timeout, undefined);

  // ledger: raised, answered and run/resumed for the execution's run
  assert.deepEqual(types, [
    RUN_LOG_EVENTS.INTERACTION_RAISED,
    RUN_LOG_EVENTS.INTERACTION_ANSWERED,
    RUN_LOG_EVENTS.RUN_RESUMED
  ]);
  assert.deepEqual(await svc.listPending({ runId: EXECUTION_ID }), []);

  unregister();
  await svc.stop();
  await runLog.stop();
});

test('agent runs resume with the 30-minute node timeout', async () => {
  const { runLog, svc } = await setup();
  const { engine, registry, executor, calls } = fakeEngine({ agent: true });
  const it = checkpointToInteraction(fakeCheckpoint(), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  await resumeWorkflowFromAnswer(
    {
      ...it,
      status: 'answered',
      answer: { value: 'approve', by: 'alice', at: new Date().toISOString(), channel: 'queue' }
    },
    { engine, registry, executor, runLog, user: { id: 'alice' } }
  );
  assert.equal(calls.resume[0].options.timeout, AGENT_NODE_TIMEOUT_MS);
  await svc.stop();
  await runLog.stop();
});

test('a rejected resume rejects the answer and leaves the interaction pending', async () => {
  const { runLog, svc } = await setup();
  const { engine, registry, executor, calls } = fakeEngine();
  registerCheckpointResume(svc, { engine, registry, executor, runLog });
  const template = checkpointToInteraction(fakeCheckpoint({ options: undefined }), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  await svc.raise({
    id: template.id,
    runId: EXECUTION_ID,
    kind: template.kind,
    origin: 'node',
    prompt: template.prompt,
    source: template.source
  });

  await assert.rejects(
    svc.answer('ckpt-1', { value: 'bogus' }, { user: { id: 'alice' } }),
    e => e instanceof CheckpointResumeError && e.code === 'RESUME_REJECTED' && e.status === 400
  );
  assert.equal((await svc.get('ckpt-1')).status, 'pending');
  assert.equal(calls.update.length, 0);
  assert.equal(calls.resume.length, 0);
  assert.deepEqual(registry.cleared, []);

  // …and the human can try again.
  const answered = await svc.answer('ckpt-1', { value: 'approve' }, { user: { id: 'alice' } });
  assert.equal(answered.status, 'answered');
  assert.equal(calls.resume.length, 1);
  await svc.stop();
  await runLog.stop();
});

test('execution state guards: not paused / checkpoint mismatch / unknown execution', async () => {
  const { runLog, svc } = await setup();
  const it = checkpointToInteraction(fakeCheckpoint(), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  const answered = {
    ...it,
    status: 'answered',
    answer: { value: 'approve', by: 'alice', at: new Date().toISOString(), channel: 'api' }
  };

  const running = fakeEngine();
  running.paused.status = 'running';
  await assert.rejects(
    resumeWorkflowFromAnswer(answered, { ...running, runLog, pauseSettleMs: 0 }),
    e => e.code === 'INVALID_STATE_FOR_RESUME' && e.status === 409
  );

  const mismatch = fakeEngine();
  mismatch.paused.data.pendingCheckpoint = fakeCheckpoint({ id: 'ckpt-other' });
  await assert.rejects(
    resumeWorkflowFromAnswer(answered, { ...mismatch, runLog }),
    e => e.code === 'CHECKPOINT_MISMATCH'
  );

  const gone = fakeEngine();
  await assert.rejects(
    resumeWorkflowFromAnswer(
      { ...answered, source: { ...answered.source, executionId: 'wf-exec-nope' } },
      { ...gone, runLog }
    ),
    e => e.code === 'EXECUTION_NOT_FOUND' && e.status === 404
  );
  await svc.stop();
  await runLog.stop();
});

test('non-checkpoint interactions are ignored by the registered handler', async () => {
  const { runLog, svc } = await setup();
  const { engine, registry, executor, calls } = fakeEngine();
  registerCheckpointResume(svc, { engine, registry, executor, runLog });
  const q = await svc.raise({
    runId: EXECUTION_ID,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which one?' },
    source: { toolCallId: 'call_1', chatId: 'chat-1' }
  });
  await svc.answer(q.id, { value: 'this one' }, { user: { id: 'alice' }, channel: 'chat' });
  assert.equal(calls.resume.length, 0);
  assert.equal(executor.calls.length, 0);
  await svc.stop();
  await runLog.stop();
});

test('an execution id that is not a safe run id is rejected before the engine is touched', async () => {
  const { runLog, svc } = await setup();
  const { engine, registry, executor, calls } = fakeEngine();
  const it = checkpointToInteraction(fakeCheckpoint(), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  let getStateCalls = 0;
  const spyingEngine = {
    ...engine,
    async getState(id) {
      getStateCalls += 1;
      return engine.getState(id);
    }
  };
  await assert.rejects(
    resumeWorkflowFromAnswer(
      {
        ...it,
        status: 'answered',
        source: { ...it.source, executionId: '../../etc' },
        answer: { value: 'approve', by: 'alice', at: new Date().toISOString(), channel: 'api' }
      },
      { engine: spyingEngine, registry, executor, runLog }
    ),
    e => e instanceof CheckpointResumeError && e.code === 'INVALID_EXECUTION_ID' && e.status === 400
  );
  assert.equal(getStateCalls, 0);
  assert.equal(calls.resume.length, 0);
  await svc.stop();
  await runLog.stop();
});

test('an expired checkpoint interaction cancels its execution (policy onTimeout: fail)', async () => {
  const { runLog, svc } = await setup();
  const cancelled = [];
  const { engine, registry, executor } = fakeEngine();
  engine.cancel = async (id, reason) => {
    cancelled.push({ id, reason });
    return { executionId: id, status: 'cancelled' };
  };
  const unregister = registerCheckpointResume(svc, { engine, registry, executor, runLog });
  const template = checkpointToInteraction(fakeCheckpoint({ timeout: 1000 }), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  const raised = await svc.raise({
    id: template.id,
    runId: EXECUTION_ID,
    kind: template.kind,
    origin: 'node',
    prompt: template.prompt,
    policy: { timeoutMs: 1000, onTimeout: 'fail' },
    source: template.source
  });
  await svc.expire(raised.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(cancelled, [{ id: EXECUTION_ID, reason: 'human_checkpoint_expired' }]);
  assert.equal((await svc.get(raised.id)).status, 'expired');

  // a chat question expiring never touches the engine
  const q = await svc.raise({
    runId: EXECUTION_ID,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which?' },
    source: { chatId: 'chat-1' }
  });
  await svc.expire(q.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled.length, 1);
  unregister();
  await svc.stop();
  await runLog.stop();
});

test('the expiry sweep transitions overdue interactions and is idempotent to start', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-sweep-'));
  const runLog = new RunLog({ baseDir, forceEnabled: true, getPlatformConfig: () => ({}) });
  const svc = new InteractionService({ runLog, saveIntervalMs: 10, now: () => now });
  await runLog.startRun({ runId: EXECUTION_ID, kind: 'workflow', user: { id: 'u1' } });
  const it = await svc.raise({
    runId: EXECUTION_ID,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Soon?' },
    policy: { timeoutMs: 1000 }
  });
  svc.startExpirySweep({ intervalMs: 5 });
  svc.startExpirySweep({ intervalMs: 5 });
  now += 5000;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await svc.get(it.id)).status, 'expired');
  svc.stopExpirySweep();
  await svc.stop();
  await runLog.stop();
});

test('an answered question checkpoint resumes the paused node with the answer on the state', async () => {
  const workflow = {
    id: 'wf-q',
    nodes: [
      { id: 'research', type: 'prompt', config: {} },
      { id: 'write', type: 'prompt' }
    ],
    edges: [{ from: 'research', to: 'write' }]
  };
  const pending = {
    id: 'ckpt-q1',
    nodeId: 'research',
    type: 'question',
    message: 'Which quarter?',
    inputType: 'text',
    allowSkip: true
  };
  const state = {
    executionId: EXECUTION_ID,
    status: 'paused',
    completedNodes: [],
    currentNodes: ['research'],
    data: {
      pendingCheckpoint: pending,
      _pausedLoops: { research: { checkpointId: 'ckpt-q1', toolCallId: 'call_1', messages: [] } },
      _workflowDefinition: workflow,
      _agent: { profileId: 'p1' }
    }
  };
  const { engine, registry, calls } = fakeEngine({ state });
  const interaction = {
    id: 'ckpt-q1',
    runId: EXECUTION_ID,
    kind: 'question',
    origin: 'tool',
    status: 'answered',
    prompt: { message: 'Which quarter?', inputType: 'text' },
    source: {
      checkpointId: 'ckpt-q1',
      executionId: EXECUTION_ID,
      nodeId: 'research',
      toolCallId: 'call_1'
    },
    answer: { value: 'Q3 2025', by: 'alice', at: '2026-09-02T12:00:00.000Z', channel: 'run_page' }
  };
  assert.equal(
    isCheckpointInteraction(interaction),
    true,
    'a tool-origin question with a checkpoint id pauses an execution'
  );

  const executor = {
    resume() {
      throw new Error('the human node executor must not be involved');
    }
  };
  const newState = await resumeWorkflowFromAnswer(interaction, {
    user: { id: 'alice' },
    engine,
    registry,
    executor
  });
  assert.equal(newState.status, 'running');
  assert.deepEqual(registry.cleared, [EXECUTION_ID]);
  assert.equal(calls.getNextNodes.length, 0, 'no branch routing: the same node runs again');
  assert.equal(calls.update.length, 1);
  const patch = calls.update[0].patch;
  assert.equal(patch.data.pendingCheckpoint, null);
  assert.equal(patch.data._questionAnswers['ckpt-q1'].value, 'Q3 2025');
  assert.equal(patch.data._questionAnswers['ckpt-q1'].skipped, false);
  assert.equal(
    patch.currentNodes,
    undefined,
    'currentNodes untouched: the paused node stays current'
  );
  assert.equal(calls.resume.length, 1);
  assert.equal(
    calls.resume[0].options.timeout,
    AGENT_NODE_TIMEOUT_MS,
    'agent runs keep their node budget'
  );
});

test('an answer that arrives before the pause is written waits for it instead of rejecting', async () => {
  const { runLog, svc } = await setup();
  const fake = fakeEngine();
  fake.paused.status = 'running';
  let reads = 0;
  const realGetState = fake.engine.getState.bind(fake.engine);
  fake.engine.getState = async id => {
    reads += 1;
    if (reads >= 3) fake.paused.status = 'paused';
    return realGetState(id);
  };
  const it = checkpointToInteraction(fakeCheckpoint(), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  const answered = {
    ...it,
    status: 'answered',
    answer: { value: 'approve', by: 'alice', at: new Date().toISOString(), channel: 'api' }
  };
  const started = Date.now();
  const result = await resumeWorkflowFromAnswer(answered, {
    ...fake,
    runLog,
    pauseSettleMs: 1000
  });
  assert.equal(result.status, 'running');
  assert.ok(reads >= 3, 'the state was re-read until the pause landed');
  assert.ok(Date.now() - started < 1000, 'resumed as soon as the pause landed');
  assert.equal(fake.calls.resume.length, 1);
  await svc.stop();
  await runLog.stop();
});

test('a failing engine.resume restores the paused state and its checkpoint; the answer can be retried', async () => {
  const { runLog, svc } = await setup();
  const { engine, registry, executor, calls } = fakeEngine();
  let failNext = true;
  const realResume = engine.resume.bind(engine);
  engine.resume = async (...args) => {
    if (failNext) {
      failNext = false;
      const err = new Error('Workflow definition not available');
      err.code = 'WORKFLOW_NOT_AVAILABLE';
      throw err;
    }
    return realResume(...args);
  };
  registerCheckpointResume(svc, { engine, registry, executor, runLog });
  const template = checkpointToInteraction(fakeCheckpoint({ options: undefined }), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  await svc.raise({
    id: template.id,
    runId: EXECUTION_ID,
    kind: template.kind,
    origin: 'node',
    prompt: template.prompt,
    source: template.source
  });

  await assert.rejects(
    svc.answer('ckpt-1', { value: 'approve' }, { user: { id: 'alice' } }),
    e =>
      e instanceof CheckpointResumeError && e.code === 'WORKFLOW_NOT_AVAILABLE' && e.status === 409
  );
  assert.equal((await svc.get('ckpt-1')).status, 'pending');
  const restore = calls.update.at(-1).patch;
  assert.equal(restore.status, 'paused');
  assert.deepEqual(restore.completedNodes, ['plan']);
  assert.deepEqual(restore.currentNodes, ['approval']);
  assert.equal(restore.data.pendingCheckpoint.id, 'ckpt-1');
  assert.deepEqual(registry.cleared, [EXECUTION_ID]);
  assert.deepEqual(
    registry.restored.map(r => [r.id, r.checkpoint.id]),
    [[EXECUTION_ID, 'ckpt-1']]
  );

  // …and the retry goes through.
  const answered = await svc.answer('ckpt-1', { value: 'approve' }, { user: { id: 'alice' } });
  assert.equal(answered.status, 'answered');
  assert.equal(calls.resume.length, 1);
  await svc.stop();
  await runLog.stop();
});

test('a failing engine.resume after a question answer restores the checkpoint too', async () => {
  const { runLog, svc } = await setup();
  const pending = {
    id: 'ckpt-q1',
    nodeId: 'research',
    type: 'question',
    message: 'Which quarter?',
    inputType: 'text'
  };
  const workflow = {
    id: 'wf-q',
    nodes: [{ id: 'research', type: 'prompt', config: {} }],
    edges: []
  };
  const state = {
    executionId: EXECUTION_ID,
    status: 'paused',
    completedNodes: [],
    currentNodes: ['research'],
    data: { pendingCheckpoint: pending, _workflowDefinition: workflow }
  };
  const { engine, registry, calls } = fakeEngine({ state });
  let code = 'WORKFLOW_NOT_AVAILABLE';
  engine.resume = async () => {
    const err = new Error('resume failed');
    err.code = code;
    throw err;
  };
  const interaction = {
    id: 'ckpt-q1',
    runId: EXECUTION_ID,
    kind: 'question',
    origin: 'tool',
    status: 'answered',
    prompt: { message: 'Which quarter?', inputType: 'text' },
    source: {
      checkpointId: 'ckpt-q1',
      executionId: EXECUTION_ID,
      nodeId: 'research',
      toolCallId: 'call_1'
    },
    answer: { value: 'Q3', by: 'alice', at: new Date().toISOString(), channel: 'run_page' }
  };
  await assert.rejects(
    resumeWorkflowFromAnswer(interaction, { engine, registry, runLog }),
    e => e.code === 'WORKFLOW_NOT_AVAILABLE'
  );
  const restore = calls.update.at(-1).patch;
  assert.equal(restore.status, 'paused');
  assert.equal(restore.data.pendingCheckpoint.id, 'ckpt-q1');
  assert.deepEqual(
    registry.restored.map(r => r.checkpoint.id),
    ['ckpt-q1']
  );

  // The engine saying the execution is no longer paused means it moved on
  // (resumed or finished elsewhere): nothing is put back.
  code = 'INVALID_STATE_FOR_RESUME';
  const updatesBefore = calls.update.length;
  await assert.rejects(
    resumeWorkflowFromAnswer(interaction, { engine, registry, runLog }),
    e => e.code === 'INVALID_STATE_FOR_RESUME' && e.status === 409
  );
  assert.equal(calls.update.length, updatesBefore + 1, 'only the answer was written');
  assert.notEqual(calls.update.at(-1).patch.status, 'paused');
  assert.equal(registry.restored.length, 1);
  await svc.stop();
  await runLog.stop();
});
