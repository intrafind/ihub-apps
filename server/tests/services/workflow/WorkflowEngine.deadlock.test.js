/**
 * WorkflowEngine._runExecutionLoop deadlock handling.
 *
 * When the scheduler returns zero executable nodes but the state still has
 * non-empty currentNodes (a node blocked on an unsatisfiable dependency),
 * the loop must fail the run instead of silently breaking and leaving the
 * execution stuck in RUNNING forever.
 */

import { jest } from '@jest/globals';
import { WorkflowEngine } from '../../../services/workflow/WorkflowEngine.js';
import { WorkflowStatus } from '../../../services/workflow/StateManager.js';
import { getExecutionRegistry } from '../../../services/workflow/ExecutionRegistry.js';
import { actionTracker } from '../../../actionTracker.js';

function createEngine(state) {
  const stateManager = {
    get: jest.fn().mockResolvedValue(state),
    update: jest.fn().mockResolvedValue(undefined),
    addError: jest.fn().mockResolvedValue(undefined),
    checkpoint: jest.fn().mockResolvedValue(undefined)
  };
  const scheduler = {
    getExecutableNodes: jest.fn().mockReturnValue([])
  };
  const engine = new WorkflowEngine({ stateManager, scheduler });
  return { engine, stateManager, scheduler };
}

describe('WorkflowEngine deadlock handling', () => {
  test('fails the run when nodes are blocked on unsatisfiable dependencies', async () => {
    const executionId = 'exec-deadlock-1';
    const state = {
      status: WorkflowStatus.RUNNING,
      currentNodes: ['nodeA'],
      completedNodes: [],
      data: {}
    };
    const { engine, stateManager } = createEngine(state);

    const registryUpdateSpy = jest.spyOn(getExecutionRegistry(), 'updateStatus');
    const emitSpy = jest.spyOn(actionTracker, 'emit');

    const workflow = { nodes: [] };
    const controller = new AbortController();

    await engine._runExecutionLoop(workflow, executionId, {}, controller.signal);

    expect(stateManager.update).toHaveBeenCalledWith(
      executionId,
      expect.objectContaining({ status: WorkflowStatus.FAILED })
    );
    expect(stateManager.addError).toHaveBeenCalledWith(
      executionId,
      expect.objectContaining({ code: 'WORKFLOW_DEADLOCK' })
    );
    expect(stateManager.checkpoint).toHaveBeenCalledWith(executionId, 'deadlock_failure');
    expect(registryUpdateSpy).toHaveBeenCalledWith(
      executionId,
      WorkflowStatus.FAILED,
      expect.objectContaining({ currentNode: null })
    );
    expect(emitSpy).toHaveBeenCalledWith(
      'fire-sse',
      expect.objectContaining({
        event: 'workflow.failed',
        executionId,
        error: expect.objectContaining({ code: 'WORKFLOW_DEADLOCK' })
      })
    );

    registryUpdateSpy.mockRestore();
    emitSpy.mockRestore();
  });
});
