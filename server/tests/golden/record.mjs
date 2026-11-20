#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Record golden cases in a process of its own and write the comparable part
 * of each record as canonical JSON. `determinism.test.js` uses it for the
 * recording "in a second process"; by hand it shows what a case records:
 *
 *   node server/tests/golden/record.mjs --out-dir /tmp/records harness/chat-turn-tool
 *   node server/tests/golden/record.mjs --out-dir /tmp/records --all
 *
 * The files are `<out-dir>/<surface>/<case>.json`. Nothing under `__goldens__`
 * is touched: a golden is written by `UPDATE_GOLDENS=1` and the golden test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './normalise.js';
import { comparable } from './assertGolden.js';
import { recordCase } from './harness.js';
import { CASES, findCase } from './cases.js';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out-dir');
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
const ids = args.filter((arg, index) => !arg.startsWith('--') && index !== outIndex + 1);
const all = args.includes('--all');

if (!outDir || (!all && ids.length === 0)) {
  console.error(
    'usage: node server/tests/golden/record.mjs --out-dir <dir> (--all | <surface>/<case> ...)'
  );
  process.exit(2);
}

const cases = all ? CASES : ids.map(findCase);
for (const goldenCase of cases) {
  const record = await recordCase(goldenCase);
  const file = path.join(outDir, goldenCase.surface, `${goldenCase.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canonicalJson(comparable(record)));
  console.error(`recorded ${goldenCase.id}`);
}
// Background timers of the server modules would keep the process alive.
process.exit(0);
