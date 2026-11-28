// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared part of the guideline ratchets (`check-api-guidelines.js`,
 * `check-observability-guidelines.js`): read the zero-context diff of a change
 * from standard input, find the lines it adds or changes, and report the
 * violations a script's `findViolations` finds on them as GitHub annotations.
 */

import { readFileSync } from 'node:fs';

/** Line numbers a zero-context hunk header ("@@ -a,b +c,d @@") adds or changes. */
function hunkLines(header) {
  const [, start, count = '1'] = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  return Array.from({ length: Number(count) }, (_, i) => Number(start) + i);
}

/**
 * The lines a unified diff (made with `--unified=0`) adds or changes, per checked file.
 *
 * @param {string} diff - Output of `git diff --unified=0 --no-color`
 * @param {RegExp} checked - The repository paths to check
 * @returns {Map<string, Set<number>>}
 */
export function parseChangedLines(diff, checked) {
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    // git ends the header with a tab when the path contains a space.
    const file = /^\+\+\+ b\/(.+?)\t?$/.exec(line)?.[1];
    if (file) {
      current = checked.test(file) && !file.includes('..') ? new Set() : null;
      if (current) files.set(file, current);
    } else if (current && line.startsWith('@@ ')) {
      for (const n of hunkLines(line)) current.add(n);
    }
  }
  return files;
}

/**
 * The whole of stdin. Not `readFileSync(0)`: a pipe is non-blocking, so that
 * throws EAGAIN whenever the producer (`git diff`) has not written yet.
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Run a ratchet as a command: exit 1 when the change introduces a violation.
 *
 * @param {Object} options
 * @param {string} options.script - The script's path, for the usage line
 * @param {RegExp} options.checked - The repository paths to check
 * @param {(source: string, file: string, changed: Set<number>) => Array<{line: number, rule: string, message: string}>} options.findViolations
 * @param {string} options.title - What is checked, e.g. "API guidelines"
 * @param {string} options.docs - The guideline document
 * @param {string} options.ignoreMarker - The comment that exempts a line
 */
export async function runRatchet({ script, checked, findViolations, title, docs, ignoreMarker }) {
  if (process.stdin.isTTY) {
    console.error(
      `Pipe the diff in: git diff --unified=0 --diff-filter=ACMR --no-color origin/main...HEAD -- server | node ${script}`
    );
    process.exit(2);
  }

  const files = parseChangedLines(await readStdin(), checked);
  if (files.size === 0) {
    console.log('No changed server files to check.');
    return;
  }

  let count = 0;
  for (const [file, lines] of files) {
    for (const v of findViolations(readFileSync(file, 'utf8'), file, lines)) {
      count++;
      console.log(`::error file=${file},line=${v.line},title=${title} (${v.rule})::${v.message}`);
    }
  }

  console.log(
    `\nChecked ${files.size} changed server file(s): ${count} ${title.replace(/s$/, '')} violation(s) introduced by this change.`
  );
  if (count > 0) {
    console.log(
      `Fix them before merging; see ${docs}. A line with a real reason to break a rule carries "// ${ignoreMarker}: <reason>".`
    );
    process.exit(1);
  }
}
