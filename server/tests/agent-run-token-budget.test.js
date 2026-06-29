// Plain-node test (node server/tests/agent-run-token-budget.test.js).
//
// Regression for the missing token circuit-breaker in phased agent runs
// (run wf-exec-f33f80fc burned 3.29M input tokens before a 30-min wall-clock
// timeout — no token guard ever tripped). Per-task workers run in CHILD
// sub-workflows; their token usage never bubbled back to the parent's
// `_budget`, so `_budget.total` showed 266K while the true cost was 3.29M.
// `maxTokensPerRun` could only ever see a single child's budget.
//
// Fix: on planner bubble-up, recompute the parent `_budget` from the merged
// `_stepLogs` (the authoritative per-step token records that DO bubble up).
// This makes `_budget` reflect true cumulative cost; because `childInitial`
// copies `_budget` into each round, the in-task `maxTokensPerRun` guard then
// sees the running total and can abort.
import { PlannerNodeExecutor } from '../services/workflow/executors/PlannerNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

const e = new PlannerNodeExecutor();

// ---- _aggregateBudgetFromStepLogs ----
const stepLogs = {
  'nelms-bio': { tokens: { input: 32884, output: 2469 } },
  'intrafind-ihub': { tokens: { input: 220446, output: 3726 } },
  planner_r1: { tokens: null }, // planner has no token record — must be skipped
  r3_verify_market_guide_authors: { tokens: { input: 481724, output: 2481 } },
  weird: {}, // no tokens key — must be skipped
  alsoWeird: { tokens: { input: 'x' } } // non-numeric — treated as 0
};

const agg = e._aggregateBudgetFromStepLogs(stepLogs);
check('sums input across step logs', agg.input === 32884 + 220446 + 481724, `got ${agg.input}`);
check('sums output across step logs', agg.output === 2469 + 3726 + 2481, `got ${agg.output}`);
check('total = input + output', agg.total === agg.input + agg.output, `got ${agg.total}`);

check('empty object → zeros', JSON.stringify(e._aggregateBudgetFromStepLogs({})) === JSON.stringify({ input: 0, output: 0, total: 0 }));
check('null → zeros', e._aggregateBudgetFromStepLogs(null).total === 0);
check('undefined → zeros', e._aggregateBudgetFromStepLogs(undefined).total === 0);

// ---- Realistic: the actual failed run's totals ----
// 20 task step logs from wf-exec-f33f80fc summed to 3,294,566 input. Spot-check
// the helper reaches into the millions, i.e. far past the 266K _budget that the
// guard saw.
const bigLogs = {};
for (let i = 0; i < 20; i++) bigLogs[`t${i}`] = { tokens: { input: 165000, output: 3000 } };
const bigAgg = e._aggregateBudgetFromStepLogs(bigLogs);
check('aggregates millions of input tokens', bigAgg.input === 165000 * 20, `got ${bigAgg.input}`);
check('would exceed a 1M maxTokensPerRun cap', bigAgg.total > 1_000_000, `got ${bigAgg.total}`);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
