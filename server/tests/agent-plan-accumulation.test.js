// Plain-node test (NOT jest — PlannerNodeExecutor's import graph pulls in uuid).
// Regression guard for: on a review-loop re-plan round, planCreated.tasks was
// OVERWRITTEN with only the current round's tasks, so round-0 tasks vanished
// from the run-detail Tasks panel even though their results/logs persisted in
// _taskResults/_stepLogs. The planner must ACCUMULATE planCreated.tasks across
// rounds (matching how _taskResults/_stepLogs are already merged on bubble-up).
import { PlannerNodeExecutor } from '../services/workflow/executors/PlannerNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

async function run() {
  const p = new PlannerNodeExecutor();

  // Round 0: no prior plan yet.
  const round0 = [
    { id: 'bio-career-research', title: 'Biography' },
    { id: 'ai-expertise-research', title: 'AI expertise' }
  ];
  const m0 = p._mergePlanTasks(undefined, round0);
  check(
    'round 0: empty prior → just the new tasks',
    m0.length === 2 && m0[0].id === 'bio-career-research'
  );

  // Round 1: prior holds round-0 tasks, incoming holds namespaced gap tasks.
  const round1 = [
    { id: 'r1_verify-dates', title: 'Verify dates' },
    { id: 'r1_final-report-revision', title: 'Revise report' }
  ];
  const m1 = p._mergePlanTasks(round0, round1);
  check('round 1: keeps round-0 tasks AND adds round-1 tasks', m1.length === 4, `got ${m1.length}`);
  check(
    'round 1: round-0 tasks come first (order preserved)',
    m1[0].id === 'bio-career-research' && m1[1].id === 'ai-expertise-research'
  );
  check(
    'round 1: round-1 tasks appended after',
    m1[2].id === 'r1_verify-dates' && m1[3].id === 'r1_final-report-revision'
  );

  // Idempotency: re-merging the same round (the planner writes planCreated more
  // than once per execution — early persist + bubble-up) must not duplicate.
  const again = p._mergePlanTasks(round0, round1);
  const reMerged = p._mergePlanTasks(round0, round1);
  check(
    'idempotent: same prior+incoming → same length, no dupes',
    again.length === 4 && reMerged.length === 4
  );

  // Same id in both: incoming refreshes metadata but keeps first-seen position.
  const refreshed = p._mergePlanTasks(
    [{ id: 'task_a', title: 'old', status: 'open' }],
    [{ id: 'task_a', title: 'new', status: 'done' }]
  );
  check('same id deduped (no duplicate row)', refreshed.length === 1);
  check(
    'same id: incoming metadata wins',
    refreshed[0].title === 'new' && refreshed[0].status === 'done'
  );

  // Defensive: non-array inputs never throw.
  check(
    'non-array inputs are safe',
    Array.isArray(p._mergePlanTasks(null, null)) && p._mergePlanTasks(null, null).length === 0
  );

  // Tasks without an id are dropped (can't be keyed/rendered reliably).
  const withBad = p._mergePlanTasks([{ id: 'ok' }], [{ title: 'no id' }, { id: 'ok2' }]);
  check('tasks without id are skipped', withBad.length === 2 && withBad.every(t => t.id));

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
