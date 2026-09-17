#!/usr/bin/env node

/**
 * Unit tests for living-plan reconciliation on terminal state
 * (WorkflowEngine._reconcilePlanOnTerminal):
 *   - leftover in_progress / open tasks are cancelled when a run ends, so a
 *     completed/failed run never shows a perpetually-spinning task
 *   - already-terminal tasks (done / failed / cancelled) are left untouched
 *   - runs without a _taskQueue are a no-op (non-agent workflows)
 *
 * Run directly: `node server/tests/agent-plan-reconciliation.test.js`.
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

function seedState(stateDir, executionId, data) {
  mkdirSync(path.join(stateDir, executionId), { recursive: true });
  writeFileSync(
    path.join(stateDir, executionId, 'latest.json'),
    JSON.stringify({
      executionId,
      workflowId: 'claude-style-agent',
      status: 'running',
      currentNodes: [],
      completedNodes: [],
      checkpoints: [],
      history: [],
      data
    }),
    'utf8'
  );
}

function newEngine() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-reconcile-'));
  const sm = new StateManager({ stateDir });
  return { engine: new WorkflowEngine({ stateManager: sm }), sm, stateDir };
}

async function run() {
  console.log('🧪 reconcile cancels leftover in_progress/open tasks\n');
  {
    const { engine, sm, stateDir } = newEngine();
    const execId = 'wf-exec-recon-1';
    seedState(stateDir, execId, {
      _taskQueue: [
        { id: 't1', title: 'Step 1', status: 'in_progress' },
        { id: 't2', title: 'Step 2', status: 'open' },
        { id: 't3', title: 'Step 3', status: 'done' },
        { id: 't4', title: 'Step 4', status: 'failed' }
      ]
    });
    await engine._reconcilePlanOnTerminal(execId);
    const after = await sm.get(execId);
    const byId = Object.fromEntries((after.data._taskQueue || []).map(t => [t.id, t.status]));
    check('in_progress → cancelled', byId.t1 === 'cancelled', JSON.stringify(byId));
    check('open → cancelled', byId.t2 === 'cancelled', JSON.stringify(byId));
    check('done is left as done', byId.t3 === 'done', JSON.stringify(byId));
    check('failed is left as failed', byId.t4 === 'failed', JSON.stringify(byId));
  }

  console.log('\n🧪 reconcile is a no-op when nothing is open\n');
  {
    const { engine, sm, stateDir } = newEngine();
    const execId = 'wf-exec-recon-2';
    seedState(stateDir, execId, {
      _taskQueue: [{ id: 't1', title: 'Step 1', status: 'done' }]
    });
    await engine._reconcilePlanOnTerminal(execId);
    const after = await sm.get(execId);
    check('done stays done (untouched)', after.data._taskQueue[0].status === 'done');
  }

  console.log('\n🧪 reconcile is a no-op for non-agent runs (no _taskQueue)\n');
  {
    const { engine, sm, stateDir } = newEngine();
    const execId = 'wf-exec-recon-3';
    seedState(stateDir, execId, { foo: 'bar' });
    let threw = false;
    try {
      await engine._reconcilePlanOnTerminal(execId);
    } catch {
      threw = true;
    }
    const after = await sm.get(execId);
    check('does not throw without a task queue', threw === false);
    check('leaves unrelated data intact', after.data.foo === 'bar');
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
