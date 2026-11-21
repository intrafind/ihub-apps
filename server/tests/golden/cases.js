// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every golden case, in one list. `golden.test.js` compares each with its
 * golden, `determinism.test.js` records each three times, and `record.mjs`
 * records one by id.
 *
 * A surface adds its cases here (`surfaces/<surface>.js` exports a list made
 * with `defineCase`).
 *
 * @module tests/golden/cases
 */
import { harnessCases } from './harnessCases.js';

/** @type {ReadonlyArray<ReturnType<typeof import('./harness.js').defineCase>>} */
export const CASES = Object.freeze([...harnessCases]);

{
  const seen = new Set();
  for (const goldenCase of CASES) {
    if (seen.has(goldenCase.id)) throw new Error(`golden case ${goldenCase.id} is defined twice`);
    seen.add(goldenCase.id);
  }
}

/**
 * @param {string} id - `<surface>/<case>`.
 * @returns {Object} The case.
 */
export function findCase(id) {
  const found = CASES.find(goldenCase => goldenCase.id === id);
  if (!found) {
    throw new Error(`No golden case "${id}". Known: ${CASES.map(c => c.id).join(', ')}`);
  }
  return found;
}
