# Storage Providers

The storage abstraction is the seam between runtime data and where that data
lives. Today everything runtime writes — run ledgers, workflow state,
interactions — is filesystem code spread across the services that own it. The
abstraction pulls that behaviour behind one provider interface so a later
release can put the same data in SQLite, PostgreSQL or OpenSearch without
touching the services.

Two kinds of data, two facets: the [run ledger](run-ledger.md) is an
append-only stream of events for a run that is happening right now, while
durable history — a chat you come back to tomorrow — is a document you read in
one go. Forcing both through a single key-value interface was the flaw in the
earlier persistence design; the provider therefore exposes an **AppendLog** and
a **DocumentStore** as separate facets, plus the two primitives a multi-instance
deployment needs later (**ChangeNotifier**, **LockManager**).

**Durable chats are the first consumer.** `server/storage/bootstrap.js` brings
the provider up in every worker at startup, and `ChatRepository` keeps stored
conversations in the `chats` and `chat-messages` namespaces — see
[Chat Persistence](chat-persistence.md), which is off by default. Everything
else — run ledgers, workflow state, interactions — is still filesystem code
inside the service that owns it, and a provider that fails to initialize simply
leaves those features behaving as they did before. The full plan is in
`concepts/persistence-layer/2026-09-09 Storage Provider and Durable Chats Design.md`.

## The four facets

A provider is a `StorageProvider` (`server/storage/StorageProvider.js`) with
four getters and a lifecycle:

```js
provider.documents; // DocumentStore
provider.logs; // AppendLog
provider.notifier; // ChangeNotifier
provider.locks; // LockManager

await provider.initialize(); // idempotent
await provider.healthCheck(); // { status: 'ok'|'degraded'|'error', provider, latencyMs, details? }
provider.getCapabilities(); // see Capabilities below
await provider.shutdown(); // flush, stop timers, close listeners
```

```js
// DocumentStore
get(ns, key)                       -> Promise<Document|null>
put(ns, key, data, opts?)          -> Promise<Document>
delete(ns, key)                    -> Promise<boolean>
list(ns, opts?)                    -> Promise<{ items: Document[], nextCursor: string|null }>

// AppendLog
append(stream, entry, seq)         -> Promise<{ stream, seq }>
appendBatch(stream, items)         -> Promise<{ stream, count, lastSeq }>
read(stream, opts?)                -> Promise<Object[]>
lastSeq(stream)                    -> Promise<number>
deleteStream(stream)               -> Promise<boolean>
sweep({ olderThan })               -> Promise<{ streams: number, blobs: number }>
putBlob(stream, name, bytes, opts?)-> Promise<BlobRef>
getBlob(stream, name)              -> Promise<Buffer|null>
flush()                            -> Promise<void>

// ChangeNotifier
publish(event)                     -> Promise<void>
subscribe(handler)                 -> () => void          // returns unsubscribe
close()                            -> Promise<void>

// LockManager
withLock(name, fn, opts?)          -> Promise<T>           // opts { ttlMs = 30000, waitMs = 5000 }
```

The four abstract base classes carry the full contract in their JSDoc; a
provider extends them and every method it does not implement throws
`NotSupportedError` rather than silently doing nothing.

## Documents

```js
{
  ns: string,
  key: string,
  ownerId: string | null,
  contentType: string,   // default 'application/json'
  createdAt: string,     // ISO-8601, preserved across overwrites
  updatedAt: string,     // ISO-8601, always "now" on put
  etag: string,          // sha256 hex of JSON.stringify(data)
  size: number,          // Buffer.byteLength(JSON.stringify(data), 'utf8')
  data: any              // undefined when list({ includeData: false })
}
```

`etag` and `size` are **derived from the data**, not stored and not
provider-specific: the same document has the same etag on every provider, so a
migration can verify a copy by comparing etags.

`ns` and `key` are validated with `isValidId()` from
`server/utils/pathSecurity.js` — `''`, `'a/b'` and `'../x'` all raise
`InvalidKeyError`. `data` must be JSON-serializable and must not be
`undefined` (`StorageError` with code `INVALID_DATA`).

### Conditional writes

`put(ns, key, data, opts)` takes `{ ownerId?, etag?, contentType? }`. The
`etag` option has three modes, and they are distinguished by presence, not by
truthiness:

| `etag`             | Semantics                                                                       | On conflict          |
| ------------------ | -------------------------------------------------------------------------------- | -------------------- |
| omitted            | Unconditional create-or-overwrite                                                | –                    |
| a string           | Compare-and-set: the stored document must exist and carry exactly this etag      | `EtagMismatchError`  |
| `null`             | Create-only: the key must be free                                                | `EtagMismatchError`  |

A rejected conditional write leaves the stored document exactly as it was.
`EtagMismatchError` carries `httpStatus` 409, so a route can map it straight
onto a response.

`ownerId` follows the same absent-versus-null rule: leaving it out of an
overwrite **keeps** the stored owner, passing `ownerId: null` clears it.
Providers read it with `'ownerId' in opts`.

`contentType` is carried over the same way: absent on an overwrite it keeps the
stored type, absent on a create it defaults to `application/json`. A document
written as `text/html` stays `text/html` across a metadata-only rewrite rather
than silently turning into JSON.

### Listing

`list(ns, { ownerId?, prefix?, limit?, cursor?, includeData? })`:

- Ordering is **key ascending** (plain string comparison), the same on every
  provider.
- `limit` defaults to 100 and is clamped to 1000 rather than rejected.
- `nextCursor` is opaque and `null` on the last page; passing it back returns
  the next page with no gaps and no repeats. A cursor the store did not issue
  raises `StorageError` with code `INVALID_CURSOR` — it is never silently
  treated as "start from the beginning", which would make a paging loop repeat
  the namespace forever.
- `ownerId` filtering must be **index-backed** — no provider may scan a whole
  namespace to answer "list my chats".
- `prefix` filters keys with `startsWith`; `includeData: false` omits `data`
  and keeps the metadata.
- An unknown namespace lists empty; it never throws.

## Append-logs

**Sequence numbers stay with the caller.** `RunLog` assigns `seq` synchronously
in memory because the SSE projection depends on it, so the log persists
`{ ...entry, seq }` verbatim and never allocates. A `seq` that is not a
positive integer raises `StorageError` with code `INVALID_SEQ`.

`read(stream, { afterSeq = 0, limit = Infinity })` returns records with
`seq > afterSeq` in ascending seq order — by sequence number, not by the order
they reached storage, so `limit` selects the *lowest* sequence numbers and a
caller paging with `afterSeq` cannot skip a record. `appendBatch` validates
every item before it accepts any of them, so a batch rejected for a bad `seq`
persists nothing and can be retried whole. `lastSeq(stream)` must be correct
**after a restart** — a fresh provider instance over the same data reports the
same number, which is how a recovering worker continues a run's sequence
without reusing a number.

Writes may be buffered, but `read`, `lastSeq`, `sweep` and `deleteStream` flush
the affected stream first, so a read always sees what was appended. "Nothing is
queued" is not enough to skip that barrier: a provider that empties its buffer
before writing it must still wait for a flush that is already in flight.

`putBlob` takes `Buffer | string | Uint8Array` plus
`{ contentType = 'application/octet-stream' }` and returns a `BlobRef`
(`{ stream, name, bytes, sha256, contentType }`); `getBlob` returns `null` when
the blob is absent. Blobs are the ledger's spill payloads. `deleteStream`
removes a stream's blobs with it, and `sweep({ olderThan })` (a `Date` or
epoch-ms) does the same for every stream last modified before that point — the
retention sweep. Blobs are swept in their own right, not only as a side effect
of finding the stream beside them, so a payload spilled for a stream that never
persisted a record is still reclaimed.

## Change notification

```js
{ type: string, ns?: string, key?: string, ownerId?: string|null, at: string }
```

`at` is filled in by the notifier when the caller omits it. The document store
publishes `document.put` and `document.delete` (the delete only when it
actually removed something). A handler that throws is caught and logged: it can
never break `publish` or starve the other subscribers.

The eventual consumer is config-cache invalidation across instances, which is
why the reach of notifications is part of the capability matrix.

## Locks

`withLock(name, fn, { ttlMs = 30000, waitMs = 5000 })` runs `fn` while holding
an exclusive lease, releases it when `fn` settles either way, and rethrows
`fn`'s rejection unchanged. If the lease is held elsewhere it waits up to
`waitMs` and then throws `LockTimeoutError` (`httpStatus` 503) — it never runs
`fn` without the lock. A lease older than its `ttlMs` is treated as abandoned
by a dead process and taken over.

Reentrancy is **not** supported: a nested `withLock` on the same name blocks
until `waitMs` expires and then throws.

## Choosing a provider

```json
{
  "storage": {
    "provider": "filesystem",
    "filesystem": {
      "dataDir": "data",
      "flushIntervalMs": 2000
    }
  }
}
```

| Key                            | Default        | Meaning                                                    |
| ------------------------------ | -------------- | ---------------------------------------------------------- |
| `storage.provider`             | `filesystem`   | Which registered provider backs runtime data               |
| `storage.filesystem.dataDir`   | `data`         | Directory under `contents/` holding storage data           |
| `storage.filesystem.flushIntervalMs` | `2000`   | Debounce for buffered append-log writes                    |

`IHUB_STORAGE_PROVIDER` overrides `storage.provider` for one environment.
Precedence is environment variable → `platform.json` → `filesystem`, and the
config handed to the provider is `storage[<provider>]`, or `{}` when that block
is absent. `provider` is a free string, not an enum, so an installation can be
configured for a provider a later release registers without failing platform
validation on the older one.

**A provider change requires a restart.** The provider is a process singleton;
`initializeStorage()` called twice returns the instance that already exists and
logs a warning when the resolved name differs.

Migration V094 writes the defaults into an existing `platform.json`, so
upgrading installations see the block without editing anything.

```js
import { initializeStorage, getStorageProvider, shutdownStorage } from '../storage/index.js';

const provider = await initializeStorage({ platformConfig }); // resolves + initializes
getStorageProvider(); // the singleton; throws STORAGE_NOT_INITIALIZED before init
await shutdownStorage(); // idempotent
```

`server/storage/index.js` is the public surface. It re-exports the interfaces,
the errors and the registry, and it is the one place that calls
`registerProvider('filesystem', …)` — provider modules themselves have no
registry side effects, so importing one from a test or a tool cannot change
which backend the process resolves.

## Errors

| Class                  | `code`                  | `httpStatus` |
| ---------------------- | ----------------------- | ------------ |
| `StorageError`         | caller-supplied         | –            |
| `EtagMismatchError`    | `ETAG_MISMATCH`         | 409          |
| `LockTimeoutError`     | `LOCK_TIMEOUT`          | 503          |
| `InvalidKeyError`      | `INVALID_KEY`           | 400          |
| `NotSupportedError`    | `NOT_SUPPORTED`         | 501          |
| `UnknownProviderError` | `UNKNOWN_PROVIDER`      | –            |

`StorageError` is also thrown directly for `INVALID_DATA`, `INVALID_SEQ`,
`INVALID_CURSOR`, `PATH_ESCAPE` and `STORAGE_NOT_INITIALIZED`.

## The filesystem provider

The default provider, and the reference implementation. Its base directory is
`contents/data` (`storage.filesystem.dataDir` under `contents/`, or an absolute
`baseDir` in provider config, which is what the tests pass).

```
contents/data/
  <ns>/<key>.json                     the document envelope
  <ns>/.owners/<ownerSegment>/<key>   empty marker file — the per-owner index
  <ns>/.locks/<key>.lock              transient compare-and-set lock
  logs/<stream segments>.jsonl        one append-log stream, one JSON per line
  logs/<stream segments>.blobs/       that stream's blobs
  locks/<sha256(name)[0..40]>.lock    LockManager leases
```

The envelope is written with `atomicWriteJSON`:

```
{
  "v": 1,
  "key": "…",
  "ownerId": "…" | null,
  "contentType": "application/json",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "data": {}
}
```

`etag` and `size` are recomputed on every read, never stored, so they cannot
drift from the data.

**Why documents are flat and owners are an index.** The design sketch had
`contents/data/<ns>/[<ownerId>/]<key>.json`, but `get(ns, key)` takes no
ownerId — a document living under an owner directory could not be found by key
in a single read. So the documents stay flat and the per-owner subdirectories
become the *index*, which is what the "owner listing must never be a scan"
constraint actually asks for. Owner directories are named by the first 40 hex
characters of `sha256(ownerId)` because owner ids are external strings — email
addresses, OIDC subjects — that are not path-safe; the readable ownerId stays
in every envelope.

A `put` writes the owner marker **before** the envelope. A crash in between
leaves a marker whose document does not exist, and `list` skips those while
`put`/`delete` clean them up. The other order would make a written document
invisible to its owner, which is the worse failure.

`put` and `delete` run their read-modify-write under a per-key lock file
(`withFileLock`), so the etag compare-and-set and the `createdAt` carry-over
hold across cluster workers sharing the volume. That is advisory,
single-machine exclusion — two installations pointed at one directory are not
supported.

Streams map to directories: `run:abc` is `logs/run/abc.jsonl` with its blobs in
`logs/run/abc.blobs/`. A stream name without a colon lands in the `_` bucket.
Appends go through the shared buffered appender (`utils/jsonlAppender.js`) —
the same mechanism `RunLog` uses — flushed on the configured interval, on any
read and on shutdown. A read of an idle log still writes nothing: the flush
short-circuits on an empty buffer, and taking it unconditionally is what makes
the read wait out a drain that is already under way. `lastSeq` streams the file
and returns the highest `seq` it finds rather than trusting the last line, and
malformed lines are skipped, never thrown.

Documents whose key starts with a dot (`.draft`) are ordinary documents:
`isValidId` accepts them, and the namespace listing skips the store's own
`.owners`, `.locks` and `.tmp_*` entries by name rather than by their leading
dot, so the plain and the owner-filtered listing always agree on what a
namespace holds.

An abandoned lease is taken over with `rename` rather than `unlink`. `unlink`
removes whatever is at the path when it runs, not the lease that was judged
abandoned a round-trip earlier, so two waiters could each delete the other's
fresh lease and both enter the critical section. `rename` elects exactly one
evictor — everyone else gets `ENOENT` and retries — and hands it the bytes it
moved, so a lease that turns out to have been acquired in the meantime is put
straight back with `link` (which refuses an existing target).

That narrows the window rather than closing it: the path is unoccupied between
the rename and the restore, so a third waiter creating a lease right there
makes the restore fail and the moved-aside lease is lost. A POSIX filesystem
offers no atomic compare-and-delete, so no eviction scheme on files closes this
entirely — hence `locking: 'advisory-single-machine'`. Anything that must not
run twice across instances needs a provider with real distributed locks
(PostgreSQL advisory locks, step 3 of the epic), not this one.

Every path is built through `containedPath()`, which resolves the target and
rejects anything that leaves the base directory (`PATH_ESCAPE`).

## Capabilities

`getCapabilities()` returns what a caller may rely on, so nobody has to
special-case a provider by name:

```js
{
  transactions: boolean,
  notifications: 'in-process' | 'push' | 'poll' | 'none',
  locking: 'none' | 'advisory-single-machine' | 'distributed',
  search: boolean,
  multiInstance: boolean,
  blobs: boolean,
  conditionalWrites: boolean
}
```

The filesystem provider reports
`{ transactions: false, notifications: 'in-process', locking: 'advisory-single-machine', search: false, multiInstance: false, blobs: true, conditionalWrites: true }`.

The planned lineup, from the design:

|                          | Filesystem                   | SQLite                        | PostgreSQL          | OpenSearch                                |
| ------------------------ | ---------------------------- | ----------------------------- | ------------------- | ----------------------------------------- |
| Durable chats/runs/config | ✅                           | ✅                            | ✅                  | ✅                                        |
| Transactions             | ❌                           | ✅                            | ✅                  | ❌ (per-doc versioning)                   |
| Change notification      | in-process                   | in-process                    | LISTEN/NOTIFY (push)| poll (change-log index, ~5 s)             |
| Distributed locks        | ❌                           | ❌                            | advisory locks      | TTL documents (create-if-absent)          |
| Full-text search         | ❌                           | ❌                            | JSONB GIN           | ✅ native                                 |
| Multi-instance           | ❌                           | ❌                            | ✅ first-class      | ⚠️ supported, polling caveats             |
| Best for                 | default, dev, single instance | small installs, one-file backup | production HA    | search-centric orgs                       |

Only the filesystem provider ships today.

## Writing a provider

1. Extend `StorageProvider` and the four facet base classes from
   `server/storage/`. Implement the lifecycle (`initialize` idempotent,
   `shutdown` leaves no timers or handles behind), and report the truth in
   `getCapabilities()`.
2. Register it in `server/storage/index.js` with
   `registerProvider('<name>', config => new MyProvider(config))`, and add its
   config block to the `storage` section of
   `server/validators/platformConfigSchema.js` plus a migration for existing
   installations.
3. Run the conformance suite against it — it is the acceptance gate:

```js
import { runProviderConformance } from '../storage/__tests__/providerConformance.js';

runProviderConformance({
  name: 'my-provider',
  createProvider: async ({ reuse } = {}) => ({ provider, cleanup }),
  capabilities: {
    /* what getCapabilities() must return */
  }
});
```

`server/storage/__tests__/providerConformance.js` is provider-agnostic: 59
`node:test` cases covering lifecycle, document CRUD and etag semantics,
owner listing and cursor paging, append-log slicing and **restart recovery**
(`createProvider({ reuse: true })` opens a second instance over the same
location and must report the same `lastSeq`), blobs, lock ordering and TTL
takeover, and notifier delivery. `server/tests/storage-filesystem-conformance.test.js`
is the filesystem provider's four-line wiring of it over a temp directory —
copy that file for a new provider.

```bash
npm run test:storage
```
