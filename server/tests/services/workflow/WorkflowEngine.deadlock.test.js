// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A run whose scheduler returns no executable nodes while nodes are still
 * pending (deadlock) must be failed, not left RUNNING forever.
 */

import { jest } from '@jest/globals';
import { WorkflowEngine } from '../../../services/workflow/WorkflowEngine.js';
import { WorkflowStatus } from '../../../services/workflow/StateManager.js';

describe('WorkflowEngine._runExecutionLoop deadlock handling', () => {
  test('fails the run with WORKFLOW_DEADLOCK when nodes are blocked', async () => {
    const stateManager = {
      update: jest.fn().mockResolvedValue(undefined),
      addError: jest.fn().mockResolvedValue(undefined),
      checkpoint: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue({
        status: WorkflowStatus.RUNNING,
        currentNodes: ['nodeA'],
        completedNodes: [],
        data: {}
      })
    };
    const scheduler = { getExecutableNodes: jest.fn().mockReturnValue([]) };
    const engine = new WorkflowEngine({ stateManager, scheduler });
    const events = [];
    engine._emitEvent = (name, payload) => events.push({ name, payload });

    await engine._runExecutionLoop(
      { id: 'wf', nodes: [] },
      'exec-deadlock',
      {},
      new AbortController().signal
    );

    expect(stateManager.update).toHaveBeenCalledWith(
      'exec-deadlock',
      expect.objectContaining({ status: WorkflowStatus.FAILED })
    );
    expect(stateManager.addError).toHaveBeenCalledWith(
      'exec-deadlock',
      expect.objectContaining({ code: 'WORKFLOW_DEADLOCK' })
    );
    expect(stateManager.checkpoint).toHaveBeenCalledWith('exec-deadlock', 'deadlock_failure');
    const failed = events.find(e => e.name === 'workflow.failed');
    expect(failed.payload.error.code).toBe('WORKFLOW_DEADLOCK');
  });
});
