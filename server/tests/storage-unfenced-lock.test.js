// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `withLock(name, fn, { fence: false })`: the same exclusion without a fencing
 * token, so no counter file is read or written. And the fenced path no longer
 * tries to remove a scratch file its rename already consumed.
 */
import { fork } from 'node:child_process';
import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemLockManager } from '../storage/providers/filesystem/FilesystemLockManager.js';

const WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers/lock-manager-worker.js'
);
const roots = [];
after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function manager() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-unfenced-lock-'));
  roots.push(baseDir);
  return new FilesystemLockManager({ baseDir, pollMs: 5 });
}

describe('FilesystemLockManager: unfenced locks', () => {
  it('creates no fencing counter and hands the section no token', async () => {
    const locks = await manager();
    let seen;
    await locks.withLock(
      'chat:c1',
      async lease => {
        seen = { token: lease.token, current: await lease.isCurrent() };
      },
      { fence: false }
    );
    assert.deepEqual(seen, { token: null, current: true });
    const files = await fs.readdir(locks.lockDir);
    assert.deepEqual(
      files.filter(file => file.includes('.fence')),
      [],
      'no counter or scratch file'
    );
    assert.deepEqual(files, [], 'the lease is gone after release');
  });

  it('keeps fenced tokens growing across an unfenced acquisition of the name', async () => {
    const locks = await manager();
    let first;
    await locks.withLock('mixed', lease => (first = lease.token));
    await locks.withLock('mixed', () => {}, { fence: false });
    let next;
    await locks.withLock('mixed', lease => (next = lease.token));
    assert.ok(next > first);
  });

  it('hands an unfenced lease on in-process, but never to a fenced caller', async () => {
    const locks = await manager();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const owners = [];
    const owner = async () =>
      JSON.parse(
        await fs.readFile(
          locks.lockDir + '/' + (await fs.readdir(locks.lockDir)).find(f => f.endsWith('.lock')),
          'utf8'
        )
      ).owner;
    // One TTL and renewal for all three, so only the fence decides the hand-off.
    const opts = { ttlMs: 30_000, renewMs: 10 };
    let fenced;
    await Promise.all([
      locks.withLock('line', async () => owners.push(await owner()) && sleep(5), {
        ...opts,
        fence: false
      }),
      locks.withLock('line', async () => owners.push(await owner()), { ...opts, fence: false }),
      locks.withLock(
        'line',
        async lease => {
          // Past a renewal of the lease it would otherwise have inherited.
          await sleep(40);
          fenced = { token: lease.token, current: await lease.isCurrent() };
        },
        opts
      )
    ]);
    assert.equal(owners[0], owners[1], 'the second unfenced caller inherited the lease');
    assert.ok(fenced.token > 0);
    assert.equal(fenced.current, true, 'the fenced section holds a lease naming its token');
    assert.deepEqual(
      (await fs.readdir(locks.lockDir)).filter(f => f.endsWith('.lock')),
      []
    );
  });

  it('keeps separate processes out of each other’s sections', async () => {
    const locks = await manager();
    const baseDir = path.dirname(locks.lockDir);
    const counterPath = path.join(baseDir, 'counter.txt');
    const insidePath = path.join(baseDir, 'inside.marker');
    await fs.writeFile(counterPath, '0');
    const workers = 4;
    const iterations = 15;
    const results = await Promise.all(
      Array.from(
        { length: workers },
        () =>
          new Promise((resolve, reject) => {
            const child = fork(WORKER, [
              baseDir,
              'chat:shared',
              counterPath,
              insidePath,
              String(iterations),
              'false'
            ]);
            let message = null;
            child.on('message', m => (message = m));
            child.on('exit', code =>
              code === 0 ? resolve(message) : reject(new Error(`worker exited ${code}`))
            );
          })
      )
    );
    assert.deepEqual(
      results.map(r => r.overlaps),
      new Array(workers).fill(0),
      'two holders were inside the section at once'
    );
    assert.equal(Number(await fs.readFile(counterPath, 'utf8')), workers * iterations);
    assert.deepEqual(
      (await fs.readdir(locks.lockDir)).filter(file => file.includes('.fence')),
      []
    );
  });
});

describe('FilesystemLockManager: issuing a token', () => {
  it('removes the scratch file only when the rename did not consume it', async () => {
    const locks = await manager();
    await locks.withLock('warm', () => {});
    const unlink = mock.method(fsp, 'unlink');
    try {
      await locks.withLock('warm', () => {});
      const scratchRemovals = unlink.mock.calls.filter(call =>
        /\.fence\./.test(String(call.arguments[0]))
      );
      assert.equal(scratchRemovals.length, 0);
    } finally {
      unlink.mock.restore();
    }

    const rename = mock.method(fsp, 'rename', async () => {
      throw Object.assign(new Error('rename failed'), { code: 'EIO' });
    });
    try {
      await assert.rejects(
        locks.withLock('warm', () => {}),
        /rename failed/
      );
    } finally {
      rename.mock.restore();
    }
    const left = (await fs.readdir(locks.lockDir)).filter(file => /\.fence\./.test(file));
    assert.deepEqual(left, [], 'a failed rename leaves no scratch file');
  });
});
