// server/tests/agent-review-injection.test.js
import { applyReviewSettings } from '../routes/agents/runs.js';
import { resolveReviewSettings } from '../agents/profile/reviewSettings.js';
let failures = 0;
function check(l, c, d) {
  if (!c) failures++;
  console.log(`${c ? '✅' : '❌'} ${l}`);
  if (!c && d) console.log('   ' + d);
}
function run() {
  const wf = {
    nodes: [
      { id: 'planner', type: 'planner', config: {} },
      { id: 'verify', type: 'verifier', config: { criteria: 'orig' } },
      { id: 'end', type: 'end', config: {} }
    ]
  };
  const resolved = resolveReviewSettings({ strictness: 'strict' });
  applyReviewSettings(wf, resolved);
  const v = wf.nodes.find(n => n.id === 'verify');
  check('maxRetries injected', v.config.maxRetries === 6, JSON.stringify(v.config));
  check('stallLimit injected', v.config.stallLimit === 2);
  check('requirePass injected', v.config.requirePass === true);
  check('acceptPartial injected false', v.config.acceptPartial === false);
  check('criteria NOT overwritten when no override', v.config.criteria === 'orig');
  // with criteria override
  applyReviewSettings(
    wf,
    resolveReviewSettings({ strictness: 'lenient', criteria: 'cites optional' })
  );
  check(
    'criteria overwritten when override set',
    wf.nodes.find(n => n.id === 'verify').config.criteria === 'cites optional'
  );
  check(
    'non-verifier nodes untouched',
    wf.nodes.find(n => n.id === 'planner').config.maxRetries === undefined
  );
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run();
