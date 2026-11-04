#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

import { WorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { startTestStorage, stateRepositoryFor } from './helpers/testStorage.js';
import { StateManager } from '../services/workflow/StateManager.js';

const storage = await startTestStorage();

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function seedState(repository, executionId, data) {
  await repository.write(executionId, {
    executionId,
    workflowId: 'claude-style-agent',
    status: 'running',
    currentNodes: [],
    completedNodes: [],
    checkpoints: [],
    history: [],
    data
  });
}

function newEngine() {
  const repository = stateRepositoryFor(storage);
  const sm = new StateManager({ repository });
  return { engine: new WorkflowEngine({ stateManager: sm }), sm, repository };
}

async function run() {
  console.log('🧪 reconcile cancels leftover in_progress/open tasks\n');
  {
    const { engine, sm, repository } = newEngine();
    const execId = 'wf-exec-recon-1';
    await seedState(repository, execId, {
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
    const { engine, sm, repository } = newEngine();
    const execId = 'wf-exec-recon-2';
    await seedState(repository, execId, {
      _taskQueue: [{ id: 't1', title: 'Step 1', status: 'done' }]
    });
    await engine._reconcilePlanOnTerminal(execId);
    const after = await sm.get(execId);
    check('done stays done (untouched)', after.data._taskQueue[0].status === 'done');
  }

  console.log('\n🧪 reconcile is a no-op for non-agent runs (no _taskQueue)\n');
  {
    const { engine, sm, repository } = newEngine();
    const execId = 'wf-exec-recon-3';
    await seedState(repository, execId, { foo: 'bar' });
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
  await storage.stop();
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
