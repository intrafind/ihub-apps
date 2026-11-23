#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Checks before `npm run dev` that the dependencies declared in the package.json of the root,
 * client and server packages are installed in their node_modules.
 *
 * A checkout pulled after a dependency was added, but not reinstalled, otherwise starts fine and
 * then breaks one page at a time (Vite: "Failed to resolve import ..."). This stops the start with
 * the list of missing or outdated packages and the command that fixes them.
 *
 * Checked per package: that `node_modules/<name>/package.json` can be found the way Node resolves
 * it (the package's own node_modules, then its parents), and, for plain `x.y.z`, `^x.y.z` and
 * `~x.y.z` ranges, that the installed version satisfies the range. Other specs (URLs, `file:`,
 * tags, complex ranges) are only checked for presence.
 *
 * Skipped when CI is set, NODE_ENV is production, or SKIP_DEPS_CHECK=1.
 *
 * Usage: node scripts/check-installed-deps.js [packageDir ...]   (default: . client server)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKAGE_DIRS = ['.', 'client', 'server'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Finds the installed package.json of `name` from `packageDir` the way Node resolves it. */
function findInstalled(packageDir, name) {
  let dir = path.resolve(packageDir);
  for (;;) {
    const manifest = readJson(path.join(dir, 'node_modules', name, 'package.json'));
    if (manifest) return manifest;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Whether `installed` satisfies `range`, for the range forms package.json files here use
 * (`x.y.z`, `^x.y.z`, `~x.y.z`). Returns null when the range or version is in another form.
 */
export function satisfiesSimpleRange(installed, range) {
  const match = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(String(range || '').trim());
  const have = parseVersion(installed);
  if (!match || !have) return null;
  const [, op, base] = match;
  const want = parseVersion(base);
  if (compare(have, want) < 0) return false;
  if (op === '') return compare(have, want) === 0;
  if (op === '~') return have[0] === want[0] && have[1] === want[1];
  // ^: the left-most non-zero part must stay the same
  if (want[0] > 0) return have[0] === want[0];
  if (want[1] > 0) return have[0] === 0 && have[1] === want[1];
  return compare(have, want) === 0;
}

/**
 * Lists the declared dependencies of the package in `packageDir` that are not installed, or
 * installed in a version outside the declared range.
 *
 * @returns {{ name: string, declared: string, installed: string | null }[]}
 */
export function findDependencyProblems(packageDir) {
  const manifest = readJson(path.join(packageDir, 'package.json'));
  if (!manifest) return [];
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const problems = [];
  for (const [name, range] of Object.entries(declared)) {
    const installed = findInstalled(packageDir, name);
    if (!installed) {
      problems.push({ name, declared: range, installed: null });
    } else if (satisfiesSimpleRange(installed.version, range) === false) {
      problems.push({ name, declared: range, installed: installed.version });
    }
  }
  return problems;
}

export function shouldSkip(env = process.env) {
  return Boolean(env.CI) || env.NODE_ENV === 'production' || env.SKIP_DEPS_CHECK === '1';
}

/** Returns the report to print, or null when every package is installed. */
export function checkPackages(packageDirs, root = ROOT) {
  const sections = [];
  for (const dir of packageDirs) {
    const problems = findDependencyProblems(path.resolve(root, dir));
    if (problems.length === 0) continue;
    const label = dir === '.' ? 'root' : dir;
    const lines = problems.map(p =>
      p.installed
        ? `  - ${p.name}: ${p.installed} installed, package.json wants ${p.declared}`
        : `  - ${p.name} (${p.declared}): not installed`
    );
    sections.push(`${label}/package.json:\n${lines.join('\n')}`);
  }
  if (sections.length === 0) return null;
  return [
    'The installed dependencies do not match package.json:',
    '',
    ...sections,
    '',
    'Run "npm run install:all" and start again (set SKIP_DEPS_CHECK=1 to start anyway).'
  ].join('\n');
}

function main() {
  if (shouldSkip()) return;
  const dirs = process.argv.slice(2);
  const report = checkPackages(dirs.length > 0 ? dirs : DEFAULT_PACKAGE_DIRS);
  if (report) {
    console.error(`\n${report}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
