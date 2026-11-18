// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Child process for lock-fairness.test.js: one cluster worker hammering one
 * hot lock name with many concurrent callers.
 * argv: <mode file|manager> <path> <insidePath> <callers> <durationMs> <waitMs> [sectionMs=2]
 *   file:    <path> is the lock file for `withFileLock`
 *   manager: <path> is the base directory of a `FilesystemLockManager`
 *
 * Each section creates `insidePath` exclusively and removes it on exit, so a
 * second holder inside is seen directly (EEXIST). Reports the sections run,
 * the timeouts, the overlaps and the longest wait for the lock.
 */
import fs from 'node:fs/promises';
import { withFileLock } from '../../utils/fileLock.js';
import { FilesystemLockManager } from '../../storage/providers/filesystem/FilesystemLockManager.js';

const [mode, target, insidePath, callers, durationMs, waitMs, sectionMs = '2'] =
  process.argv.slice(2);
const manager = mode === 'manager' ? new FilesystemLockManager({ baseDir: target }) : null;
const stats = { done: 0, timeouts: 0, overlaps: 0, maxWaitMs: 0 };

const section = async () => {
  try {
    await fs.writeFile(insidePath, String(process.pid), { flag: 'wx' });
  } catch {
    stats.overlaps++;
  }
  await new Promise(resolve => setTimeout(resolve, Number(sectionMs)));
  await fs.rm(insidePath, { force: true });
};

const run = fn =>
  manager
    ? manager.withLock('hot', fn, { waitMs: Number(waitMs), fence: false })
    : withFileLock(target, fn, { timeoutMs: Number(waitMs) });

const end = Date.now() + Number(durationMs);
await Promise.all(
  Array.from({ length: Number(callers) }, async () => {
    while (Date.now() < end) {
      const asked = Date.now();
      try {
        await run(async () => {
          stats.maxWaitMs = Math.max(stats.maxWaitMs, Date.now() - asked);
          await section();
        });
        stats.done++;
      } catch (error) {
        if (error?.code !== 'LOCK_TIMEOUT') throw error;
        stats.timeouts++;
      }
    }
  })
);
process.send?.(stats);
