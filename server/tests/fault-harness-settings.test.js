// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The settings of the fault harness (`server/tests/faults/settings.mjs`) and
 * what the nightly workflow gives the fault tier.
 *
 * The fault tier runs at night and on a pull request with the label
 * `run-faults`, never in the pull request gate. A difference between the
 * environment of that job and what the fault tests expect would show only
 * there, as a red night. This file is in the pull request tier and pins both
 * sides: the variables of the job, and what the harness does with them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASE_TIMEOUT_MS,
  CONTENTS_PREFIX,
  EXIT_TIMEOUT_MS,
  KEEP_VARIABLE,
  LOOK_TIMEOUT_MS,
  POLL_MS,
  SERVER_LOG,
  SETUP_TIMEOUT_MS,
  START_TIMEOUT_MS,
  afterStop,
  keepsContents
} from './faults/settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const WORKFLOW = read('.github', 'workflows', 'nightly.yml');

/** The text of one job of a workflow: from its name to the next job. */
function jobText(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `the job ${job} is in the workflow`);
  const next = /\n {2}[\w-]+:\n/.exec(workflow.slice(start + 1));
  return workflow.slice(start, next ? start + 1 + next.index : undefined);
}

/** The variables of the `env:` block of a job, comments left out. */
function jobEnv(text) {
  const block = /\n {4}env:\n((?: {6}[^\n]*\n|\n)+)/.exec(text);
  assert.ok(block, 'the job has an env block');
  const env = {};
  for (const line of block[1].split('\n')) {
    const entry = /^ {6}([A-Z][A-Z0-9_]*): (.*)$/.exec(line);
    if (entry) env[entry[1]] = entry[2].replace(/^'(.*)'$/, '$1');
  }
  return env;
}

test('the contents of a stack are kept only when the variable is exactly 1', () => {
  assert.equal(KEEP_VARIABLE, 'KEEP_FAULT_CONTENTS');
  assert.equal(keepsContents({ KEEP_FAULT_CONTENTS: '1' }), true);
  assert.equal(keepsContents({}), false);
  assert.equal(keepsContents({ KEEP_FAULT_CONTENTS: '' }), false);
  assert.equal(keepsContents({ KEEP_FAULT_CONTENTS: '0' }), false);
  assert.equal(keepsContents({ KEEP_FAULT_CONTENTS: 'true' }), false);
});

test('a stopped stack removes the directory it made, or keeps it with the log; never the directory of another stack', () => {
  assert.deepEqual(afterStop({ keep: false, ownsContents: true }), { log: false, remove: true });
  assert.deepEqual(afterStop({ keep: true, ownsContents: true }), { log: true, remove: false });
  // Started on the directory of another stack: that one decides what becomes of it.
  assert.deepEqual(afterStop({ keep: false, ownsContents: false }), { log: false, remove: false });
  assert.deepEqual(afterStop({ keep: true, ownsContents: false }), { log: true, remove: false });
});

test('the nightly job gives the fault tier the variables this file knows, and uploads the log the harness writes', () => {
  const faults = jobText(WORKFLOW, 'faults');
  // A variable that is added here changes what the fault tests run with. Add it
  // to this list in the same change, and run the tier with it once
  // (docs/run-testing.md): `npm run test:faults` on a developer's machine does
  // not have it.
  assert.deepEqual(jobEnv(faults), {
    CI: 'true',
    JWT_SECRET: 'ci-nightly-faults-test-secret',
    KEEP_FAULT_CONTENTS: '1'
  });
  assert.equal(keepsContents(jobEnv(faults)), true, 'the job keeps the contents directories');
  assert.match(faults, /run: npm run test:faults\n/);
  assert.ok(
    faults.includes(`path: ${CONTENTS_PREFIX}*/${SERVER_LOG}\n`),
    'the upload names the file a stack that keeps its contents writes'
  );
});

test('no fault test asserts that a contents directory is gone without asking what the run keeps', () => {
  // With KEEP_FAULT_CONTENTS=1, as in the nightly job, a stack leaves its
  // directory. A test that expects it gone is green on a developer's machine
  // and red every night.
  const dir = path.join(root, 'server', 'tests', 'faults');
  const gone = /existsSync\(\s*(\w+)\.contentsPath\s*\)\s*,\s*false/g;
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.fault.test.js'));
  assert.ok(files.length >= 3, 'the fault tests were found');
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const match of source.matchAll(gone)) {
      const stack = match[1];
      const decided =
        source.includes(`${stack}.keepsContents`) ||
        new RegExp(`${stack} = await startStack\\(\\{[^}]*keepContents: false`).test(source);
      assert.ok(
        decided,
        `${name}: expects the directory of "${stack}" to be gone; ` +
          `ask ${stack}.keepsContents first, or start the stack with keepContents: false`
      );
    }
  }
});

test('a setup hook outlasts the longest start and the stop of a start that failed', () => {
  // startStack gives up after START_TIMEOUT_MS and then stops what it started:
  // the server (at most EXIT_TIMEOUT_MS until it is gone) and the helpers in
  // its own process. A hook that gave up before that would leave a server
  // running that no `after` hook knows.
  assert.ok(
    SETUP_TIMEOUT_MS >= START_TIMEOUT_MS + 2 * EXIT_TIMEOUT_MS,
    `${SETUP_TIMEOUT_MS} ms for the hook, ${START_TIMEOUT_MS} + 2 x ${EXIT_TIMEOUT_MS} ms for the start`
  );
  // One look at a server ends well before any wait that is made of looks.
  assert.ok(POLL_MS < LOOK_TIMEOUT_MS && LOOK_TIMEOUT_MS < EXIT_TIMEOUT_MS);
  assert.ok(LOOK_TIMEOUT_MS * 10 <= CASE_TIMEOUT_MS);
});

test('the harness takes its limits and names from the settings, not from numbers of its own', () => {
  const harness = read('server', 'tests', 'faults', 'harness.mjs');
  assert.match(harness, /from '\.\/settings\.mjs';/);
  assert.doesNotMatch(harness, /process\.env\.KEEP_FAULT_CONTENTS/);
  assert.doesNotMatch(harness, /'faults-server\.log'/);
  assert.doesNotMatch(harness, /const \w+_TIMEOUT_MS = /);
});
