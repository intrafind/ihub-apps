#!/usr/bin/env node

/**
 * Accessibility lint ratchet for pull requests.
 *
 * eslint-plugin-jsx-a11y runs as warnings in the normal lint (see
 * eslint.config.js) so the existing backlog does not block development.
 * This script fails only on jsx-a11y findings on lines a change adds or
 * modifies, so new code meets WCAG while old code is fixed as it is touched.
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

const findings = [];
for (const result of results) {
  const file = result.filePath.slice(process.cwd().length + 1);
  const lines = files.get(file) ?? new Set();
  for (const message of result.messages) {
    if (!message.ruleId?.startsWith('jsx-a11y/')) continue;
    if (!lines.has(message.line)) continue;
    findings.push({ file, ...message });
  }
}

for (const f of findings) {
  const text = `${f.message} (${f.ruleId})`.replace(/\r?\n/g, ' ');
  console.log(`::error file=${f.file},line=${f.line},col=${f.column},title=Accessibility::${text}`);
}

console.log(
  `\nChecked ${files.size} changed client file(s): ${findings.length} accessibility finding(s) on changed lines.`
);
if (findings.length > 0) {
  console.log(
    'Fix them before merging; see docs/accessibility.md for the rules and how to fix each.'
  );
  process.exit(1);
}
