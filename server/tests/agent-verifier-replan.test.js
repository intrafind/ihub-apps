// server/tests/agent-verifier-replan.test.js
import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';
let failures = 0;
function check(l, c, d) { if (!c) failures++; console.log(`${c ? '✅' : '❌'} ${l}`); if (!c && d) console.log('   ' + d); }
async function run() {
  const v = new VerifierNodeExecutor();
  // interpretResult is pure; assert a conclusive FAIL-with-gaps is a retry.
  const r = v.interpretResult({ verdict: 'FAIL', failures: ['Wrong date for X'] }, { mode: 'adversarial' });
  check('conclusive FAIL with gaps', r.conclusive === true && r.passed === false);
  // The execute() retry path is covered by the existing adversarial suite; here
  // we assert the helper that builds the replan state updates.
  const upd = v.buildReplanUpdates({ data: { _reviewRound: 1 } }, ['Wrong date for X']);
  check('advances the review round', upd._reviewRound === 2);
  check('carries the gaps for the planner', JSON.stringify(upd._lastReviewGaps) === JSON.stringify(['Wrong date for X']));
  const first = v.buildReplanUpdates({ data: {} }, ['g']);
  check('first retry → round 1', first._reviewRound === 1);
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
