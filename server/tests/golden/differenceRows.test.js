// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rows of `differences.json` point at something that exists: a golden file
 * under `__goldens__/` and parts a record has. A row with a mistyped file name
 * would accept nothing and nobody would notice until the pull request that
 * relies on it.
 *
 * `differenceList.test.js` checks the form of a row and that a changed golden
 * has one. This file imports nothing of the server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DIFFERENCES_PATH,
  GOLDENS_PATH,
  REPO_ROOT,
  parseDifferenceList,
  validateRows
} from './differenceList.js';

/** The parts of a record (`harness.js`), and the mark of a golden that is removed. */
const RECORD_PARTS = new Set([
  'approvals',
  'envelopes',
  'evidence',
  'httpResponse',
  'ledger',
  'modelRequests',
  'offeredToolIds',
  'result',
  'storedMessage',
  'title',
  'toolCalls',
  'toolSchemas',
  'usageRecords',
  '(deleted)'
]);

const listFile = path.join(REPO_ROOT, DIFFERENCES_PATH);
const rows = parseDifferenceList(
  fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8') : null
);

test('the difference list exists and its rows are well-formed', () => {
  assert.ok(fs.existsSync(listFile), `${DIFFERENCES_PATH} is missing`);
  assert.ok(rows.length > 0, 'the difference list has no rows');
  assert.deepEqual(validateRows(rows), []);
});

/**
 * The rows that name a golden which is neither a file nor accepted as deleted.
 *
 * A row with the part "(deleted)" accepts the removal of its goldens for the whole list: the
 * rows written before it that named the same file stay as they were signed, and are not the
 * mistake this looks for.
 *
 * @param {Array<{id: string, goldens: string[], parts: string[]}>} list
 * @param {(golden: string) => boolean} exists
 * @returns {string[]} `<row id>: <golden>`
 */
export function missingGoldens(list, exists) {
  const deleted = new Set(
    list.filter(row => row.parts.includes('(deleted)')).flatMap(row => row.goldens)
  );
  const missing = [];
  for (const row of list) {
    for (const golden of row.goldens) {
      if (!deleted.has(golden) && !exists(golden)) missing.push(`${row.id}: ${golden}`);
    }
  }
  return missing;
}

test('every golden a row names exists, unless a row accepts that it is deleted', () => {
  assert.deepEqual(
    missingGoldens(rows, golden => fs.existsSync(path.join(REPO_ROOT, GOLDENS_PATH, golden))),
    [],
    `These rows name a golden that is not under ${GOLDENS_PATH}. Correct the name, or add a row ` +
      'with the part "(deleted)" when the list accepts that the golden is removed.'
  );
});

test('a row that accepts a deleted golden also answers for the earlier rows that name it', () => {
  const exists = golden => golden === 'chat/plain.json';
  const earlier = { id: 'tool-error-text', goldens: ['app/depth-1.json'], parts: ['ledger'] };
  const other = { id: 'usage', goldens: ['chat/plain.json'], parts: ['usageRecords'] };
  assert.deepEqual(missingGoldens([earlier, other], exists), ['tool-error-text: app/depth-1.json']);
  const removal = { id: 'depth-1-removed', goldens: ['app/depth-1.json'], parts: ['(deleted)'] };
  assert.deepEqual(missingGoldens([earlier, other, removal], exists), []);
  // A mistyped name in another row is still found.
  const mistyped = { id: 'typo', goldens: ['chat/plian.json'], parts: ['ledger'] };
  assert.deepEqual(missingGoldens([earlier, removal, mistyped], exists), ['typo: chat/plian.json']);
});

test('every part a row names is a part of a record', () => {
  const unknown = rows.flatMap(row =>
    row.parts.filter(part => !RECORD_PARTS.has(part)).map(part => `${row.id}: ${part}`)
  );
  assert.deepEqual(unknown, [], `Parts of a record are: ${[...RECORD_PARTS].join(', ')}`);
});

test('a signed row names an owner of the difference list', () => {
  const codeowners = fs.readFileSync(path.join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8');
  const line = codeowners.split('\n').find(text => text.startsWith(`/${DIFFERENCES_PATH} `));
  assert.ok(line, `.github/CODEOWNERS names no owner for ${DIFFERENCES_PATH}`);
  const owners = line
    .split(/\s+/)
    .slice(1)
    .map(owner => owner.replace(/^@/, ''));
  for (const row of rows.filter(entry => entry.state === 'signed')) {
    assert.ok(
      owners.includes(row.signedBy),
      `row ${row.id} is signed by ${row.signedBy}, who is not an owner of the list (${owners.join(', ')})`
    );
  }
});
