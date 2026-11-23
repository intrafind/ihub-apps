// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The verdict of `compare.mjs`: the head's median TTFT at most the gate above
 * the base's, unless the base runs spread more than the limit, which makes it
 * a release gate measured by a person.
 *
 * Run: node --test tests/load/compare.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeComparison, median, spreadPct } from './compare.mjs';

test('median and spread', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(spreadPct([100, 105, 110]), (10 / 105) * 100);
});

test('a head within the gate passes, one above it fails', () => {
  const base = [200, 202, 198, 201, 199];
  assert.equal(judgeComparison({ base, head: [210, 215, 212, 219, 211] }).verdict, 'pass');
  const slow = judgeComparison({ base, head: [225, 230, 228, 226, 229] });
  assert.equal(slow.verdict, 'fail');
  assert.ok(slow.deltaPct > 10);
});

test('a noisy base makes it a release gate, whatever the head did', () => {
  const judged = judgeComparison({
    base: [150, 200, 260, 205, 199],
    head: [400, 400, 400, 400, 400]
  });
  assert.equal(judged.verdict, 'release-gate');
  assert.ok(judged.baseSpreadPct > 10);
});
