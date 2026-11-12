// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The boot rescan marks `running` executions failed because the process that
 * ran them died. A run a sibling worker still executes is not one of those.
 *
 * Native ESM: run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest, describe, it, expect } from '@jest/globals';

const updated = [];
const registry = {
  loadFromDisk: async () => {},
  getActive: async () => [
    { executionId: 'wf-exec-live', status: 'running' },
    { executionId: 'wf-exec-dead', status: 'running' },
    { executionId: 'wf-exec-done', status: 'completed' }
  ],
  updateStatus: (id, status) => updated.push([id, status]),
  flushWrites: async () => {}
};
jest.unstable_mockModule('../services/workflow/ExecutionRegistry.js', () => ({
  getExecutionRegistry: () => registry,
  default: class {}
}));
const realSse = await import('../utils/sseChannel.js');
jest.unstable_mockModule('../utils/sseChannel.js', () => ({
  ...realSse,
  startInactiveClientSweep: () => {}
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { markInterruptedExecutionsFailed } = await import('../routes/workflow/workflowRoutes.js');

describe('markInterruptedExecutionsFailed', () => {
  it('leaves a run that is live on another worker alone', async () => {
    updated.length = 0;
    const result = await markInterruptedExecutionsFailed({
      requireSchedulerOwner: false,
      heldByAnotherWorker: id => id === 'wf-exec-live'
    });
    expect(updated).toEqual([['wf-exec-dead', 'failed']]);
    expect(result).toEqual({ recovered: true, marked: 1 });
  });
});
