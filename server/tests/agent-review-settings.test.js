// server/tests/agent-review-settings.test.js
import { resolveReviewSettings } from '../agents/profile/reviewSettings.js';
let failures = 0;
function check(l, c, d) {
  if (!c) failures++;
  console.log(`${c ? '✅' : '❌'} ${l}`);
  if (!c && d) console.log('   ' + d);
}
function run() {
  // Defaults: no review block → balanced (today's behavior).
  const bal = resolveReviewSettings(undefined);
  check('default → balanced', bal.strictness === 'balanced');
  check('balanced maxRetries 4', bal.maxRetries === 4, JSON.stringify(bal));
  check('balanced stallLimit 2', bal.stallLimit === 2);
  check(
    'balanced accepts partial after stall, not immediately',
    bal.acceptPartial === false && bal.acceptPartialAfterStall === true && bal.requirePass === false
  );

  const len = resolveReviewSettings({ strictness: 'lenient' });
  check('lenient maxRetries 2 / stall 1', len.maxRetries === 2 && len.stallLimit === 1);
  check(
    'lenient accepts partial immediately',
    len.acceptPartial === true && len.requirePass === false
  );

  const strict = resolveReviewSettings({ strictness: 'strict' });
  check('strict maxRetries 6 / stall 2', strict.maxRetries === 6 && strict.stallLimit === 2);
  check(
    'strict requires pass',
    strict.requirePass === true &&
      strict.acceptPartial === false &&
      strict.acceptPartialAfterStall === false
  );

  // Overrides win when defined.
  const ov = resolveReviewSettings({
    strictness: 'strict',
    maxRounds: 8,
    stallLimit: 3,
    criteria: 'be lenient on citations'
  });
  check('maxRounds override → maxRetries', ov.maxRetries === 8);
  check('stallLimit override', ov.stallLimit === 3);
  check('criteria override carried', ov.criteria === 'be lenient on citations');

  // Unset overrides do NOT clobber the preset.
  const noov = resolveReviewSettings({ strictness: 'lenient' });
  check('no maxRounds override → preset value', noov.maxRetries === 2);
  check('criteria undefined when unset', noov.criteria === undefined);

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run();
