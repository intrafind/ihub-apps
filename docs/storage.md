# Storage Providers

The storage abstraction is the seam between runtime data and where that data
lives. Run ledgers, workflow state, interactions and stored chats each used to
be filesystem code inside the service that owned it. They now go through one
provider interface, so a later release can put the same data in SQLite,
PostgreSQL or OpenSearch without touching the services.

Two kinds of data, two facets: the [run ledger](run-ledger.md) is an
append-only stream of events for a run that is happening right now, while
durable history — a chat you come back to tomorrow — is a document you read in
one go. Forcing both through a single key-value interface was the flaw in the
earlier persistence design; the provider therefore exposes an **AppendLog** and
a **DocumentStore** as separate facets, plus the two primitives a multi-instance
deployment needs later (**ChangeNotifier**, **LockManager**).

## Who uses it

`server/storage/bootstrap.js` brings the provider up in every worker at
startup. Durable chats were the first consumer; the runtime stores followed.

| Namespace                   | Holds                                                       | Owner id                    | Documented in                            |
| --------------------------- | ----------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| `chats`, `chat-messages`    | stored conversations and their transcripts (off by default)  | the chat's principal        | [Chat Persistence](chat-persistence.md)  |
| `runs`                      | one summary per run — chats, workflow executions, agent runs | the run's principal         | [Run Ledger](run-ledger.md)              |
| `interactions`              | pending and recently settled human interactions              | the raising run's principal | [Run Ledger](run-ledger.md)              |
| `workflow-state`            | an execution's checkpoint, and what a resume reads           | the principal that started it | [Workflows](workflows.md)              |
| `integration-conversations` | the iAssistant conversation a chat maps to                   | –                           | –                                        |
| `runtime-imports`           | markers saying a one-time legacy import has already run       | –                           | [Run Ledger](run-ledger.md)              |
| `config`, `apps`, `models`, `prompts`, `tools`, `workflows`, `agents`, `locales` | an installation's configuration, read and written where it already lives | – | [Configuration Storage](configuration.md) |

`integration-conversations` is the smallest of them and the least visible: two
fields per chat (the remote conversation id and the id of the last answer,
which the next message threads onto) that used to live in a per-worker `Map`.
Storing them means a chat keeps one iAssistant conversation across a restart
and across workers, instead of quietly starting a second one. Writes are
coalesced on a timer, because that state is updated on every streamed chunk
and a document write on the streaming path is not acceptable.

Append-log streams are named `run:<runId>` and carry a run's events, with its
spilled payloads as blobs beside them. Leases are taken on `chat:<id>` for a
chat's read-modify-write, on `interaction:<id>` for the answer critical
section, on `runlog:<runId>` while a recovering worker continues a run's
sequence, and on `runtime-import:<store>` for the one-time legacy imports.

**A provider that fails to initialize is not fatal to any of them.** Each
consumer keeps the behaviour and the on-disk layout it had before the move:
the ledger writes `contents/data/run-log/` as it always did, workflow state
stays in its `<executionId>/latest.json` directories, interactions fall back to
`interactions.json` plus claim markers, iAssistant conversation state stays
in memory, and durable chats — which have no earlier layout — are simply off.
That is a supported state, not a degraded one.

One namespace shares a directory with the files it replaces: `workflow-state`
documents (`contents/data/workflow-state/<executionId>.json`) sit beside the
legacy `<executionId>/latest.json` checkpoint directories that are already
there, and the two are read as a union with the document winning. The one-time
imports that populate these namespaces never delete what they read — see
[Upgrading an installation that already has a ledger](run-ledger.md#upgrading-an-installation-that-already-has-a-ledger).

The full plan is in
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

## Raw namespaces: configuration stays where it is

Configuration is the one kind of data that could not move. Every file under
`contents/config/`, `contents/apps/`, `contents/models/` and their siblings is
hand-edited, git-tracked, docker-mounted, seeded from `server/defaults/` and
rewritten by the checksum-frozen migrations. Storing it as documents the way
everything above does would relocate it to `contents/data/` *and* wrap it in
the envelope: every installation's tree would change, `git status` would light
up, a docker mount would no longer match the image, and the migrations would
be editing files nothing reads any more.

So the document store has a second mode. A namespace declared **raw** is a
*view over files that already exist*: the JSON file at
`<contents>/<dir>/<key>.json` **is** the document body, serialized exactly the
way `utils/atomicWrite.js` has always serialized it (`JSON.stringify(data,
null, 2)`, no trailing newline). Nothing is relocated, nothing is wrapped, and
an installation's `contents/` is byte-identical before and after the release
that introduced this. That is not an aspiration:
`server/tests/config-store-byte-identity.test.js` hashes every file of a
populated tree, drives a boot's worth of reads and a save of each config type
through the store, and compares the hashes again.

`server/storage/namespaces.js` holds the whole map, and is the only place it is
written down:

| Namespace   | Directory under `contents/` | Holds                                        |
| ----------- | --------------------------- | -------------------------------------------- |
| `config`    | `config/`                   | `platform.json`, `ui.json`, `groups.json`, …  |
| `apps`      | `apps/`                     | one file per AI app                           |
| `models`    | `models/`                   | one file per LLM model                        |
| `prompts`   | `prompts/`                  | one file per prompt                           |
| `tools`     | `tools/`                    | one file per tool definition                  |
| `workflows` | `workflows/`                | one file per workflow                         |
| `agents`    | `agents/profiles/`          | agent profiles (`agents/memory` is runtime state) |
| `locales`   | `locales/`                  | translation overrides layered over the builtin locales |

Only directories that hold JSON documents **one level deep** are namespaces.
Page bodies (`contents/pages/<lang>/<id>.md`), markdown sources, renderers and
skill trees are text, or nested, or whole directories installed as a unit; they
reach the same seam — `ConfigStore` — but not the provider. See
[Configuration Storage](configuration.md) for that seam and for what a database
provider would have to answer.

### What raw changes

|                     | Enveloped document                        | Raw document                                       |
| ------------------- | ----------------------------------------- | -------------------------------------------------- |
| On disk             | `contents/data/<ns>/<key>.json`, wrapped  | `contents/<dir>/<key>.json`, the file itself        |
| `etag`              | sha256 of `JSON.stringify(data)`          | sha256 of the file's **bytes**                      |
| `ownerId`           | an owner, or null                         | rejected — `NotSupportedError`                      |
| `createdAt`/`updatedAt` | recorded in the envelope              | both `stat.mtime`                                   |
| `contentType`       | any                                       | `application/json` only                             |
| Sidecars            | `.owners/`, `.locks/` inside the namespace | none inside the namespace                          |

Each of those is a consequence of "the file is the document", not a limitation
someone chose:

- **The etag is over the bytes** because that is what a compare-and-set has to
  compare. Two files with equal data but different formatting are different
  documents here, which is exactly what makes a conditional write notice that
  somebody edited the file by hand between the read and the write.
- **There is no owner.** Configuration belongs to the installation, so
  `put(..., { ownerId })` and `list(ns, { ownerId })` are rejected rather than
  quietly ignored — a silently dropped owner filter is how a permission check
  turns into a full listing.
- **Timestamps come from `stat`.** The file carries no creation record, and an
  atomic replace gives it a new inode, so any "created" metadata the filesystem
  offers would reset on every save and report a falsehood. Both fields are the
  modification time and say so.
- **No sidecars, ever.** `resourceLoader` loads every `*.json` under
  `contents/apps` as an app, so a `.locks/` marker dropped next to a config
  file would eventually be loaded as one. Raw locks live in the provider's own
  base directory, under `contents/data/.config-locks/`.
- **A read never throws and never invents a value.** Missing, unreadable and
  malformed all resolve to `null`, because `configCache` branches on
  `data !== null` in eleven places and a throw during boot would change
  behaviour that has held for years. A missing locale override is silent — an
  installation without translation overrides is the normal case, not a fault.

A provider reports which of its namespaces follow these rules as
`getCapabilities().rawNamespaces`, so a caller — the conformance suite above
all — knows before it calls, instead of discovering it when an owner-scoped
call fails.

Raw writes publish `document.put` and `document.delete` through the same
[change notifier](#change-notification) as every other document. On the
filesystem provider that notifier is in-process and the writer has already
refreshed its own cache by the time the event arrives, so today it is a
same-instance no-op that runs *alongside* the cluster announcement, never
instead of it. It exists for the release that adds a push-capable provider:
that is the day an admin save on one instance invalidates the config cache on
every other one.

### What is deliberately not behind the seam

Configuration reaches the filesystem in exactly one place —
`server/services/config/ConfigStore.js` — and
`scripts/check-config-fs-access.js` (`npm run lint:config-access`, part of
`npm run test:quick`) fails the build on any direct `fs` or `atomicWrite*` call
against a config path outside it.

Five subsystems cannot honour that rule. They are an explicit allowlist in the
guard, each carrying the reason it is there, and the guard prints every reason
on every run — an exception nobody can restate in six months is one nobody can
re-examine. An allowlisted call site that later disappears fails the guard too,
so the list cannot outlive its subject.

| Excluded                                       | Why it cannot go through the provider                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/migrations/`                           | The runner executes in the cluster primary *before* `configCache` and before any provider exists — the provider is configured from `platform.json`, which a migration may be creating. Its migrations are frozen by checksum and use `moveFile`/`deleteFile`/`listFiles(glob)`, which have no document-store equivalent. |
| `server/services/TokenStorageService.js`       | Key material (`.encryption-key`, `.jwt-*`, `.usage-pepper`) is needed before a provider can be constructed, and none of it is a JSON document.                                                                      |
| `server/routes/admin/backup.js`                | Export and import are a directory zip and an `fs.rename` swap of the live tree. It operates on the tree *as a tree*; a document API is the wrong shape for it.                                                       |
| `loadBuiltinLocaleJson` / `listBuiltinLocales` | The builtin locales live in `shared/i18n/`, which ships with the application rather than with an installation. They are outside `contents/` entirely, so no configuration provider owns them.                        |
| `loadGroupsConfiguration()`                    | It is synchronous and cannot become async: `adminAuth` and `contentAdminAuth` call it in the middleware path of every admin request. It reads `configCache` — populated through the store — and drops to a direct file read only for a cache that has not been initialized yet, which the async store cannot serve.                       |

The first four were named up front; the fifth surfaced during the conversion
and is listed for the same reason as the others rather than being quietly
skipped.

Alongside them the guard carries a second, smaller list of *non-config* call
sites inside otherwise guarded files — uploaded UI assets, tool implementation
scripts under `server/tools/`, skill directory trees, the shipped release
notes, `contents/data/` runtime files, the seeding of a fresh `contents/` from
`server/defaults/` (which happens beside the migration runner, before a
provider exists), and the escape hatch that lets `localAuth.usersFile` and
`oauth.clientsFile` point outside `contents/` altogether. Those are not exceptions to the rule; they are outside its subject
matter. They are pinned by what the call's argument is named rather than by
line number, so the exemption cannot silently widen when a genuine config write
is added to the same file later.

There is one more read that is not a violation and not an allowlist entry: the
bootstrap load of `config/platform.json` in `server/server.js`. It goes through
`ConfigStore` like everything else, and the store answers it from the contained
filesystem path because no provider exists yet — the provider is built from
what that read returns. Configuration therefore never depends on optional
runtime storage: a malformed `storage` block cannot stop the server from
reading the file that block lives in.

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

`ttlMs` is therefore also a **ceiling on how long `fn` may run**: nothing
distinguishes a slow holder from a dead one, so a critical section that
overruns its TTL has its lease taken from underneath it and two holders run at
once — silently. Size `ttlMs` against the worst case of the section, not only
against how long a crashed holder should block others. There is no lease
renewal; it arrives with distributed locks in step 3.

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
  .config-locks/<ns>/<key>.lock       compare-and-set locks for the raw namespaces
```

`.config-locks/` is the one part of the data directory that guards files
outside it: the [raw namespaces](#raw-namespaces-configuration-stays-where-it-is)
are views over `contents/config`, `contents/apps` and the rest, and their locks
are kept here precisely so no sidecar ever appears next to a config file.

### `contents/` is a trusted tree

Every path this provider builds is checked to stay under its base directory,
and the check is **lexical**: `..` and absolute segments are resolved and
refused, and nothing asks the filesystem what a path really is. A symlink
inside the tree that points out of it is followed.

That is deliberate. `contents/` is the installation's own directory — mounted,
hand-edited, sometimes deliberately symlinked at a secret volume or a shared
configuration store — and an operator who puts a link there is configuring the
server, not attacking it.

The containment check exists for the *keys*, which arrive from requests. Those
are validated as ids first (`[A-Za-z0-9_.~:@+-]`, no separators), and the path
check is the second wall behind that. If a future consumer lets an untrusted
principal choose a path segment that is not an id, containment has to become
real: realpath the base and namespace directories once at `initialize()` and
compare every resolved path against those.

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
  conditionalWrites: boolean,
  rawNamespaces: string[]   // namespaces served in raw mode; [] when none
}
```

The filesystem provider reports
`{ transactions: false, notifications: 'in-process', locking: 'advisory-single-machine', search: false, multiInstance: false, blobs: true, conditionalWrites: true }`,
plus every namespace from `server/storage/namespaces.js` in `rawNamespaces`. A
provider that leaves `rawNamespaces` empty serves no configuration, which is a
supported answer: `ConfigStore` then reads and writes those files on the
contained filesystem path, and logs which of the two is happening at startup.

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
    /* what getCapabilities() must return, rawNamespaces included */
  },
  rawFiles: {
    /* how the suite reads a raw document's stored bytes back — optional */
  }
});
```

`server/storage/__tests__/providerConformance.js` is provider-agnostic: 84
`node:test` cases covering lifecycle, document CRUD and etag semantics,
owner listing and cursor paging, append-log slicing and **restart recovery**
(`createProvider({ reuse: true })` opens a second instance over the same
location and must report the same `lastSeq`), blobs, lock ordering and TTL
takeover, notifier delivery, and a raw-mode group that asserts the
no-envelope, no-owner, etag-over-bytes rules above.
`server/tests/storage-filesystem-conformance.test.js` is the filesystem
provider's four-line wiring of it over a temp directory — copy that file for a
new provider.

The raw-mode group is skipped unless the runner declares `rawNamespaces` in
`capabilities` *and* supplies `rawFiles`, and that default is deliberate: the
suite writes to the
namespaces it is given, and a raw namespace is a view over an installation's
real configuration directories.
`server/tests/config-store-raw-conformance.test.js` is the runner that opts in,
by pointing a provider's config view at a scratch tree first.

```bash
npm run test:storage
```
