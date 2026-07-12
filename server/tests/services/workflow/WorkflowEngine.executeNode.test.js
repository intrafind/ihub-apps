/**
 * WorkflowEngine.executeNode cycle-guard tests.
 *
 * Covers issue #1730: the `_nodeIterations` counter guards against infinite
 * loop-backs (a node id being scheduled again and again), not against
 * `node.execution.retries` re-invoking the same logical attempt. A retry
 * attempt (isRetryAttempt=true) must reuse the already-recorded iteration
 * instead of bumping it, so retries don't silently consume the loop budget.
 */

import { jest } from '@jest/globals';
import { WorkflowEngine } from '../../../services/workflow/WorkflowEngine.js';

function createEngine({ nodeIterations = {} } = {}) {
  const state = {
    data: {
      _nodeIterations: { ...nodeIterations },
      nodeResults: {}
    }
  };

  const stateManager = {
    get: jest.fn(async () => state),
    update: jest.fn(async (_executionId, { data }) => {
      state.data = data;
    }),
    markNodeCompleted: jest.fn(async () => {}),
    addStep: jest.fn(async () => {})
  };

  const engine = new WorkflowEngine({ stateManager, scheduler: {} });
  engine.registerExecutor('noop', { execute: async () => ({ status: 'success', output: 'ok' }) });

  return { engine, stateManager, state };
}

const workflow = { nodes: [], config: { maxIterations: 3 } };
const node = { id: 'node-1', type: 'noop', config: {} };

describe('WorkflowEngine.executeNode cycle guard', () => {
  test('a first attempt increments and persists _nodeIterations', async () => {
    const { engine, state } = createEngine();

    await engine.executeNode(node, workflow, 'exec-1', {});

    expect(state.data._nodeIterations['node-1']).toBe(1);
  });

  test('a retry attempt reuses the recorded iteration instead of bumping it', async () => {
    const { engine, state } = createEngine({ nodeIterations: { 'node-1': 1 } });

    await engine.executeNode(node, workflow, 'exec-1', {}, true);

    expect(state.data._nodeIterations['node-1']).toBe(1);
  });

  test('retries never trip MAX_NODE_ITERATIONS_EXCEEDED on their own', async () => {
    const { engine } = createEngine({ nodeIterations: { 'node-1': 1 } });

    // Simulate several retries of the same logical attempt (e.g. node.execution.retries: 5) —
    // none of them should advance the cycle-guard counter or exceed maxIterations: 3.
    await expect(engine.executeNode(node, workflow, 'exec-1', {}, true)).resolves.toMatchObject({
      status: 'success'
    });
    await expect(engine.executeNode(node, workflow, 'exec-1', {}, true)).resolves.toMatchObject({
      status: 'success'
    });
    await expect(engine.executeNode(node, workflow, 'exec-1', {}, true)).resolves.toMatchObject({
      status: 'success'
    });
  });

  test('a genuine loop-back (non-retry) still trips MAX_NODE_ITERATIONS_EXCEEDED', async () => {
    const { engine } = createEngine({ nodeIterations: { 'node-1': 3 } });

    await expect(engine.executeNode(node, workflow, 'exec-1', {})).rejects.toMatchObject({
      code: 'MAX_NODE_ITERATIONS_EXCEEDED',
      nodeId: 'node-1'
    });
  });

  test('result carries the reused iteration number on a retry', async () => {
    const { engine, stateManager } = createEngine({ nodeIterations: { 'node-1': 2 } });

    await engine.executeNode(node, workflow, 'exec-1', {}, true);

    expect(stateManager.markNodeCompleted).toHaveBeenCalledWith(
      'exec-1',
      'node-1',
      expect.objectContaining({ iteration: 2 })
    );
  });
});
