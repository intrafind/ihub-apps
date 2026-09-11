/**
 * Storage provider conformance suite — the acceptance gate for every backend.
 *
 * What this file asserts is the storage *contract*, not any one implementation:
 * it is written against `DocumentStore`, `AppendLog`, `ChangeNotifier` and
 * `LockManager` as documented, and imports nothing provider-specific. A new
 * backend (SQLite, PostgreSQL, OpenSearch) is finished when it passes this
 * suite unchanged — which only means something as long as the suite stays free
 * of assumptions that merely happen to hold for the filesystem provider. Values
 * the contract fixes (the sha256 etag, the byte size) are therefore recomputed
 * here from first principles instead of being compared against whatever the
 * provider returned.
 *
 * Ordering is driven by observed order rather than by wall-clock waits:
 * contention cases hand control back and forth through deferred promises, so
 * they stay decisive on a loaded CI machine. The few short waits that remain
 * are all well under a tenth of a second and exist because the property under
 * test is itself temporal — a lease that has to age past its TTL, a stream that
 * has to be older than a retention cut-off.
 *
 * Cases are independent: each one works in its own namespace, stream or lock
 * name, and anything that outlives a case (a subscription, an extra provider
 * instance) is torn down in a `finally`.
 *
 * @module storage/__tests__/providerConformance
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  EtagMismatchError,
  InvalidKeyError,
  LockTimeoutError,
  NotSupportedError,
  StorageError
} from '../errors.js';

/** ISO-8601 instant with an optional fractional part — the Document timestamp format. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Lowercase sha256 digest; the contract fixes the etag algorithm so it is portable. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Every value `Capabilities.notifications` is allowed to take. */
const NOTIFICATION_MODES = ['in-process', 'push', 'poll', 'none'];

/** Every value `Capabilities.locking` is allowed to take. */
const LOCKING_MODES = ['none', 'advisory-single-machine', 'distributed'];

/** Identifiers every provider must refuse: traversal, empty, and a path separator. */
const INVALID_IDS = ['../x', '', 'a/b'];

/** Milliseconds a case may wait for something that is genuinely time-based. */
const SHORT_WAIT_MS = 45;

let idCounter = 0;

/**
 * A collision-free identifier, so no two cases can share a namespace, a stream
 * or a lock name and observe each other's writes.
 *
 * @param {string} prefix - Readable prefix identifying the case
 * @returns {string} Identifier that is also a valid namespace/key
 */
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A promise together with its settle functions.
 *
 * This is how the suite orders two concurrent operations without sleeping: the
 * operation that must go first resolves the deferred, the other one awaits it.
 *
 * @returns {{promise: Promise<any>, resolve: Function, reject: Function}}
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Poll until `predicate` holds. Used only where the contract allows delivery to
 * be asynchronous, so a provider that dispatches events on a later tick is not
 * failed for it.
 *
 * @param {() => (boolean|Promise<boolean>)} predicate - Condition to wait for
 * @param {string} description - What is being waited for, for the failure message
 * @param {number} [timeoutMs=2000] - Give-up budget
 * @returns {Promise<void>}
 */
async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(5);
  }
}

/**
 * The etag the contract prescribes: sha256 of the serialized data.
 *
 * @param {any} data - Document body
 * @returns {string} Hex digest
 */
function contractEtag(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * The size the contract prescribes: byte length of the serialized data.
 *
 * @param {any} data - Document body
 * @returns {number} Bytes
 */
function contractSize(data) {
  return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

/**
 * The bytes a raw namespace stores for a document body.
 *
 * A raw namespace is a view over files an installation edits by hand, so its
 * serialization is fixed by compatibility rather than chosen: two-space
 * indent, no trailing newline — exactly what the configuration tooling has
 * always written. Recomputed here rather than read back from the provider,
 * like every other value the contract fixes.
 *
 * @param {any} data - Document body
 * @returns {string} The stored bytes
 */
function rawBytes(data) {
  return JSON.stringify(data, null, 2);
}

/**
 * The etag a raw namespace reports: sha256 of the stored bytes.
 *
 * Deliberately not {@link contractEtag}. In a raw namespace the file is the
 * document, so two files whose parsed data is equal but whose formatting
 * differs are different documents — that is what lets a compare-and-set
 * notice a hand edit.
 *
 * @param {string} bytes - Stored bytes
 * @returns {string} Hex digest
 */
function rawEtag(bytes) {
  return crypto.createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/**
 * Assert the envelope fields every Document carries, independent of its body.
 *
 * @param {Object} doc - Document returned by the store
 * @param {string} ns - Namespace it was asked for
 * @param {string} key - Key it was asked for
 * @returns {void}
 */
function assertDocumentShape(doc, ns, key) {
  assert.ok(doc, `expected a document for ${ns}/${key}`);
  assert.equal(doc.ns, ns, 'document echoes its namespace');
  assert.equal(doc.key, key, 'document echoes its key');
  assert.equal(typeof doc.contentType, 'string', 'contentType is a string');
  assert.match(doc.createdAt, ISO_8601, 'createdAt is ISO-8601');
  assert.match(doc.updatedAt, ISO_8601, 'updatedAt is ISO-8601');
  assert.match(doc.etag, SHA256_HEX, 'etag is a sha256 hex digest');
  assert.equal(typeof doc.size, 'number', 'size is a number');
  assert.ok(doc.ownerId === null || typeof doc.ownerId === 'string', 'ownerId is a string or null');
}

/**
 * Build and initialize a provider through the runner's factory.
 *
 * The suite — not the factory — calls `initialize()`, so the lifecycle group can
 * assert what initialization does. `dispose()` is idempotent so a case can shut
 * a provider down early (the restart case does) and still dispose in a `finally`.
 *
 * @param {Function} createProvider - Runner factory:
 *   `(options?: {reuse?: boolean}) => Promise<{provider: Object, cleanup: Function}>`.
 * @param {{reuse?: boolean}} [options] - Passed through to the factory
 * @returns {Promise<{provider: Object, dispose: () => Promise<void>}>}
 */
async function startProvider(createProvider, options) {
  const { provider, cleanup } = await createProvider(options);
  await provider.initialize();
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await provider.shutdown();
    if (typeof cleanup === 'function') await cleanup();
  };
  return { provider, dispose };
}

/**
 * Run the storage conformance suite against one provider.
 *
 * Call this at the top level of a `node --test` file; it declares the whole
 * suite as `describe`/`it` blocks.
 *
 * @param {Object} options
 * @param {string} options.name - Provider name, used in the suite title and
 *   asserted against `provider.name` and `healthCheck().provider`.
 * @param {(options?: {reuse?: boolean}) => Promise<{provider: Object, cleanup: Function}>}
 *   options.createProvider - Builds a fresh, **uninitialized** provider over a
 *   fresh scratch location, plus a cleanup that removes that location and is
 *   safe to call more than once. Called with `{ reuse: true }` it must return a
 *   brand-new provider instance over the location handed out by the *previous*
 *   call — that is how the restart-recovery case gets a second process's view
 *   of the same durable data.
 * @param {Object} options.capabilities - The exact object
 *   `getCapabilities()` is expected to return. `rawNamespaces` is the one
 *   optional member: name the raw namespaces here and the raw-mode group below
 *   runs against the first of them, leave it out and that group is skipped
 *   while the rest of the suite is unaffected. Leaving it out is the right
 *   choice unless the factory pointed the provider's raw location at a scratch
 *   directory — a raw namespace is a view over an installation's real
 *   configuration files, and the suite writes to it.
 * @param {Object} [options.rawFiles] - Access to the bytes behind a raw
 *   namespace, for the cases that assert the stored representation itself:
 *   `read(provider, ns, key) => Promise<string|null>` returns the stored bytes
 *   for a document key, `write(provider, ns, key, bytes) => Promise<void>`
 *   puts bytes there behind the store's back (a hand edit), and
 *   `entries(provider, ns) => Promise<string[]>` lists everything the backing
 *   location holds — which is how the suite proves no sidecar was written
 *   beside a configuration file. Omitted, those cases are skipped.
 * @returns {void}
 */
export function runProviderConformance({ name, createProvider, capabilities, rawFiles }) {
  assert.equal(typeof name, 'string', 'runProviderConformance needs a provider name');
  assert.equal(typeof createProvider, 'function', 'runProviderConformance needs a factory');
  assert.ok(capabilities && typeof capabilities === 'object', 'expected capabilities are required');

  // `rawNamespaces` is asserted separately from the rest of the capability set
  // so a provider may report it while a runner that does not exercise raw mode
  // stays a three-line runner.
  const { rawNamespaces: expectedRawNamespaces, ...expectedCoreCapabilities } = capabilities;
  const rawNamespace =
    Array.isArray(expectedRawNamespaces) && expectedRawNamespaces.length > 0
      ? expectedRawNamespaces[0]
      : null;

  /** Skip reasons for the facets a provider may legitimately not offer. */
  const skipWithoutBlobs = capabilities.blobs ? false : 'provider reports blobs: false';
  const skipWithoutLocks =
    capabilities.locking === 'none' ? "provider reports locking: 'none'" : false;
  const skipWithoutEvents =
    capabilities.notifications === 'none' ? "provider reports notifications: 'none'" : false;
  const skipWithoutCas = capabilities.conditionalWrites
    ? false
    : 'provider reports conditionalWrites: false';
  const skipWithoutRaw = rawNamespace ? false : 'runner declares no raw namespaces';
  const skipWithoutRawFiles =
    skipWithoutRaw || (rawFiles ? false : 'runner supplies no rawFiles access');

  describe(`storage conformance: ${name}`, () => {
    /**
     * One initialized provider serves every case that does not need an instance
     * of its own; cases stay independent through unique namespaces and streams.
     */
    let shared = null;
    let disposeShared = null;

    before(async () => {
      const started = await startProvider(createProvider);
      shared = started.provider;
      disposeShared = started.dispose;
    });

    after(async () => {
      const dispose = disposeShared;
      shared = null;
      disposeShared = null;
      if (dispose) await dispose();
    });

    describe('lifecycle', () => {
      it('initialize() is idempotent', async () => {
        const { provider, dispose } = await startProvider(createProvider);
        try {
          // startProvider already initialized it; a second call must be a no-op
          // rather than re-creating state or throwing.
          await provider.initialize();
          await provider.initialize();
          const ns = nextId('lifecycle');
          await provider.documents.put(ns, 'k', { ok: true });
          assert.deepEqual((await provider.documents.get(ns, 'k')).data, { ok: true });
        } finally {
          await dispose();
        }
      });

      it('healthCheck() reports the provider as ok', async () => {
        const health = await shared.healthCheck();
        assert.equal(health.status, 'ok');
        assert.equal(health.provider, name);
        assert.equal(shared.name, name, 'provider.name matches the registry name');
        assert.equal(typeof health.latencyMs, 'number');
        assert.ok(health.latencyMs >= 0, 'latencyMs is not negative');
      });

      it('getCapabilities() reports the expected, well-formed capability set', () => {
        const caps = shared.getCapabilities();
        const { rawNamespaces, ...core } = caps;
        assert.deepEqual(core, expectedCoreCapabilities);
        if (expectedRawNamespaces === undefined) {
          // A provider may serve raw namespaces the runner chose not to
          // exercise, but it must still describe them in a usable shape —
          // callers branch on this to know an owner has no meaning there.
          assert.ok(
            rawNamespaces === undefined ||
              (Array.isArray(rawNamespaces) &&
                rawNamespaces.every(ns => typeof ns === 'string' && ns.length > 0)),
            'rawNamespaces, when reported, is an array of namespace names'
          );
        } else {
          assert.deepEqual(rawNamespaces, expectedRawNamespaces, 'the raw namespaces are reported');
        }
        assert.equal(typeof caps.transactions, 'boolean');
        assert.ok(NOTIFICATION_MODES.includes(caps.notifications), 'notifications is in the enum');
        assert.ok(LOCKING_MODES.includes(caps.locking), 'locking is in the enum');
        assert.equal(typeof caps.search, 'boolean');
        assert.equal(typeof caps.multiInstance, 'boolean');
        assert.equal(typeof caps.blobs, 'boolean');
        assert.equal(typeof caps.conditionalWrites, 'boolean');
        // Declared, not merely present when a provider happens to serve raw
        // namespaces: `ConfigStore` reads it to decide what it may route, and
        // "absent" and "serves none" must not look the same — the first is a
        // bug, the second a supported deployment.
        assert.ok(
          Array.isArray(caps.rawNamespaces),
          'rawNamespaces is an array, empty when the provider serves no raw configuration'
        );
      });

      it('shutdown() twice is safe', async () => {
        const { provider, dispose } = await startProvider(createProvider);
        try {
          await provider.shutdown();
          await provider.shutdown();
        } finally {
          // dispose() shuts down a third time, then removes the scratch location.
          await dispose();
        }
      });

      it('append() after shutdown rejects instead of accepting the record', async () => {
        // The one post-shutdown write the contract is strict about, because it
        // is the one that can be accepted and then lost. A provider that
        // buffers — the filesystem one does — otherwise queues the record into
        // memory nothing will drain, tells the caller it landed, and exits. A
        // run ledger then ends one record short of whatever the process was
        // shutting down over, with nothing anywhere saying so.
        //
        // Every ledger consumer already handles a failed append. None of them
        // can handle one that succeeded and vanished.
        const { provider, dispose } = await startProvider(createProvider);
        const stream = nextId('shutdown');
        try {
          await provider.logs.append(stream, { type: 'before' }, 1);
          await provider.shutdown();
          await assert.rejects(
            () => provider.logs.append(stream, { type: 'after' }, 2),
            error => error?.code === 'STORAGE_SHUT_DOWN',
            'an append after shutdown must be refused, not buffered'
          );
        } finally {
          await dispose();
        }
      });
    });

    describe('documents', () => {
      it('get() of a missing key resolves null', async () => {
        assert.equal(await shared.documents.get(nextId('docs'), 'absent'), null);
      });

      it('put() then get() round-trips nested data', async () => {
        const ns = nextId('docs');
        const data = {
          title: 'nested',
          count: 3,
          flag: false,
          nothing: null,
          list: [1, 'two', { three: [4, 5] }],
          deep: { a: { b: { c: 'd' } } }
        };
        await shared.documents.put(ns, 'doc', data);
        const read = await shared.documents.get(ns, 'doc');
        assertDocumentShape(read, ns, 'doc');
        assert.deepEqual(read.data, data);
      });

      it('put() returns exactly the document a following get() returns', async () => {
        const ns = nextId('docs');
        const written = await shared.documents.put(ns, 'doc', { v: 1 }, { ownerId: 'alice' });
        const read = await shared.documents.get(ns, 'doc');
        assert.deepEqual(read, written);
      });

      it('an overwrite updates data and updatedAt and keeps createdAt', async () => {
        const ns = nextId('docs');
        const first = await shared.documents.put(ns, 'doc', { v: 1 });
        // The timestamps have millisecond resolution, so two writes in the same
        // millisecond would be indistinguishable; this is the one place the
        // suite has to let the clock move.
        await delay(10);
        const second = await shared.documents.put(ns, 'doc', { v: 2 });
        assert.deepEqual(second.data, { v: 2 });
        assert.equal(second.createdAt, first.createdAt, 'createdAt survives an overwrite');
        assert.ok(
          Date.parse(second.updatedAt) > Date.parse(first.updatedAt),
          'updatedAt moves forward'
        );
        assert.notEqual(second.etag, first.etag);
      });

      it('delete() reports true once and false afterwards', async () => {
        const ns = nextId('docs');
        await shared.documents.put(ns, 'doc', { v: 1 });
        assert.equal(await shared.documents.delete(ns, 'doc'), true);
        assert.equal(await shared.documents.delete(ns, 'doc'), false);
        assert.equal(await shared.documents.get(ns, 'doc'), null);
      });

      it('etag and size are derived from the data, not from the storage layout', async () => {
        const ns = nextId('docs');
        const data = { a: 1, b: ['x', 'y'] };
        const same = { a: 1, b: ['x', 'y'] };
        const different = { a: 2, b: ['x', 'y'] };
        const one = await shared.documents.put(ns, 'one', data);
        const two = await shared.documents.put(ns, 'two', same, { ownerId: 'other-owner' });
        const three = await shared.documents.put(ns, 'three', different);
        assert.equal(one.etag, contractEtag(data), 'etag is sha256 of the serialized data');
        assert.equal(one.size, contractSize(data), 'size is the serialized byte length');
        assert.equal(one.etag, two.etag, 'equal data has an equal etag regardless of metadata');
        assert.notEqual(one.etag, three.etag, 'different data has a different etag');
      });

      it('ownerId is echoed back on put and get', async () => {
        const ns = nextId('docs');
        const written = await shared.documents.put(ns, 'doc', { v: 1 }, { ownerId: 'alice@e.com' });
        assert.equal(written.ownerId, 'alice@e.com');
        assert.equal((await shared.documents.get(ns, 'doc')).ownerId, 'alice@e.com');
      });

      it('an overwrite without ownerId keeps the stored owner', async () => {
        const ns = nextId('docs');
        await shared.documents.put(ns, 'doc', { v: 1 }, { ownerId: 'alice' });
        const second = await shared.documents.put(ns, 'doc', { v: 2 });
        assert.equal(second.ownerId, 'alice');
        assert.equal((await shared.documents.get(ns, 'doc')).ownerId, 'alice');
      });

      it('an explicit ownerId: null clears the owner', async () => {
        const ns = nextId('docs');
        await shared.documents.put(ns, 'doc', { v: 1 }, { ownerId: 'alice' });
        const cleared = await shared.documents.put(ns, 'doc', { v: 2 }, { ownerId: null });
        assert.equal(cleared.ownerId, null);
        assert.equal((await shared.documents.get(ns, 'doc')).ownerId, null);
      });

      it('contentType defaults to application/json and round-trips a custom value', async () => {
        const ns = nextId('docs');
        const plain = await shared.documents.put(ns, 'plain', { v: 1 });
        assert.equal(plain.contentType, 'application/json');
        const custom = await shared.documents.put(ns, 'custom', 'hello', {
          contentType: 'text/plain'
        });
        assert.equal(custom.contentType, 'text/plain');
        assert.equal((await shared.documents.get(ns, 'custom')).contentType, 'text/plain');
      });

      it('an overwrite that names no contentType keeps the stored one', async () => {
        const ns = nextId('docs');
        await shared.documents.put(ns, 'doc', { v: 1 }, { contentType: 'text/plain' });
        const overwritten = await shared.documents.put(ns, 'doc', { v: 2 });
        assert.equal(
          overwritten.contentType,
          'text/plain',
          'contentType follows the same absent-versus-null rule as ownerId'
        );
        assert.equal((await shared.documents.get(ns, 'doc')).contentType, 'text/plain');
      });

      it('rejects an invalid namespace or key with InvalidKeyError', async () => {
        const ns = nextId('docs');
        const docs = shared.documents;
        for (const bad of INVALID_IDS) {
          const shown = JSON.stringify(bad);
          const attempts = [
            [`get(ns=${shown})`, () => docs.get(bad, 'k')],
            [`get(key=${shown})`, () => docs.get(ns, bad)],
            [`put(ns=${shown})`, () => docs.put(bad, 'k', {})],
            [`put(key=${shown})`, () => docs.put(ns, bad, {})],
            [`delete(ns=${shown})`, () => docs.delete(bad, 'k')],
            [`delete(key=${shown})`, () => docs.delete(ns, bad)],
            [`list(ns=${shown})`, () => docs.list(bad)]
          ];
          for (const [label, attempt] of attempts) {
            await assert.rejects(attempt, InvalidKeyError, label);
          }
        }
      });

      it('rejects data: undefined with a StorageError', async () => {
        const ns = nextId('docs');
        await assert.rejects(
          () => shared.documents.put(ns, 'doc', undefined),
          error => {
            assert.ok(error instanceof StorageError, 'undefined data is a StorageError');
            assert.equal(error.code, 'INVALID_DATA');
            return true;
          }
        );
        assert.equal(await shared.documents.get(ns, 'doc'), null, 'nothing was stored');
      });

      describe('conditional writes', { skip: skipWithoutCas }, () => {
        it('a put carrying the current etag succeeds', async () => {
          const ns = nextId('cas');
          const first = await shared.documents.put(ns, 'doc', { v: 1 });
          const second = await shared.documents.put(ns, 'doc', { v: 2 }, { etag: first.etag });
          assert.deepEqual(second.data, { v: 2 });
          assert.equal(second.etag, contractEtag({ v: 2 }));
        });

        it('a put carrying a stale etag throws EtagMismatchError', async () => {
          const ns = nextId('cas');
          const first = await shared.documents.put(ns, 'doc', { v: 1 });
          await shared.documents.put(ns, 'doc', { v: 2 });
          await assert.rejects(
            () => shared.documents.put(ns, 'doc', { v: 3 }, { etag: first.etag }),
            EtagMismatchError
          );
        });

        it('etag: null on an existing key throws EtagMismatchError', async () => {
          const ns = nextId('cas');
          await shared.documents.put(ns, 'doc', { v: 1 });
          await assert.rejects(
            () => shared.documents.put(ns, 'doc', { v: 2 }, { etag: null }),
            EtagMismatchError
          );
        });

        it('etag: null on a free key creates the document', async () => {
          const ns = nextId('cas');
          const created = await shared.documents.put(ns, 'doc', { v: 1 }, { etag: null });
          assert.deepEqual(created.data, { v: 1 });
          assert.deepEqual((await shared.documents.get(ns, 'doc')).data, { v: 1 });
        });

        it('a string etag for a key that was never written throws EtagMismatchError', async () => {
          const ns = nextId('cas');
          // The natural single-statement upsert an SQL provider reaches for
          // (`INSERT … ON CONFLICT … WHERE etag = $expected`) *creates* the row
          // here instead of rejecting, which would resurrect a key a concurrent
          // worker had just deleted. Compare-and-set requires the document to
          // exist, not merely to be free of a conflicting etag.
          await assert.rejects(
            () =>
              shared.documents.put(ns, 'never-written', { v: 1 }, { etag: contractEtag({ v: 0 }) }),
            EtagMismatchError
          );
          assert.equal(
            await shared.documents.get(ns, 'never-written'),
            null,
            'the rejected compare-and-set created nothing'
          );
        });

        it('a failed conditional put leaves the stored document untouched', async () => {
          const ns = nextId('cas');
          const stored = await shared.documents.put(ns, 'doc', { v: 1 }, { ownerId: 'alice' });
          await assert.rejects(
            () =>
              shared.documents.put(
                ns,
                'doc',
                { v: 999 },
                { etag: contractEtag({ not: 'the stored data' }), ownerId: 'mallory' }
              ),
            EtagMismatchError
          );
          assert.deepEqual(await shared.documents.get(ns, 'doc'), stored);
        });
      });
    });

    describe('listing and paging', () => {
      /**
       * Seed a namespace with `key -> { data, ownerId }` entries.
       *
       * @param {string} ns - Namespace to fill
       * @param {Object<string, {data?: any, ownerId?: string}>} spec - What to write
       * @returns {Promise<void>}
       */
      async function seed(ns, spec) {
        for (const [key, entry] of Object.entries(spec)) {
          const opts = 'ownerId' in entry ? { ownerId: entry.ownerId } : {};
          await shared.documents.put(ns, key, entry.data ?? { key }, opts);
        }
      }

      it('an unknown namespace lists empty instead of throwing', async () => {
        const page = await shared.documents.list(nextId('list'));
        assert.deepEqual(page.items, []);
        assert.equal(page.nextCursor, null);
      });

      it('items come back in ascending key order', async () => {
        const ns = nextId('list');
        await seed(ns, { 'k-c': {}, 'k-a': {}, 'k-b': {} });
        const page = await shared.documents.list(ns);
        assert.deepEqual(
          page.items.map(item => item.key),
          ['k-a', 'k-b', 'k-c']
        );
        assert.equal(page.nextCursor, null, 'a complete page has no cursor');
      });

      it('orders by code unit, not by a locale collation', async () => {
        // Every other key set in this suite sorts identically under code-unit
        // order and under an ICU or glibc locale collation, so a SQL provider
        // that inherited its database's default collation would pass all of
        // them while ordering differently. This set does not: a locale
        // collation weighs punctuation at a lower level and reorders these
        // four.
        //
        // The paging consequence is the serious one. Keyset paging asks
        // `WHERE key > :cursor`, so if the provider's comparison and its
        // ordering are not the same total order, a listing can skip a document
        // or return one twice — in the middle of a page, with nothing to
        // indicate it. `ORDER BY key COLLATE "C"`.
        const ns = nextId('collate');
        await seed(ns, { k1: {}, 'k-1': {}, 'k.1': {}, k_1: {} });

        const page = await shared.documents.list(ns);
        assert.deepEqual(
          page.items.map(item => item.key),
          ['k-1', 'k.1', 'k1', 'k_1'],
          "'-' (0x2D) < '.' (0x2E) < '1' (0x31) < '_' (0x5F)"
        );

        // And the cursor agrees with that order rather than with another one.
        const first = await shared.documents.list(ns, { limit: 2 });
        assert.deepEqual(
          first.items.map(item => item.key),
          ['k-1', 'k.1']
        );
        const second = await shared.documents.list(ns, { limit: 2, cursor: first.nextCursor });
        assert.deepEqual(
          second.items.map(item => item.key),
          ['k1', 'k_1'],
          'paging loses nothing and repeats nothing across the punctuation boundary'
        );
      });

      it('scan walks the whole namespace in one pass, in key order', async () => {
        // `list` is the paged REST-facing API; `scan` is the walk every
        // whole-namespace consumer needs. A provider that implements it must
        // agree with `list` on order and completeness — the difference is the
        // cost, not the answer.
        if (!shared.documents.supportsScan) return;
        const ns = nextId('scan');
        await seed(ns, { 'k-c': {}, 'k-a': {}, 'k-b': {}, 'k-d': {} });

        const walked = [];
        for await (const doc of shared.documents.scan(ns)) walked.push(doc.key);
        assert.deepEqual(walked, ['k-a', 'k-b', 'k-c', 'k-d']);

        const paged = [];
        let cursor = null;
        do {
          const page = await shared.documents.list(ns, {
            limit: 1,
            ...(cursor ? { cursor } : {})
          });
          for (const item of page.items) paged.push(item.key);
          cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(walked, paged, 'scan and a full paged walk agree');
      });

      it('scan yields documents lazily, so stopping early stops the work', async () => {
        if (!shared.documents.supportsScan) return;
        const ns = nextId('scan');
        await seed(ns, { 'k-a': {}, 'k-b': {}, 'k-c': {} });

        const seen = [];
        for await (const doc of shared.documents.scan(ns)) {
          seen.push(doc.key);
          break;
        }
        assert.deepEqual(seen, ['k-a'], 'the first document is available before the last is read');
      });

      it('scan honours ownerId and prefix the way list does', async () => {
        if (!shared.documents.supportsScan) return;
        const ns = nextId('scan');
        await seed(ns, {
          'ax-1': { ownerId: 'owner-a' },
          'ax-2': { ownerId: 'owner-b' },
          'bx-1': { ownerId: 'owner-a' }
        });

        const owned = [];
        for await (const doc of shared.documents.scan(ns, { ownerId: 'owner-a' })) {
          owned.push(doc.key);
        }
        assert.deepEqual(owned.sort(), ['ax-1', 'bx-1']);

        const prefixed = [];
        for await (const doc of shared.documents.scan(ns, { prefix: 'ax-' })) {
          prefixed.push(doc.key);
        }
        assert.deepEqual(prefixed, ['ax-1', 'ax-2']);
      });

      it('scan on an unknown namespace yields nothing instead of throwing', async () => {
        if (!shared.documents.supportsScan) return;
        const walked = [];
        for await (const doc of shared.documents.scan(nextId('scan'))) walked.push(doc.key);
        assert.deepEqual(walked, []);
      });

      it("ownerId returns only that owner's documents", async () => {
        const ns = nextId('list');
        await seed(ns, {
          'k-a': { ownerId: 'alice@example.com' },
          'k-b': { ownerId: 'bob@example.com' },
          'k-c': { ownerId: 'alice@example.com' },
          'k-d': {}
        });
        const alice = await shared.documents.list(ns, { ownerId: 'alice@example.com' });
        assert.deepEqual(
          alice.items.map(item => item.key),
          ['k-a', 'k-c']
        );
        const bob = await shared.documents.list(ns, { ownerId: 'bob@example.com' });
        assert.deepEqual(
          bob.items.map(item => item.key),
          ['k-b']
        );
        const nobody = await shared.documents.list(ns, { ownerId: 'carol@example.com' });
        assert.deepEqual(nobody.items, []);
      });

      it('changing the owner moves a document between owner listings', async () => {
        const ns = nextId('list');
        await seed(ns, { 'k-a': { ownerId: 'alice' } });
        await shared.documents.put(ns, 'k-a', { v: 2 }, { ownerId: 'bob' });
        const alice = await shared.documents.list(ns, { ownerId: 'alice' });
        assert.deepEqual(alice.items, [], 'the previous owner no longer sees it');
        const bob = await shared.documents.list(ns, { ownerId: 'bob' });
        assert.deepEqual(
          bob.items.map(item => item.key),
          ['k-a']
        );
      });

      it('deleting a document removes it from the owner listing', async () => {
        const ns = nextId('list');
        await seed(ns, { 'k-a': { ownerId: 'alice' }, 'k-b': { ownerId: 'alice' } });
        assert.equal(await shared.documents.delete(ns, 'k-a'), true);
        const alice = await shared.documents.list(ns, { ownerId: 'alice' });
        assert.deepEqual(
          alice.items.map(item => item.key),
          ['k-b']
        );
      });

      it('prefix filters keys by startsWith', async () => {
        const ns = nextId('list');
        await seed(ns, { 'chat.1': {}, 'chat.2': {}, 'note.1': {} });
        const chats = await shared.documents.list(ns, { prefix: 'chat.' });
        assert.deepEqual(
          chats.items.map(item => item.key),
          ['chat.1', 'chat.2']
        );
        const none = await shared.documents.list(ns, { prefix: 'zz' });
        assert.deepEqual(none.items, []);
      });

      it('a key beginning with a dot is listed like any other key', async () => {
        // `isValidId` accepts a leading dot, so `.draft` is a storable key — and
        // a store that hides it from the plain listing while the owner-filtered
        // listing still returns it disagrees with itself about what the
        // namespace holds, silently dropping the document from any migration,
        // export or garbage collection that enumerates the namespace.
        const ns = nextId('list');
        await seed(ns, { '.draft': { ownerId: 'alice' }, plain: { ownerId: 'alice' } });
        assert.ok(await shared.documents.get(ns, '.draft'), 'the document is readable by key');
        const all = await shared.documents.list(ns);
        assert.deepEqual(
          all.items.map(item => item.key),
          ['.draft', 'plain']
        );
        const owned = await shared.documents.list(ns, { ownerId: 'alice' });
        assert.deepEqual(
          owned.items.map(item => item.key),
          ['.draft', 'plain'],
          'the owner listing is the same set, not a different one'
        );
      });

      it('limit and cursor walk every document exactly once', async () => {
        const ns = nextId('list');
        const keys = ['k-01', 'k-02', 'k-03', 'k-04', 'k-05', 'k-06', 'k-07'];
        await seed(ns, Object.fromEntries(keys.map(key => [key, {}])));

        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
          const page = await shared.documents.list(ns, { limit: 3, cursor });
          pages += 1;
          assert.ok(page.items.length <= 3, 'a page never exceeds its limit');
          seen.push(...page.items.map(item => item.key));
          cursor = page.nextCursor;
          assert.ok(pages <= keys.length + 1, 'paging terminates');
        } while (cursor !== null);

        assert.deepEqual(seen, keys, 'every key exactly once, still ascending');
        assert.equal(pages, 3);
      });

      it('an oversized limit is clamped rather than rejected', async () => {
        const ns = nextId('list');
        await seed(ns, { 'k-a': {}, 'k-b': {} });
        const page = await shared.documents.list(ns, { limit: 100000 });
        assert.deepEqual(
          page.items.map(item => item.key),
          ['k-a', 'k-b']
        );
        assert.equal(page.nextCursor, null);
      });

      it('a cursor the store never issued throws INVALID_CURSOR', async () => {
        const ns = nextId('list');
        await seed(ns, { 'k-a': {}, 'k-b': {} });
        // Decoding defensively and starting from the beginning instead would
        // hand a client that kept a stale cursor page one for ever, so the
        // paging loop never terminates.
        await assert.rejects(
          () => shared.documents.list(ns, { cursor: 'not a cursor!!' }),
          error => {
            assert.ok(error instanceof StorageError, 'an unusable cursor is a StorageError');
            assert.equal(error.code, 'INVALID_CURSOR');
            return true;
          }
        );
      });

      it('a listing with no limit returns the default page of 100', async () => {
        const ns = nextId('list');
        const keys = Array.from(
          { length: 101 },
          (_, index) => `k-${String(index).padStart(3, '0')}`
        );
        await seed(ns, Object.fromEntries(keys.map(key => [key, {}])));

        const page = await shared.documents.list(ns);
        assert.equal(page.items.length, 100, 'limit defaults to 100 rather than to "everything"');
        assert.deepEqual(
          page.items.map(item => item.key),
          keys.slice(0, 100)
        );
        assert.ok(page.nextCursor, 'a truncated page carries a cursor to the rest');
        const rest = await shared.documents.list(ns, { cursor: page.nextCursor });
        assert.deepEqual(
          rest.items.map(item => item.key),
          keys.slice(100)
        );
        assert.equal(rest.nextCursor, null);
      });

      it('includeData: false omits data but keeps the metadata', async () => {
        const ns = nextId('list');
        const data = { body: 'kept out of the listing' };
        await seed(ns, { 'k-a': { data, ownerId: 'alice' } });
        const page = await shared.documents.list(ns, { includeData: false });
        assert.equal(page.items.length, 1);
        const [item] = page.items;
        assertDocumentShape(item, ns, 'k-a');
        assert.equal(item.data, undefined, 'data is omitted');
        assert.equal(item.ownerId, 'alice');
        assert.equal(item.etag, contractEtag(data), 'the etag still describes the body');
        assert.equal(item.size, contractSize(data));
      });
    });

    /**
     * Raw namespaces — the mode where the stored file *is* the document.
     *
     * A provider may declare that some namespaces are views over
     * configuration an installation already owns and edits by hand. Those
     * namespaces keep the DocumentStore interface but change what the stored
     * representation is, and three contract points follow from that: the
     * bytes are the two-space JSON the configuration tooling has always
     * written, the etag digests those bytes rather than a re-serialization of
     * the parsed data, and there is no owner to file the document under.
     *
     * The owner-scoped cases in `listing and paging` therefore do **not** run
     * against a raw namespace. They are not quietly assumed to pass either:
     * the cases below assert that asking for an owner is refused outright, so
     * a provider that started storing owners here would fail rather than drift.
     */
    describe('raw namespaces', { skip: skipWithoutRaw }, () => {
      const ns = rawNamespace;

      /** Entries the backing location gained between two listings. */
      const added = (before, after) => after.filter(entry => !before.includes(entry));

      it('round-trips a document stored unwrapped, with no owner', async () => {
        const key = nextId('raw');
        const data = { id: key, nested: { list: [1, 2, 3] }, flag: true, nothing: null };
        const written = await shared.documents.put(ns, key, data);
        assertDocumentShape(written, ns, key);
        assert.equal(written.ownerId, null, 'configuration has no owner');
        assert.equal(written.contentType, 'application/json', 'the file is JSON');
        const read = await shared.documents.get(ns, key);
        assert.deepEqual(read, written, 'put returns exactly what a following get returns');
        assert.deepEqual(read.data, data);
      });

      it('etag and size describe the stored bytes, not a re-serialization', async () => {
        const key = nextId('raw');
        const data = { id: key, list: ['x', 'y'] };
        const bytes = rawBytes(data);
        const written = await shared.documents.put(ns, key, data);
        assert.equal(written.etag, rawEtag(bytes), 'etag is sha256 of the stored bytes');
        assert.equal(written.size, Buffer.byteLength(bytes, 'utf8'));
        assert.notEqual(
          written.etag,
          contractEtag(data),
          'an enveloped etag over the compact form would miss a whitespace-only edit'
        );
      });

      it('rejects an ownerId with NotSupportedError and stores nothing', async () => {
        const key = nextId('raw');
        await assert.rejects(
          () => shared.documents.put(ns, key, { v: 1 }, { ownerId: 'alice' }),
          NotSupportedError,
          'a configuration document cannot be owned'
        );
        assert.equal(await shared.documents.get(ns, key), null, 'the rejected put stored nothing');
        await assert.rejects(
          () => shared.documents.list(ns, { ownerId: 'alice' }),
          NotSupportedError,
          'and it cannot be listed by owner either'
        );
      });

      it('accepts ownerId: null, the state the document is already in', async () => {
        const key = nextId('raw');
        const written = await shared.documents.put(ns, key, { v: 1 }, { ownerId: null });
        assert.equal(written.ownerId, null);
        const page = await shared.documents.list(ns, { prefix: key, ownerId: null });
        assert.deepEqual(
          page.items.map(item => item.key),
          [key],
          'an explicit null is "no filter", not an owner'
        );
      });

      it('pages a raw namespace in code-unit order', async () => {
        // The generic documents group above runs against ordinary namespaces,
        // which a routing provider sends to its *enveloped* store — so none of
        // it reaches the raw store's own paging, and `ConfigStore.list()` is
        // what pages through that. Ordering and cursors are asserted here
        // directly, on keys that a locale collation would reorder: every other
        // key set in this suite sorts the same either way, so a provider that
        // inherited its database's default collation would pass them all.
        const prefix = nextId('raw');
        const suffixes = ['1', '-1', '.1', '_1'];
        for (const suffix of suffixes) {
          await shared.documents.put(ns, `${prefix}${suffix}`, { v: suffix });
        }

        const all = await shared.documents.list(ns, { prefix });
        assert.deepEqual(
          all.items.map(item => item.key),
          [`${prefix}-1`, `${prefix}.1`, `${prefix}1`, `${prefix}_1`],
          "'-' (0x2D) < '.' (0x2E) < '1' (0x31) < '_' (0x5F)"
        );

        // And the cursor agrees with that order. Keyset paging asks
        // `WHERE key > :cursor`, so a comparison that disagrees with the
        // ordering skips a document or repeats one, mid-listing, silently.
        const first = await shared.documents.list(ns, { prefix, limit: 2 });
        assert.deepEqual(
          first.items.map(item => item.key),
          [`${prefix}-1`, `${prefix}.1`],
          'a limit is honoured'
        );
        assert.ok(first.nextCursor, 'and a partial page carries a cursor');
        const second = await shared.documents.list(ns, {
          prefix,
          limit: 2,
          cursor: first.nextCursor
        });
        assert.deepEqual(
          second.items.map(item => item.key),
          [`${prefix}1`, `${prefix}_1`],
          'paging loses nothing and repeats nothing across the punctuation boundary'
        );
        assert.equal(second.nextCursor, null, 'and the last page says so');

        for (const suffix of suffixes) await shared.documents.delete(ns, `${prefix}${suffix}`);
      });

      it('rejects a content type the file cannot carry', async () => {
        const key = nextId('raw');
        await assert.rejects(
          () => shared.documents.put(ns, key, { v: 1 }, { contentType: 'text/plain' }),
          NotSupportedError,
          'silently storing it as JSON and reporting text/plain would be a lie'
        );
        assert.equal(await shared.documents.get(ns, key), null);
      });

      it('a document that was never written reads null and lists nothing', async () => {
        const key = nextId('raw');
        assert.equal(await shared.documents.get(ns, key), null);
        const page = await shared.documents.list(ns, { prefix: key });
        assert.deepEqual(page.items, [], 'and it is absent from the listing too');
      });

      it('delete reports true once and false afterwards', async () => {
        const key = nextId('raw');
        await shared.documents.put(ns, key, { v: 1 });
        assert.equal(await shared.documents.delete(ns, key), true);
        assert.equal(await shared.documents.delete(ns, key), false);
        assert.equal(await shared.documents.get(ns, key), null);
      });

      it('lists the namespace in ascending key order', async () => {
        const prefix = nextId('raw');
        const keys = [`${prefix}.c`, `${prefix}.a`, `${prefix}.b`];
        for (const key of keys) await shared.documents.put(ns, key, { key });
        const page = await shared.documents.list(ns, { prefix });
        assert.deepEqual(
          page.items.map(item => item.key),
          [...keys].sort()
        );
      });

      it('rejects an unsafe key with InvalidKeyError', async () => {
        for (const bad of INVALID_IDS) {
          await assert.rejects(() => shared.documents.get(ns, bad), InvalidKeyError);
          await assert.rejects(() => shared.documents.put(ns, bad, {}), InvalidKeyError);
          await assert.rejects(() => shared.documents.delete(ns, bad), InvalidKeyError);
        }
      });

      describe('conditional writes', { skip: skipWithoutCas }, () => {
        it('a put carrying the current etag succeeds', async () => {
          const key = nextId('raw');
          const first = await shared.documents.put(ns, key, { v: 1 });
          const second = await shared.documents.put(ns, key, { v: 2 }, { etag: first.etag });
          assert.deepEqual(second.data, { v: 2 });
          assert.equal(second.etag, rawEtag(rawBytes({ v: 2 })));
        });

        it('a stale etag and a create-only write on an existing file both lose', async () => {
          const key = nextId('raw');
          const first = await shared.documents.put(ns, key, { v: 1 });
          await shared.documents.put(ns, key, { v: 2 });
          await assert.rejects(
            () => shared.documents.put(ns, key, { v: 3 }, { etag: first.etag }),
            EtagMismatchError
          );
          await assert.rejects(
            () => shared.documents.put(ns, key, { v: 4 }, { etag: null }),
            EtagMismatchError
          );
          assert.deepEqual((await shared.documents.get(ns, key)).data, { v: 2 }, 'untouched');
        });
      });

      describe('the bytes on disk', { skip: skipWithoutRawFiles }, () => {
        it('stores exactly the two-space JSON, with no trailing newline', async () => {
          const key = nextId('raw');
          const data = { id: key, name: { en: 'Config' }, list: [1, 2] };
          await shared.documents.put(ns, key, data);
          const stored = await rawFiles.read(shared, ns, key);
          assert.equal(
            stored,
            rawBytes(data),
            'a different serialization rewrites every configuration file on first save'
          );
          assert.ok(!stored.endsWith('\n'), 'no trailing newline is part of that shape');
        });

        it('reads a document written by hand, formatting and all', async () => {
          const key = nextId('raw');
          const handWritten = '{\n\t"id":"hand",\n\n  "list": [ 1,2 ]\n}';
          await rawFiles.write(shared, ns, key, handWritten);
          const read = await shared.documents.get(ns, key);
          assert.deepEqual(
            read.data,
            { id: 'hand', list: [1, 2] },
            'the body is what it parses to'
          );
          assert.equal(read.etag, rawEtag(handWritten), 'the etag follows the bytes as written');
          assert.equal(read.size, Buffer.byteLength(handWritten, 'utf8'));
        });

        it('a malformed document reads as absent instead of throwing', async () => {
          const key = nextId('raw');
          await rawFiles.write(shared, ns, key, '{ "half": ');
          assert.equal(
            await shared.documents.get(ns, key),
            null,
            'callers branch on null; a throw here would fail a boot over one bad file'
          );
          const page = await shared.documents.list(ns, { prefix: key });
          assert.deepEqual(page.items, [], 'and the listing does not invent an empty document');
        });

        it(
          'a hand edit between read and write fails the compare-and-set',
          {
            skip: skipWithoutCas
          },
          async () => {
            const key = nextId('raw');
            const read = await shared.documents.put(ns, key, { v: 1 });
            const edited = rawBytes({ v: 1, byHand: true });
            await rawFiles.write(shared, ns, key, edited);
            await assert.rejects(
              () => shared.documents.put(ns, key, { v: 2 }, { etag: read.etag }),
              EtagMismatchError,
              'the point of digesting the bytes: an out-of-band edit is not lost'
            );
            assert.equal(await rawFiles.read(shared, ns, key), edited, 'the hand edit survived');
          }
        );

        it('writes nothing beside the documents themselves', async () => {
          const prefix = nextId('raw');
          const before = await rawFiles.entries(shared, ns);
          await shared.documents.put(ns, `${prefix}.a`, { v: 1 });
          await shared.documents.put(ns, `${prefix}.b`, { v: 2 });
          const afterWrite = await rawFiles.entries(shared, ns);
          assert.equal(
            added(before, afterWrite).length,
            2,
            'an owner index, a lock file or a leftover temp file here would be loaded as configuration'
          );
          assert.equal(await shared.documents.delete(ns, `${prefix}.a`), true);
          assert.equal(await shared.documents.delete(ns, `${prefix}.b`), true);
          assert.deepEqual(
            added(before, await rawFiles.entries(shared, ns)),
            [],
            'and a delete leaves nothing behind either'
          );
        });
      });
    });

    describe('append logs', () => {
      it('an empty stream reads [] and reports lastSeq 0', async () => {
        const stream = nextId('log');
        assert.deepEqual(await shared.logs.read(stream), []);
        assert.equal(await shared.logs.lastSeq(stream), 0);
        assert.equal(await shared.logs.lastRecord(stream), null);
      });

      it('append() then read() returns the entry with its sequence number', async () => {
        const stream = nextId('log');
        const accepted = await shared.logs.append(stream, { type: 'hello', payload: [1, 2] }, 1);
        assert.deepEqual(accepted, { stream, seq: 1 });
        const records = await shared.logs.read(stream);
        assert.deepEqual(records, [{ type: 'hello', payload: [1, 2], seq: 1 }]);
        assert.equal(await shared.logs.lastSeq(stream), 1);
      });

      it('the caller sequence overrides any seq inside the entry', async () => {
        const stream = nextId('log');
        await shared.logs.append(stream, { seq: 99, type: 'x' }, 4);
        const [record] = await shared.logs.read(stream);
        assert.equal(record.seq, 4, 'the log never allocates and never trusts entry.seq');
      });

      it('afterSeq and limit slice the stream', async () => {
        const stream = nextId('log');
        for (let seq = 1; seq <= 5; seq++) {
          await shared.logs.append(stream, { n: seq }, seq);
        }
        assert.deepEqual(
          (await shared.logs.read(stream, { afterSeq: 3 })).map(r => r.seq),
          [4, 5]
        );
        assert.deepEqual(
          (await shared.logs.read(stream, { limit: 2 })).map(r => r.seq),
          [1, 2]
        );
        assert.deepEqual(
          (await shared.logs.read(stream, { afterSeq: 1, limit: 2 })).map(r => r.seq),
          [2, 3]
        );
        assert.deepEqual(await shared.logs.read(stream, { afterSeq: 5 }), []);
      });

      it('appendBatch persists every item and reports the highest sequence', async () => {
        const stream = nextId('log');
        const result = await shared.logs.appendBatch(stream, [
          { entry: { n: 'a' }, seq: 1 },
          { entry: { n: 'b' }, seq: 2 },
          { entry: { n: 'c' }, seq: 3 }
        ]);
        assert.deepEqual(result, { stream, count: 3, lastSeq: 3 });
        assert.deepEqual(
          (await shared.logs.read(stream)).map(r => r.n),
          ['a', 'b', 'c']
        );
        assert.equal(await shared.logs.lastSeq(stream), 3);
      });

      it('records keep their insertion order', async () => {
        const stream = nextId('log');
        await shared.logs.append(stream, { n: 'first' }, 10);
        await shared.logs.appendBatch(stream, [
          { entry: { n: 'second' }, seq: 11 },
          { entry: { n: 'third' }, seq: 12 }
        ]);
        await shared.logs.append(stream, { n: 'fourth' }, 13);
        assert.deepEqual(
          (await shared.logs.read(stream)).map(r => r.n),
          ['first', 'second', 'third', 'fourth']
        );
      });

      it('an out-of-order append still reads back in sequence order', async () => {
        const stream = nextId('log');
        await shared.logs.append(stream, { n: 'high' }, 7);
        await shared.logs.append(stream, { n: 'low' }, 3);
        assert.equal(await shared.logs.lastSeq(stream), 7, 'lastSeq is the highest, not the last');
        // Ordering is by sequence number, not by the order the records reached
        // storage: a provider that returned them as persisted would hand a
        // caller paging with `afterSeq` a cursor past a record it never saw.
        assert.deepEqual(
          (await shared.logs.read(stream)).map(record => record.seq),
          [3, 7]
        );
        assert.deepEqual(
          (await shared.logs.read(stream, { limit: 1 })).map(record => record.seq),
          [3],
          'limit takes the lowest sequence numbers, not the first lines written'
        );
        assert.deepEqual(
          (await shared.logs.read(stream, { afterSeq: 3 })).map(record => record.seq),
          [7]
        );
      });

      it('lastRecord returns the highest-seq record, not the last one written', async () => {
        // The reason this is on the facet rather than left to callers: `read`
        // takes the *lowest* sequence numbers above a cursor (pinned by the
        // test above), so nobody can ask for the newest record through it.
        // `lastSeq` + `read({afterSeq: seq - 1, limit: 1})` gets there, but a
        // provider that cannot stop early — the filesystem one cannot, since a
        // record's position need not follow its sequence number — pays for two
        // passes to fetch a record the first pass already held. Replaying a
        // finished run made that the difference between one parse of its
        // ledger per page and two.
        const stream = nextId('log');
        await shared.logs.append(stream, { n: 'high' }, 7);
        await shared.logs.append(stream, { n: 'low' }, 3);

        const last = await shared.logs.lastRecord(stream);
        assert.deepEqual(last, { n: 'high', seq: 7 });
        assert.equal(last.seq, await shared.logs.lastSeq(stream), 'the two never disagree');

        // An append below the maximum does not become the last record.
        await shared.logs.append(stream, { n: 'lower' }, 1);
        assert.deepEqual(await shared.logs.lastRecord(stream), { n: 'high', seq: 7 });

        // ...and one above it does.
        await shared.logs.append(stream, { n: 'higher' }, 9);
        assert.deepEqual(await shared.logs.lastRecord(stream), { n: 'higher', seq: 9 });
      });

      it('lastRecord comes from durable storage, like lastSeq', async () => {
        // `RunLog.hasEnded` asks it about runs this worker never held, so an
        // answer that only works while the writer is still in memory would
        // report a finished run as still running after every restart.
        const stream = nextId('log');
        const first = await startProvider(createProvider);
        try {
          await first.provider.logs.appendBatch(stream, [
            { entry: { n: 'a' }, seq: 1 },
            { entry: { n: 'end' }, seq: 2 }
          ]);
          await first.provider.shutdown();

          const second = await startProvider(createProvider, { reuse: true });
          try {
            assert.deepEqual(await second.provider.logs.lastRecord(stream), { n: 'end', seq: 2 });
          } finally {
            await second.dispose();
          }
        } finally {
          await first.dispose();
        }
      });

      it('a read sees an accepted append while a flush is already in flight', async () => {
        const stream = nextId('log');
        await shared.logs.append(stream, { n: 'buffered' }, 1);
        // Start a flush without awaiting it — exactly what a provider's own
        // debounce timer does — and give it the microtasks it needs to take the
        // records out of its buffer but not yet to write them. A read that
        // decides whether to flush by asking "is anything queued?" answers no
        // here and streams a store that does not hold the record yet; the
        // dangerous half is `lastSeq`, since a recovering worker that reads 0
        // restarts numbering at 1 over a stream that already holds 1..N.
        const inFlight = shared.logs.flush();
        await Promise.resolve();
        await Promise.resolve();
        try {
          assert.equal(await shared.logs.lastSeq(stream), 1, 'lastSeq never under-reports');
          assert.deepEqual(
            (await shared.logs.read(stream)).map(record => record.n),
            ['buffered']
          );
        } finally {
          await inFlight;
        }
      });

      it('a new provider instance over the same location recovers lastSeq', async () => {
        const stream = nextId('log');
        const first = await startProvider(createProvider);
        try {
          await first.provider.logs.appendBatch(stream, [
            { entry: { n: 'a' }, seq: 1 },
            { entry: { n: 'b' }, seq: 2 }
          ]);
          assert.equal(await first.provider.logs.lastSeq(stream), 2);
          // Shut the writer down before opening the second instance: the
          // restart this simulates is a process exit, not two live writers.
          await first.provider.shutdown();

          const second = await startProvider(createProvider, { reuse: true });
          try {
            assert.equal(
              await second.provider.logs.lastSeq(stream),
              2,
              'lastSeq comes from durable storage, not from memory'
            );
            assert.deepEqual(
              (await second.provider.logs.read(stream)).map(r => r.n),
              ['a', 'b']
            );
            await second.provider.logs.append(stream, { n: 'c' }, 3);
            assert.equal(await second.provider.logs.lastSeq(stream), 3);
          } finally {
            await second.dispose();
          }
        } finally {
          await first.dispose();
        }
      });

      it('deleteStream removes the stream and reports false the second time', async () => {
        const stream = nextId('log');
        await shared.logs.append(stream, { n: 'a' }, 1);
        assert.equal(await shared.logs.deleteStream(stream), true);
        assert.deepEqual(await shared.logs.read(stream), []);
        assert.equal(await shared.logs.lastSeq(stream), 0);
        assert.equal(await shared.logs.deleteStream(stream), false);
      });

      it("sweep({kind}) leaves another consumer's streams alone", async () => {
        // The sweep is driven from one consumer's retention policy — today the
        // run ledger's `runLog.retentionDays`. Store-wide, that policy deletes
        // every other consumer's aged streams too, and counts them into the
        // ledger's own `removed` total, so the number in the log does not even
        // show it happening. The second consumer does not exist yet, which is
        // exactly why this is worth pinning now: nothing would fail when it
        // arrives, its data would simply stop being there.
        const { provider, dispose } = await startProvider(createProvider);
        try {
          const mine = `retained:${nextId('sweep')}`;
          const theirs = `other:${nextId('sweep')}`;
          await provider.logs.append(mine, { n: 'mine' }, 1);
          await provider.logs.append(theirs, { n: 'theirs' }, 1);
          await provider.logs.flush();
          await delay(SHORT_WAIT_MS);

          const result = await provider.logs.sweep({
            olderThan: Date.now(),
            kind: 'retained'
          });
          assert.ok(result.streams >= 1, 'the scoped stream was swept');
          assert.deepEqual(await provider.logs.read(mine), [], 'the scoped stream is gone');
          assert.equal(
            (await provider.logs.read(theirs)).length,
            1,
            "a stream of another kind is not this policy's to delete"
          );
        } finally {
          await dispose();
        }
      });

      it('sweep removes streams older than olderThan and keeps newer ones', async () => {
        // Retention is store-wide, so it runs on its own instance rather than
        // sweeping away streams other cases are still using.
        const { provider, dispose } = await startProvider(createProvider);
        try {
          const old = nextId('sweep');
          const fresh = nextId('sweep');
          await provider.logs.append(old, { n: 'old' }, 1);
          await provider.logs.flush();
          await delay(SHORT_WAIT_MS);
          const cutoff = Date.now();
          await delay(SHORT_WAIT_MS);
          await provider.logs.append(fresh, { n: 'fresh' }, 1);
          await provider.logs.flush();

          const result = await provider.logs.sweep({ olderThan: cutoff });
          assert.ok(result.streams >= 1, 'the aged stream was swept');
          assert.equal(typeof result.blobs, 'number');
          assert.deepEqual(await provider.logs.read(old), [], 'the aged stream is gone');
          assert.equal((await provider.logs.read(fresh)).length, 1, 'the recent stream survived');
        } finally {
          await dispose();
        }
      });

      it('sweep accepts a Date and keeps everything newer than it', async () => {
        const { provider, dispose } = await startProvider(createProvider);
        try {
          const stream = nextId('sweep');
          await provider.logs.append(stream, { n: 'recent' }, 1);
          await provider.logs.flush();
          const result = await provider.logs.sweep({ olderThan: new Date(Date.now() - 3600_000) });
          assert.deepEqual(result, { streams: 0, blobs: 0 });
          assert.equal((await provider.logs.read(stream)).length, 1);
        } finally {
          await dispose();
        }
      });

      it('a sequence number that is not a positive integer is rejected', async () => {
        const stream = nextId('log');
        for (const seq of [0, -1, 1.5, Number.NaN, '2', null, undefined]) {
          await assert.rejects(
            () => shared.logs.append(stream, { n: 'x' }, seq),
            error => {
              assert.ok(error instanceof StorageError, `seq ${String(seq)} is a StorageError`);
              assert.equal(error.code, 'INVALID_SEQ');
              return true;
            },
            `seq ${String(seq)}`
          );
        }
        assert.deepEqual(await shared.logs.read(stream), [], 'nothing was persisted');
      });

      it('appendBatch validates every item before it accepts any of them', async () => {
        const stream = nextId('log');
        // A provider that validates and inserts item by item leaves the first
        // half of the batch behind; the caller retries the batch whole and the
        // stream ends up holding the same sequence numbers twice.
        await assert.rejects(
          () =>
            shared.logs.appendBatch(stream, [
              { entry: { n: 'a' }, seq: 1 },
              { entry: { n: 'b' }, seq: 0 }
            ]),
          error => {
            assert.ok(error instanceof StorageError, 'a bad seq in a batch is a StorageError');
            assert.equal(error.code, 'INVALID_SEQ');
            return true;
          }
        );
        assert.deepEqual(await shared.logs.read(stream), [], 'a rejected batch persists nothing');
        assert.equal(await shared.logs.lastSeq(stream), 0);
      });

      it('streams are isolated from one another', async () => {
        const one = nextId('log');
        const two = `run:${nextId('log')}`;
        await shared.logs.append(one, { n: 'one' }, 1);
        await shared.logs.append(two, { n: 'two' }, 5);
        assert.deepEqual(
          (await shared.logs.read(one)).map(r => r.n),
          ['one']
        );
        assert.deepEqual(
          (await shared.logs.read(two)).map(r => r.n),
          ['two']
        );
        assert.equal(await shared.logs.lastSeq(one), 1);
        assert.equal(await shared.logs.lastSeq(two), 5);
        assert.equal(await shared.logs.deleteStream(one), true);
        assert.equal(await shared.logs.lastSeq(two), 5, 'deleting one stream spares the other');
      });
    });

    describe('blobs', { skip: skipWithoutBlobs }, () => {
      it('putBlob then getBlob round-trips the bytes', async () => {
        const stream = nextId('blob');
        const bytes = Buffer.from('conformance blob payload', 'utf8');
        const ref = await shared.logs.putBlob(stream, 'payload.bin', bytes);
        assert.equal(ref.stream, stream);
        assert.equal(ref.name, 'payload.bin');
        assert.equal(ref.bytes, bytes.length);
        assert.equal(ref.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
        assert.equal(ref.contentType, 'application/octet-stream');
        const read = await shared.logs.getBlob(stream, 'payload.bin');
        assert.ok(Buffer.isBuffer(read), 'getBlob returns a Buffer');
        assert.deepEqual(read, bytes);
      });

      it('putBlob accepts a string or a Uint8Array and honours contentType', async () => {
        const stream = nextId('blob');
        const text = await shared.logs.putBlob(stream, 'note.txt', 'hello', {
          contentType: 'text/plain'
        });
        assert.equal(text.contentType, 'text/plain');
        assert.equal(text.bytes, 5);
        assert.equal((await shared.logs.getBlob(stream, 'note.txt')).toString('utf8'), 'hello');

        const raw = Uint8Array.from([1, 2, 3, 4]);
        const binary = await shared.logs.putBlob(stream, 'raw.bin', raw);
        assert.equal(binary.bytes, 4);
        assert.deepEqual(await shared.logs.getBlob(stream, 'raw.bin'), Buffer.from(raw));
      });

      it('a blob name carrying path separators is contained, not traversed', async () => {
        const stream = nextId('blob');
        const hostile = '../../etc/passwd';
        const bytes = Buffer.from('contained', 'utf8');
        const ref = await shared.logs.putBlob(stream, hostile, bytes);
        assert.equal(ref.stream, stream);
        assert.equal(ref.bytes, bytes.length);
        // Whether the provider sanitizes the name or stores it verbatim, the
        // caller must be able to read it back under the name it passed — and a
        // provider that resolved it as a path would either escape its own store
        // or refuse a name that is not actually an escape.
        assert.deepEqual(await shared.logs.getBlob(stream, hostile), bytes);
      });

      it('getBlob of a missing blob is null', async () => {
        const stream = nextId('blob');
        assert.equal(await shared.logs.getBlob(stream, 'nothing.bin'), null);
        await shared.logs.putBlob(stream, 'present.bin', Buffer.from('x'));
        assert.equal(await shared.logs.getBlob(stream, 'still-nothing.bin'), null);
      });

      it('sweep reclaims the blobs of a stream that persisted no record', async () => {
        // Retention is store-wide, so this runs on its own instance.
        const { provider, dispose } = await startProvider(createProvider);
        try {
          const orphan = nextId('sweep');
          await provider.logs.putBlob(orphan, 'spill.bin', Buffer.from('spilled payload'));
          assert.notEqual(await provider.logs.getBlob(orphan, 'spill.bin'), null);
          // A cut-off in the future: nothing this instance holds can survive by
          // being recent, so a payload still there afterwards is one retention
          // can never reach — and blobs are the large ones.
          const result = await provider.logs.sweep({ olderThan: Date.now() + 3600_000 });
          assert.ok(result.blobs >= 1, 'the spilled payload was counted as removed');
          assert.equal(
            await provider.logs.getBlob(orphan, 'spill.bin'),
            null,
            'a blob whose stream never reached storage is still swept'
          );
        } finally {
          await dispose();
        }
      });

      it('deleteStream removes the blobs stored beside the stream', async () => {
        const stream = nextId('blob');
        await shared.logs.append(stream, { n: 'a' }, 1);
        await shared.logs.putBlob(stream, 'payload.bin', Buffer.from('bytes'));
        assert.equal(await shared.logs.deleteStream(stream), true);
        assert.equal(await shared.logs.getBlob(stream, 'payload.bin'), null);
      });
    });

    describe('locks', { skip: skipWithoutLocks }, () => {
      it('withLock returns the value fn resolved with', async () => {
        const value = await shared.locks.withLock(nextId('lock'), async () => ({ ok: 42 }));
        assert.deepEqual(value, { ok: 42 });
      });

      it('a contending withLock waits for the holder and only then runs', async () => {
        const lock = nextId('lock');
        const order = [];
        const entered = deferred();
        const release = deferred();

        const holder = shared.locks.withLock(lock, async () => {
          order.push('holder:enter');
          entered.resolve();
          await release.promise;
          order.push('holder:exit');
          return 'holder';
        });
        await entered.promise;

        const contender = shared.locks.withLock(
          lock,
          async () => {
            order.push('contender:enter');
            return 'contender';
          },
          { waitMs: 5000 }
        );
        try {
          // Long enough for a polling implementation to have retried at least
          // once; if exclusion were broken the contender would already have run.
          await delay(SHORT_WAIT_MS);
          assert.deepEqual(order, ['holder:enter'], 'the contender is still waiting');

          release.resolve();
          assert.deepEqual(await Promise.all([holder, contender]), ['holder', 'contender']);
          assert.deepEqual(order, ['holder:enter', 'holder:exit', 'contender:enter']);
        } finally {
          // A failed assertion must not leave the holder parked forever or the
          // contender rejecting into nobody's hands.
          release.resolve();
          await Promise.allSettled([holder, contender]);
        }
      });

      it('a rejecting fn releases the lock and its rejection propagates unchanged', async () => {
        const lock = nextId('lock');
        const boom = new Error('fn exploded');
        boom.marker = 'conformance';
        await assert.rejects(
          () =>
            shared.locks.withLock(lock, async () => {
              throw boom;
            }),
          error => {
            assert.equal(error, boom, 'the original error instance is rethrown');
            assert.equal(error.marker, 'conformance');
            return true;
          }
        );
        // The lease must be gone: a following acquisition may not have to wait.
        const reacquired = await shared.locks.withLock(lock, async () => 'free', { waitMs: 200 });
        assert.equal(reacquired, 'free');
      });

      it('waitMs expiry throws LockTimeoutError without running fn', async () => {
        const lock = nextId('lock');
        const entered = deferred();
        const release = deferred();
        let contenderRan = false;

        const holder = shared.locks.withLock(lock, async () => {
          entered.resolve();
          await release.promise;
          return 'holder';
        });
        await entered.promise;

        try {
          await assert.rejects(
            () =>
              shared.locks.withLock(
                lock,
                async () => {
                  contenderRan = true;
                },
                { waitMs: 20 }
              ),
            LockTimeoutError
          );
          assert.equal(contenderRan, false, 'fn never runs without the lock');
        } finally {
          release.resolve();
          await holder;
        }
      });

      it('a lease older than its ttlMs is taken over', async () => {
        const lock = nextId('lock');
        const order = [];
        const entered = deferred();
        const release = deferred();

        const holder = shared.locks.withLock(
          lock,
          async () => {
            order.push('holder:enter');
            entered.resolve();
            await release.promise;
            order.push('holder:exit');
            return 'holder';
          },
          { ttlMs: 30, waitMs: 2000 }
        );
        await entered.promise;

        try {
          // Let the lease age past its (deliberately tiny) TTL so the next
          // acquirer must treat it as abandoned by a dead process.
          await delay(SHORT_WAIT_MS);

          const taker = await shared.locks.withLock(lock, async () => {
            order.push('taker');
            return 'taker';
          });
          assert.equal(taker, 'taker');

          release.resolve();
          assert.equal(await holder, 'holder');
          assert.deepEqual(order, ['holder:enter', 'taker', 'holder:exit']);
          // The previous holder must not have released the lease it lost.
          const reacquired = await shared.locks.withLock(lock, async () => 'after', {
            waitMs: 500
          });
          assert.equal(reacquired, 'after');
        } finally {
          release.resolve();
          await Promise.allSettled([holder]);
        }
      });

      it('an expired lease under contention is taken over by one waiter at a time', async () => {
        const lock = nextId('lock');
        // A holder that outlives its own TTL: every waiter below finds a lease
        // that looks abandoned, which is also the state a crashed worker leaves
        // behind. Taking it over must still be an election, not a free-for-all
        // in which each waiter removes whatever lease it happens to find.
        const entered = deferred();
        const release = deferred();
        const holder = shared.locks.withLock(
          lock,
          async () => {
            entered.resolve();
            await release.promise;
            return 'holder';
          },
          { ttlMs: 20, waitMs: 2000 }
        );
        await entered.promise;
        await delay(SHORT_WAIT_MS);

        let inside = 0;
        let mostAtOnce = 0;
        const contenders = Array.from({ length: 8 }, () =>
          shared.locks.withLock(
            lock,
            async () => {
              inside += 1;
              mostAtOnce = Math.max(mostAtOnce, inside);
              await delay(1);
              inside -= 1;
            },
            { ttlMs: 5000, waitMs: 5000 }
          )
        );

        try {
          await Promise.all(contenders);
          assert.equal(mostAtOnce, 1, 'a takeover never lets two waiters hold the same lease');
        } finally {
          release.resolve();
          await Promise.allSettled([holder, ...contenders]);
        }
      });

      it('different lock names do not exclude each other', async () => {
        const first = nextId('lock');
        const second = nextId('lock');
        const entered = deferred();
        const release = deferred();

        const holder = shared.locks.withLock(first, async () => {
          entered.resolve();
          await release.promise;
          return 'first';
        });
        await entered.promise;

        try {
          const other = await shared.locks.withLock(second, async () => 'second');
          assert.equal(other, 'second');
          release.resolve();
          assert.equal(await holder, 'first');
        } finally {
          release.resolve();
          await Promise.allSettled([holder]);
        }
      });
    });

    describe('notifications', { skip: skipWithoutEvents }, () => {
      it('a subscriber receives published events, with at stamped when omitted', async () => {
        const seen = [];
        const unsubscribe = shared.notifier.subscribe(event => seen.push(event));
        try {
          await shared.notifier.publish({ type: 'conformance.plain', ns: 'n', key: 'k' });
          const at = '2020-01-01T00:00:00.000Z';
          await shared.notifier.publish({ type: 'conformance.stamped', at });
          await waitFor(() => seen.length === 2, 'both events to be delivered');
          assert.equal(seen[0].type, 'conformance.plain');
          assert.equal(seen[0].ns, 'n');
          assert.equal(seen[0].key, 'k');
          assert.match(seen[0].at, ISO_8601, 'the notifier stamps a missing at');
          assert.equal(seen[1].at, at, 'a supplied at is preserved');
        } finally {
          unsubscribe();
        }
      });

      it('unsubscribe stops delivery', async () => {
        const seen = [];
        const unsubscribe = shared.notifier.subscribe(event => seen.push(event));
        try {
          await shared.notifier.publish({ type: 'conformance.before' });
          await waitFor(() => seen.length === 1, 'the first event');
          unsubscribe();
          // Unsubscribing twice must be harmless.
          unsubscribe();
          await shared.notifier.publish({ type: 'conformance.after' });
          await delay(10);
          assert.deepEqual(
            seen.map(event => event.type),
            ['conformance.before']
          );
        } finally {
          unsubscribe();
        }
      });

      it('a throwing subscriber neither fails publish nor starves the others', async () => {
        const seen = [];
        const unsubscribeBroken = shared.notifier.subscribe(() => {
          throw new Error('subscriber is broken');
        });
        const unsubscribeGood = shared.notifier.subscribe(event => seen.push(event.type));
        try {
          await shared.notifier.publish({ type: 'conformance.resilient' });
          await waitFor(() => seen.length === 1, 'the healthy subscriber to be called');
          assert.deepEqual(seen, ['conformance.resilient']);
        } finally {
          unsubscribeBroken();
          unsubscribeGood();
        }
      });

      it('a document put publishes document.put carrying ns, key and ownerId', async () => {
        const ns = nextId('events');
        const seen = [];
        const unsubscribe = shared.notifier.subscribe(event => {
          if (event.ns === ns) seen.push(event);
        });
        try {
          await shared.documents.put(ns, 'doc', { v: 1 }, { ownerId: 'alice' });
          await waitFor(() => seen.length === 1, 'a document.put event');
          assert.equal(seen[0].type, 'document.put');
          assert.equal(seen[0].key, 'doc');
          assert.equal(seen[0].ownerId, 'alice');
          assert.match(seen[0].at, ISO_8601);
        } finally {
          unsubscribe();
        }
      });

      it('document.delete is published only when something was removed', async () => {
        const ns = nextId('events');
        const seen = [];
        const unsubscribe = shared.notifier.subscribe(event => {
          if (event.ns === ns && event.type === 'document.delete') seen.push(event);
        });
        try {
          assert.equal(await shared.documents.delete(ns, 'absent'), false);
          await delay(10);
          assert.deepEqual(seen, [], 'a no-op delete publishes nothing');

          await shared.documents.put(ns, 'doc', { v: 1 });
          assert.equal(await shared.documents.delete(ns, 'doc'), true);
          await waitFor(() => seen.length === 1, 'a document.delete event');
          assert.equal(seen[0].key, 'doc');
        } finally {
          unsubscribe();
        }
      });
    });
  });
}

export default runProviderConformance;
