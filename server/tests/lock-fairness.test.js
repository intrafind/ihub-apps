// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One hot lock name hammered by two processes with many callers each: the
 * process holding the lease hands it on to its own callers only for a bounded
 * run while the other process waits, so neither side times out, and two
 * holders are never inside at once.
 *
 * Run: node --test server/tests/lock-fairness.test.js
 */
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers/lock-hot-key-worker.js'
);
const PROCESSES = 2;
const CALLERS = 8;
const DURATION_MS = 2500;
const WAIT_MS = 2000;

async function hammer(mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-lock-fair-'));
  const target = mode === 'file' ? path.join(dir, 'hot.lock') : dir;
  try {
    return await Promise.all(
      Array.from(
        { length: PROCESSES },
        () =>
          new Promise((resolve, reject) => {
            const child = fork(WORKER, [
              mode,
              target,
              path.join(dir, 'inside.marker'),
              String(CALLERS),
              String(DURATION_MS),
              String(WAIT_MS)
            ]);
            let stats = null;
            child.on('message', m => (stats = m));
            child.on('exit', code =>
              code === 0 ? resolve(stats) : reject(new Error(`worker exited ${code}`))
            );
          })
      )
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const mode of ['file', 'manager']) {
  describe(`one hot lock over two processes (${mode === 'file' ? 'withFileLock' : 'FilesystemLockManager'})`, () => {
    it('neither process times out, and the sections never overlap', async () => {
      const results = await hammer(mode);
      assert.deepEqual(
        results.map(r => r.overlaps),
        [0, 0],
        'two holders were inside at once'
      );
      assert.deepEqual(
        results.map(r => r.timeouts),
        [0, 0],
        `a process timed out: ${JSON.stringify(results)}`
      );
      const total = results.reduce((sum, r) => sum + r.done, 0);
      for (const r of results) {
        assert.ok(r.done >= total / 5, `a process was starved: ${JSON.stringify(results)}`);
      }
    });
  });
}
