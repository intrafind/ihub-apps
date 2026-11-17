// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cancelling a workflow run cancels the questions and approvals it was waiting
 * on (AX-B16). Before, an "Ask a Person" checkpoint of a cancelled run stayed
 * in Admin → Approvals with "Open run", and nothing could ever answer it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestStorage } from '../helpers/testStorage.js';
import { RunLog } from '../../services/loop/RunLog.js';
import { InteractionService } from '../../services/loop/InteractionService.js';
import { WorkflowEngine } from '../../services/workflow/WorkflowEngine.js';

function fakeStateManager(states) {
  return {
    async get(id) {
      return states.get(id) || null;
    },
    async update(id, patch) {
      states.set(id, { ...(states.get(id) || {}), ...patch });
    },
    async checkpoint() {},
    async addStep() {}
  };
}

const silentBus = () => ({
  publish: () => true,
  subscribe: () => () => {},
  hasRemote: () => false,
  createPresenceMap: () => new Map()
});

test('cancelling a paused run cancels its pending interactions, not those of other runs', async () => {
  const storage = await startTestStorage({ prefix: 'wf-cancel-interactions-' });
  try {
    const runLog = new RunLog({ forceEnabled: true, getPlatformConfig: () => ({}) });
    const interactions = new InteractionService({ runLog, bus: silentBus() });
    const states = new Map([
      ['wf-exec-paused', { executionId: 'wf-exec-paused', status: 'paused' }],
      ['wf-exec-other', { executionId: 'wf-exec-other', status: 'paused' }]
    ]);
    const engine = new WorkflowEngine({
      bus: silentBus(),
      stateManager: fakeStateManager(states),
      interactions
    });

    const raise = runId =>
      interactions.raise({
        runId,
        kind: 'approval',
        origin: 'node',
        prompt: { message: 'Approve?' },
        source: { executionId: runId, checkpointId: `ckpt-${runId}` }
      });
    const mine = await raise('wf-exec-paused');
    const theirs = await raise('wf-exec-other');

    const state = await engine.cancel('wf-exec-paused', 'user_cancelled');

    assert.equal(state.status, 'cancelled');
    assert.equal((await interactions.get(mine.id)).status, 'cancelled');
    const pending = await interactions.listPending();
    assert.deepEqual(
      pending.map(interaction => interaction.id),
      [theirs.id],
      'only the other run keeps its approval in the queue'
    );
    await interactions.stop();
  } finally {
    await storage.stop();
  }
});

test('a failing interaction store does not stop the cancellation', async () => {
  const states = new Map([['wf-exec-x', { executionId: 'wf-exec-x', status: 'paused' }]]);
  const engine = new WorkflowEngine({
    bus: silentBus(),
    stateManager: fakeStateManager(states),
    interactions: {
      listPending: async () => {
        throw new Error('store down');
      },
      cancel: async () => {}
    }
  });

  const state = await engine.cancel('wf-exec-x');

  assert.equal(state.status, 'cancelled');
});

test('a failed step is named by its name in the run language, not by its id (AX-B32)', async () => {
  const { actionTracker } = await import('../../actionTracker.js');
  const states = new Map([['wf-exec-fail', { executionId: 'wf-exec-fail', status: 'running' }]]);
  const engine = new WorkflowEngine({
    bus: silentBus(),
    stateManager: {
      ...fakeStateManager(states),
      async markNodeFailed() {}
    },
    interactions: { listPending: async () => [], cancel: async () => {} }
  });
  const events = [];
  const listener = event => {
    if (event.event === 'workflow.failed' && event.executionId === 'wf-exec-fail') {
      events.push(event);
    }
  };
  actionTracker.on('fire-sse', listener);
  try {
    const error = new Error('Agent execution failed');
    await engine._handleNodeError(
      'wf-exec-fail',
      {
        id: 'prompt-1794518310650',
        type: 'prompt',
        name: { en: 'Summarise', de: 'Zusammenfassen' }
      },
      error,
      { language: 'de' }
    );
  } finally {
    actionTracker.off('fire-sse', listener);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].error.message, 'Step "Zusammenfassen" failed: Agent execution failed');
  assert.equal(events[0].error.nodeId, 'prompt-1794518310650', 'the id stays for machines');
});

test('an interaction a node raises after the cancel sweep is cancelled too, and the run stays cancelled', async () => {
  const storage = await startTestStorage({ prefix: 'wf-cancel-late-raise-' });
  try {
    const runLog = new RunLog({ forceEnabled: true, getPlatformConfig: () => ({}) });
    const interactions = new InteractionService({ runLog, bus: silentBus() });
    const executionId = 'wf-exec-late';
    const states = new Map([
      [
        executionId,
        { executionId, status: 'running', currentNodes: ['ask'], completedNodes: [], data: {} }
      ]
    ]);
    const engine = new WorkflowEngine({
      bus: silentBus(),
      stateManager: fakeStateManager(states),
      interactions,
      scheduler: { getExecutableNodes: (_workflow, current) => current }
    });
    const controller = new AbortController();
    engine.abortControllers.set(executionId, controller);

    let late;
    // The node is past its abort checks when the run is cancelled, then asks.
    engine.executeNode = async () => {
      await engine.cancel(executionId, 'user_cancelled');
      late = await interactions.raise({
        runId: executionId,
        kind: 'approval',
        origin: 'node',
        prompt: { message: 'Approve?' },
        source: { executionId, checkpointId: 'ckpt-late' }
      });
      return { status: 'paused', pauseReason: 'human_checkpoint', checkpoint: { id: 'ckpt-late' } };
    };

    await engine._runExecutionLoop(
      { id: 'wf', nodes: [{ id: 'ask', type: 'human', config: {} }], edges: [] },
      executionId,
      {},
      controller.signal
    );

    assert.equal(states.get(executionId).status, 'cancelled', 'not overwritten with paused');
    assert.equal((await interactions.get(late.id)).status, 'cancelled');
    assert.deepEqual(await interactions.listPending(), []);
    await interactions.stop();
  } finally {
    await storage.stop();
  }
});
