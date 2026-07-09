#!/usr/bin/env node

/**
 * Tests for run-timeline derivation on the agent run detail page.
 *
 * Covers the heuristics that have caused regressions before (per the inline
 * comments in runTimeline.js): dual event-shape normalization, resume/retry
 * status handling, recovered-task backfill, and orchestrator-node detection.
 * Pure (no React) so it runs under node.
 *
 * Run directly: `node client/src/features/admin/utils/runTimeline.test.js`.
 */

import { deriveRunTimeline } from './runTimeline.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

function findTask(unifiedTasks, key) {
  return unifiedTasks.find(t => t.key === key);
}

console.log('🧪 deriveRunTimeline — empty / missing run\n');
{
  const empty = deriveRunTimeline(null);
  check('null run → no tasks', empty.unifiedTasks.length === 0);
  check('null run → zeroed token usage', empty.tokenUsage.total === 0);
  check('null run → empty stepLogs/history', Object.keys(empty.stepLogs).length === 0);
}

console.log('\n🧪 deriveRunTimeline — live SSE vs persisted API event shapes\n');
{
  const wfSummaryNodes = [{ id: 'planner', type: 'planner' }];
  const live = deriveRunTimeline({
    data: { _workflowSummary: { nodes: wfSummaryNodes } },
    history: [
      { event: 'workflow.node.start', nodeId: 'planner' },
      { event: 'workflow.node.complete', nodeId: 'planner' }
    ]
  });
  const persisted = deriveRunTimeline({
    data: { _workflowSummary: { nodes: wfSummaryNodes } },
    history: [
      { type: 'node_start', nodeId: 'planner' },
      { type: 'node_complete', nodeId: 'planner' }
    ]
  });
  check(
    'live SSE shape → planner row done',
    findTask(live.unifiedTasks, 'orch:planner')?.status === 'done'
  );
  check(
    'persisted API shape → planner row done',
    findTask(persisted.unifiedTasks, 'orch:planner')?.status === 'done'
  );
}

console.log('\n🧪 deriveRunTimeline — resume / retry status handling\n');
{
  const wfSummaryNodes = [{ id: 'agent', type: 'prompt', _persistAsArtifact: true }];
  const resumedAfterFailure = deriveRunTimeline({
    data: { _workflowSummary: { nodes: wfSummaryNodes } },
    history: [
      { type: 'node_start', nodeId: 'agent' },
      { type: 'node_error', nodeId: 'agent' },
      { type: 'node_start', nodeId: 'agent' }
    ]
  });
  check(
    'a failed node re-starting flips back to in_progress',
    findTask(resumedAfterFailure.unifiedTasks, 'agent:agent')?.status === 'in_progress',
    `got ${findTask(resumedAfterFailure.unifiedTasks, 'agent:agent')?.status}`
  );

  const staleStartAfterDone = deriveRunTimeline({
    data: { _workflowSummary: { nodes: wfSummaryNodes } },
    history: [
      { type: 'node_start', nodeId: 'agent' },
      { type: 'node_complete', nodeId: 'agent' },
      { type: 'node_start', nodeId: 'agent' }
    ]
  });
  check(
    'a done node does not un-complete on a stray late start',
    findTask(staleStartAfterDone.unifiedTasks, 'agent:agent')?.status === 'done',
    `got ${findTask(staleStartAfterDone.unifiedTasks, 'agent:agent')?.status}`
  );
}

console.log('\n🧪 deriveRunTimeline — _taskResults backfill without history events\n');
{
  const run = {
    data: {
      planCreated: { tasks: [{ id: 'task-1', title: 'T1', description: 'd1' }] },
      _taskResults: { 'task-1': { taskId: 'task-1', title: 'T1' } }
    },
    history: []
  };
  const { unifiedTasks } = deriveRunTimeline(run);
  check(
    '_taskResults marks a task done even with no matching history event',
    findTask(unifiedTasks, 'plan:task-1')?.status === 'done'
  );
}

console.log('\n🧪 deriveRunTimeline — planner status independent of orchestrator history\n');
{
  const run = {
    data: {
      planCreated: { tasks: [{ id: 'task-1', title: 'T1', description: 'd1' }] }
    },
    history: []
  };
  const { unifiedTasks } = deriveRunTimeline(run);
  check(
    'planner row is done once planCreated.tasks is non-empty, even with no planner history',
    findTask(unifiedTasks, 'orch:planner')?.status === 'done'
  );
}

console.log('\n🧪 deriveRunTimeline — recovered plan tasks\n');
{
  const run = {
    data: {
      planCreated: { tasks: [{ id: 'task-2', title: 'T2', description: 'd2' }] },
      _taskResults: {
        'task-1': { taskId: 'task-1', title: 'Recovered task' },
        'task-2': { taskId: 'task-2', title: 'T2' }
      }
    },
    history: []
  };
  const { unifiedTasks } = deriveRunTimeline(run);
  const planRows = unifiedTasks.filter(t => t.kind === 'planner');
  check('recovered task is prepended before the current plan', planRows[0]?.nodeId === 'task-1');
  check('recovered task renders as done', planRows[0]?.status === 'done');
  check('current plan task still present after it', planRows[1]?.nodeId === 'task-2');
}

console.log('\n🧪 deriveRunTimeline — orchestrator-node detection flags\n');
{
  const memoryComposeRun = deriveRunTimeline({
    data: { _stepLogs: { 'memory-compose': { output: '{}' } } },
    history: []
  });
  check(
    'hasMemoryCompose triggers from _stepLogs alone (no workflow summary entry)',
    !!findTask(memoryComposeRun.unifiedTasks, 'orch:memory-compose')
  );

  const reviewerRun = deriveRunTimeline({
    data: { _reviewRound: 2 },
    history: []
  });
  check(
    'hasReviewer triggers from a numeric _reviewRound alone',
    !!findTask(reviewerRun.unifiedTasks, 'orch:reviewer')
  );

  const noReviewerRun = deriveRunTimeline({ data: {}, history: [] });
  check(
    'reviewer row absent when none of the reviewer signals are set',
    !findTask(noReviewerRun.unifiedTasks, 'orch:reviewer')
  );
}

console.log('\n🧪 deriveRunTimeline — retry/round labeling\n');
{
  const wfSummaryNodes = [
    { id: 'drain', type: 'loop' },
    { id: 'agent', type: 'prompt', _persistAsArtifact: true }
  ];
  const run = {
    data: {
      _workflowSummary: { nodes: wfSummaryNodes },
      _nodeIterations: { agent: 3 }
    },
    history: []
  };
  const { unifiedTasks } = deriveRunTimeline(run);
  const agentRow = findTask(unifiedTasks, 'agent:agent');
  check(
    'drain loop present → agent row is labeled as decomposer',
    agentRow?.title?.includes('Planning sub-tasks')
  );
  check('repeated attempts are called out in the title', agentRow?.title?.includes('attempt 3'));
  check(
    'description mentions the revision count',
    agentRow?.description?.includes('revised 2 times')
  );
}

console.log('\n🧪 deriveRunTimeline — token usage passthrough\n');
{
  const run = {
    data: {
      _stepLogs: {
        agent: { model: 'gemini-flash-latest', tokens: { input: 100, output: 20 } }
      }
    },
    history: []
  };
  const { tokenUsage } = deriveRunTimeline(run);
  check(
    'tokenUsage aggregates the run’s step logs',
    tokenUsage.total === 120,
    `got ${tokenUsage.total}`
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
