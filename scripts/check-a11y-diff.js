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

import { execFileSync } from 'child_process';
import { ESLint } from 'eslint';

const base = process.argv[2] || 'origin/main';
const LINTED = /^client\/.*\.(js|jsx)$/;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Lines added or changed per file, from a zero-context diff against the merge base. */
function changedLines() {
  const diff = git(
    'diff',
    '--unified=0',
    '--diff-filter=ACMR',
    '--no-color',
    `${base}...HEAD`,
    '--',
    'client'
  );
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    const file = line.match(/^\+\+\+ b\/(.+)$/);
    if (file) {
      current = LINTED.test(file[1]) ? file[1] : null;
      if (current) files.set(current, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) files.get(current).add(n);
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

const mergeBase = git('merge-base', base, 'HEAD').trim();
// Path of each changed file at the merge base (renames included; absent when added).
const basePaths = new Map();
for (const line of git('diff', '--name-status', '-M', `${base}...HEAD`, '--', 'client').split(
  '\n'
)) {
  const [status, from, to] = line.split('\t');
  if (status?.startsWith('R')) basePaths.set(to, from);
  else if (status === 'M') basePaths.set(from, from);
}

/** jsx-a11y findings per rule for |file| as it was at the merge base. */
async function baseCounts(file) {
  const counts = new Map();
  const basePath = basePaths.get(file);
  if (!basePath) return counts;
  const source = git('show', `${mergeBase}:${basePath}`);
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
