// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Child process for storage-unfenced-lock.test.js: one cluster worker taking a
 * named lease through `FilesystemLockManager`.
 * argv: <baseDir> <name> <counterPath> <insidePath> <iterations> <fence: 'true'|'false'>
 *
 * Same shape as file-lock-worker.js: a slow read-modify-write of a counter
 * inside the lock, with an exclusively created marker that detects a second
 * holder inside the section.
 */
import fs from 'node:fs/promises';
import { FilesystemLockManager } from '../../storage/providers/filesystem/FilesystemLockManager.js';

const [baseDir, name, counterPath, insidePath, iterations, fence] = process.argv.slice(2);
const locks = new FilesystemLockManager({ baseDir, pollMs: 5 });
let overlaps = 0;

for (let i = 0; i < Number(iterations); i++) {
  await locks.withLock(
    name,
    async () => {
      try {
        await fs.writeFile(insidePath, String(process.pid), { flag: 'wx' });
      } catch {
        overlaps++;
      }
      const n = Number(await fs.readFile(counterPath, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 5));
      await fs.writeFile(counterPath, String(n + 1));
      await fs.rm(insidePath, { force: true });
    },
    { waitMs: 60_000, fence: fence !== 'false' }
  );
}
process.send?.({ overlaps });
