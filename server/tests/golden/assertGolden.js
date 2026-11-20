// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Compare a record with its golden file, or write the golden.
 *
 * A golden is a plain JSON file with sorted keys under
 * `__goldens__/<surface>/<case>.json`, not a jest snapshot: it is read in a
 * review, diffed by git, and compared here with a message that names the
 * paths that differ.
 *
 * `UPDATE_GOLDENS=1` writes the file and passes. A changed golden then needs a
 * row in `differences.json` (`differenceList.test.js`). See docs/run-testing.md.
 *
 * @module tests/golden/assertGolden
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './normalise.js';
import { GOLDEN_DIR } from './harness.js';

/** How many differing paths a failure lists. */
const MAX_LISTED = 25;

/**
 * The paths at which two JSON values differ.
 *
 * @param {any} expected - The golden.
 * @param {any} actual - The record.
 * @param {string} [at] - Path of the values.
 * @returns {Array<{path: string, expected: any, actual: any}>}
 */
export function diffPaths(expected, actual, at = '') {
  if (Object.is(expected, actual)) return [];
  const isObject = value => value !== null && typeof value === 'object';
  if (
    !isObject(expected) ||
    !isObject(actual) ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    return [{ path: at || '(record)', expected, actual }];
  }
  const differences = [];
  if (Array.isArray(expected)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++) {
      differences.push(...diffPaths(expected[i], actual[i], `${at}[${i}]`));
    }
    return differences;
  }
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    differences.push(...diffPaths(expected[key], actual[key], at ? `${at}.${key}` : key));
  }
  return differences;
}

const short = value => {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

/** The file a record is compared with. */
export function goldenFile(record, dir = GOLDEN_DIR) {
  return path.join(dir, record.surface, `${record.case}.json`);
}

/** The part of a record that is compared: everything but `report`. */
export function comparable(record) {
  const { report: _report, ...compared } = record;
  return compared;
}

function writeReport(record, reportDir) {
  if (!reportDir || !record.report) return;
  const file = path.join(reportDir, record.surface, `${record.case}.requests.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canonicalJson(record.report));
}

/**
 * Fail unless the record equals its golden.
 *
 * @param {Object} record - From `recordCase`.
 * @param {Object} [options]
 * @param {string} [options.dir] - Where the goldens are (default: `__goldens__` next to this file).
 * @param {boolean} [options.update] - Write the golden instead of comparing (default: `UPDATE_GOLDENS=1`).
 * @param {string} [options.reportDir] - Where the full model request bodies are written for people to
 *   read (default: `GOLDEN_REPORT_DIR`; nothing is written without it).
 * @param {boolean} [options.ci] - Whether this is a CI run (default: the `CI` variable), where a golden
 *   is never written.
 * @returns {{file: string, written: boolean}}
 */
export function assertGolden(
  record,
  {
    dir = GOLDEN_DIR,
    update = process.env.UPDATE_GOLDENS === '1',
    reportDir = process.env.GOLDEN_REPORT_DIR,
    ci = Boolean(process.env.CI) && process.env.CI !== 'false'
  } = {}
) {
  const file = goldenFile(record, dir);
  const relative = path.relative(process.cwd(), file);
  const actual = canonicalJson(comparable(record));
  writeReport(record, reportDir);

  if (update) {
    assert.ok(
      !ci,
      'UPDATE_GOLDENS is set in a CI run. A golden is recorded on a developer machine and committed.'
    );
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (before !== actual) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, actual);
    }
    return { file, written: before !== actual };
  }

  assert.ok(
    fs.existsSync(file),
    `No golden is recorded for ${record.surface}/${record.case} (${relative}). ` +
      'Record it with UPDATE_GOLDENS=1 and commit the file.'
  );
  const expected = fs.readFileSync(file, 'utf8');
  if (expected === actual) return { file, written: false };

  const differences = diffPaths(JSON.parse(expected), JSON.parse(actual));
  const listed = differences
    .slice(0, MAX_LISTED)
    .map(d => `  ${d.path}\n    golden: ${short(d.expected)}\n    now:    ${short(d.actual)}`);
  const more =
    differences.length > MAX_LISTED ? `\n  ... and ${differences.length - MAX_LISTED} more` : '';
  assert.fail(
    `The run ${record.surface}/${record.case} differs from its golden (${relative}) ` +
      `at ${differences.length} place(s):\n${listed.join('\n')}${more}\n` +
      'This is a regression, or a change that was decided. A decided change needs a row in ' +
      'server/tests/golden/differences.json that names this golden; then record it again with ' +
      'UPDATE_GOLDENS=1. See docs/run-testing.md.'
  );
  return { file, written: false };
}
