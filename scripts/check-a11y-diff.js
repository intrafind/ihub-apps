#!/usr/bin/env node

/**
 * Accessibility lint ratchet for pull requests.
 *
 * eslint-plugin-jsx-a11y runs as warnings in the normal lint (see
 * eslint.config.js) so the existing backlog does not block development.
 * This script fails only on jsx-a11y findings on lines a change adds or
 * modifies, so new code meets WCAG while old code is fixed as it is touched.
 *
 * A change can also break an untouched line: deleting onKeyDown from a
 * clickable <div> is reported on the <div> line, which the diff does not
 * touch. So each changed file is also linted as it was at the merge base, and
 * a rule that now fires more often than before (beyond the changed-line
 * findings) fails too.
 *
 * Usage: node scripts/check-a11y-diff.js [base-ref]   (default: origin/main)
 *
 * Findings are printed as GitHub annotations, which show inline on the PR.
 */

import { execFileSync } from 'node:child_process';
import { ESLint } from 'eslint';

const base = process.argv[2] || 'origin/main';
// A ref, never an option: git would read "--output=…" as one.
if (!/^\w[\w./~^@{}-]*$/.test(base)) {
  console.error(`Invalid base ref: ${base}`);
  process.exit(2);
}
const LINTED = /^client\/.*\.(js|jsx)$/;

/**
 * Runs git with |args| (no shell) and returns its stdout. core.quotePath=false
 * keeps non-ASCII paths unquoted in patch headers, so they match like any other.
 */
function git(...args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
}

/** Line numbers a zero-context hunk header ("@@ -a,b +c,d @@") adds or changes. */
function hunkLines(header) {
  const [, start, count = '1'] = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  return Array.from({ length: Number(count) }, (_, i) => Number(start) + i);
}

/** Lines added or changed per file, from a zero-context diff against the merge base. */
function changedLines() {
  const diff = git(
    'diff',
    '--unified=0',
    '--diff-filter=ACMR',
    '--no-color',
    '--end-of-options',
    `${base}...HEAD`,
    '--',
    'client'
  );
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    // git ends the header with a tab when the path contains a space.
    const file = /^\+\+\+ b\/(.+?)\t?$/.exec(line)?.[1];
    if (file) {
      current = LINTED.test(file) ? new Set() : null;
      if (current) files.set(file, current);
    } else if (current && line.startsWith('@@ ')) {
      for (const n of hunkLines(line)) current.add(n);
    }
  }
  return files;
}

const files = changedLines();
if (files.size === 0) {
  console.log(`No client JS/JSX changes against ${base}; nothing to check.`);
  process.exit(0);
}

const eslint = new ESLint();
const results = await eslint.lintFiles([...files.keys()]);
const isA11y = message => message.ruleId?.startsWith('jsx-a11y/');

const mergeBase = git('merge-base', '--end-of-options', base, 'HEAD').trim();
// Path of each changed file at the merge base (renames included; absent when
// added). -z output is "status NUL path [NUL new path] NUL", unquoted.
const basePaths = new Map();
const nameStatus = git(
  'diff',
  '--name-status',
  '-z',
  '-M',
  '--end-of-options',
  `${base}...HEAD`,
  '--',
  'client'
).split('\0');
for (let i = 0; i < nameStatus.length - 1;) {
  const status = nameStatus[i];
  if (status.startsWith('R') || status.startsWith('C')) {
    basePaths.set(nameStatus[i + 2], nameStatus[i + 1]);
    i += 3;
  } else {
    if (status === 'M') basePaths.set(nameStatus[i + 1], nameStatus[i + 1]);
    i += 2;
  }
}

/** jsx-a11y findings per rule for |file| as it was at the merge base. */
async function baseCounts(file) {
  const counts = new Map();
  const basePath = basePaths.get(file);
  if (!basePath) return counts;
  const source = git('show', '--end-of-options', `${mergeBase}:${basePath}`);
  const [result] = await eslint.lintText(source, { filePath: file });
  for (const message of result.messages.filter(isA11y)) {
    counts.set(message.ruleId, (counts.get(message.ruleId) ?? 0) + 1);
  }
  return counts;
}

const findings = [];
for (const result of results) {
  const file = result.filePath.slice(process.cwd().length + 1);
  const lines = files.get(file) ?? new Set();
  const messages = result.messages.filter(isA11y);
  for (const message of messages) {
    if (lines.has(message.line)) findings.push({ file, ...message });
  }

  // Rules that fire more often than at the merge base, beyond what the changed
  // lines explain: the change broke an element on an untouched line.
  const before = await baseCounts(file);
  for (const ruleId of new Set(messages.map(m => m.ruleId))) {
    const now = messages.filter(m => m.ruleId === ruleId);
    const onChangedLines = now.filter(m => lines.has(m.line)).length;
    const added = now.length - (before.get(ruleId) ?? 0) - onChangedLines;
    if (added <= 0) continue;
    const candidates = now.filter(m => !lines.has(m.line));
    findings.push({
      file,
      ruleId,
      line: candidates[0].line,
      column: candidates[0].column,
      message:
        `${added} more finding(s) than before this change, on an unchanged line ` +
        `(one of lines ${candidates.map(m => m.line).join(', ')}): ${candidates[0].message}`
    });
  }
}

for (const f of findings) {
  const text = `${f.message} (${f.ruleId})`.replace(/\r?\n/g, ' ');
  console.log(`::error file=${f.file},line=${f.line},col=${f.column},title=Accessibility::${text}`);
}

console.log(
  `\nChecked ${files.size} changed client file(s): ${findings.length} accessibility finding(s) introduced by this change.`
);
if (findings.length > 0) {
  console.log(
    'Fix them before merging; see docs/accessibility.md for the rules and how to fix each.'
  );
  process.exit(1);
}
