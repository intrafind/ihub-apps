// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Child process for file-lock.test.js: stands in for one cluster worker.
 * argv: <lockPath> <counterPath> <insidePath> <iterations>
 *
 * Each iteration is a slow read-modify-write of a counter file inside the lock.
 * `insidePath` is created exclusively on entry and removed on exit, so a second
 * holder inside the section is detected directly (EEXIST) and reported.
 */
import fs from 'node:fs/promises';
import { withFileLock } from '../../utils/fileLock.js';

const [lockPath, counterPath, insidePath, iterations] = process.argv.slice(2);
let overlaps = 0;

for (let i = 0; i < Number(iterations); i++) {
  await withFileLock(
    lockPath,
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
    { timeoutMs: 60_000, pollMs: 5 }
  );
}
process.send?.({ overlaps });
