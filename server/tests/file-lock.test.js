// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `withFileLock` is a real lock: the critical section never runs unguarded.
 *
 * Covers what the old implementation got wrong — it ran the section anyway when
 * the wait expired, stole a stale lock non-atomically, unlinked a lock it no
 * longer owned on release, and never renewed a lock a long section was holding.
 */
import { fork } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { touchLease, withFileLock } from '../utils/fileLock.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const STEAL_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers/file-lock-steal-worker.js'
);
const WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers/file-lock-worker.js'
);

let dir;
before(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-file-lock-'));
});
after(() => fsSync.rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const lockPathFor = () => path.join(dir, `l${++seq}.lock`);

/** Make a lock file look abandoned: a dead holder's marker, an hour old. */
async function plantStaleLock(lockPath, ownerLess = false) {
  const body = ownerLess ? '' : JSON.stringify({ pid: 1, at: new Date(0).toISOString() });
  await fs.writeFile(lockPath, body);
  const old = new Date(Date.now() - 3600_000);
  await fs.utimes(lockPath, old, old);
}

describe('withFileLock', () => {
  it('N concurrent holders (separate processes) never overlap in the critical section', async () => {
    const lockPath = lockPathFor();
    const counterPath = path.join(dir, 'counter.txt');
    const insidePath = path.join(dir, 'inside.marker');
    await fs.writeFile(counterPath, '0');
    const workers = 4;
    const iterations = 15;
    const results = await Promise.all(
      Array.from(
        { length: workers },
        () =>
          new Promise((resolve, reject) => {
            const child = fork(WORKER, [lockPath, counterPath, insidePath, String(iterations)]);
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
  });

  it('two waiters racing on one stale lock cannot both enter', async () => {
    // The old steal was `read marker → unlink`: both waiters read the same
    // stale marker, A unlinked and created its lock, B unlinked A's fresh lock.
    // The race is narrow, so repeat it.
    for (let trial = 0; trial < 100; trial++) {
      const lockPath = lockPathFor();
      await plantStaleLock(lockPath);
      let inside = 0;
      let maxInside = 0;
      const section = async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(3);
        inside--;
      };
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withFileLock(lockPath, section, { staleMs: 1000, pollMs: 0 })
        )
      );
      assert.equal(maxInside, 1, `trial ${trial}: ${maxInside} holders inside at once`);
    }
  });

  it('waiters in separate processes racing on one stale lock cannot both enter', async () => {
    // Real parallelism: all processes are released at once onto the same
    // abandoned lock. The old steal was `read marker -> unlink`, so one waiter
    // could unlink the fresh lock another had just created.
    const children = 6;
    let overlaps = 0;
    for (let round = 0; round < 8; round++) {
      const lockPath = lockPathFor();
      const insidePath = `${lockPath}.inside`;
      const goPath = `${lockPath}.go`;
      await plantStaleLock(lockPath);
      const all = Array.from(
        { length: children },
        () =>
          new Promise((resolve, reject) => {
            const child = fork(STEAL_WORKER, [lockPath, insidePath, goPath]);
            let message = null;
            child.on('message', m => (message = m));
            child.on('exit', code =>
              code === 0 ? resolve(message) : reject(new Error(`worker exited ${code}`))
            );
          })
      );
      await sleep(400); // let every child finish booting and reach the barrier
      await fs.writeFile(goPath, '');
      for (const result of await Promise.all(all)) if (result.overlap) overlaps++;
    }
    assert.equal(overlaps, 0, `${overlaps} waiter(s) entered while another held the lock`);
  });

  it('an unparseable stale lock is also taken over by exactly one waiter', async () => {
    const lockPath = lockPathFor();
    await plantStaleLock(lockPath, true);
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      [0, 1].map(() =>
        withFileLock(
          lockPath,
          async () => {
            inside++;
            maxInside = Math.max(maxInside, inside);
            await sleep(15);
            inside--;
          },
          { staleMs: 1000, pollMs: 1 }
        )
      )
    );
    assert.equal(maxInside, 1);
  });

  it("a holder whose lock expired does not delete the new owner's lock on release", async () => {
    const lockPath = lockPathFor();
    let thiefHasLock;
    const thiefReady = new Promise(resolve => (thiefHasLock = resolve));
    let releaseThief;
    const thiefGate = new Promise(resolve => (releaseThief = resolve));

    // renewMs: 0 — no heartbeat, so the lease genuinely ages out under the holder.
    const first = withFileLock(
      lockPath,
      async () => {
        await sleep(250);
      },
      { staleMs: 100, renewMs: 0 }
    );
    await sleep(20);
    const thief = withFileLock(
      lockPath,
      async () => {
        thiefHasLock();
        await thiefGate;
      },
      { staleMs: 100, timeoutMs: 2000, pollMs: 10 }
    );
    await thiefReady; // the thief took the expired lock over
    await first; // the original holder finishes and releases
    assert.ok(
      fsSync.existsSync(lockPath),
      "the original holder's release deleted the new owner's lock"
    );
    releaseThief();
    await thief;
    assert.ok(!fsSync.existsSync(lockPath), 'the lock is released once its owner is done');
  });

  it('a long section keeps its lock via heartbeat and is not stolen', async () => {
    const lockPath = lockPathFor();
    let entered = false;
    let sectionDone = false;
    const holder = withFileLock(
      lockPath,
      async () => {
        await sleep(700); // several times staleMs
        sectionDone = true;
      },
      { staleMs: 150 }
    );
    await sleep(30);
    await assert.rejects(
      withFileLock(
        lockPath,
        async () => {
          entered = true;
        },
        { staleMs: 150, timeoutMs: 450, pollMs: 10 }
      ),
      err => err.code === 'LOCK_TIMEOUT'
    );
    assert.equal(entered, false, 'a live holder was preempted while it was still writing');
    assert.equal(sectionDone, false);
    await holder;
  });

  it('throws on timeout instead of running the section unlocked', async () => {
    const lockPath = lockPathFor();
    let ran = false;
    const holder = withFileLock(lockPath, () => sleep(500), { staleMs: 60_000 });
    await sleep(20);
    await assert.rejects(
      withFileLock(
        lockPath,
        async () => {
          ran = true;
        },
        { staleMs: 60_000, timeoutMs: 100, pollMs: 10 }
      ),
      err =>
        err.name === 'LockTimeoutError' && err.code === 'LOCK_TIMEOUT' && err.httpStatus === 503
    );
    assert.equal(ran, false);
    await holder;
  });

  it('releases the lock when the section throws, rethrowing its error unchanged', async () => {
    const lockPath = lockPathFor();
    const boom = new Error('boom');
    await assert.rejects(
      withFileLock(lockPath, async () => {
        throw boom;
      }),
      err => err === boom
    );
    assert.ok(!fsSync.existsSync(lockPath));
    assert.equal(await withFileLock(lockPath, async () => 'ok'), 'ok');
  });

  it('keeps renewing after a transient read error instead of treating the lease as lost', async () => {
    const lockPath = lockPathFor();
    await fs.writeFile(lockPath, JSON.stringify({ owner: 'me', at: new Date().toISOString() }));
    const realOpen = fs.open;
    // A handle whose read fails once, as a hiccup on a network volume would.
    mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      handle.readFile = async () => {
        throw Object.assign(new Error('read failed'), { code: 'EIO' });
      };
      return handle;
    });
    try {
      assert.equal(
        await touchLease(lockPath, 'me', 1000, 'test', undefined),
        true,
        'a failed read is not evidence that the lease was taken over'
      );
    } finally {
      mock.restoreAll();
    }
    // A readable lease of another owner is still reported as lost.
    await fs.writeFile(lockPath, JSON.stringify({ owner: 'someone-else' }));
    assert.equal(await touchLease(lockPath, 'me', 1000, 'test', undefined), false);
  });
});
