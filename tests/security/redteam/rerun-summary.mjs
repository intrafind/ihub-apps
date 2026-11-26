// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The job summary of the failing corpus pages that were run again:
 *
 *   node tests/security/redteam/rerun-summary.mjs redteam-report/corpus-results.json redteam-report/corpus-rerun.json
 *
 * The corpus run asks each page once. A page the model obeyed in that run is asked again twice
 * (`promptfoo eval --filter-failing <first results> --repeat 2`, in the workflow), and this table
 * puts the three runs side by side: "3 of 3" is a model that obeys that page every time, "1 of 3" is
 * a one-off. It changes nothing about the verdict: the first run decides whether the job fails.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const describe = row => row.testCase?.description ?? row.description ?? '(no description)';

/**
 * @param {{results?: {results?: Array<Object>}}} first - the corpus run
 * @param {{results?: {results?: Array<Object>}}} rerun - the failing pages, run again
 * @returns {Array<{description: string, runs: number, failed: number, reasons: string[]}>} one row
 *   per page that failed in the first run, in its order
 */
export function rerunRows(first, rerun) {
  const rows = new Map();
  for (const row of first?.results?.results ?? []) {
    if (row.success) continue;
    rows.set(describe(row), { description: describe(row), runs: 1, failed: 1, reasons: [] });
  }
  for (const row of rerun?.results?.results ?? []) {
    const entry = rows.get(describe(row));
    if (!entry) continue; // a page that did not fail first is none of this table's business
    entry.runs += 1;
    if (!row.success) {
      entry.failed += 1;
      const reason = row.gradingResult?.reason ?? row.error ?? '';
      if (reason) entry.reasons.push(String(reason));
    }
  }
  return [...rows.values()];
}

/**
 * @param {Object} first
 * @param {Object} rerun
 * @returns {string} Markdown, ends with a newline
 */
export function rerunSummary(first, rerun) {
  const rows = rerunRows(first, rerun);
  const lines = ['## Red team: failing pages run again', ''];
  if (rows.length === 0) return `${lines.join('\n')}No page failed in the first run.\n`;
  lines.push('| Page | Failed | Reading | Why (rerun) |', '| --- | --- | --- | --- |');
  for (const row of rows) {
    const reading =
      row.runs === 1
        ? 'not run again'
        : row.failed === row.runs
          ? 'every time'
          : row.failed === 1
            ? 'one-off'
            : 'sometimes';
    const why = [...new Set(row.reasons)]
      .map(r => r.replaceAll(/[|\r\n]/g, ' ').slice(0, 160))
      .join('<br>');
    lines.push(
      `| ${row.description.replaceAll('|', ' ')} | ${row.failed} of ${row.runs} | ${reading} | ${why} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const read = path =>
    fs.existsSync(path) && fs.statSync(path).size > 0
      ? JSON.parse(fs.readFileSync(path, 'utf8'))
      : {};
  const [firstPath, rerunPath] = process.argv.slice(2);
  process.stdout.write(rerunSummary(read(firstPath), read(rerunPath)));
}
