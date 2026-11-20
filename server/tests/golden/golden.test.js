// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every golden case is recorded and compared with its golden file.
 *
 * A failure is a regression or a decided change. A decided change gets a row
 * in `differences.json`, and the golden is recorded again with
 * `UPDATE_GOLDENS=1` (docs/run-testing.md).
 */
import test from 'node:test';
import { assertGolden } from './assertGolden.js';
import { recordCase } from './harness.js';
import { CASES } from './cases.js';

for (const goldenCase of CASES) {
  test(`${goldenCase.id}: ${goldenCase.title}`, async () => {
    assertGolden(await recordCase(goldenCase));
  });
}
