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

test('every golden a row names exists, unless the row accepts that it is deleted', () => {
  const missing = [];
  for (const row of rows) {
    if (row.parts.includes('(deleted)')) continue;
    for (const golden of row.goldens) {
      if (!fs.existsSync(path.join(REPO_ROOT, GOLDENS_PATH, golden))) {
        missing.push(`${row.id}: ${golden}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `These rows name a golden that is not under ${GOLDENS_PATH}. Correct the name, or list the ` +
      'part "(deleted)" when the row accepts that the golden is removed.'
  );
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
