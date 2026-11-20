// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every golden case is recorded and compared with its golden file.
 *
 * A failure is a regression or a decided change. A decided change gets a row
 * in `differences.json`, and the golden is recorded again with
 * `UPDATE_GOLDENS=1` (docs/run-testing.md).
 *
 * The golden files and the cases are also compared as two lists: a golden file
 * without a case fails. A case that is dropped or renamed must take its golden
 * with it, and a deleted golden needs a row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGolden, unmatchedGoldens } from './assertGolden.js';
import { recordCase } from './harness.js';
import { CASES } from './cases.js';

for (const goldenCase of CASES) {
  test(`${goldenCase.id}: ${goldenCase.title}`, async () => {
    assertGolden(await recordCase(goldenCase));
  });
}

test('every golden file belongs to a case, and every case has a golden file', () => {
  const { withoutCase, withoutGolden } = unmatchedGoldens(CASES);
  assert.deepEqual(
    withoutCase,
    [],
    'These files under __goldens__ belong to no case of cases.js, so nothing compares them any ' +
      'more. A case that was removed or renamed takes its golden with it: delete the file and ' +
      'add a row with the part "(deleted)" to differences.json (docs/run-testing.md).'
  );
  // With UPDATE_GOLDENS=1 the tests above have just written the missing files.
  assert.deepEqual(withoutGolden, [], 'Record these cases with UPDATE_GOLDENS=1.');
});

test('the comparison of files and cases finds a dropped case, a renamed case and a stray file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-golden-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = file => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '{}\n');
  };
  const cases = [
    { surface: 'chat', name: 'plain' },
    { surface: 'chat', name: 'one-tool' },
    { surface: 'scheduled', name: 'run-now' }
  ];
  for (const goldenCase of cases) write(`${goldenCase.surface}/${goldenCase.name}.json`);
  assert.deepEqual(unmatchedGoldens(cases, dir), { withoutCase: [], withoutGolden: [] });

  // A case removed from the list: its golden stays behind.
  assert.deepEqual(unmatchedGoldens(cases.slice(1), dir), {
    withoutCase: ['chat/plain.json'],
    withoutGolden: []
  });
  // A case renamed without its golden: the old file has no case, the new case no file.
  const renamed = [{ surface: 'chat', name: 'plain-turn' }, ...cases.slice(1)];
  assert.deepEqual(unmatchedGoldens(renamed, dir), {
    withoutCase: ['chat/plain.json'],
    withoutGolden: ['chat/plain-turn.json']
  });
  // A surface whose list was never added to cases.js, and a file that is no golden at all.
  write('workflow/nda.json');
  write('chat/notes.txt');
  assert.deepEqual(unmatchedGoldens(cases, dir).withoutCase, [
    'chat/notes.txt',
    'workflow/nda.json'
  ]);
  // No directory at all: every case is without a golden.
  assert.equal(unmatchedGoldens(cases, path.join(dir, 'missing')).withoutGolden.length, 3);
});
