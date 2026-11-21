#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Picks what the agents end-to-end suite (`tests/e2e-agents/`) runs.
 *
 *   node tests/config/agents-run.mjs gate     # the pull request job
 *   node tests/config/agents-run.mjs matrix   # the transport matrix
 *   node tests/config/agents-run.mjs gate -- --list   # what follows `--` goes to Playwright
 *
 * - `gate`: the tests tagged `@gate`, plus every test of a spec that
 *   `agents-spec-map.json` maps to a path the change touches (a spec file that
 *   changed is always mapped to itself). Nothing tagged `@slow`. The change is
 *   `git diff` against `E2E_AGENTS_BASE` (default `origin/main`), plus what is not
 *   committed yet. When the change cannot be read, every spec is mapped.
 * - `matrix`: the tests tagged `@matrix`, once per overlay of the map's `overlays`,
 *   each on a server started with that overlay (`E2E_AGENTS_OVERLAY`, see
 *   `agents-server.mjs`). The seeded settings are not an overlay: the full run
 *   (`npm run test:e2e:agents`) covers them.
 *
 * The gate runs on every pull request (`.github/workflows/e2e.yml`). The full suite
 * and the matrix are the workflow's `full` job. The nightly workflow runs it every
 * night (`.github/workflows/nightly.yml`); it is also started by hand (Actions,
 * "End-to-end", "Run workflow") and before a slice of the stack is merged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOverlay } from './agents-contents.mjs';
import { featureRegistry } from '../../server/featureRegistry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC_DIR = 'tests/e2e-agents';
const MAP_FILE = 'tests/config/agents-spec-map.json';
const CONFIG = 'tests/config/playwright.agents.config.js';

/** The tags of the suite: every test carries at least one (`e2e-agents-suite.test.js`). */
export const TAGS = ['@gate', '@matrix', '@slow'];

/**
 * The ids an overlay's `features` may set: the features of `server/featureRegistry.js`.
 * A key the server does not know changes nothing, so a matrix run with it would
 * be a second copy of the seeded run.
 */
export const FEATURE_IDS = featureRegistry.map(feature => feature.id);

/** @returns {string[]} The spec files of the suite, by file name */
export function listSpecs(repoRoot = root) {
  return fs
    .readdirSync(path.join(repoRoot, SPEC_DIR))
    .filter(name => name.endsWith('.spec.js'))
    .sort(byCodeUnit);
}

/** @returns {{specs: Array<{paths: string[], specs: string[]|'*'}>, overlays: Object}} */
export function readSpecMap(repoRoot = root) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, MAP_FILE), 'utf8'));
}

/**
 * What is wrong with a spec map: a spec that does not exist, a path that does
 * not exist (a renamed directory would silently stop mapping), an overlay the
 * server would refuse, an overlay that sets a feature the server does not have (a
 * misspelled or renamed id: the run would test the seeded settings once more).
 *
 * @param {Object} map
 * @param {{specs: string[], pathExists: (path: string) => boolean, featureIds: string[]}} repo -
 *   `featureIds`: see {@link FEATURE_IDS}
 * @returns {string[]} Problems; empty when the map is fine
 */
export function specMapProblems(map, { specs, pathExists, featureIds }) {
  const problems = [];
  if (!Array.isArray(map?.specs)) return ['"specs" must be a list of { paths, specs } rows'];
  map.specs.forEach((row, index) => {
    const where = `specs[${index}]`;
    if (!Array.isArray(row.paths) || row.paths.length === 0) {
      problems.push(`${where}: "paths" must name at least one path`);
    } else {
      for (const mapped of row.paths) {
        if (!pathExists(mapped)) problems.push(`${where}: the path ${mapped} does not exist`);
      }
    }
    if (row.specs === '*') return;
    if (!Array.isArray(row.specs) || row.specs.length === 0) {
      problems.push(`${where}: "specs" must be "*" or a list of spec files`);
      return;
    }
    for (const spec of row.specs) {
      if (!specs.includes(spec)) problems.push(`${where}: ${SPEC_DIR}/${spec} does not exist`);
    }
  });
  for (const [name, overlay] of Object.entries(map.overlays || {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      problems.push(`overlays: "${name}" must be lower case letters, digits and hyphens`);
    }
    try {
      for (const id of Object.keys(parseOverlay(overlay).features || {})) {
        if (!featureIds.includes(id)) {
          problems.push(
            `overlays.${name}: "${id}" is not a feature id of server/featureRegistry.js`
          );
        }
      }
    } catch (error) {
      problems.push(`overlays.${name}: ${error.message}`);
    }
  }
  return problems;
}

/** Whether `file` is `mapped` or lies below it (`mapped` ends with `/` for a directory). */
const touches = (file, mapped) =>
  file === mapped || (mapped.endsWith('/') && file.startsWith(mapped));

/** Sorts like `sort()` without arguments, but says so: by code unit, not by locale. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The specs the gate runs in full for a change.
 *
 * @param {string[]|null} changed - Repository paths; `null` when the change is unknown
 * @param {Object} map - See {@link readSpecMap}
 * @param {string[]} specs - See {@link listSpecs}
 * @returns {string[]} Spec file names, sorted
 *
 * @example
 * mappedSpecs(['tests/e2e-agents/smoke.spec.js'], map, specs); // ['smoke.spec.js']
 */
export function mappedSpecs(changed, map, specs) {
  if (changed === null) return [...specs].sort(byCodeUnit);
  const picked = new Set();
  for (const file of changed) {
    if (file.startsWith(`${SPEC_DIR}/`) && specs.includes(file.slice(SPEC_DIR.length + 1))) {
      picked.add(file.slice(SPEC_DIR.length + 1));
    }
    for (const row of map.specs) {
      if (!row.paths.some(mapped => touches(file, mapped))) continue;
      for (const spec of row.specs === '*' ? specs : row.specs) picked.add(spec);
    }
  }
  return [...picked].sort(byCodeUnit);
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Playwright's arguments for the gate: `@gate` or a mapped spec file, never
 * `@slow`. Playwright matches `--grep` against the file path, the titles and the
 * tags of a test, so one expression selects by tag and by file.
 *
 * @param {string[]} specs - From {@link mappedSpecs}
 * @returns {string[]}
 */
export function gateArgs(specs) {
  // The file name stands between the project name and the first title.
  const files = specs.map(spec => `(?<= )${escapeRegExp(spec)}(?= )`);
  return ['--grep', ['@gate', ...files].join('|'), '--grep-invert', '@slow'];
}

const GIT_BINARIES = ['/usr/bin/git', '/usr/local/bin/git', '/bin/git', '/opt/homebrew/bin/git'];

/**
 * git by its full path in a system directory, never through PATH, which a checkout
 * could lead with a directory of its own. Where git lives elsewhere (Windows), this
 * throws and the caller selects every spec.
 */
function gitBinary() {
  const found = GIT_BINARIES.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('git is in none of the system directories');
  return found;
}

/**
 * The paths a change touches: the commits since the merge base with `base`, and
 * what is not committed. `null` when git cannot tell.
 *
 * A moved file counts under both paths (`--no-renames`): with git's rename
 * detection only the new one is listed, and a file moved out of a mapped
 * directory would not count as a change to it.
 *
 * @param {string} base - A git revision
 * @param {string} [repoRoot]
 * @returns {string[]|null}
 */
export function changedPaths(base, repoRoot = root) {
  const git = (...args) =>
    execFileSync(gitBinary(), args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  try {
    const [mergeBase] = git('merge-base', base, 'HEAD');
    return [
      ...new Set([
        ...git('diff', '--name-only', '--no-renames', mergeBase, 'HEAD'),
        ...git('diff', '--name-only', '--no-renames', 'HEAD'),
        ...git('ls-files', '--others', '--exclude-standard')
      ])
    ];
  } catch (error) {
    console.error(
      `[agents-run] cannot read the change against ${base}: ${String(error.message).split('\n')[0]}`
    );
    return null;
  }
}

function playwright(args, env = {}) {
  const result = spawnSync(
    path.join(root, 'node_modules', '.bin', 'playwright'),
    ['test', '--config', CONFIG, ...args],
    { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }
  );
  return result.status ?? 1;
}

function main(argv) {
  const [mode, ...rest] = argv;
  const extra = rest[0] === '--' ? rest.slice(1) : rest;
  const map = readSpecMap();
  const specs = listSpecs();
  const problems = specMapProblems(map, {
    specs,
    pathExists: mapped => fs.existsSync(path.join(root, mapped)),
    featureIds: FEATURE_IDS
  });
  if (problems.length > 0) {
    console.error(`[agents-run] ${MAP_FILE}:\n  ${problems.join('\n  ')}`);
    return 1;
  }

  if (mode === 'gate') {
    const base = process.env.E2E_AGENTS_BASE || 'origin/main';
    const mapped = mappedSpecs(changedPaths(base), map, specs);
    console.log(
      `[agents-run] gate: @gate${mapped.length ? ` plus ${mapped.join(', ')}` : ''} (change against ${base})`
    );
    return playwright([...gateArgs(mapped), ...extra]);
  }

  if (mode === 'matrix') {
    const overlays = Object.entries(map.overlays || {});
    if (overlays.length === 0) {
      console.log('[agents-run] matrix: the spec map defines no overlay; nothing to run');
      return 0;
    }
    let status = 0;
    for (const [name, overlay] of overlays) {
      console.log(`[agents-run] matrix: overlay ${name} ${JSON.stringify(overlay)}`);
      const code = playwright(['--grep', '@matrix', ...extra], {
        E2E_AGENTS_OVERLAY: JSON.stringify(overlay),
        E2E_AGENTS_OVERLAY_NAME: name
      });
      if (code !== 0) {
        console.error(`[agents-run] matrix: overlay ${name} failed (exit code ${code})`);
        status = code;
      }
    }
    return status;
  }

  console.error(
    'Usage: node tests/config/agents-run.mjs <gate|matrix> [-- <playwright arguments>]'
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
