// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A golden is only worth comparing with when recording is deterministic. Every
 * case is recorded twice in this process and once in a second process, and the
 * three records must be equal byte for byte.
 *
 * Two recordings in one process find state that leaks from one run into the
 * next (a counter, a cache, an id that is reused). The second process finds
 * what depends on the process: start-up order, the working directory. It also
 * runs on another date (`shiftClock.mjs`): 400 days and 7 hours later, so in
 * another year, month, weekday and hour. A date the normaliser does not know
 * about fails here, not in CI on the first day of the next month.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './normalise.js';
import { comparable, diffPaths } from './assertGolden.js';
import { recordCase } from './harness.js';
import { CASES } from './cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLOCK_SHIFT_MS = 400 * 24 * 60 * 60 * 1000 + 7 * 60 * 60 * 1000;
let secondProcessDir;
let secondProcess;

/** Fail with the paths that differ, not with two walls of JSON. */
function assertSameBytes(actual, expected, message) {
  if (actual === expected) return;
  const differences = diffPaths(JSON.parse(expected), JSON.parse(actual))
    .slice(0, 20)
    .map(
      d =>
        `  ${d.path}\n    first: ${JSON.stringify(d.expected)}\n    other: ${JSON.stringify(d.actual)}`
    );
  assert.fail(`${message}:\n${differences.join('\n')}`);
}

before(() => {
  secondProcessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-golden-second-'));
  const env = { ...process.env, NODE_ENV: 'test', GOLDEN_CLOCK_SHIFT_MS: String(CLOCK_SHIFT_MS) };
  // The child is a plain script, not a nested test run.
  delete env.NODE_TEST_CONTEXT;
  secondProcess = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(here, 'shiftClock.mjs'),
      path.join(here, 'record.mjs'),
      '--out-dir',
      secondProcessDir,
      '--all'
    ],
    // Another working directory than this process, on purpose.
    { cwd: os.tmpdir(), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
});

after(() => {
  if (secondProcessDir) fs.rmSync(secondProcessDir, { recursive: true, force: true });
});

test('the second process recorded every case', () => {
  assert.equal(
    secondProcess.status,
    0,
    `record.mjs failed:\n${secondProcess.stderr?.slice(-4000)}`
  );
});

for (const goldenCase of CASES) {
  test(`${goldenCase.id} records the same bytes twice in one process and once in a second`, async () => {
    const first = canonicalJson(comparable(await recordCase(goldenCase)));
    const second = canonicalJson(comparable(await recordCase(goldenCase)));
    assertSameBytes(second, first, 'the second recording in this process differs from the first');
    const file = path.join(secondProcessDir, goldenCase.surface, `${goldenCase.name}.json`);
    assert.ok(fs.existsSync(file), `the second process wrote no record for ${goldenCase.id}`);
    assertSameBytes(
      fs.readFileSync(file, 'utf8'),
      first,
      'the recording of the second process differs from the first of this process'
    );
  });
}
