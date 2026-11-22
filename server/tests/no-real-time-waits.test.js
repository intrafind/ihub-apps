// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * No test of the agents epic waits on real time (#3786): not for a lease, a
 * due time or a limit. A test that sleeps is slow when it passes and flaky when
 * the machine is busy.
 *
 * The test directories and helpers that came with the epic are searched for
 * sleeps and for timers with a literal delay of one second or more. A test
 * that needs time to pass moves a clock: `helpers/fakeClock.js` for code that
 * takes its clock as a parameter, the fake timers of the test runner for code
 * that calls `setTimeout` itself (docs/run-testing.md).
 *
 * A directory that does not exist yet is skipped, so the list can name the
 * directories of later pull requests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Directories and files under `server/tests/`, searched with everything below them. A test file
 * for runs at the top level of `server/tests/` is added here by name.
 *
 * This file is not in the list: its samples for the detector are sleeps written as text, and the
 * detector reads text.
 */
const SEARCHED = [
  'golden',
  'faults',
  'run',
  'runExecutor',
  'followups',
  'helpers/scriptedModel.js',
  'helpers/fakeClock.js',
  'helpers/scheduledTaskHarness.js',
  'scriptedModel.test.js',
  'fakeClock.test.js',
  'appToolsGateway.characterization.test.js',
  'appToolsGateway.test.js',
  'run-server-tests-runner.test.js',
  'killPoint.test.js',
  'killPoint-inventory.test.js',
  'testTools.test.js',
  'test-counter.test.js',
  'nightly-red-issue.test.js',
  'fault-harness-settings.test.js',
  'helpers/runAccessHarness.js',
  'runAccessIntent.test.js',
  'steerApproval.test.js',
  'runHumanEventsRoute.test.js',
  'routeInventory.test.js',
  'chatTurnStart.test.js',
  'fixtures/scriptedModel',
  'fixtures/sideBySide'
];

/** One second: the shortest literal delay that counts as waiting on real time. */
const LIMIT_MS = 1000;

const RULES = [
  { name: 'a sleep', pattern: /\b(?:sleep|delay|wait)\s*\(\s*[\d_]+/g },
  { name: 'await sleep()', pattern: /\bawait\s+sleep\s*\(/g },
  { name: 'the promise timers of Node', pattern: /['"](?:node:)?timers\/promises['"]/g },
  {
    name: 'a promise that resolves on a real timer',
    pattern: /new\s+Promise\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*(?:\{\s*)?setTimeout\s*\(/g
  }
];

/** `setTimeout(fn, 1500)`, `setInterval(fn, 60_000)`: a timer whose delay is a literal number. */
const LITERAL_TIMER =
  /\b(setTimeout|setInterval)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?),\s*([\d_]+)\s*\)/g;

/**
 * What in a source text waits on real time.
 *
 * @param {string} source
 * @returns {Array<{line: number, what: string}>}
 */
export function findRealTimeWaits(source) {
  // Comments describe waits without making them.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:'"`\\])\/\/[^\n]*/g,
      (match, before) => before + ' '.repeat(match.length - before.length)
    );
  const lineOf = index => code.slice(0, index).split('\n').length;
  const found = [];
  for (const { name, pattern } of RULES) {
    for (const match of code.matchAll(pattern))
      found.push({ line: lineOf(match.index), what: name });
  }
  for (const match of code.matchAll(LITERAL_TIMER)) {
    const delay = Number(match[3].replaceAll('_', ''));
    if (delay >= LIMIT_MS) {
      found.push({
        line: lineOf(match.index),
        what: `${match[1]} with a literal delay of ${delay} ms`
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function filesUnder(entry) {
  const full = path.join(testsDir, entry);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [full];
  return fs
    .readdirSync(full, { recursive: true, withFileTypes: true })
    .filter(file => file.isFile() && /\.(?:js|mjs|cjs)$/.test(file.name))
    .map(file => path.join(file.parentPath, file.name));
}

test('the detector finds sleeps and long literal timers, and leaves the rest alone', () => {
  const whats = source => findRealTimeWaits(source).map(found => found.what);
  assert.deepEqual(whats('await sleep(50);'), ['a sleep', 'await sleep()']);
  assert.deepEqual(whats('await sleep(pollMs);'), ['await sleep()']);
  assert.deepEqual(whats('await delay(2000);'), ['a sleep']);
  assert.deepEqual(whats("import { setTimeout as pause } from 'node:timers/promises';"), [
    'the promise timers of Node'
  ]);
  assert.deepEqual(whats('await new Promise(resolve => setTimeout(resolve, 20));'), [
    'a promise that resolves on a real timer'
  ]);
  assert.deepEqual(whats('await new Promise((r) => { setTimeout(r, 1500); });'), [
    'a promise that resolves on a real timer',
    'setTimeout with a literal delay of 1500 ms'
  ]);
  assert.deepEqual(whats('setTimeout(() => done(new Error("late")), 60_000);'), [
    'setTimeout with a literal delay of 60000 ms'
  ]);
  assert.deepEqual(whats('setInterval(tick, 1000)'), [
    'setInterval with a literal delay of 1000 ms'
  ]);
  assert.deepEqual(whats('const t = setTimeout(\n  () => finish(a, b),\n  5000\n);'), [
    'setTimeout with a literal delay of 5000 ms'
  ]);

  // Allowed: a short timer, a delay that is not a literal, a clock that is moved by hand.
  assert.deepEqual(whats('setTimeout(tick, 50);'), []);
  assert.deepEqual(whats('setTimeout(tick, DELTA_COALESCE_MS);'), []);
  assert.deepEqual(whats('clock.setTimer(send, 60_000); clock.advance(180_000);'), []);
  assert.deepEqual(whats('llmClient.sleep = async () => {};'), []);
  assert.deepEqual(
    whats('// await sleep(5000) would be wrong here\n/* setTimeout(x, 9000) */'),
    []
  );
  assert.equal(findRealTimeWaits('ok();\nok();\nawait sleep(1);')[0].line, 3);
});

test('no test or helper of the agents epic waits on real time', () => {
  const files = SEARCHED.flatMap(filesUnder);
  assert.ok(files.length > 10, 'the search found the golden directory');
  const found = [];
  for (const file of files) {
    for (const wait of findRealTimeWaits(fs.readFileSync(file, 'utf8'))) {
      found.push(`${path.relative(testsDir, file)}:${wait.line} ${wait.what}`);
    }
  }
  assert.deepEqual(
    found,
    [],
    'Move a clock instead of waiting: helpers/fakeClock.js, or the fake timers of the test runner.'
  );
});
