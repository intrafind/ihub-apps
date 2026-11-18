// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Idle fencing counters of the filesystem lock manager are swept, and tokens
 * keep growing across the sweep: the counter is clock-seeded, so a counter
 * that is gone starts again above every token issued before it.
 */
import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FilesystemLockManager } from '../storage/providers/filesystem/FilesystemLockManager.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';
import { msUntilHour } from '../storage/providers/filesystem/FilesystemStorageProvider.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const roots = [];

after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function manager() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-fence-sweep-'));
  roots.push(baseDir);
  return new FilesystemLockManager({ baseDir, pollMs: 5 });
}

/** File name the manager keeps a name's counter under. */
function fenceFile(locks, name) {
  const digest = crypto.createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 40);
  return path.join(locks.lockDir, `${digest}.fence`);
}

async function age(file, ms) {
  const then = new Date(Date.now() - ms);
  await fs.utimes(file, then, then);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

describe('sweepIdleFences', () => {
  it('removes a counter idle past the threshold and keeps a fresh one', async () => {
    const locks = await manager();
    await locks.withLock('idle', () => {});
    await locks.withLock('fresh', () => {});
    await age(fenceFile(locks, 'idle'), DAY_MS + 1000);

    const outcome = await locks.sweepIdleFences();

    assert.equal(outcome.removed, 1);
    assert.equal(await exists(fenceFile(locks, 'idle')), false);
    assert.equal(await exists(fenceFile(locks, 'fresh')), true);
  });

  it('paces itself: pauses after each batch, so a large backlog does not flood the disk', async () => {
    const locks = await manager();
    for (let i = 0; i < 5; i += 1) {
      await locks.withLock(`n${i}`, () => {});
      await age(fenceFile(locks, `n${i}`), DAY_MS + 1000);
    }
    const started = Date.now();
    const outcome = await locks.sweepIdleFences({ batch: 2, pauseMs: 60 });
    assert.equal(outcome.removed, 5);
    assert.ok(Date.now() - started >= 110, 'two pauses for five counters in batches of two');
  });

  it('keeps the counter of a name whose lease is held', async () => {
    const locks = await manager();
    await locks.withLock('held', async () => {
      await age(fenceFile(locks, 'held'), DAY_MS + 1000);
      const outcome = await locks.sweepIdleFences();
      assert.equal(outcome.busy, 1);
      assert.equal(outcome.removed, 0);
    });
    assert.equal(await exists(fenceFile(locks, 'held')), true);
  });

  it('removes counter scratch files a crash left behind', async () => {
    const locks = await manager();
    await locks.withLock('scratch', () => {});
    const leftover = `${fenceFile(locks, 'scratch')}.4242-${crypto.randomUUID()}`;
    await fs.writeFile(leftover, '{"token":1}');
    await age(leftover, DAY_MS + 1000);

    const outcome = await locks.sweepIdleFences();

    assert.equal(outcome.scratch, 1);
    assert.equal(await exists(leftover), false);
  });

  it('removes a want marker a waiter left behind, and keeps a fresh one', async () => {
    const locks = await manager();
    const stale = fenceFile(locks, 'want-stale').replace(/\.fence$/, '.lock.want');
    const fresh = fenceFile(locks, 'want-fresh').replace(/\.fence$/, '.lock.want');
    await fs.mkdir(locks.lockDir, { recursive: true });
    await fs.writeFile(stale, '');
    await fs.writeFile(fresh, '');
    await age(stale, DAY_MS + 1000);

    const outcome = await locks.sweepIdleFences();

    assert.equal(outcome.scratch, 1);
    assert.equal(await exists(stale), false);
    assert.equal(await exists(fresh), true);
  });

  it('issues a larger token after the counter was swept', async () => {
    const locks = await manager();
    const first = await locks.withLock('grow', lease => lease.token);
    await age(fenceFile(locks, 'grow'), DAY_MS + 1000);
    await locks.sweepIdleFences();
    const second = await locks.withLock('grow', lease => lease.token);
    assert.ok(second > first, `${second} > ${first}`);
  });

  it('a holder whose counter was swept is no longer current', async () => {
    const locks = await manager();
    let stale = null;
    await locks.withLock(
      'stale',
      async lease => {
        stale = lease;
        // The lease ages out under a holder that stopped renewing it.
        await new Promise(resolve => setTimeout(resolve, 80));
        await age(fenceFile(locks, 'stale'), DAY_MS + 1000);
        const outcome = await locks.sweepIdleFences();
        assert.equal(outcome.removed, 1);
        assert.equal(await lease.isCurrent(), false);
      },
      { ttlMs: 40, renewMs: 0 }
    );
    const next = await locks.withLock('stale', lease => lease.token);
    assert.ok(next > stale.token);
  });

  it('keeps a counter that ran ahead of the clock', async () => {
    const locks = await manager();
    await locks.withLock('ahead', () => {});
    const ahead = Date.now() + DAY_MS;
    await fs.writeFile(fenceFile(locks, 'ahead'), JSON.stringify({ token: ahead }));
    await age(fenceFile(locks, 'ahead'), DAY_MS + 1000);

    const outcome = await locks.sweepIdleFences();

    assert.equal(outcome.removed, 0);
    const next = await locks.withLock('ahead', lease => lease.token);
    assert.equal(next, ahead + 1, 'the token keeps growing from where it was');
  });

  it('keeps a counter when its lease was lost before the delete', async () => {
    const locks = await manager();
    await locks.withLock('lost', () => {});
    await age(fenceFile(locks, 'lost'), DAY_MS + 1000);
    // The sweep's lease is not renewed; a waiter may have taken it over.
    locks._touch = async () => false;

    const outcome = await locks.sweepIdleFences();

    assert.equal(outcome.removed, 0);
    assert.equal(await exists(fenceFile(locks, 'lost')), true);
  });

  it('stops early when asked to', async () => {
    const locks = await manager();
    await locks.withLock('a', () => {});
    await age(fenceFile(locks, 'a'), DAY_MS + 1000);
    const outcome = await locks.sweepIdleFences({ shouldStop: () => true });
    assert.equal(outcome.removed, 0);
  });
});

describe('clock-seeded fencing tokens', () => {
  it('a token is never below the clock', async () => {
    const locks = await manager();
    const before = Date.now();
    const token = await locks.withLock('clock', lease => lease.token);
    assert.ok(token >= before);
  });

  it('continues a legacy small counter from the clock', async () => {
    const locks = await manager();
    await fs.mkdir(locks.lockDir, { recursive: true });
    await fs.writeFile(fenceFile(locks, 'legacy'), JSON.stringify({ token: 5 }));
    const before = Date.now();
    const token = await locks.withLock('legacy', lease => lease.token);
    assert.ok(token >= before, `${token} >= ${before}`);
  });

  it('still grows when the clock is set back', async () => {
    const locks = await manager();
    const first = await locks.withLock('backwards', lease => lease.token);
    const realNow = Date.now;
    const now = mock.method(Date, 'now', () => realNow() - DAY_MS);
    try {
      const second = await locks.withLock('backwards', lease => lease.token);
      assert.equal(second, first + 1);
    } finally {
      now.mock.restore();
    }
  });
});

describe('the provider sweeps at night', () => {
  it('does not sweep at start; its sweep removes an idle counter', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-fence-provider-'));
    roots.push(baseDir);
    const seed = new FilesystemLockManager({ baseDir });
    await seed.withLock('old', () => {});
    await age(fenceFile(seed, 'old'), DAY_MS + 1000);

    const provider = new FilesystemStorageProvider({ baseDir });
    await provider.initialize();
    assert.equal(provider._fenceSweep, null, 'nothing runs at start');
    assert.equal(await exists(fenceFile(seed, 'old')), true);
    await provider._sweepFences();
    assert.equal(await exists(fenceFile(seed, 'old')), false);
    await provider.shutdown();
  });

  it('waits until the next occurrence of the sweep hour', () => {
    const at = (h, m) => new Date(2026, 10, 15, h, m, 0, 0);
    assert.equal(msUntilHour(3, at(1, 30)), 90 * 60 * 1000);
    assert.equal(msUntilHour(3, at(3, 0)), 24 * 60 * 60 * 1000, 'exactly at the hour: tomorrow');
    assert.equal(msUntilHour(3, at(15, 0)), 12 * 60 * 60 * 1000);
  });

  it('lets one process at a time sweep: a second worker skips while the first is at it', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-fence-one-'));
    roots.push(baseDir);
    const a = new FilesystemStorageProvider({ baseDir, fenceSweepIntervalMs: 0 });
    const b = new FilesystemStorageProvider({ baseDir, fenceSweepIntervalMs: 0 });
    await a.initialize();
    await b.initialize();
    let running = 0;
    let calls = 0;
    const slowSweep = async () => {
      calls += 1;
      running += 1;
      assert.equal(running, 1, 'two sweeps at once');
      await new Promise(resolve => setTimeout(resolve, 100));
      running -= 1;
      return { removed: 0, scratch: 0, busy: 0 };
    };
    a._locks.sweepIdleFences = slowSweep;
    b._locks.sweepIdleFences = slowSweep;
    await Promise.all([a._sweepFences(), b._sweepFences()]);
    assert.equal(calls, 1);
    await a.shutdown();
    await b.shutdown();
  });
});
