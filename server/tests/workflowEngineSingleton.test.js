#!/usr/bin/env node

/**
 * Unit tests for the shared WorkflowEngine singleton (getWorkflowEngine):
 *   - repeated calls return the identical instance (and its abortControllers
 *     Map, the only genuinely per-instance state)
 *   - resetWorkflowEngine() forces a fresh instance
 *   - the actual bug this fixes: a cancel() issued through one "entry point"
 *     reference now aborts a run started through a different reference,
 *     because both resolve to the same instance. Before this fix, every
 *     entry point (workflowRunner, workflowRoutes, agents/runs,
 *     agents/artifacts, boot-time resume) built its own `new WorkflowEngine()`
 *     with an independent `abortControllers` Map, so a cancel from one
 *     surface could only flip the persisted status (picked up between
 *     nodes) — it could not interrupt a mid-node await tracked by a
 *     different instance's AbortController.
 *
 * Run directly: `node server/tests/workflowEngineSingleton.test.js`.
 */

import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';
import { getWorkflowEngine, resetWorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { StateManager } from '../services/workflow/StateManager.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/**
 * Node executor that blocks until its abortSignal fires, so a test can
 * observe whether an in-flight node execution actually gets interrupted
 * (rather than only checking the persisted status, which would pass even
 * against the pre-fix code).
 */
class HoldExecutor {
  constructor() {
    this.invoked = false;
    this.aborted = false;
  }

  async execute(_node, _state, context) {
    this.invoked = true;
    const signal = context.abortSignal;
    if (signal?.aborted) {
      this.aborted = true;
      throw Object.assign(new Error('aborted before start'), { code: 'ABORTED' });
    }
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        this.aborted = true;
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      });
    });
  }
}

async function run() {
  console.log('🧪 getWorkflowEngine() singleton identity\n');
  {
    resetWorkflowEngine();
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-engine-singleton-'));
    const stateManager = new StateManager({ stateDir });

    const engineFromRunner = getWorkflowEngine({ stateManager });
    const engineFromRoutes = getWorkflowEngine();
    const engineFromAgentsRuns = getWorkflowEngine({
      stateManager: new StateManager({ stateDir })
    });

    check(
      'second call returns the identical instance (ignores new options)',
      engineFromRoutes === engineFromRunner
    );
    check(
      'a third call site also gets the identical instance',
      engineFromAgentsRuns === engineFromRunner
    );
    check(
      'abortControllers map is the same object across references',
      engineFromRoutes.abortControllers === engineFromRunner.abortControllers
    );

    resetWorkflowEngine();
    const engineAfterReset = getWorkflowEngine({ stateManager });
    check('resetWorkflowEngine() forces a fresh instance', engineAfterReset !== engineFromRunner);
  }

  console.log('\n🧪 cancel() through a different reference aborts an in-flight node\n');
  {
    resetWorkflowEngine();
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-engine-singleton-cancel-'));
    const stateManager = new StateManager({ stateDir });

    // Simulates workflowRunner.js obtaining the engine and starting a run.
    const engineA = getWorkflowEngine({ stateManager });
    const holdExecutor = new HoldExecutor();
    engineA.registerExecutor('hold', holdExecutor);

    const workflow = {
      id: 'wf-singleton-cancel-test',
      nodes: [{ id: 'n1', type: 'hold' }],
      edges: [],
      config: {}
    };

    const state = await engineA.start(workflow, {}, { user: { id: 'tester' } });

    const nodeStarted = await waitFor(() => holdExecutor.invoked);
    check('the node executor actually started running', nodeStarted);

    // Simulates a DIFFERENT entry point (e.g. an admin/agents route) fetching
    // "its own" engine reference and issuing the cancel.
    const engineB = getWorkflowEngine();
    check('cancelling reference is the same instance as the starting one', engineB === engineA);

    await engineB.cancel(state.executionId, 'test_cross_reference_cancel');

    const nodeAborted = await waitFor(() => holdExecutor.aborted);
    check(
      'the in-flight node executor observed the abort signal (not just a status flip)',
      nodeAborted,
      'holdExecutor.aborted stayed false — cancel() did not reach the running node'
    );

    // Note: the node's rejected promise and cancel()'s own status update race
    // independently — _handleNodeError unconditionally sets FAILED, which can
    // overwrite the CANCELLED status cancel() just persisted. That race is a
    // pre-existing WorkflowEngine behavior unrelated to the singleton fix
    // under test here, so this only asserts the run reached SOME terminal
    // state rather than being left running.
    const finalState = await engineA.getState(state.executionId);
    check(
      'run reached a terminal state after cancel',
      ['cancelled', 'failed'].includes(finalState?.status),
      `status was ${finalState?.status}`
    );
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
