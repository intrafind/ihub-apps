// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the architecture guards share: the server's own source files and their
 * code without comments, and an allow-list format whose every entry gives its
 * reason.
 *
 * A guard scans a root (the server directory, or the directory of a scratch
 * fixture in its own test) and reports the files whose code makes a call the
 * guard forbids, by the name of the rule. An allow-list entry names a file and
 * the rules it may break; a listed file that no longer breaks one of them is
 * reported too, so the list never outlives what it excuses.
 *
 * @module tests/architecture/sourceScan
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { byCodeUnit } from '../golden/byCodeUnit.js';

/** The server directory. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Directories never scanned: dependencies, tests, shipped content. */
const SKIPPED_DIRS = new Set(['node_modules', 'tests', 'defaults']);

/**
 * The JavaScript files under `dir`, as paths relative to `root` with `/`.
 *
 * @param {string} root
 * @param {Object} [options]
 * @param {string[]} [options.under] - only these directories of the root (relative)
 * @param {string[]} [options.skip] - further directories (relative to the root) to leave out
 * @returns {Promise<string[]>} sorted
 */
export async function sourceFiles(root, { under = ['.'], skip = [] } = {}) {
  const skipped = new Set(skip.map(dir => path.normalize(dir)));
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || skipped.has(path.normalize(rel))) continue;
        await walk(full);
      } else if (/\.(c|m)?js$/.test(entry.name)) {
        files.push(rel.split(path.sep).join('/'));
      }
    }
  }
  for (const dir of under) await walk(path.join(root, dir));
  return files.sort(byCodeUnit);
}

/**
 * The source without its comments, line by line, so a doc comment never counts.
 *
 * @param {string} source
 * @returns {string}
 */
export function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

/**
 * The rules a piece of code breaks.
 *
 * @param {string} code - without comments ({@link codeOf})
 * @param {Object<string, (code: string) => boolean>} rules - name → whether the code breaks it
 * @returns {string[]} the names, sorted
 */
export function brokenRules(code, rules) {
  return Object.entries(rules)
    .filter(([, breaks]) => breaks(code))
    .map(([name]) => name)
    .sort(byCodeUnit);
}

/**
 * Every file under the root that breaks a rule, with the rules it breaks.
 *
 * @param {string} root
 * @param {Object<string, Function>} rules
 * @param {Object} [options] - see {@link sourceFiles}; `exclude(rel)` leaves a file out
 * @returns {Promise<Map<string, string[]>>}
 */
export async function scan(root, rules, { exclude = () => false, ...options } = {}) {
  const found = new Map();
  for (const rel of await sourceFiles(root, options)) {
    if (exclude(rel)) continue;
    const broken = brokenRules(codeOf(await fs.readFile(path.join(root, rel), 'utf8')), rules);
    if (broken.length > 0) found.set(rel, broken);
  }
  return found;
}

/**
 * What a scan found that the allow-list does not excuse, and the entries that
 * excuse more than the file does.
 *
 * @param {Map<string, string[]>} found - {@link scan}
 * @param {Array<{path: string, rules: string[]}>} entries
 * @returns {{unlisted: string[], stale: string[]}} `<path>: <rule>` lines, sorted
 */
export function compareWithAllowList(found, entries) {
  const allowed = new Map(entries.map(entry => [entry.path, new Set(entry.rules)]));
  const unlisted = [];
  for (const [rel, rules] of found) {
    for (const rule of rules) if (!allowed.get(rel)?.has(rule)) unlisted.push(`${rel}: ${rule}`);
  }
  const stale = [];
  for (const entry of entries) {
    const rules = found.get(entry.path) || [];
    for (const rule of entry.rules) if (!rules.includes(rule)) stale.push(`${entry.path}: ${rule}`);
  }
  return { unlisted: unlisted.sort(byCodeUnit), stale: stale.sort(byCodeUnit) };
}

/**
 * What is wrong with the entries of an allow-list: every entry names a file
 * once, the rules it may break (known ones), a reason, and the issue that
 * removes it (`#<number>`) or, where `removal` is null, a reason that says why
 * it stays.
 *
 * @param {Array<Object>} entries
 * @param {string[]} knownRules
 * @param {Object} [options]
 * @param {boolean} [options.removalRequired=true]
 * @returns {string[]}
 */
export function allowListProblems(entries, knownRules, { removalRequired = true } = {}) {
  const problems = [];
  const seen = new Set();
  if (!Array.isArray(entries) || entries.length === 0) return ['the allow-list has no entries'];
  for (const entry of entries) {
    const name = typeof entry?.path === 'string' ? entry.path : JSON.stringify(entry);
    if (typeof entry?.path !== 'string') problems.push(`${name}: a path`);
    if (seen.has(entry.path)) problems.push(`${name} is listed twice`);
    seen.add(entry.path);
    if (!Array.isArray(entry.rules) || entry.rules.length === 0) {
      problems.push(`${name}: the rules it may break`);
    } else {
      for (const rule of entry.rules) {
        if (!knownRules.includes(rule)) problems.push(`${name}: unknown rule ${rule}`);
      }
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length <= 20) {
      problems.push(`${name}: a reason`);
    }
    const removal = entry.removal ?? null;
    if (removal === null ? removalRequired : !/^#\d+$/.test(String(removal))) {
      problems.push(`${name}: the removal issue (#<number>)`);
    }
  }
  return problems;
}
