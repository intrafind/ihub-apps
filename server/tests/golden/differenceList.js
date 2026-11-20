// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The difference list: the accepted differences between the behaviour the
 * goldens were recorded with and the behaviour of today.
 *
 * A golden never changes silently. Whoever changes one adds a row to
 * `differences.json` that names the golden file, the parts of the record that
 * changed and the pull request, and says what was decided. The product owner
 * signs the row by approving that pull request
 * (`scripts/check-difference-signatures.js`).
 *
 * This module has no dependency on the server, so the check runs on a bare
 * checkout. See docs/run-testing.md.
 *
 * @module tests/golden/differenceList
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { byCodeUnit } from './byCodeUnit.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root. */
export const REPO_ROOT = path.resolve(here, '../../..');
/** The difference list, relative to the repository root. */
export const DIFFERENCES_PATH = 'server/tests/golden/differences.json';
/** The directory of the goldens, relative to the repository root. */
export const GOLDENS_PATH = 'server/tests/golden/__goldens__';

/** `proposed`: written by the author of the change. `signed`: approved by the product owner. */
export const ROW_STATES = Object.freeze(['proposed', 'signed']);

const ROW_ID = /^[a-z0-9][a-z0-9-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROW_KEYS = new Set([
  'id',
  'title',
  'state',
  'decision',
  'goldens',
  'parts',
  'pr',
  'signedBy',
  'signedOn',
  'notes'
]);

/**
 * Parse the difference list. A missing file is an empty list.
 *
 * @param {string|null} [text] - The content of `differences.json`; null or left out when there
 *   is no file.
 * @returns {Object[]} The rows.
 */
export function parseDifferenceList(text) {
  if (text === null || text === undefined || text.trim() === '') return [];
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.rows)) {
    throw new Error(`${DIFFERENCES_PATH} must be an object with a "rows" array`);
  }
  return parsed.rows;
}

const isText = value => typeof value === 'string' && value.trim() !== '';
const isTextList = value => Array.isArray(value) && value.length > 0 && value.every(isText);

/**
 * What is wrong with the rows, as sentences. An empty list means the rows are well-formed.
 *
 * A row:
 * - `id`: lower-case, unique.
 * - `title`: what differs, in one sentence.
 * - `decision`: what was decided about it, and why.
 * - `goldens`: the golden files the row is about, relative to `__goldens__` (`chat/plain.json`).
 * - `parts`: the parts of a record the row accepts as changed (`envelopes`, `modelRequests`, ...).
 * - `pr`: the pull request that changes the goldens.
 * - `state`, `signedBy`, `signedOn`: `proposed` with both null, or `signed` with the login of the
 *   product owner and the day (`YYYY-MM-DD`).
 *
 * @param {Object[]} rows
 * @returns {string[]}
 */
export function validateRows(rows) {
  const problems = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const name = `row ${index + 1}${isText(row?.id) ? ` (${row.id})` : ''}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`${name} is not an object`);
      return;
    }
    if (!isText(row.id) || !ROW_ID.test(row.id)) problems.push(`${name}: id must match ${ROW_ID}`);
    else if (seen.has(row.id)) problems.push(`${name}: the id is used twice`);
    seen.add(row.id);
    for (const key of ['title', 'decision', 'pr']) {
      if (!isText(row[key])) problems.push(`${name}: ${key} must be a non-empty text`);
    }
    for (const key of ['goldens', 'parts']) {
      if (!isTextList(row[key])) problems.push(`${name}: ${key} must be a non-empty list of texts`);
    }
    for (const golden of Array.isArray(row.goldens) ? row.goldens : []) {
      if (
        isText(golden) &&
        (!golden.endsWith('.json') || golden.startsWith('/') || golden.includes('..'))
      ) {
        problems.push(
          `${name}: golden "${golden}" must be a .json path relative to ${GOLDENS_PATH}`
        );
      }
    }
    if (!ROW_STATES.includes(row.state)) {
      problems.push(`${name}: state must be one of ${ROW_STATES.join(', ')}`);
    } else if (row.state === 'signed') {
      if (!isText(row.signedBy))
        problems.push(`${name}: a signed row names who signed it (signedBy)`);
      if (!isText(row.signedOn) || !DAY.test(row.signedOn)) {
        problems.push(`${name}: a signed row has the day it was signed (signedOn, YYYY-MM-DD)`);
      }
    } else if ((row.signedBy ?? null) !== null || (row.signedOn ?? null) !== null) {
      problems.push(`${name}: a proposed row has signedBy and signedOn set to null`);
    }
    for (const key of Object.keys(row)) {
      if (!ROW_KEYS.has(key)) problems.push(`${name}: unknown field "${key}"`);
    }
  });
  return problems;
}

/**
 * The top-level parts of a golden that differ between two versions of it.
 *
 * @param {Object|null} before - The golden at the base; null when it did not exist.
 * @param {Object|null} after - The golden now; null when it was deleted.
 * @returns {string[]} Sorted. `(deleted)` for a golden that is gone.
 */
export function changedParts(before, after) {
  if (after === null) return ['(deleted)'];
  if (before === null) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort(byCodeUnit);
}

const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Check that every changed golden is named by a row.
 *
 * A row counts for a changed golden when it lists the golden file, lists the
 * part that changed, and is itself new or changed in this pull request: a row
 * that was accepted for an earlier change does not cover a later one.
 *
 * @param {Object} params
 * @param {Array<{golden: string, before: Object|null, after: Object|null}>} params.changes - The goldens
 *   that differ from the base. `golden` is relative to `__goldens__`.
 * @param {Object[]} params.rows - The rows now.
 * @param {Object[]} [params.baseRows=[]] - The rows at the base.
 * @returns {string[]} What is missing, as sentences. Empty when every change is named.
 */
export function checkChangedGoldens({ changes, rows, baseRows = [] }) {
  const baseById = new Map(baseRows.map(row => [row.id, row]));
  const fresh = rows.filter(row => !baseById.has(row.id) || !sameRow(baseById.get(row.id), row));
  const problems = [];
  for (const { golden, before, after } of changes) {
    const parts = changedParts(before, after);
    if (parts.length === 0) continue;
    const naming = fresh.filter(row => Array.isArray(row.goldens) && row.goldens.includes(golden));
    if (naming.length === 0) {
      const stale = rows.some(row => Array.isArray(row.goldens) && row.goldens.includes(golden));
      problems.push(
        `${golden} changed (${parts.join(', ')}) and no row of ${DIFFERENCES_PATH} added or changed in ` +
          `this pull request names it.${stale ? ' A row from an earlier pull request names it, but that row was accepted for an earlier change.' : ''}`
      );
      continue;
    }
    const covered = new Set(naming.flatMap(row => (Array.isArray(row.parts) ? row.parts : [])));
    const uncovered = parts.filter(part => !covered.has(part));
    if (uncovered.length > 0) {
      problems.push(
        `${golden} changed in ${uncovered.join(', ')}, which no row that names it lists under "parts" ` +
          `(rows: ${naming.map(row => row.id).join(', ')}).`
      );
    }
  }
  return problems;
}

const SYSTEM_BINARIES = {
  git: ['/usr/bin/git', '/usr/local/bin/git', '/bin/git', '/opt/homebrew/bin/git'],
  gh: ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh']
};

/**
 * `git` or `gh` by its full path in a system directory, never through PATH,
 * which a checkout could lead with a directory of its own.
 *
 * The checks that use it run on Linux (CI) and macOS. Where the program lives
 * elsewhere (Windows), this throws like a program that is not installed: the
 * difference list test then finds no base and is skipped, and
 * `scripts/check-difference-signatures.js` ends with exit code 2.
 *
 * @param {'git'|'gh'} name
 * @returns {string} The full path.
 * @throws {Error} When the program is in none of the system directories.
 */
export function systemBinary(name) {
  const found = SYSTEM_BINARIES[name].find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`${name} is in none of ${SYSTEM_BINARIES[name].join(', ')}`);
  return found;
}

function git(args, { cwd = REPO_ROOT, allowFailure = false } = {}) {
  try {
    return execFileSync(systemBinary('git'), args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

/**
 * The commit the goldens are compared with: the merge base of the working
 * tree and the target branch.
 *
 * The target branch is `GOLDEN_BASE_REF`, else `origin/<GITHUB_BASE_REF>`, else
 * `origin/main`, else `main`.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - The repository.
 * @param {Object} [options.env=process.env]
 * @returns {{commit: string, ref: string}|null} Null when there is no git repository or none of the
 *   refs exists (a shallow checkout).
 */
export function resolveBase({ cwd = REPO_ROOT, env = process.env } = {}) {
  const candidates = [
    env.GOLDEN_BASE_REF,
    env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : null,
    'origin/main',
    'main'
  ].filter(Boolean);
  for (const ref of candidates) {
    const commit = git(['merge-base', ref, 'HEAD'], { cwd, allowFailure: true })?.trim();
    if (commit) return { commit, ref };
    // A named base that does not resolve is an error of the caller, not a reason to try the next one.
    if (ref === env.GOLDEN_BASE_REF) return null;
  }
  return null;
}

const readJson = text => (text === null ? null : JSON.parse(text));

/**
 * The goldens that differ between the base and the working tree, with both
 * versions. A golden that is new is not a change.
 *
 * @param {Object} params
 * @param {string} params.base - The commit to compare with.
 * @param {string} [params.cwd] - The repository.
 * @returns {{changes: Array<{golden: string, before: Object|null, after: Object|null}>,
 *   rows: Object[], baseRows: Object[]}}
 */
export function readChanges({ base, cwd = REPO_ROOT }) {
  const status = git(['diff', '--name-status', '--no-renames', base, '--', GOLDENS_PATH], { cwd });
  const changes = [];
  for (const line of status.split('\n').filter(Boolean)) {
    const [code, file] = line.split('\t');
    if (!file.endsWith('.json') || code === 'A') continue;
    const before = readJson(git(['show', `${base}:${file}`], { cwd, allowFailure: true }));
    const absolute = path.join(cwd, file);
    const after =
      code === 'D' || !fs.existsSync(absolute) ? null : readJson(fs.readFileSync(absolute, 'utf8'));
    changes.push({ golden: path.posix.relative(GOLDENS_PATH, file), before, after });
  }
  const listFile = path.join(cwd, DIFFERENCES_PATH);
  return {
    changes,
    rows: parseDifferenceList(fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8') : null),
    baseRows: parseDifferenceList(
      git(['show', `${base}:${DIFFERENCES_PATH}`], { cwd, allowFailure: true })
    )
  };
}
