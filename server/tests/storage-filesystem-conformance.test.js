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

describe('filesystem storage provider: create-only writes (filesystem-specific)', () => {
  it('refuses to create over a document that exists but does not parse', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    try {
      await provider.documents.put('chats', 'truncated', { id: 'truncated' }, { ownerId: 'ann' });
      const docPath = path.join(provider.baseDir, 'chats', 'truncated.json');
      // What a killed write, a full disk or a hand-edit leaves behind.
      await fs.writeFile(docPath, '{"v":1,"key":"trunca', 'utf8');

      // Reading it as absent is deliberate — it keeps the store usable and is
      // what every read path here answers. Creating over it is a different
      // question: the file is somebody's chat, and "it did not parse" is a
      // reason to keep it for a human to look at, not a licence to destroy the
      // last copy. A create that judged existence by parsing would say yes.
      await assert.rejects(
        () => provider.documents.put('chats', 'truncated', { id: 'other' }, { etag: null }),
        error => error?.code === 'ETAG_MISMATCH',
        'a create-only write must not replace an unreadable document'
      );
      assert.equal(
        await fs.readFile(docPath, 'utf8'),
        '{"v":1,"key":"trunca',
        'and the bytes that were there are still there'
      );

      // The refused create must not leave its owner pointing at a document it
      // does not own. Reachable because the marker is written first, so that a
      // crash can never hide a document from its owner's listing.
      const owners = await fs
        .readdir(path.join(provider.baseDir, 'chats', '.owners'), { recursive: true })
        .catch(() => []);
      assert.equal(
        owners.filter(entry => entry.endsWith('truncated')).length,
        1,
        'exactly one owner index still claims the key — the original owner, not the refused creator'
      );
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });

  it('lets only one create-only write win even when the advisory lock is not held', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    try {
      // `withFileLock` runs its critical section anyway once its wait expires
      // rather than failing, which is right for its other callers and fatal
      // here: create-only is a read followed by a write, so two writers that
      // both give up waiting both see "absent" and both write. Holding the
      // lock from outside puts both writers in that state without a second
      // process, at the cost of the lock's full 5 s wait budget.
      const lockPath = path.join(provider.baseDir, 'chats', '.locks', 'contended.lock');
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify({ pid: -1, at: new Date().toISOString() }));
      const keepAlive = setInterval(() => {
        fs.utimes(lockPath, new Date(), new Date()).catch(() => {});
      }, 1000);

      let settled;
      try {
        settled = await Promise.allSettled([
          provider.documents.put(
            'chats',
            'contended',
            { by: 'first' },
            { etag: null, ownerId: 'ann' }
          ),
          provider.documents.put(
            'chats',
            'contended',
            { by: 'second' },
            { etag: null, ownerId: 'bob' }
          )
        ]);
      } finally {
        clearInterval(keepAlive);
        await fs.rm(lockPath, { force: true });
      }

      const created = settled.filter(r => r.status === 'fulfilled');
      assert.equal(
        created.length,
        1,
        `exactly one create-only write may succeed; ${created.length} did`
      );
      assert.equal(
        settled.find(r => r.status === 'rejected')?.reason?.code,
        'ETAG_MISMATCH',
        'and the other is told the document already exists'
      );

      const stored = await provider.documents.get('chats', 'contended');
      assert.equal(stored.data.by, created[0].value.data.by, 'the winner is what is on disk');
      assert.deepEqual(
        await provider.documents
          .list('chats', { ownerId: created[0].value.ownerId === 'ann' ? 'bob' : 'ann' })
          .then(page => page.items.map(item => item.key)),
        [],
        "and the refused creator's owner index does not claim the winner's document"
      );
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });
});

describe('filesystem storage provider: the owner index (filesystem-specific)', () => {
  it('does not hand a document to an owner the envelope disagrees with', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    try {
      await provider.documents.put('chats', 'moved', { secret: 'ann only' }, { ownerId: 'ann' });
      await provider.documents.put('chats', 'moved', { secret: 'ann only' }, { ownerId: 'bob' });

      // What a crash between the envelope write and the old marker's removal
      // leaves behind. The change of owner is three steps and only the last
      // one retires the previous index entry; lose it and Ann's index claims
      // one of Bob's documents for good, because nothing else ever re-checks.
      const annsMarker = path.join(
        provider.baseDir,
        'chats',
        '.owners',
        crypto.createHash('sha256').update('ann', 'utf8').digest('hex').slice(0, 40),
        'moved'
      );
      await fs.mkdir(path.dirname(annsMarker), { recursive: true });
      await fs.writeFile(annsMarker, '', 'utf8');

      const anns = await provider.documents.list('chats', { ownerId: 'ann' });
      assert.deepEqual(
        anns.items.map(item => item.key),
        [],
        'the envelope is the authority on who owns a document, not the index'
      );

      // And the wrong entry is gone, rather than being re-answered every time.
      // Safe only because the envelope exists and names somebody else: a
      // *missing* envelope is a put in flight and must never be pruned.
      assert.equal(
        await fs
          .access(annsMarker)
          .then(() => true)
          .catch(() => false),
        false,
        'the stale marker is pruned once it is known to be wrong'
      );

      const bobs = await provider.documents.list('chats', { ownerId: 'bob' });
      assert.deepEqual(
        bobs.items.map(item => item.key),
        ['moved'],
        'the real owner still sees it'
      );
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });
});

describe('filesystem storage provider: lease liveness (filesystem-specific)', () => {
  it('acquires the lock in the same call that evicted the dead lease', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    try {
      const name = 'interaction:evict-then-take';
      const digest = crypto.createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 40);
      const lockPath = path.join(provider.baseDir, 'locks', `${digest}.lock`);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      // A lease from a process that is long gone: TTL 1ms, written now.
      await fs.writeFile(
        lockPath,
        JSON.stringify({ owner: 'dead-worker', pid: 1, at: new Date(0).toISOString(), ttlMs: 1 })
      );

      // Eviction is a rename, a read and an unlink, so looping back to the
      // deadline guard after it means the wait budget can already be spent —
      // and the caller that cleared the dead lease is the one told the lock is
      // busy. That surfaces as a 409 ANSWER_IN_PROGRESS against a run that
      // finished whenever the dead holder died.
      //
      // `waitMs: 1` rather than the 50 ms `ANSWER_LOCK_OPTIONS` uses, because
      // the defect is timing-dependent and 50 ms makes the test a race that a
      // fast machine wins by accident. The budget is always spent by the first
      // eviction here, so the assertion is about ordering — evict, then try,
      // then check the clock — rather than about how quick the disk is. The
      // first attempt is guaranteed regardless of budget, so a 1 ms wait is
      // not a degenerate case.
      let ran = false;
      await provider.locks.withLock(
        name,
        async () => {
          ran = true;
        },
        { ttlMs: 30_000, waitMs: 1 }
      );
      assert.equal(ran, true, 'the section ran rather than timing out on a lock it just freed');
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });

  it('expires a lease whose holder wrote a timestamp from the future', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    try {
      const name = 'interaction:clock-skew';
      const digest = crypto.createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 40);
      const lockPath = path.join(provider.baseDir, 'locks', `${digest}.lock`);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      // One NTP correction, or two cluster hosts a minute apart: `at` is in
      // this reader's future. Judged on the holder's word alone the age is
      // negative, so the lease never expires and the lock is wedged for good —
      // waiters get LockTimeoutError, the caller turns it into a 503, and the
      // takeover warning that would name the lock is never reached. The file's
      // own mtime cannot drift this way, so the earlier of the two decides.
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          owner: 'skewed-worker',
          pid: 1,
          at: new Date(Date.now() + 3_600_000).toISOString(),
          ttlMs: 1
        })
      );
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      let ran = false;
      await provider.locks.withLock(
        name,
        async () => {
          ran = true;
        },
        { ttlMs: 30_000, waitMs: 200 }
      );
      assert.equal(ran, true, 'a lease older than its TTL by the filesystem clock is taken over');
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });

  it('hands back leases it still holds when the provider shuts down', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    const lockDir = path.join(provider.baseDir, 'locks');
    try {
      // A section that never settles, so the lease is still held when the
      // process goes away — a SIGTERM mid-answer, which is the ordinary way a
      // deploy ends a worker. Without a release the next worker waits out the
      // whole TTL for a lock nobody holds: 30s of 409s on an interaction.
      let release;
      const blocked = new Promise(resolve => {
        release = resolve;
      });
      const held = provider.locks.withLock('interaction:sigterm', () => blocked, {
        ttlMs: 300_000,
        waitMs: 1000
      });
      await delay(20);
      assert.equal(
        (await fs.readdir(lockDir)).filter(entry => entry.endsWith('.lock')).length,
        1,
        'the lease is on disk while the section runs'
      );

      await provider.shutdown();
      assert.deepEqual(
        (await fs.readdir(lockDir)).filter(entry => entry.endsWith('.lock')),
        [],
        'and shutdown handed it back rather than leaving it to time out'
      );
      release();
      await held;
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });
});

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
