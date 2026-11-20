// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The difference list: every golden that changed in a pull request is named by
 * a row of `differences.json`, with the parts of the record that changed, the
 * request projection (`modelRequests`, `toolSchemas`) included.
 *
 * The last test checks this repository. It needs the commit the pull request
 * started from; on a checkout without it (a shallow clone, as in the unit test
 * workflow) it is skipped and says so. The end-to-end workflow runs it with
 * `GOLDEN_REQUIRE_BASE=1` on a full clone, where a missing base is a failure.
 *
 * This file imports nothing of the server, so it runs without `npm install`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DIFFERENCES_PATH,
  GOLDENS_PATH,
  REPO_ROOT,
  changedParts,
  checkChangedGoldens,
  parseDifferenceList,
  readChanges,
  resolveBase,
  validateRows
} from './differenceList.js';

const row = (overrides = {}) => ({
  id: 'tool-error-text',
  title: 'The text of a tool error names the tool',
  state: 'proposed',
  decision: 'Accepted: the new text is what every surface now sends.',
  goldens: ['chat/one-tool.json'],
  parts: ['envelopes', 'ledger'],
  pr: 'tool-runner',
  signedBy: null,
  signedOn: null,
  ...overrides
});

test('a missing or empty difference list has no rows; a list is an object with rows', () => {
  assert.deepEqual(parseDifferenceList(null), []);
  assert.deepEqual(parseDifferenceList(undefined), []);
  assert.deepEqual(parseDifferenceList('  '), []);
  assert.deepEqual(parseDifferenceList(JSON.stringify({ rows: [row()] })), [row()]);
  assert.throws(() => parseDifferenceList('[]'), /must be an object with a "rows" array/);
});

test('a well-formed row passes; each rule of a row is checked', () => {
  assert.deepEqual(validateRows([row()]), []);
  assert.deepEqual(
    validateRows([row({ state: 'signed', signedBy: 'Intradmin', signedOn: '2026-11-20' })]),
    []
  );
  const problemsOf = overrides => validateRows([row(overrides)]).join('\n');
  assert.match(problemsOf({ id: 'Tool Error' }), /id must match/);
  assert.match(problemsOf({ title: '' }), /title must be a non-empty text/);
  assert.match(problemsOf({ decision: undefined }), /decision must be a non-empty text/);
  assert.match(problemsOf({ pr: ' ' }), /pr must be a non-empty text/);
  assert.match(problemsOf({ goldens: [] }), /goldens must be a non-empty list/);
  assert.match(problemsOf({ parts: 'ledger' }), /parts must be a non-empty list/);
  assert.match(problemsOf({ goldens: ['../x.json'] }), /must be a \.json path relative to/);
  assert.match(problemsOf({ goldens: ['chat/one-tool'] }), /must be a \.json path relative to/);
  assert.match(problemsOf({ state: 'done' }), /state must be one of proposed, signed/);
  assert.match(problemsOf({ state: 'signed' }), /names who signed it/);
  assert.match(problemsOf({ state: 'signed', signedBy: 'x', signedOn: 'today' }), /YYYY-MM-DD/);
  assert.match(
    problemsOf({ signedBy: 'Intradmin' }),
    /a proposed row has signedBy and signedOn set to null/
  );
  assert.match(problemsOf({ approved: true }), /unknown field "approved"/);
  assert.match(validateRows([row(), row()]).join('\n'), /the id is used twice/);
  assert.match(validateRows(['x']).join('\n'), /is not an object/);
});

test('changedParts names the top-level parts of a golden that differ', () => {
  const before = {
    envelopes: [1],
    ledger: [{ a: 1 }],
    modelRequests: [{ roles: ['user'] }],
    title: 't'
  };
  assert.deepEqual(changedParts(before, structuredClone(before)), []);
  assert.deepEqual(
    changedParts(before, {
      ...before,
      ledger: [{ a: 2 }],
      modelRequests: [{ roles: ['system', 'user'] }]
    }),
    ['ledger', 'modelRequests']
  );
  assert.deepEqual(changedParts(before, { ...before, evidence: {} }), ['evidence']);
  assert.deepEqual(changedParts(before, null), ['(deleted)']);
  assert.deepEqual(changedParts(null, before), [], 'a new golden is not a change');
});

test('a changed golden without a row is reported', () => {
  const changes = [
    { golden: 'chat/one-tool.json', before: { envelopes: [1] }, after: { envelopes: [2] } }
  ];
  const problems = checkChangedGoldens({ changes, rows: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /chat\/one-tool\.json changed \(envelopes\) and no row/);
  // A row about another golden does not help.
  assert.equal(
    checkChangedGoldens({ changes, rows: [row({ goldens: ['chat/plain.json'] })] }).length,
    1
  );
});

test('a row that names the golden and the changed parts is enough', () => {
  const changes = [
    {
      golden: 'chat/one-tool.json',
      before: { envelopes: [1], ledger: [1], usageRecords: [] },
      after: { envelopes: [2], ledger: [2], usageRecords: [] }
    }
  ];
  assert.deepEqual(checkChangedGoldens({ changes, rows: [row()] }), []);
  // Two rows can share the parts of one golden.
  assert.deepEqual(
    checkChangedGoldens({
      changes,
      rows: [row({ parts: ['envelopes'] }), row({ id: 'second', parts: ['ledger'] })]
    }),
    []
  );
});

test('the request projection needs a row like every other part', () => {
  const changes = [
    {
      golden: 'chat/one-tool.json',
      before: { envelopes: [1], modelRequests: [{ systemPromptHash: 'a' }], toolSchemas: { x: 1 } },
      after: { envelopes: [1], modelRequests: [{ systemPromptHash: 'b' }], toolSchemas: { y: 1 } }
    }
  ];
  const problems = checkChangedGoldens({ changes, rows: [row()] });
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /changed in modelRequests, toolSchemas, which no row that names it lists/
  );
  assert.deepEqual(
    checkChangedGoldens({ changes, rows: [row({ parts: ['modelRequests', 'toolSchemas'] })] }),
    []
  );
});

test('a row accepted for an earlier change does not cover a later one', () => {
  const changes = [
    { golden: 'chat/one-tool.json', before: { envelopes: [1] }, after: { envelopes: [2] } }
  ];
  const problems = checkChangedGoldens({ changes, rows: [row()], baseRows: [row()] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /A row from an earlier pull request names it/);
  // The same row, changed in this pull request (another golden added to it), counts again.
  assert.deepEqual(
    checkChangedGoldens({
      changes,
      rows: [row({ goldens: ['chat/one-tool.json', 'chat/two-tools.json'] })],
      baseRows: [row()]
    }),
    []
  );
});

test('a deleted golden needs a row that lists "(deleted)"', () => {
  const changes = [{ golden: 'chat/one-tool.json', before: { envelopes: [1] }, after: null }];
  assert.equal(checkChangedGoldens({ changes, rows: [row()] }).length, 1);
  assert.deepEqual(checkChangedGoldens({ changes, rows: [row({ parts: ['(deleted)'] })] }), []);
});

/** A scratch repository with one golden on its main branch and a branch that changes it. */
function scratchRepository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-golden-difflist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (file, value) => {
    const absolute = path.join(dir, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
    );
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write(`${GOLDENS_PATH}/chat/one-tool.json`, {
    envelopes: [1],
    modelRequests: [{ roles: ['user'] }]
  });
  write(`${GOLDENS_PATH}/chat/plain.json`, { envelopes: [1] });
  git('add', '.');
  git('commit', '--quiet', '-m', 'goldens');
  git('checkout', '--quiet', '-b', 'change');
  return { dir, git, write };
}

test('readChanges finds changed and deleted goldens against the merge base, not new ones', t => {
  const { dir, git, write } = scratchRepository(t);
  write(`${GOLDENS_PATH}/chat/one-tool.json`, {
    envelopes: [2],
    modelRequests: [{ roles: ['user'] }]
  });
  write(`${GOLDENS_PATH}/chat/new-case.json`, { envelopes: [1] });
  git('rm', '--quiet', `${GOLDENS_PATH}/chat/plain.json`);
  git('add', '.');
  git('commit', '--quiet', '-m', 'change a golden');
  // Not committed yet: the working tree counts, so the check works right after UPDATE_GOLDENS=1.
  write(DIFFERENCES_PATH, { rows: [row()] });

  const base = resolveBase({ cwd: dir, env: { GOLDEN_BASE_REF: 'main' } });
  assert.ok(base, 'the base is found');
  const { changes, rows, baseRows } = readChanges({ base: base.commit, cwd: dir });
  assert.deepEqual(
    changes.map(change => [change.golden, changedParts(change.before, change.after)]),
    [
      ['chat/one-tool.json', ['envelopes']],
      ['chat/plain.json', ['(deleted)']]
    ]
  );
  assert.deepEqual(baseRows, []);
  const problems = checkChangedGoldens({ changes, rows, baseRows });
  assert.equal(problems.length, 1, 'the row covers one-tool, nothing covers the deleted golden');
  assert.match(problems[0], /chat\/plain\.json changed \(\(deleted\)\)/);
});

test('resolveBase: a named base that does not exist is not replaced by a guess', t => {
  const { dir } = scratchRepository(t);
  assert.equal(resolveBase({ cwd: dir, env: { GOLDEN_BASE_REF: 'no-such-branch' } }), null);
  assert.equal(resolveBase({ cwd: dir, env: {} })?.ref, 'main');
  assert.equal(resolveBase({ cwd: os.tmpdir(), env: {} }), null, 'no repository, no base');
});

test('the difference list of this repository is well-formed', () => {
  const file = path.join(REPO_ROOT, DIFFERENCES_PATH);
  const rows = parseDifferenceList(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  assert.deepEqual(validateRows(rows), []);
});

test('every golden changed in this pull request is named by a row of the difference list', t => {
  const base = resolveBase();
  if (!base) {
    const reason =
      'the commit this branch started from is not in the checkout ' +
      '(set GOLDEN_BASE_REF, or fetch the target branch)';
    assert.notEqual(
      process.env.GOLDEN_REQUIRE_BASE,
      '1',
      `GOLDEN_REQUIRE_BASE is set and ${reason}`
    );
    t.skip(reason);
    return;
  }
  const { changes, rows, baseRows } = readChanges({ base: base.commit });
  const problems = checkChangedGoldens({ changes, rows, baseRows });
  assert.deepEqual(
    problems,
    [],
    `compared with ${base.ref} (${base.commit.slice(0, 12)}). Add a row to ${DIFFERENCES_PATH}, ` +
      'see docs/run-testing.md.'
  );
});
