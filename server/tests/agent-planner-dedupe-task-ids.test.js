// Plain-node test (node server/tests/agent-planner-dedupe-task-ids.test.js).
//
// Regression for run wf-exec-8b36a2e7, which HARD-FAILED on round 2 with
// "Invalid plan: Duplicate task ID: r2_reconstruct_thesis_mapping" — discarding
// a finished round-1 deliverable. On a re-plan round the LLM sometimes re-lists
// the same gap-closing task (and self-prefixes round ids, which the namespacer
// already tolerates). A redundant duplicate task is safe to DROP; killing the
// whole run is not.
//
// Fix: the planner now NAMESPACES → DE-DUPES → VALIDATES, so both raw duplicate
// ids AND post-namespace collisions (`foo` + `r2_foo` → both `r2_foo`) are
// repaired before validation rather than aborting the run.
import { PlannerNodeExecutor } from '../services/workflow/executors/PlannerNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

const e = new PlannerNodeExecutor();

// ---- _dedupeTaskIds (pure) ----
{
  const plan = {
    tasks: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'a', title: 'A-dup' }, // duplicate → dropped
      { id: 'c', title: 'C' }
    ]
  };
  const dropped = e._dedupeTaskIds(plan);
  check('returns count of dropped duplicates', dropped === 1, `got ${dropped}`);
  check('keeps first occurrence, drops later dup', plan.tasks.length === 3);
  check('first-seen order preserved', plan.tasks.map(t => t.id).join(',') === 'a,b,c');
  check('kept task is the FIRST occurrence', plan.tasks.find(t => t.id === 'a').title === 'A');
}

{
  const plan = { tasks: [{ id: 'x' }, { id: 'y' }] };
  check('no duplicates → drops nothing', e._dedupeTaskIds(plan) === 0 && plan.tasks.length === 2);
}

{
  check('null plan → 0', e._dedupeTaskIds(null) === 0);
  check('missing tasks → 0', e._dedupeTaskIds({}) === 0);
}

// ---- The actual failure: raw duplicate already-prefixed ids on round 2 ----
{
  const plan = {
    tasks: [
      { id: 'r2_reconstruct_thesis_mapping', title: 'first' },
      { id: 'r2_reconstruct_thesis_mapping', title: 'second (dup)' }
    ]
  };
  e._namespaceTaskIds(plan, 2); // already prefixed → no-op
  e._dedupeTaskIds(plan);
  check('raw duplicate prefixed ids collapse to one', plan.tasks.length === 1);
  check('validation now passes', e._validatePlan(plan, 10) === null);
}

// ---- Post-namespace collision: `foo` + `r2_foo` both become `r2_foo` ----
{
  const plan = {
    tasks: [
      { id: 'reconstruct_thesis_mapping', title: 'unprefixed' },
      { id: 'r2_reconstruct_thesis_mapping', title: 'prefixed' },
      { id: 'verify_dates', title: 'distinct' }
    ]
  };
  e._namespaceTaskIds(plan, 2); // first → r2_reconstruct_thesis_mapping (collides), verify_dates → r2_verify_dates
  const dropped = e._dedupeTaskIds(plan);
  check('post-namespace collision is de-duped', dropped === 1, `dropped ${dropped}`);
  check('distinct task survives', plan.tasks.some(t => t.id === 'r2_verify_dates'));
  check('collided pair reduced to one', plan.tasks.filter(t => t.id === 'r2_reconstruct_thesis_mapping').length === 1);
  check('validation passes after repair', e._validatePlan(plan, 10) === null);
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
