// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Child process for file-lock.test.js: one cluster worker whose callers keep a
 * single lock busy, so its own line never runs empty.
 * argv: <lockPath> <callers> <durationMs>
 *
 * Reports how many sections ran and how many callers timed out.
 */
import { withFileLock } from '../../utils/fileLock.js';

const [lockPath, callers, durationMs] = process.argv.slice(2);
const stats = { done: 0, timeouts: 0 };
const end = Date.now() + Number(durationMs);

await Promise.all(
  Array.from({ length: Number(callers) }, async () => {
    while (Date.now() < end) {
      try {
        await withFileLock(lockPath, () => new Promise(resolve => setTimeout(resolve, 5)));
        stats.done++;
      } catch (error) {
        if (error?.code !== 'LOCK_TIMEOUT') throw error;
        stats.timeouts++;
      }
    }
  })
);
process.send?.(stats);
