#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A pull request that records goldens and says it changes no production code
 * is held to it.
 *
 * The goldens of the run tests are worth something only when they were
 * recorded before the code they pin was changed (docs/run-testing.md). A
 * recording pull request is one whose title has the type `test`, `docs` or
 * `ci` and whose diff adds, changes or deletes a file under
 * `server/tests/golden/__goldens__/`. Such a pull request may not change the
 * code a golden pins: `server/` outside `server/tests/`, `shared/` and
 * `client/`. A file there fails the check.
 *
 * Not checked:
 * - a pull request of another type (`feat`, `fix`, `refactor`, ...). It may
 *   change production code, and a golden it changes needs a row in the
 *   difference list instead.
 * - a `test`, `docs` or `ci` pull request that touches no golden: a concept
 *   under `concepts/`, a change to `CLAUDE.md`, a test hook in the server that
 *   comes with its test harness. Nothing is recorded in it, so nothing can be
 *   recorded after the fact.
 *
 * The title is read from GitHub when the check runs (`PR_NUMBER`,
 * `GITHUB_REPOSITORY`, token in `GH_TOKEN`), not from the event that started
 * the workflow: a job that is run again replays its event, with the title the
 * pull request had then. Without `PR_NUMBER` the title is `PR_TITLE` (by hand).
 *
 * Usage:
 *
 *   PR_TITLE="test: ..." node scripts/check-test-only-diff.js --base origin/main
 *
 * Exit codes: 0 fine or not a recording pull request, 1 a production path is in
 * the diff, 2 the check could not run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

/** Where the goldens are. A pull request that touches a file here records. */
export const GOLDENS_PREFIX = 'server/tests/golden/__goldens__/';

/** The code a golden can pin. */
export const PRODUCTION_PREFIXES = Object.freeze(['server/', 'shared/', 'client/']);

/** Inside the production prefixes, but tests. */
export const TEST_PREFIXES = Object.freeze(['server/tests/']);

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
 * The golden files among the paths of a diff.
 *
 * @param {string[]} paths - Relative to the repository root, with forward slashes.
 * @returns {string[]} Sorted.
 */
export function goldenPaths(paths) {
  return paths.filter(file => file?.startsWith(GOLDENS_PREFIX)).sort(byCodeUnit);
}

/**
 * The paths of a diff that are production code.
 *
 * @param {string[]} paths - Relative to the repository root, with forward slashes.
 * @returns {string[]} Sorted.
 */
export function productionPaths(paths) {
  return paths
    .filter(
      file =>
        file &&
        PRODUCTION_PREFIXES.some(prefix => file.startsWith(prefix)) &&
        !TEST_PREFIXES.some(prefix => file.startsWith(prefix))
    )
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
 * Read with `-z`: without it git writes a path that holds a byte outside ASCII (an umlaut in the
 * name of a fixture) in quotes and with escapes, and such a path starts with no prefix at all.
 *
 * @param {string} base - A ref of the target branch.
 * @param {string} cwd - The repository.
 * @returns {string[]}
 */
export function changedPaths(base, cwd) {
  const mergeBase = git(['merge-base', base, 'HEAD'], cwd).trim();
  return git(['diff', '--name-only', '--no-renames', '-z', mergeBase], cwd)
    .split('\0')
    .filter(Boolean);
}

const GH_LOCATIONS = ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];

/** The GitHub CLI by its full path (or `GH_EXECUTABLE`), never through `PATH`. */
function ghExecutable(env) {
  const found = [env.GH_EXECUTABLE, ...GH_LOCATIONS].find(file => file && fs.existsSync(file));
  if (!found) {
    throw new Error(`gh not found in ${GH_LOCATIONS.join(', ')}; set GH_EXECUTABLE to its path`);
  }
  return found;
}

/**
 * The title a pull request has now, read with the GitHub CLI (`gh`, present on every GitHub
 * runner; it takes the token from `GH_TOKEN`).
 *
 * @param {Object} params
 * @param {string} params.repo - `owner/name`.
 * @param {string|number} params.pr - The number of the pull request.
 * @param {Object} [params.env=process.env]
 * @returns {string}
 * @throws {Error} When the title cannot be read.
 */
export function fetchTitle({ repo, pr, env = process.env }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo)) || !/^\d+$/.test(String(pr))) {
    throw new Error(`Not a repository and pull request number: "${repo}" #${pr}`);
  }
  try {
    return execFileSync(ghExecutable(env), ['api', `repos/${repo}/pulls/${pr}`, '--jq', '.title'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024
    }).trim();
  } catch (error) {
    throw new Error(
      `The title of #${pr} could not be read with gh: ${String(error.stderr || error.message).trim()}`
    );
  }
}

/**
 * The title the check judges.
 *
 * With the number of a pull request it is the title the pull request has now. The title of the
 * event (`PR_TITLE`) is not used then, not even when GitHub cannot be asked: a pull request
 * opened as `feat:` and renamed to `test:` would pass on the old title.
 *
 * @param {Object} env - `PR_NUMBER`, `GITHUB_REPOSITORY`, `PR_TITLE`.
 * @param {(params: {repo: string, pr: string, env: Object}) => string} [fetch=fetchTitle]
 * @returns {{title: string, source: 'github'|'PR_TITLE'}}
 * @throws {Error} When a pull request is named and its title cannot be read.
 */
export function currentTitle(env, fetch = fetchTitle) {
  if (env.PR_NUMBER) {
    return {
      title: fetch({ repo: env.GITHUB_REPOSITORY, pr: env.PR_NUMBER, env }),
      source: 'github'
    };
  }
  return { title: env.PR_TITLE ?? '', source: 'PR_TITLE' };
}

function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const base = baseIndex >= 0 ? args[baseIndex + 1] : process.env.TEST_ONLY_BASE_REF;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  let title;
  try {
    ({ title } = currentTitle(process.env));
  } catch (error) {
    console.error(`check-test-only-diff: ${error.message}`);
    return 2;
  }
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
  const goldens = goldenPaths(paths);
  if (goldens.length === 0) {
    console.log(
      `${paths.length} changed file(s), none under ${GOLDENS_PREFIX}: this pull request records ` +
        'no golden. Not checked.'
    );
    return 0;
  }
  const outside = productionPaths(paths);
  if (outside.length === 0) {
    console.log(
      `${paths.length} changed file(s), ${goldens.length} of them goldens, none in production ` +
        `code (${PRODUCTION_PREFIXES.join(', ')} outside ${TEST_PREFIXES.join(', ')}).`
    );
    return 0;
  }
  console.error(
    `The title "${title}" says this pull request changes no production code, and it records ` +
      `${goldens.length} golden file(s), but these files are production code:\n` +
      `${outside.map(file => `  ${file}`).join('\n')}\n` +
      'Move the production change into a pull request of its own, after this one. A golden is ' +
      'recorded before the code it pins is changed (docs/run-testing.md).'
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
