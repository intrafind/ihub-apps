/**
 * The filesystem provider's **raw** namespaces driven through the shared
 * provider conformance suite.
 *
 * `server/tests/storage-filesystem-conformance.test.js` runs the same suite
 * without declaring `rawNamespaces`, and it is right not to: a raw namespace
 * is a view over an installation's real configuration directories, and the
 * suite writes to it. This runner is the other half — it points a provider's
 * config view at a scratch tree, so the raw-mode group can run for real
 * instead of being skipped everywhere.
 *
 * The provider is built with nothing but `baseDir`, which is how production
 * relates the two directories (`baseDir` is `<contents>/data`, so its parent
 * is `<contents>`). Nothing here special-cases the test: the same resolution
 * that gives a running server `contents/apps` gives this suite
 * `<scratch>/apps`.
 *
 * What the shared suite asserts for raw mode — no envelope, no owner, an etag
 * over the stored bytes, `JSON.stringify(data, null, 2)` with no trailing
 * newline, a malformed file reading as absent, a hand edit failing a
 * compare-and-set, and nothing written beside the documents — lives in
 * `server/storage/__tests__/providerConformance.js` so a future SQLite or
 * PostgreSQL provider inherits it. Only the one property that is genuinely
 * about *this* backend's on-disk layout is asserted below.
 *
 * Contract: `CONFIG_STORE_CONTRACT.md` D0 and §4.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runProviderConformance } from '../storage/__tests__/providerConformance.js';
import { CONFIG_LOCK_DIR, CONFIG_NAMESPACES, RAW_NAMESPACE_NAMES } from '../storage/namespaces.js';
import { FilesystemStorageProvider } from '../storage/providers/filesystem/index.js';

/** Directory handed out by the most recent factory call; `reuse` re-opens it. */
let lastScratchDir = null;

/**
 * Absolute path of a raw namespace's directory under a provider's config view.
 *
 * @param {FilesystemStorageProvider} provider - The provider under test
 * @param {string} ns - Raw namespace name
 * @returns {string} Absolute directory path
 */
function namespaceDir(provider, ns) {
  return path.join(provider.contentsDir, ...CONFIG_NAMESPACES[ns].dir.split('/'));
}

/**
 * Access to the bytes behind a raw namespace, for the conformance cases that
 * assert the stored representation itself.
 */
const rawFiles = {
  /**
   * @param {FilesystemStorageProvider} provider - The provider under test
   * @param {string} ns - Raw namespace name
   * @param {string} key - Document key
   * @returns {Promise<string|null>} Stored bytes, or null when absent
   */
  read: async (provider, ns, key) => {
    try {
      return await fs.readFile(path.join(namespaceDir(provider, ns), `${key}.json`), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },

  /**
   * Put bytes there behind the store's back — a hand edit, or an older
   * release's formatting.
   *
   * @param {FilesystemStorageProvider} provider - The provider under test
   * @param {string} ns - Raw namespace name
   * @param {string} key - Document key
   * @param {string} bytes - Exact file contents
   * @returns {Promise<void>}
   */
  write: async (provider, ns, key, bytes) => {
    const dir = namespaceDir(provider, ns);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${key}.json`), bytes, 'utf8');
  },

  /**
   * Everything the namespace directory holds, documents and any sidecar
   * alike — which is how the suite proves nothing was written beside a
   * configuration file.
   *
   * @param {FilesystemStorageProvider} provider - The provider under test
   * @param {string} ns - Raw namespace name
   * @returns {Promise<string[]>} Entry names
   */
  entries: async (provider, ns) => {
    try {
      return await fs.readdir(namespaceDir(provider, ns));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
};

/**
 * Build an uninitialized provider whose config view is a scratch tree.
 *
 * @param {Object} [options]
 * @param {boolean} [options.reuse=false] - Re-open the previous directory
 *   instead of creating a new one, so the restart case sees the same files.
 * @returns {Promise<{provider: FilesystemStorageProvider, cleanup: () => Promise<void>}>}
 */
async function createProvider({ reuse = false } = {}) {
  const scratchDir =
    reuse && lastScratchDir
      ? lastScratchDir
      : await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-config-raw-'));
  lastScratchDir = scratchDir;

  // Only `baseDir`: `<scratch>/data` makes `<scratch>` the contents directory
  // by the same rule production uses, and a mistake in that rule has to show
  // up here rather than being papered over by an explicit `contentsDir`.
  const provider = new FilesystemStorageProvider({
    baseDir: path.join(scratchDir, 'data'),
    flushIntervalMs: 25
  });

  return {
    provider,
    /** Idempotent — the restart case disposes two providers over one directory. */
    cleanup: async () => {
      await fs.rm(scratchDir, { recursive: true, force: true });
      if (lastScratchDir === scratchDir) lastScratchDir = null;
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
    conditionalWrites: true,
    rawNamespaces: [...RAW_NAMESPACE_NAMES]
  },
  rawFiles
});

describe('raw namespaces: on-disk layout (filesystem-specific)', () => {
  it('serializes a write to a config file without a lock beside it', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    try {
      // Two concurrent writers of the same document: the lock has to be taken,
      // so if it were taken next to the file this is where it would appear.
      await Promise.all([
        provider.documents.put('apps', 'locking', { id: 'locking', v: 1 }),
        provider.documents.put('apps', 'locking', { id: 'locking', v: 2 })
      ]);

      assert.deepEqual(
        await fs.readdir(namespaceDir(provider, 'apps')),
        ['locking.json'],
        'resourceLoader loads every *.json under contents/apps as an app — a .locks ' +
          'sidecar here would eventually be loaded as one'
      );
      assert.deepEqual(
        await fs.readdir(path.join(provider.baseDir, CONFIG_LOCK_DIR)),
        ['apps'],
        'the lock tree lives in the data directory the provider owns instead'
      );

      const stored = await provider.documents.get('apps', 'locking');
      assert.ok([1, 2].includes(stored.data.v), 'one of the two writers won outright');
      assert.equal(
        JSON.parse(await rawFiles.read(provider, 'apps', 'locking')).v,
        stored.data.v,
        'and the file holds one complete document, not two interleaved writes'
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
      // `withFileLock` runs its critical section anyway once its wait expires,
      // rather than failing — a deliberate choice for its other callers, who
      // guard bookkeeping and would rather write unguarded than hang a
      // request forever. Create-only cannot live with it: the check is a read
      // followed by a write, so two writers that both give up waiting both see
      // "absent" and both write, and the loser is told it created a document
      // it in fact destroyed. Admin POST for apps, agents and prompts maps
      // this store's conflict onto HTTP 409, so losing it means one admin's
      // new app silently replaces another's under the same id.
      //
      // Holding the lock from outside is how the test reaches that state
      // without waiting on a real second process. Both writers below wait out
      // the full timeout and then proceed with no lock at all, which is
      // exactly the production case this has to survive — and it costs the
      // lock's whole 5 s wait budget, by construction. Shortening it would
      // mean a tuning knob on the provider that exists only for this test;
      // five seconds once per CI run is the cheaper of the two.
      const lockPath = path.join(provider.baseDir, CONFIG_LOCK_DIR, 'apps', 'contended.lock');
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify({ pid: -1, at: new Date().toISOString() }));
      // The holder has to look alive for the whole wait, or it is taken over
      // as stale and the lock does its job after all — which would test
      // nothing.
      const keepAlive = setInterval(() => {
        fs.utimes(lockPath, new Date(), new Date()).catch(() => {});
      }, 1000);

      let settled;
      try {
        settled = await Promise.allSettled([
          provider.documents.put(
            'apps',
            'contended',
            { id: 'contended', by: 'first' },
            { etag: null }
          ),
          provider.documents.put(
            'apps',
            'contended',
            { id: 'contended', by: 'second' },
            { etag: null }
          )
        ]);
      } finally {
        clearInterval(keepAlive);
        await fs.rm(lockPath, { force: true });
      }

      const created = settled.filter(r => r.status === 'fulfilled');
      const rejected = settled.filter(r => r.status === 'rejected');
      assert.equal(
        created.length,
        1,
        `exactly one create-only write may succeed; ${created.length} did. ` +
          'Both winning means the second POST overwrote the first and neither admin saw a conflict.'
      );
      assert.equal(rejected.length, 1, 'and the other is told the document already exists');
      assert.equal(
        rejected[0].reason?.code,
        'ETAG_MISMATCH',
        `ConfigStore.createJson maps exactly this code onto EEXIST and then onto 409; got ${rejected[0].reason?.code}`
      );

      const stored = await provider.documents.get('apps', 'contended');
      assert.equal(
        stored.data.by,
        created[0].value.data.by,
        'and the winner is the document on disk — not overwritten by the writer that was refused'
      );
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });

  it('lists a namespace directory an installation never created as empty', async () => {
    const { provider, cleanup } = await createProvider();
    await provider.initialize();
    try {
      // `contents/locales` is absent from a default installation, and asking
      // for a translation override there must read as "no overrides" rather
      // than as an I/O failure.
      assert.deepEqual(await provider.documents.list('locales'), { items: [], nextCursor: null });
      assert.equal(await provider.documents.get('locales', 'en'), null);
      assert.equal(
        await fs.readdir(provider.contentsDir).then(entries => entries.includes('locales')),
        false,
        'and reading it did not create the directory'
      );
    } finally {
      await provider.shutdown();
      await cleanup();
    }
  });
});
