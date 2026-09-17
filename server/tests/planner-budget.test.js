#!/usr/bin/env node

/**
 * Unit tests for PlannerNodeExecutor._checkAndUpdatePlanBudget.
 *
 * Per-node `maxTasks` bounds one planner call; without a global counter,
 * nested planners (planner → sub-workflow → planner) multiply unbounded.
 * The budget lives in state.data._planBudget and is enforced before
 * materializing a sub-workflow.
 *
 * Run directly: `node server/tests/planner-budget.test.js`.
 */

import { PlannerNodeExecutor } from '../services/workflow/executors/PlannerNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const executor = new PlannerNodeExecutor();

console.log('🧪 plan budget — accepts plans within limit\n');
{
  const state = { data: {} };
  const plan = { tasks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })) };
  const err = executor._checkAndUpdatePlanBudget(plan, state, { id: 'planner' });
  check('returns null when budget has room', err === null, `got: ${err}`);
  check(
    'budget recorded with used=10, max=100',
    state.data._planBudget?.used === 10 && state.data._planBudget?.max === 100,
    `got ${JSON.stringify(state.data._planBudget)}`
  );
}

console.log('\n🧪 plan budget — accumulates across multiple planners\n');
{
  const state = { data: { _planBudget: { used: 80, max: 100 } } };
  const plan = { tasks: Array.from({ length: 15 }, (_, i) => ({ id: `t${i}` })) };
  const err = executor._checkAndUpdatePlanBudget(plan, state, { id: 'planner-2' });
  check('returns null when accumulated total still fits', err === null);
  check(
    'budget accumulates to 95',
    state.data._planBudget?.used === 95,
    `got ${state.data._planBudget?.used}`
  );
}

console.log('\n🧪 plan budget — rejects when over the cap\n');
{
  const state = { data: { _planBudget: { used: 95, max: 100 } } };
  const plan = { tasks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })) };
  const err = executor._checkAndUpdatePlanBudget(plan, state, { id: 'planner-3' });
  check('returns an error message', typeof err === 'string' && err.length > 0);
  check('error mentions the limit', typeof err === 'string' && err.includes('100'), `got: ${err}`);
  check(
    'budget is NOT incremented when rejection happens',
    state.data._planBudget?.used === 95,
    `got ${state.data._planBudget?.used}`
  );
}

console.log('\n🧪 plan budget — handles missing state.data gracefully\n');
{
  const state = {};
  const plan = { tasks: [{ id: 't1' }, { id: 't2' }] };
  const err = executor._checkAndUpdatePlanBudget(plan, state, { id: 'planner' });
  check('initializes state.data when missing', err === null);
  check('initializes _planBudget when missing', state.data?._planBudget?.used === 2);
}

console.log('\n🧪 plan budget — defends against nested planner attack\n');
{
  // Simulate: parent planner emits 10 tasks, each task's sub-workflow has
  // its own planner. The budget is shared via state.data, so even though
  // each individual call is "only 10 tasks", the total stops climbing
  // once the global budget is hit.
  const sharedState = { data: {} };
  let acceptedBatches = 0;
  let rejectedBatches = 0;
  for (let batch = 0; batch < 20; batch++) {
    const plan = { tasks: Array.from({ length: 10 }, (_, i) => ({ id: `b${batch}-t${i}` })) };
    const err = executor._checkAndUpdatePlanBudget(plan, sharedState, { id: 'planner' });
    if (err) rejectedBatches += 1;
    else acceptedBatches += 1;
  }
  check(
    'accepts the first batches that fit (10 × 10 = 100)',
    acceptedBatches === 10,
    `accepted ${acceptedBatches}, rejected ${rejectedBatches}`
  );
  check(
    'rejects the remaining batches',
    rejectedBatches === 10,
    `accepted ${acceptedBatches}, rejected ${rejectedBatches}`
  );
  check(
    'final used count never exceeds max',
    sharedState.data._planBudget.used <= sharedState.data._planBudget.max,
    `used ${sharedState.data._planBudget.used} / max ${sharedState.data._planBudget.max}`
  );
}

console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
