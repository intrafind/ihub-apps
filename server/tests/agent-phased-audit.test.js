// server/tests/agent-phased-audit.test.js
//
// Asserts the per-task auditability contract: round-1+ task ids are
// namespaced with r{N}_ so _taskResults / _stepLogs from round 0 are
// never overwritten by round 1 (and vice-versa).
//
// Run: node server/tests/agent-phased-audit.test.js

import { PlannerNodeExecutor } from '../services/workflow/executors/PlannerNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const executor = new PlannerNodeExecutor();

// ── helper: build a minimal plan with N tasks ──────────────────────────────
function makePlan(ids) {
  return { tasks: ids.map(id => ({ id, dependsOn: [] })) };
}

// ── round-0 ids are returned unchanged ────────────────────────────────────
console.log('\n🧪 round 0 — task ids pass through unchanged\n');
{
  const plan = makePlan(['task_a', 'task_b', 'task_c']);
  executor._namespaceTaskIds(plan, 0);
  const got = plan.tasks.map(t => t.id);
  check('task_a unchanged', got[0] === 'task_a', `got ${got[0]}`);
  check('task_b unchanged', got[1] === 'task_b', `got ${got[1]}`);
  check('task_c unchanged', got[2] === 'task_c', `got ${got[2]}`);
}

// ── round-1 ids are prefixed r1_ ──────────────────────────────────────────
console.log('\n🧪 round 1 — task ids get r1_ prefix\n');
{
  const plan = makePlan(['task_a', 'task_b']);
  executor._namespaceTaskIds(plan, 1);
  const got = plan.tasks.map(t => t.id);
  check('task_a → r1_task_a', got[0] === 'r1_task_a', `got ${got[0]}`);
  check('task_b → r1_task_b', got[1] === 'r1_task_b', `got ${got[1]}`);
  check('all round-1 ids start with r1_', got.every(id => id.startsWith('r1_')));
}

// ── round-2 ids are prefixed r2_ ──────────────────────────────────────────
console.log('\n🧪 round 2 — task ids get r2_ prefix\n');
{
  const plan = makePlan(['gap_x', 'gap_y']);
  executor._namespaceTaskIds(plan, 2);
  const got = plan.tasks.map(t => t.id);
  check('gap_x → r2_gap_x', got[0] === 'r2_gap_x', `got ${got[0]}`);
  check('gap_y → r2_gap_y', got[1] === 'r2_gap_y', `got ${got[1]}`);
}

// ── core auditability contract: round-0 and round-1 id sets are DISJOINT ──
console.log('\n🧪 auditability — round-0 and round-1 ids produce no overlap\n');
{
  const rawIds = ['task_a', 'task_b', 'task_c'];

  const plan0 = makePlan(rawIds);
  executor._namespaceTaskIds(plan0, 0);
  const ids0 = new Set(plan0.tasks.map(t => t.id));

  const plan1 = makePlan(rawIds);
  executor._namespaceTaskIds(plan1, 1);
  const ids1 = new Set(plan1.tasks.map(t => t.id));

  const overlap = [...ids0].filter(id => ids1.has(id));
  check('round-0 ids and round-1 ids are disjoint', overlap.length === 0,
    `overlap: ${JSON.stringify(overlap)}`);
  check('round-0 ids have no r{N}_ prefix', [...ids0].every(id => !/^r\d+_/.test(id)),
    `ids0: ${JSON.stringify([...ids0])}`);
  check('round-1 ids are namespaced (r1_ prefix)', [...ids1].every(id => id.startsWith('r1_')),
    `ids1: ${JSON.stringify([...ids1])}`);
}

// ── dependsOn same-round refs are also namespaced ─────────────────────────
console.log('\n🧪 dependsOn — same-round deps get same prefix\n');
{
  const plan = {
    tasks: [
      { id: 'step_1', dependsOn: [] },
      { id: 'step_2', dependsOn: ['step_1'] }
    ]
  };
  executor._namespaceTaskIds(plan, 1);
  check('step_1 → r1_step_1', plan.tasks[0].id === 'r1_step_1', `got ${plan.tasks[0].id}`);
  check('step_2 → r1_step_2', plan.tasks[1].id === 'r1_step_2', `got ${plan.tasks[1].id}`);
  check('dep step_1 → r1_step_1', plan.tasks[1].dependsOn[0] === 'r1_step_1',
    `got ${plan.tasks[1].dependsOn[0]}`);
}

// ── cross-round deps (from a prior round) are NOT re-prefixed ─────────────
console.log('\n🧪 dependsOn — cross-round deps (prior round ids) are preserved\n');
{
  const plan = {
    tasks: [
      // This task depends on a prior-round task (r0_ does not exist; the raw
      // prior-round id is just 'prior_task' which is NOT in sameRoundIds).
      { id: 'new_task', dependsOn: ['prior_task'] }
    ]
  };
  executor._namespaceTaskIds(plan, 1);
  check('new_task → r1_new_task', plan.tasks[0].id === 'r1_new_task', `got ${plan.tasks[0].id}`);
  check('cross-round dep prior_task unchanged', plan.tasks[0].dependsOn[0] === 'prior_task',
    `got ${plan.tasks[0].dependsOn[0]}`);
}

// ── already-prefixed ids are not double-prefixed ───────────────────────────
console.log('\n🧪 idempotency — already-prefixed ids are not double-prefixed\n');
{
  const plan = {
    tasks: [
      { id: 'r1_task_a', dependsOn: [] }  // LLM already added the prefix
    ]
  };
  executor._namespaceTaskIds(plan, 1);
  check('r1_task_a not doubled to r1_r1_task_a', plan.tasks[0].id === 'r1_task_a',
    `got ${plan.tasks[0].id}`);
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
