#!/usr/bin/env node

/**
 * webContentExtractor must clamp the caller-requested maxLength to a
 * server-side ceiling, so the model can't inject 30k-char page dumps that
 * then get re-billed every agent iteration.
 *
 * Run directly: `node server/tests/web-content-extractor-cap.test.js`.
 */

import { clampMaxLength, MAX_CONTENT_CEILING } from '../tools/webContentExtractor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

check('ceiling is 10000', MAX_CONTENT_CEILING === 10000);
check('requested 30000 clamped to ceiling', clampMaxLength(30000) === 10000);
check('requested 4000 passes through', clampMaxLength(4000) === 4000);
check('missing/invalid falls back to default 5000', clampMaxLength(undefined) === 5000);
check('zero/negative falls back to default', clampMaxLength(0) === 5000);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
