// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Child process for file-lock.test.js: one of several waiters that all find the
 * same abandoned lock. argv: <lockPath> <insidePath> <goPath>
 *
 * Spins until `goPath` exists so the processes start together, then takes the
 * lock once. Reports whether another holder was inside the section with it.
 */
import fs from 'node:fs';
import { withFileLock } from '../../utils/fileLock.js';

const [lockPath, insidePath, goPath] = process.argv.slice(2);
while (!fs.existsSync(goPath)) {
  // busy-wait: a sleep would let the processes drift apart
}
let overlap = false;
await withFileLock(
  lockPath,
  async () => {
    try {
      fs.writeFileSync(insidePath, String(process.pid), { flag: 'wx' });
    } catch {
      overlap = true;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
    if (!overlap) fs.rmSync(insidePath, { force: true });
  },
  { staleMs: 1000, timeoutMs: 30_000, pollMs: 1 }
);
process.send?.({ overlap });
