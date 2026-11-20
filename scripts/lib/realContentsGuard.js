// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Detects a test run that wrote into the real `contents/` directory of the
 * checkout.
 *
 * Tests must run on a scratch contents directory
 * (`server/tests/support/scratchContents.js`). When one does not, it creates or
 * reads the installation's master key (`contents/.encryption-key`) and writes
 * storage data next to the developer's own. `contents/` is git-ignored, so
 * `git status` does not show it; this module does.
 *
 * Usage (see `scripts/run-server-tests.js`):
 *
 * ```js
 * const before = snapshotContents(contentsDir);
 * // ... run the tests ...
 * const report = compareContents(before, snapshotContents(contentsDir));
 * if (report.violations.length > 0) process.exit(1);
 * ```
 *
 * What fails a run:
 * - a master key file (`.encryption-key`, also with a suffix) that was
 *   created, changed or removed;
 * - a file or directory below `data/` (where the storage layer keeps
 *   documents, logs, blobs and its encryption state) that was created, changed
 *   or removed, unless it is listed in {@link KNOWN_DATA_LEAKS} (leaks of older
 *   tests that are not fixed yet; they are printed as notices).
 *
 * Every other change below `contents/` is reported as a notice and does not
 * fail the run.
 *
 * A file counts as changed when its size or modification time differs; the
 * content is not read (the key must not be read by tooling).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Paths below `data/` that tests older than this guard still write. Each
 * entry is a defect of the named test, kept visible here until it is fixed.
 * Do not add an entry to get a red run green: point the test at the scratch
 * directory instead.
 *
 * @type {Array<{pattern: RegExp, reason: string}>}
 */
export const KNOWN_DATA_LEAKS = [
  {
    pattern: /^data\/audit-log(\/[^/]+\.jsonl)?$/,
    reason:
      'Older route tests (chat shares, OAuth client registration, login and logout) append ' +
      'audit lines to the real audit log during a full run. Which files do it is not known yet: ' +
      'none of them does it when it is run alone or in a group of 30.'
  },
  {
    pattern: /^data\/integration-action-usage(\/[^/]+\.jsonl)?$/,
    reason:
      'An older integration action test appends one usage line during a full run; not ' +
      'reproduced when the files are run alone or in a group of 30.'
  }
];

/**
 * Record every file and directory below a contents directory.
 *
 * @param {string} contentsDir - Absolute path; may not exist.
 * @returns {Map<string, string>} Path relative to `contentsDir` (with `/`) →
 *   `dir`, or `<size>:<mtimeMs>` for a file. Empty when the directory is absent.
 */
export function snapshotContents(contentsDir) {
  const entries = new Map();
  const walk = dir => {
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      const relative = path.relative(contentsDir, full).split(path.sep).join('/');
      if (child.isDirectory()) {
        entries.set(relative, 'dir');
        walk(full);
        continue;
      }
      try {
        const stat = fs.lstatSync(full);
        entries.set(relative, `${stat.size}:${stat.mtimeMs}`);
      } catch {
        // Removed while we were looking: not there, as far as the snapshot goes.
      }
    }
  };
  walk(contentsDir);
  return entries;
}

/** Whether a relative path is a master key file. */
function isKeyFile(relative) {
  return /^\.encryption-key([.-].*)?$/.test(relative);
}

/** Whether a relative path is storage data. */
function isStorageData(relative) {
  return relative === 'data' || relative.startsWith('data/');
}

/**
 * Compare two snapshots.
 *
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {{violations: Array<{path: string, change: string, kind: string}>,
 *   notices: Array<{path: string, change: string, kind: string}>}}
 *   `change` is `created`, `changed` or `removed`; `kind` is `key`, `storage`,
 *   `known-leak` or `other`. Both lists are sorted by path.
 */
export function compareContents(before, after) {
  const differences = [];
  for (const [relative, state] of after) {
    if (!before.has(relative)) differences.push({ path: relative, change: 'created' });
    else if (before.get(relative) !== state)
      differences.push({ path: relative, change: 'changed' });
  }
  for (const relative of before.keys()) {
    if (!after.has(relative)) differences.push({ path: relative, change: 'removed' });
  }
  differences.sort((a, b) => a.path.localeCompare(b.path));

  const violations = [];
  const notices = [];
  let dataDirectory = null;
  for (const difference of differences) {
    if (isKeyFile(difference.path)) {
      violations.push({ ...difference, kind: 'key' });
    } else if (difference.path === 'data') {
      // Judged below: the directory alone says nothing about what is in it.
      dataDirectory = difference;
    } else if (isStorageData(difference.path)) {
      const known = KNOWN_DATA_LEAKS.some(leak => leak.pattern.test(difference.path));
      (known ? notices : violations).push({
        ...difference,
        kind: known ? 'known-leak' : 'storage'
      });
    } else {
      notices.push({ ...difference, kind: 'other' });
    }
  }
  if (dataDirectory) {
    // `data` itself counts as storage data, unless everything that changed
    // below it is a known leak.
    const onlyKnown =
      !violations.some(entry => entry.kind === 'storage') &&
      notices.some(entry => entry.kind === 'known-leak');
    (onlyKnown ? notices : violations).push({
      ...dataDirectory,
      kind: onlyKnown ? 'known-leak' : 'storage'
    });
    violations.sort((x, y) => x.path.localeCompare(y.path));
    notices.sort((x, y) => x.path.localeCompare(y.path));
  }
  return { violations, notices };
}

/**
 * The report as lines of text.
 *
 * @param {{violations: Array<Object>, notices: Array<Object>}} report
 * @param {string} contentsDir - For the message.
 * @param {number} [limit=40] - Lines per list.
 * @returns {string[]} Empty when there is nothing to say.
 */
export function formatContentsReport(report, contentsDir, limit = 40) {
  const lines = [];
  const list = entries => {
    for (const entry of entries.slice(0, limit)) {
      lines.push(`  ${entry.change.padEnd(7)} ${entry.path}`);
    }
    if (entries.length > limit) lines.push(`  ... and ${entries.length - limit} more`);
  };
  if (report.violations.length > 0) {
    lines.push(
      `[contents guard] FAILED: the test run wrote into the real contents directory ${contentsDir}.`,
      '[contents guard] A test loaded server code before it pointed CONTENTS_DIR at a scratch',
      '[contents guard] directory. Make server/tests/support/scratchContents.js its first import.'
    );
    list(report.violations);
  }
  if (report.notices.length > 0) {
    lines.push(
      `[contents guard] notice: other changes below ${contentsDir} during the run (not a failure):`
    );
    list(report.notices);
  }
  return lines;
}
