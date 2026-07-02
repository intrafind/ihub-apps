#!/usr/bin/env node

/**
 * Unit tests for crash-resume of workflow runs:
 *   - WorkflowEngine.resume() restores a checkpoint, flips status back to
 *     running, and re-enters the execution loop (and no-ops on terminal runs).
 *   - resumeManager.findResumableExecutions / resumeInterruptedRuns select the
 *     right runs, honor the scheduler-lock gate, and skip unresolvable defs.
 *
 * Run directly: `node server/tests/workflow-resume.test.js`.
 */

import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { WorkflowEngine } from '../services/workflow/WorkflowEngine.js';
import { StateManager } from '../services/workflow/StateManager.js';
import {
  findResumableExecutions,
  resumeInterruptedRuns
} from '../services/workflow/resumeManager.js';

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
      status: state.status,
      currentNodes: state.currentNodes || [],
      completedNodes: state.completedNodes || [],
      checkpoints: [],
      history: [],
      data: state.data || {}
    }),
    'utf8'
  );
}

const def = {
  id: 'wf1',
  config: { maxExecutionTime: 60000 },
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'end', type: 'end' }
  ],
  edges: [{ source: 'start', target: 'end' }]
};

async function run() {
  console.log('🧪 WorkflowEngine.resume — running checkpoint\n');
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-resume-'));
    const execId = 'wf-exec-running-1';
    seedState(stateDir, execId, {
      status: 'running',
      completedNodes: ['start'],
      currentNodes: ['end'],
      data: { foo: 'bar' }
    });
    const sm = new StateManager({ stateDir });
    const engine = new WorkflowEngine({ stateManager: sm });
    let loopCalled = false;
    engine._runExecutionLoop = async () => {
      loopCalled = true;
    };

    const result = await engine.resumeFromCheckpoint(def, execId, {});
    check('returns restored state', !!result && result.executionId === execId);
    check('status flipped to running', result.status === 'running');
    check('re-entered the execution loop', loopCalled === true);
    check('preserved checkpointed data', result.data.foo === 'bar');
    check('re-anchored the execution deadline', typeof result.data._executionDeadline === 'number');
    check('marked _resumedAt', typeof result.data._resumedAt === 'string');
  }

  console.log('\n🧪 WorkflowEngine.resume — terminal run is a no-op\n');
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-resume-'));
    const execId = 'wf-exec-done-1';
    seedState(stateDir, execId, { status: 'completed', completedNodes: ['start', 'end'] });
    const sm = new StateManager({ stateDir });
    const engine = new WorkflowEngine({ stateManager: sm });
    let loopCalled = false;
    engine._runExecutionLoop = async () => {
      loopCalled = true;
    };
    const result = await engine.resumeFromCheckpoint(def, execId, {});
    check('returns the terminal state', result.status === 'completed');
    check('does NOT re-enter the loop', loopCalled === false);
  }

  console.log('\n🧪 WorkflowEngine.resume — missing checkpoint returns null\n');
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-resume-'));
    const sm = new StateManager({ stateDir });
    const engine = new WorkflowEngine({ stateManager: sm });
    const result = await engine.resumeFromCheckpoint(def, 'wf-exec-missing', {});
    check('returns null when no checkpoint exists', result === null);
  }

  console.log('\n🧪 findResumableExecutions\n');
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-resume-'));
    seedState(stateDir, 'wf-exec-a', { status: 'running' });
    seedState(stateDir, 'wf-exec-b', { status: 'completed' });
    seedState(stateDir, 'wf-exec-c', { status: 'pending' });
    const found = await findResumableExecutions(stateDir);
    const ids = found.map(f => f.executionId).sort();
    check(
      'returns only running/pending runs',
      ids.length === 2 && ids[0] === 'wf-exec-a' && ids[1] === 'wf-exec-c'
    );
  }

  console.log('\n🧪 resumeInterruptedRuns\n');
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-resume-'));
    seedState(stateDir, 'wf-exec-r1', { status: 'running', workflowId: 'wf1' });
    seedState(stateDir, 'wf-exec-r2', { status: 'running', workflowId: 'nope' });

    const resumedIds = [];
    const engine = {
      resumeFromCheckpoint: async (definition, execId) => {
        resumedIds.push(execId);
      }
    };
    const resolveDefinition = async state =>
      state.workflowId === 'wf1' ? { definition: def, options: {} } : null;

    const res = await resumeInterruptedRuns({
      engine,
      resolveDefinition,
      requireSchedulerOwner: false,
      stateDir
    });
    check('resumes the resolvable run', res.resumed.includes('wf-exec-r1'));
    check('skips the unresolvable run', res.skipped.includes('wf-exec-r2'));
    check('engine.resume called once', resumedIds.length === 1);
  }

  console.log('\n🧪 resumeInterruptedRuns — scheduler-lock gate\n');
  {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-resume-'));
    seedState(stateDir, 'wf-exec-g1', { status: 'running', workflowId: 'wf1' });
    let called = false;
    const engine = {
      resumeFromCheckpoint: async () => {
        called = true;
      }
    };
    // requireSchedulerOwner defaults true; no lock acquired in this process →
    // isSchedulerOwner() is false → should NOT resume.
    const res = await resumeInterruptedRuns({
      engine,
      resolveDefinition: async () => ({ definition: def }),
      stateDir
    });
    check('does not resume when not lock owner', res.resumed.length === 0 && called === false);
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
