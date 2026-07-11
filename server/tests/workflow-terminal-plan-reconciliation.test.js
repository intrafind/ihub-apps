#!/usr/bin/env node

/**
 * Regression tests for GH #1729: _runExecutionLoop must reconcile the living
 * plan (cancel leftover in_progress/open tasks) on EVERY terminal-failure
 * exit, not just the node-error and success paths. Covers the three branches
 * that previously skipped it: the maxExecutionTime deadline, the
 * MAX_EXECUTION_ITERATIONS cap, and the outer fatal-error catch.
 *
 * Run directly: `node server/tests/workflow-terminal-plan-reconciliation.test.js`.
 */

import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { WorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { StateManager } from '../services/workflow/StateManager.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

function seedState(stateDir, executionId, state) {
  mkdirSync(path.join(stateDir, executionId), { recursive: true });
  writeFileSync(
    path.join(stateDir, executionId, 'latest.json'),
    JSON.stringify({
      executionId,
      workflowId: state.workflowId || 'wf1',
      status: state.status || 'running',
      currentNodes: state.currentNodes || [],
      completedNodes: state.completedNodes || [],
      failedNodes: [],
      checkpoints: [],
      history: [],
      errors: [],
      data: state.data || {}
    }),
    'utf8'
  );
}

function newEngine() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-terminal-reconcile-'));
  const sm = new StateManager({ stateDir });
  return { engine: new WorkflowEngine({ stateManager: sm }), sm, stateDir };
}

const taskQueueWithOpenTask = [
  { id: 't1', title: 'Step 1', status: 'in_progress' },
  { id: 't2', title: 'Step 2', status: 'done' }
];

function reconciledStatuses(state) {
  return Object.fromEntries((state.data._taskQueue || []).map(t => [t.id, t.status]));
}

async function run() {
  console.log('🧪 deadline (maxExecutionTime) failure reconciles the plan\n');
  {
    const { engine, sm, stateDir } = newEngine();
    const execId = 'wf-exec-deadline-1';
    seedState(stateDir, execId, {
      currentNodes: ['a'],
      data: {
        _executionDeadline: Date.now() - 1000,
        _taskQueue: taskQueueWithOpenTask
      }
    });
    // Preload into StateManager's in-memory map (update() requires this).
    await sm.get(execId);

    const def = {
      id: 'wf1',
      config: {},
      nodes: [{ id: 'a', type: 'noop' }],
      edges: []
    };
    await engine._runExecutionLoop(def, execId, {}, new AbortController().signal);

    const after = await sm.get(execId);
    const byId = reconciledStatuses(after);
    check('status is failed', after.status === 'failed', after.status);
    check('in_progress task cancelled', byId.t1 === 'cancelled', JSON.stringify(byId));
    check('already-done task untouched', byId.t2 === 'done', JSON.stringify(byId));
    check(
      'error code recorded',
      after.errors?.some(e => e.code === 'MAX_EXECUTION_TIME_EXCEEDED'),
      JSON.stringify(after.errors)
    );
  }

  console.log('\n🧪 fatal error in the execution loop reconciles the plan\n');
  {
    const { engine, sm, stateDir } = newEngine();
    const execId = 'wf-exec-fatal-1';
    seedState(stateDir, execId, {
      currentNodes: ['a'],
      data: { _taskQueue: taskQueueWithOpenTask }
    });
    await sm.get(execId);

    // Force the try block to throw so control reaches the outer catch,
    // without needing a real scheduler/node-execution setup.
    engine.scheduler.getExecutableNodes = () => {
      throw new Error('boom');
    };

    const def = {
      id: 'wf1',
      config: {},
      nodes: [{ id: 'a', type: 'noop' }],
      edges: []
    };
    await engine._runExecutionLoop(def, execId, {}, new AbortController().signal);

    const after = await sm.get(execId);
    const byId = reconciledStatuses(after);
    check('status is failed', after.status === 'failed', after.status);
    check('in_progress task cancelled', byId.t1 === 'cancelled', JSON.stringify(byId));
    check(
      'error message recorded',
      after.errors?.some(e => e.message === 'boom'),
      JSON.stringify(after.errors)
    );
  }

  console.log('\n🧪 MAX_EXECUTION_ITERATIONS cap reconciles the plan\n');
  {
    const { engine, sm, stateDir } = newEngine();
    const execId = 'wf-exec-max-iter-1';
    seedState(stateDir, execId, {
      currentNodes: ['a'],
      // Seed 'a' as already-completed so the self-loop edge (source: a,
      // target: a) is satisfied on the very first readiness check too —
      // otherwise the first iteration deadlocks waiting on its own back-edge.
      completedNodes: ['a'],
      data: { _taskQueue: taskQueueWithOpenTask }
    });
    await sm.get(execId);

    // Self-looping single node: getExecutableNodes stays ready forever
    // (allowCycles defaults true), so the real loop runs until it trips the
    // 10000-iteration cap. Stub executeNode to skip real node dispatch while
    // still driving the state transitions _runExecutionLoop depends on.
    engine.executeNode = async (node, _workflow, executionId) => {
      await sm.markNodeCompleted(executionId, node.id, {});
      return {};
    };

    const def = {
      id: 'wf1',
      config: {},
      nodes: [{ id: 'a', type: 'noop' }],
      edges: [{ source: 'a', target: 'a' }]
    };
    await engine._runExecutionLoop(def, execId, {}, new AbortController().signal);

    const after = await sm.get(execId);
    const byId = reconciledStatuses(after);
    check('status is failed', after.status === 'failed', after.status);
    check('in_progress task cancelled', byId.t1 === 'cancelled', JSON.stringify(byId));
    check(
      'error code recorded',
      after.errors?.some(e => e.code === 'MAX_ITERATIONS_EXCEEDED'),
      JSON.stringify(after.errors)
    );
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
