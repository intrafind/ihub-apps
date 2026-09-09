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
import { EtagMismatchError, InvalidKeyError, LockTimeoutError, StorageError } from '../errors.js';

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
 *   `getCapabilities()` is expected to return.
 * @returns {void}
 */
export function runProviderConformance({ name, createProvider, capabilities }) {
  assert.equal(typeof name, 'string', 'runProviderConformance needs a provider name');
  assert.equal(typeof createProvider, 'function', 'runProviderConformance needs a factory');
  assert.ok(capabilities && typeof capabilities === 'object', 'expected capabilities are required');

  /** Skip reasons for the facets a provider may legitimately not offer. */
  const skipWithoutBlobs = capabilities.blobs ? false : 'provider reports blobs: false';
  const skipWithoutLocks =
    capabilities.locking === 'none' ? "provider reports locking: 'none'" : false;
  const skipWithoutEvents =
    capabilities.notifications === 'none' ? "provider reports notifications: 'none'" : false;
  const skipWithoutCas = capabilities.conditionalWrites
    ? false
    : 'provider reports conditionalWrites: false';

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
        assert.deepEqual(caps, capabilities);
        assert.equal(typeof caps.transactions, 'boolean');
        assert.ok(NOTIFICATION_MODES.includes(caps.notifications), 'notifications is in the enum');
        assert.ok(LOCKING_MODES.includes(caps.locking), 'locking is in the enum');
        assert.equal(typeof caps.search, 'boolean');
        assert.equal(typeof caps.multiInstance, 'boolean');
        assert.equal(typeof caps.blobs, 'boolean');
        assert.equal(typeof caps.conditionalWrites, 'boolean');
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

    describe('append logs', () => {
      it('an empty stream reads [] and reports lastSeq 0', async () => {
        const stream = nextId('log');
        assert.deepEqual(await shared.logs.read(stream), []);
        assert.equal(await shared.logs.lastSeq(stream), 0);
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
