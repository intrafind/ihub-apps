// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The job summary of the nightly red team by OWASP LLM Top 10 id:
 *
 *   node tests/security/redteam/owasp-summary.mjs redteam-report/results.json redteam-report/corpus-results.json
 *
 * Reads promptfoo result files (`-o results.json`) and prints a Markdown table: for each id, how
 * many tests speak to it, how many runs passed, and which tests failed. A run counts for every id
 * its test carries in `metadata.owasp`; a test without ids is listed under "untagged", so a gap in
 * the tagging shows up in the summary.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OWASP_LLM } from './owasp.mjs';

const UNTAGGED = 'untagged';

/**
 * @param {Array<{results?: {results?: Array<Object>}}>} files - parsed promptfoo result files
 * @returns {Map<string, {tests: Set<string>, runs: number, passed: number, failed: Set<string>}>}
 */
export function groupByOwasp(files) {
  const groups = new Map();
  for (const file of files) {
    for (const row of file?.results?.results ?? []) {
      const description = row.testCase?.description ?? row.description ?? '(no description)';
      const tagged = row.testCase?.metadata?.owasp ?? row.metadata?.owasp;
      const ids = Array.isArray(tagged) && tagged.length > 0 ? tagged : [UNTAGGED];
      for (const id of ids) {
        if (!groups.has(id))
          groups.set(id, { tests: new Set(), runs: 0, passed: 0, failed: new Set() });
        const group = groups.get(id);
        group.tests.add(description);
        group.runs += 1;
        if (row.success) group.passed += 1;
        else group.failed.add(description);
      }
    }
  }
  return groups;
}

/**
 * @param {Array<Object>} files - parsed promptfoo result files
 * @returns {string} Markdown, ends with a newline
 */
export function owaspSummary(files) {
  const groups = groupByOwasp(files);
  const lines = ['## Red team by OWASP LLM Top 10 (2025)', ''];
  if (groups.size === 0) return `${lines.join('\n')}No results.\n`;
  lines.push(
    '| Id | Risk | Tests | Runs passed | Failing tests |',
    '| --- | --- | --- | --- | --- |'
  );
  const order = [...Object.keys(OWASP_LLM), ...[...groups.keys()].filter(id => !(id in OWASP_LLM))];
  for (const id of order) {
    const group = groups.get(id);
    if (!group) continue;
    const failing = [...group.failed].map(d => d.replaceAll(/[|\r\n]/g, ' ').slice(0, 120));
    lines.push(
      `| ${id} | ${OWASP_LLM[id] ?? ''} | ${group.tests.size} | ${group.passed}/${group.runs} | ${failing.join('<br>')} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv
    .slice(2)
    .filter(path => fs.existsSync(path) && fs.statSync(path).size > 0)
    .map(path => JSON.parse(fs.readFileSync(path, 'utf8')));
  process.stdout.write(owaspSummary(files));
}
