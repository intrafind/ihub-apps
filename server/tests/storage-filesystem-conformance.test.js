/**
 * The filesystem storage provider driven through the shared provider
 * conformance suite (`server/storage/__tests__/providerConformance.js`).
 *
 * Almost everything asserted here is the storage contract rather than this
 * backend, so the same expectations will hold the day a SQLite or PostgreSQL
 * provider is added and gets its own three-line runner. The one exception is
 * the group at the bottom, which reaches into the on-disk lease layout to force
 * an interleaving the public API cannot express — it is marked as
 * filesystem-specific and belongs to this runner, not to the shared suite.
 *
 * Each provider gets its own `mkdtemp` directory. `reuse: true` re-opens the
 * directory handed out by the previous call instead of making a new one —
 * that is what lets the suite simulate a restart by building a second,
 * brand-new provider instance over the same durable files.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runProviderConformance } from '../storage/__tests__/providerConformance.js';
import { LockTimeoutError } from '../storage/errors.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';

/** Directory handed out by the most recent factory call; `reuse` re-opens it. */
let lastBaseDir = null;

/**
 * Build an uninitialized filesystem provider over a scratch directory.
 *
 * @param {Object} [options]
 * @param {boolean} [options.reuse=false] - Re-open the previous directory
 *   instead of creating a new one.
 * @returns {Promise<{provider: FilesystemStorageProvider, cleanup: () => Promise<void>}>}
 */
async function createProvider({ reuse = false } = {}) {
  const baseDir =
    reuse && lastBaseDir ? lastBaseDir : await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-storage-'));
  lastBaseDir = baseDir;

  // A short flush interval keeps the buffered append-log honest without the
  // suite ever having to wait for a timer: every read flushes explicitly.
  const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 25 });

  return {
    provider,
    /** Idempotent — the restart case disposes two providers over one directory. */
    cleanup: async () => {
      await fs.rm(baseDir, { recursive: true, force: true });
      if (lastBaseDir === baseDir) lastBaseDir = null;
    }
  };
}

runProviderConformance({
  name: 'filesystem',
  createProvider,
  capabilities: {
    transactions: false,
    notifications: 'in-process',
    locking: 'advisory-single-machine',
    search: false,
    multiInstance: false,
    blobs: true,
    conditionalWrites: true
  }
});

/**
 * A lease file whose content cannot be parsed and whose modification time is an
 * hour old, so any waiter judges it abandoned — and large enough that a waiter
 * is still reading it while the takeover it is racing completes. Unparseable
 * rather than valid JSON on purpose: it keeps the waiter's read in the I/O
 * thread pool instead of blocking the event loop in a multi-megabyte
 * `JSON.parse`, which is what makes the interleaving reproducible.
 */
const ABANDONED_LEASE_BYTES = 8 * 1024 * 1024;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('filesystem storage provider: lease takeover (filesystem-specific)', () => {
  it('a waiter never removes a lease acquired after the one it judged abandoned', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-storage-lease-'));
    const provider = new FilesystemStorageProvider({ baseDir, flushIntervalMs: 1000 });
    await provider.initialize();
    try {
      const name = 'takeover-race';
      const digest = crypto.createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 40);
      const lockDir = path.join(baseDir, 'locks');
      await fs.mkdir(lockDir, { recursive: true });
      const lockPath = path.join(lockDir, `${digest}.lock`);

      await fs.writeFile(lockPath, Buffer.alloc(ABANDONED_LEASE_BYTES, 'x'));
      const anHourAgo = new Date(Date.now() - 3600_000);
      await fs.utimes(lockPath, anHourAgo, anHourAgo);
      const abandoned = await fs.stat(lockPath);

      // The lease of the worker that wins the takeover, prepared up front so
      // installing it costs a single rename.
      const incoming = `${lockPath}.incoming`;
      await fs.writeFile(
        incoming,
        JSON.stringify({
          owner: 'other-worker',
          pid: 1,
          at: new Date().toISOString(),
          ttlMs: 30_000
        })
      );

      let sectionRan = false;
      const waiter = provider.locks.withLock(
        name,
        async () => {
          sectionRan = true;
        },
        { ttlMs: 30_000, waitMs: 250 }
      );

      // Long enough for the waiter to be inside its read of the abandoned
      // lease, short enough that it cannot have finished it.
      await delay(2);
      const current = await fs.stat(lockPath).catch(() => null);
      assert.equal(
        current?.ino,
        abandoned.ino,
        'the waiter is still looking at the abandoned lease'
      );
      await fs.rename(incoming, lockPath);

      // The waiter's decision to evict was taken from the abandoned lease, so
      // it must not touch the live one that replaced it.
      await assert.rejects(waiter, LockTimeoutError, 'the waiter must not take a live lease');
      assert.equal(sectionRan, false, 'the critical section never ran');
      const held = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      assert.equal(held.owner, 'other-worker', "the live holder's lease survived");
    } finally {
      await provider.shutdown();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
