#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A pull request that says it changes no production code is held to it.
 *
 * The goldens of the run tests are worth something only when they were
 * recorded before the code they pin was changed (docs/run-testing.md). So the
 * pull request that records them, and every other pull request whose title has
 * the type `test`, `docs` or `ci`, may only touch tests, docs, scripts and
 * workflows. A file anywhere else fails the check.
 *
 * A pull request of another type (`feat`, `fix`, `refactor`, ...) is not
 * checked here: it may change production code, and a golden it changes needs a
 * row in the difference list instead.
 *
 * Usage (the workflow sets `PR_TITLE`):
 *
 *   PR_TITLE="test: ..." node scripts/check-test-only-diff.js --base origin/main
 *
 * Exit codes: 0 fine or not a test-only pull request, 1 a production path is in
 * the diff, 2 the check could not run.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitExecutable } from './git-executable.js';

/** The order `sort()` has without a comparator, said out loud: by UTF-16 code unit. */
const byCodeUnit = (a, b) => {
  const x = String(a);
  const y = String(b);
  if (x < y) return -1;
  return x > y ? 1 : 0;
};

/** The types of a title that claim "no production code". */
export const TEST_ONLY_TYPES = Object.freeze(['test', 'docs', 'ci']);

/** Where a test-only pull request may change files. */
export const ALLOWED_PREFIXES = Object.freeze([
  'server/tests/',
  'tests/',
  'docs/',
  'scripts/',
  '.github/'
]);

/**
 * The conventional-commit type of a title, lower-case, or null.
 *
 * @param {string} title - `test(golden): ...`, `feat!: ...`
 * @returns {string|null}
 */
export function titleType(title) {
  const match = /^\s*([a-zA-Z]+)(?:\([^)]*\))?!?:/.exec(String(title ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/** Whether a title claims that the pull request changes no production code. */
export function isTestOnlyTitle(title) {
  return TEST_ONLY_TYPES.includes(titleType(title));
}

/**
 * The paths of a diff that are outside the allowed places.
 *
 * @param {string[]} paths - Relative to the repository root, with forward slashes.
 * @returns {string[]} Sorted.
 */
export function productionPaths(paths) {
  return paths
    .filter(file => file && !ALLOWED_PREFIXES.some(prefix => file.startsWith(prefix)))
    .sort(byCodeUnit);
}

function git(args, cwd) {
  // By its full path, never through PATH (scripts/git-executable.js).
  return execFileSync(gitExecutable(), args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
}

/**
 * The paths that differ between the merge base with `base` and the working tree, both sides of
 * a rename included.
 *
 * @param {string} base - A ref of the target branch.
 * @param {string} cwd - The repository.
 * @returns {string[]}
 */
export function changedPaths(base, cwd) {
  const mergeBase = git(['merge-base', base, 'HEAD'], cwd).trim();
  return git(['diff', '--name-only', '--no-renames', mergeBase], cwd).split('\n').filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const base = baseIndex >= 0 ? args[baseIndex + 1] : process.env.TEST_ONLY_BASE_REF;
  const title = process.env.PR_TITLE ?? '';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  if (!isTestOnlyTitle(title)) {
    console.log(
      `The title "${title}" has the type "${titleType(title) ?? 'none'}", not one of ` +
        `${TEST_ONLY_TYPES.join(', ')}: this pull request may change production code. Not checked.`
    );
    return 0;
  }
  if (!base) {
    console.error('check-test-only-diff: pass --base <ref> (the target branch)');
    return 2;
  }
  let paths;
  try {
    paths = changedPaths(base, root);
  } catch (error) {
    console.error(
      `check-test-only-diff: the diff against ${base} could not be read: ${error.message}`
    );
    return 2;
  }
  const outside = productionPaths(paths);
  if (outside.length === 0) {
    console.log(
      `${paths.length} changed file(s), all under ${ALLOWED_PREFIXES.join(', ')}: no production path.`
    );
    return 0;
  }
  console.error(
    `The title "${title}" says this pull request changes no production code, but these files are ` +
      `outside ${ALLOWED_PREFIXES.join(', ')}:\n${outside.map(file => `  ${file}`).join('\n')}\n` +
      'Move the production change into a pull request of its own, after this one. A golden is ' +
      'recorded before the code it pins is changed (docs/run-testing.md).'
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
