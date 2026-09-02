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
    clearPendingCheckpoint(id) {
      this.cleared.push(id);
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

test('isCheckpointInteraction: node origin + source.checkpointId', () => {
  const it = checkpointToInteraction(fakeCheckpoint(), {
    runId: EXECUTION_ID,
    executionId: EXECUTION_ID
  });
  assert.equal(isCheckpointInteraction(it), true);
  assert.equal(isCheckpointInteraction({ ...it, source: {} }), false);
  assert.equal(isCheckpointInteraction({ ...it, origin: 'tool' }), false);
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
    resumeWorkflowFromAnswer(answered, { ...running, runLog }),
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
