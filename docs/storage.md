---
description: "The storage abstraction between runtime data and where it is kept, and how to keep blobs in an S3-compatible bucket."
audience: developer
type: reference
---

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

Administrators find what they need in two places: [Blob storage backends](#blob-storage-backends)
(keeping uploaded files in an S3-compatible bucket, the commands `storage:check` and
`storage:copy-blobs`, troubleshooting) and [Storage Encryption](storage-encryption.md) (encrypting
what is stored, on disk and in the bucket). The rest of this page is a developer reference.

## Who uses it

`server/storage/bootstrap.js` brings the provider up in every worker at
startup. Durable chats were the first consumer; the runtime stores followed.

| Namespace                   | Holds                                                       | Owner id                    | Documented in                            |
| --------------------------- | ----------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| `chats`, `chat-messages`    | every conversation and its transcript — temporary unless the Chat History feature keeps it | the chat's principal        | [Chat Persistence](chat-persistence.md)  |
| `artifacts`                 | what a run produced: a metadata document and a blob per artifact | –                        | [Artifacts](artifacts.md)                |
| `chat-files`                | files uploaded to a chat or a scheduled task, or through the Inference API: a metadata document per file (the extracted text, page images and original are blobs beside it) and the `_meta__server-bytes` counter that enforces the server-wide quota | the owner | [Chat and Scheduled-Task Files](chat-files.md) |
| `chat-evidence`, `chat-evidence-content` | the evidence record of each stored answer (what went into every model call and every tool call) and the content it refers to, one pack of items per answer (an item a previous answer stored is referenced, not copied); deleted with the chat | the chat's principal | [Chat Evidence Record](chat-evidence.md) |
| `run-evidence`, `run-evidence-content` | the same record for runs without a chat (`/v1` completions, the Responses API without a stored conversation) | the caller | [Chat Evidence Record](chat-evidence.md) |
| `runs`                      | one summary per run — chats, workflow executions, agent runs | the run's principal         | [Run Ledger](run-ledger.md)              |
| `interactions`              | pending and recently settled human interactions              | the raising run's principal | [Run Ledger](run-ledger.md)              |
| `workflow-state`            | an execution's checkpoint, and what a resume reads           | the principal that started it | [Workflows](workflows.md)              |
| `workflow-active`           | the executions whose last checkpoint is unfinished (running, pending, paused), so the resume and the orphan sweep at startup read only those; kept on every checkpoint write, built once from `workflow-state` on the first start | – | [Workflows](workflows.md) |
| `integration-conversations` | the iAssistant conversation a chat maps to                   | –                           | –                                        |
| `runtime-imports`           | markers saying a one-time job (migration V219, the connection re-index, the `workflow-active` build, the execution-record backfill) has already run | –            | [Run Ledger](run-ledger.md)              |
| `provenance-records`        | one document per content hash with its newest provenance records (never the text), removed after `provenance.retentionDays` | – | [Provenance Records](provenance.md) |
| `provenance-meta`           | the installation ID, minted once                              | –                           | [Provenance Records](provenance.md) |
| `a2a-tasks`                 | tasks of the inbound A2A endpoint, kept 24 hours after they finish | the calling principal | [MCP Integration](mcp-integration.md) |
| `a2a-contexts`              | A2A conversations (`contextId`): bound skill and recent history, kept 7 days after the last message | the calling principal | [MCP Integration](mcp-integration.md) |
| `a2a-client-contexts`       | conversations with remote A2A agents: the agent's `contextId` and a waiting `taskId` per user, chat and agent, kept 30 days after the last call | the user | [A2A agents](a2a-agents.md) |
| `mcp-oauth-clients`         | how iHub is registered at each per-user OAuth MCP server's authorization server | – | [MCP Integration](mcp-integration.md) |
| `mcp-tool-catalog`          | the last tool list of each per-user OAuth MCP server, readable without a token | – | [MCP Integration](mcp-integration.md) |
| `user-prompts`, `user-prompt-versions` | prompts users write in the prompt library, and each saved version | the owner (versions: the prompt) | [Prompts Library](prompts.md) |
| `user-prompt-shares`        | one marker per share target of a user prompt, so "shared with me" is an index read | `user:<id>`, `group:<name>` or `everyone` | [Prompts Library](prompts.md) |
| `prompt-preferences`        | a user's prompt favorites and recents                        | the user                    | [Prompts Library](prompts.md)            |
| `config`, `apps`, `models`, `prompts`, `tools`, `workflows`, `agents`, `locales` | an installation's configuration, read and written where it already lives | – | [Configuration Storage](configuration.md) |

`integration-conversations` is the smallest of them and the least visible: two
fields per chat (the remote conversation id and the id of the last answer,
which the next message threads onto) that used to live in a per-worker `Map`.
Storing them means a chat keeps one iAssistant conversation across a restart
and across workers, instead of quietly starting a second one. Writes are
coalesced on a timer, because that state is updated on every streamed chunk
and a document write on the streaming path is not acceptable.

Append-log streams are named `run:<runId>` and carry a run's events, with its
spilled payloads as blobs beside them. They are the journal of active runs: the
stream of a finished chat or `/v1` run is deleted 15 minutes after it ended
(its summary in `runs` stays), so `logs/run/` holds the running runs plus the
workflow and agent runs — see
[Journals of finished runs](run-ledger.md#journals-of-finished-runs). Leases are taken on `chat:<id>` for a
chat's read-modify-write, on `interaction:<id>` for the answer critical
section, on `runlog:<runId>` while a recovering worker continues a run's
sequence, and on `runtime-import:<store>` for the one-time connection re-index.

**The provider is mandatory.** The filesystem provider is the default and needs
no configuration. A `storage` block that names an unknown provider, or a
provider that fails to initialize, stops the server from starting with a
`StorageBootstrapError` (`server/storage/bootstrap.js`) that says which setting
to check; in a cluster the primary checks once before it forks workers, so a
bad block ends the process instead of a respawn loop. Nothing falls back to an
in-memory or earlier on-disk layout. The same holds for the blob backend
(`storage.blobs.provider`) and for storage encryption: a bucket that cannot be
reached, a wrong master key or an unfinished conversion ends the process with
exit code 1, and blobs are never served from local disk instead.

Installations that last ran a release before the storage provider (5.5.2) keep
their old runtime files under `contents/data/`. Migration `V219` carries them
into these namespaces once, on the first start after the upgrade — see
[Upgrading an installation that already has a ledger](run-ledger.md#upgrading-an-installation-that-already-has-a-ledger).
`workflow-state` shares a directory with the files it replaced:
`contents/data/workflow-state/<executionId>.json` documents sit beside the old
`<executionId>/latest.json` directories, which nothing reads any more.

The full plan is in
`concepts/persistence-layer/2026-09-09 Storage Provider and Durable Chats Design.md`.

## The five facets

A provider is a `StorageProvider` (`server/storage/StorageProvider.js`) with
five getters and a lifecycle:

```js
provider.documents; // DocumentStore
provider.blobs; // BlobStore
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

// BlobStore — payloads too large for a document, addressed by key
put(ns, key, data, opts?)          -> Promise<{ key, bytes, sha256 }>
get(ns, key)                       -> Promise<{ key, bytes, data: Buffer }|null>
delete(ns, key)                    -> Promise<boolean>
list(ns, opts?)                    -> Promise<{ items: [{ key, bytes }], nextCursor }>

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

The abstract base classes carry the full contract in their JSDoc; a provider
extends them and every method it does not implement throws
`NotSupportedError` rather than silently doing nothing.

**Documents and blobs are split for a reason.** A document is small,
structured and listable — the thing you filter and compare. A blob is
megabytes written once and read whole. Putting a payload in a document forces
base64 (a 33% tax), puts megabytes in a JSONB column, and makes an object store
impossible to slot in, because S3 stores objects rather than rows. So the blob
facet takes bytes under a key and nothing else, which is deliberately the
smallest surface the filesystem, an S3-compatible store and PostgreSQL all
have natively — see [Artifacts](artifacts.md#swapping-the-payload-backend)
and issue #2318. An S3-compatible backend for this facet exists:
[Blob storage backends](#blob-storage-backends).

The blob facet a caller gets is never the bare store. `StorageRegistry` puts an
encrypting store (`server/storage/EncryptingBlobStore.js`) in front of the
filesystem blob store and of the S3 store alike. With
`storage.encryption.enabled` it encrypts every payload; with the switch off it
passes payloads through and still decrypts what was encrypted earlier. `put`,
`get` and `list` report the length and the SHA-256 of the payload, never of the
stored bytes.

## Documents

```js
{
  ns: string,
  key: string,
  ownerId: string | null,
  contentType: string,   // default 'application/json'
  createdAt: string,     // ISO-8601, preserved across overwrites
  updatedAt: string,     // ISO-8601, always "now" on put
  etag: string,          // sha256 hex of the canonical serialization of data
  size: number,          // its byte length
  data: any              // undefined when list({ includeData: false })
}
```

`etag` and `size` are **derived from the data**, not from the storage layout
and not from the order the writing code built the object in: the serialization
sorts object keys at every depth (array order is data and is preserved), so the
same document has the same etag on every provider and a migration can verify a
copy by comparing etags.

That is a requirement on providers, not a promise about one function. A backend
that normalizes values on the way in — a PostgreSQL `jsonb` column collapsing
`1.0` to `1`, dropping duplicate keys or re-escaping unicode — cannot recompute
the digest from what it reads back, and meets the requirement by persisting the
etag it minted at write time. Raw namespaces are their own exception, below:
there the file is the document and the etag follows its bytes.

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

A consumer that needs every entry of a namespace, an owner or a prefix walks
it with `scan` instead of paging `list` — `scan(ns, opts)` on documents and on
blobs, picked (with a paged-`list` fallback for stores that have no `scan`) by
`walkDocuments` / `walkBlobs` in `server/storage/walk.js`. On the filesystem
provider a paged walk re-reads the whole directory for every page; `scan` reads
it once.

`deletePrefix(ns, prefix)` on documents and on blobs removes every key starting
with the prefix and answers how many went — the scope delete of a repository
keyed `<scope>__<id>` (all evidence of one chat). An empty prefix is refused
(`INVALID_KEY`). The base classes implement it as one listing and a delete per
key, so every provider has it; the conformance suite checks it in its
`prefix deletes` section.

Namespaces whose listings are scoped by the leading `__` segments of the key
are declared in `KEY_PREFIX_SEGMENTS` (`server/storage/namespaces.js`):
`chat-files` and `artifacts` by two segments (`<scopeType>__<scopeId>__…`),
`project-files`, `chat-evidence`, `chat-evidence-content` and
`run-evidence-content` by one (`<projectId>__…`, `<chat scope>__…`). A provider may index those segments
so a listing of one chat's files does not read all of them; results are the
same either way.

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
bootstrap load of `config/platform.json` in `server/startup/worker.js`. It goes through
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
| `storage.blobs.provider`       | `default`      | Where blobs are kept: `default` (the provider itself) or `s3`. See [Blob storage backends](#blob-storage-backends) |
| `storage.encryption.enabled`   | `false`        | Encrypts stored content. `true` in the `platform.json` of a fresh installation. See [Storage Encryption](storage-encryption.md) |

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
`registerProvider('filesystem', …)` and `registerBlobBackend('s3', …)` —
provider modules themselves have no registry side effects, so importing one
from a test or a tool cannot change which backend the process resolves.

The provider `initializeStorage()` returns is a `ComposedStorageProvider`
(`server/storage/ComposedStorageProvider.js`): documents, logs, notifier and
locks of the configured provider, and the blob facet of the configured blob
backend. `provider.blobBackend` names the backend (`default` or `s3`).

## Blob storage backends

This section is for administrators. It describes where blobs are kept and how to keep them in an
S3-compatible bucket.

Blobs are the large payloads: uploaded chat and task files (original, extracted text, page texts),
the extracted text of project documents, artifact payloads, the content of evidence records and
crawled website pages. By default the storage provider keeps them itself, on the filesystem under
`contents/data/blobs/`. `storage.blobs.provider` can move them to an S3-compatible service.

Only blobs move. Documents (chats, transcripts, metadata), append logs (the run ledger), locks and
the configuration stay on `storage.provider`, which means on the local `contents/` directory.

**S3 for blobs does not make iHub stateless and does not make it multi-instance.** The server still
needs its `contents/` volume, and the rules of
[Multi-Server Deployment](multi-server-deployment.md) still apply. Do not remove the volume because
the files are in a bucket.

What was tested: the S3 backend was run against the S3 server that ships in this repository
(`npm run s3:dev`, see [Local development backend](#local-development-backend)), which does not
verify request signatures. It has not been run against AWS S3 or another S3 product. The compose
file with versitygw and the CI workflow that uses it have not been executed yet. Test your own S3
service with `npm run storage:check` and a trial installation before you rely on it.

### Settings

```json
{
  "storage": {
    "provider": "filesystem",
    "encryption": { "enabled": true },
    "blobs": {
      "provider": "s3",
      "s3": {
        "endpoint": "https://s3.example.internal:7070",
        "region": "us-east-1",
        "bucket": "ihub",
        "prefix": "production",
        "accessKeyId": "${IHUB_S3_ACCESS_KEY_ID}",
        "secretAccessKey": "${IHUB_S3_SECRET_ACCESS_KEY}"
      }
    }
  }
}
```

The `storage.blobs` block is optional and absent by default. No migration writes it.

| Setting                              | Default     | What it does, and what happens if it is wrong                                                                                                                                                                    |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.blobs.provider`             | `default`   | `default` keeps blobs on the storage provider (local disk). `s3` keeps them in the bucket. Any other value stops the start (`BLOB_PROVIDER_UNKNOWN`).                                                            |
| `storage.blobs.s3.endpoint`          | AWS S3      | URL of the S3 service: scheme, host and port only. Empty means `https://s3.<region>.amazonaws.com`. A path, a query, credentials in the URL or a link-local address (`169.254.x.x`, `fe80::/10`) stop the start. |
| `storage.blobs.s3.region`            | `us-east-1` | Region used to sign requests. A wrong region gives `S3_REGION_MISMATCH` on AWS. Most other S3 services accept any value.                                                                                         |
| `storage.blobs.s3.bucket`            | none        | Required. The bucket must exist. iHub never creates one (`S3_BUCKET_NOT_FOUND`). Lower case letters, digits, `.` and `-`, 3 to 63 characters.                                                                    |
| `storage.blobs.s3.prefix`            | empty       | Key prefix inside the bucket. Letters, digits, `.`, `_`, `-`, and `/` between segments. No leading `/`.                                                                                                          |
| `storage.blobs.s3.accessKeyId`       | none        | Required. Text or `${VAR}`.                                                                                                                                                                                      |
| `storage.blobs.s3.secretAccessKey`   | none        | Required. `${VAR}`, an `ENC[...]` value or text. See [Credentials](#credentials).                                                                                                                                |
| `storage.blobs.s3.forcePathStyle`    | `true`      | `true` addresses the bucket in the path (`https://host/bucket/key`), which most S3-compatible services need. `false` puts the bucket into the host name (`https://bucket.host/key`).                             |
| `storage.blobs.s3.allowInsecureHttp` | `false`     | Accepts a plain `http://` endpoint on another host. See [TLS, proxy and plain http](#tls-proxy-and-plain-http).                                                                                                  |
| `storage.blobs.s3.maxObjectBytes`    | `134217728` | Largest blob accepted, in bytes before encryption (128 MiB). 1 to 4 GiB. A larger write is refused with `BLOB_TOO_LARGE` (HTTP 413), and a larger object in the bucket is not read.                              |
| `storage.blobs.s3.connectTimeoutMs`  | `5000`      | Time allowed to open a connection. 1 to 600000.                                                                                                                                                                  |
| `storage.blobs.s3.requestTimeoutMs`  | `60000`     | Time allowed for the response headers of one request, and idle time on the connection. 1 to 3600000. Too low a value makes large uploads fail with `S3_ENDPOINT_UNREACHABLE`.                                    |
| `storage.blobs.s3.maxAttempts`       | `3`         | Attempts per request, retries included. 1 to 10.                                                                                                                                                                 |
| `storage.encryption.enabled`         | `false`     | Encrypts what is stored, in the bucket and on disk. A fresh installation has `true` in its `platform.json`. See [Storage Encryption](storage-encryption.md).                                                     |

Environment:

| Variable                      | What it does                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IHUB_STORAGE_BLOBS_PROVIDER` | Overrides `storage.blobs.provider`. Precedence: this variable, then `platform.json`, then `default`.                                                                                                   |
| `IHUB_S3_ADOPT_BUCKET`        | `true` for one start accepts a bucket or prefix that holds objects but no key-check object. See [The key-check object](#the-key-check-object). Remove it after that start.                             |
| any `${VAR}` you name         | Every string under `storage.blobs.s3` may be a `${VAR}` placeholder. A placeholder whose variable is not set stops the start (`S3_CONFIG_INCOMPLETE`, the message names the setting and the variable). |

The storage settings are read from the file `contents/config/platform.json` at start, before the
rest of the configuration is loaded. `IHUB_PLATFORM__...` overrides do not reach them. A change of
any setting in this section needs a restart. A wrong value stops the start, and the message names
the setting.

### Credentials

iHub signs requests with one static access key and secret. It does not use instance roles, web
identity, session tokens or the shared AWS configuration files, even when the host has them.

Three ways to store the secret, safest first:

1. `"secretAccessKey": "${IHUB_S3_SECRET_ACCESS_KEY}"` and the value in the environment, from your
   secret store.
2. An encrypted value, `ENC[...]`. The secret is encrypted with the master key when the platform
   configuration is saved in the admin interface. An `ENC[...]` value that does not decrypt with
   the master key of this installation stops the start.
3. Plain text in `platform.json`. It works. Anyone who can read the file has the secret.

The admin interface and the API never return the secret, and the status endpoint returns neither
the secret nor the access key ID. A secret with a trailing space or a line break is rejected by the
S3 service (`S3_CREDENTIALS_REJECTED`).

### TLS, proxy and plain http

- **Certificates.** The connection to the endpoint is verified like every other outbound
  connection. For a private CA, add the CA to the server's trust store (`NODE_EXTRA_CA_CERTS`, see
  [SSL Certificates](ssl-certificates.md)). Verification is skipped only when
  `ssl.ignoreInvalidCertificates` is `true` and the endpoint host is on `ssl.domainWhitelist`. With
  `forcePathStyle: false` the host is `<bucket>.<endpoint host>`, which a whitelist entry for the
  endpoint host may not match.
- **Proxy.** The platform proxy settings (`proxy` in `platform.json`, see
  [Proxy Configuration](proxy-configuration.md)) apply, including the no-proxy list.
- **Restart.** The S3 connection is built once at start. A change of the SSL whitelist or of the
  proxy settings reaches it after a restart, although other connections pick it up at once.
- **Plain http.** An `http://` endpoint is accepted when the host is this machine (`localhost`,
  `127.0.0.0/8`, `::1`). For any other host the start is refused unless `allowInsecureHttp` is
  `true`. With plain http the object names travel in clear text and a signed request can be
  replayed. The server logs a warning at every start.

### What is in the bucket

One object per blob:

```text
[<prefix>/]default/<namespace>/<key>
[<prefix>/]default/_ihub/keycheck          the key-check object (encryption on)
[<prefix>/]default/_ihub/probe-<uuid>      test objects, removed right after they are written
```

`default` is a fixed segment. The namespaces are `project-files`, `chat-files`,
`chat-evidence-content`, `run-evidence-content`, `artifacts` and `website-corpora`.

- **Object names are readable.** A key holds ids, for example
  `<scopeType>__<scopeId>__<fileId>.txt`. It never holds a file name, a user name or a URL. Anyone
  who can list the bucket sees chat and project ids, the number of files per chat, object sizes and
  times.
- **Content.** With `storage.encryption.enabled` every object is encrypted by iHub before upload: a
  512-byte header followed by the ciphertext. With the switch off the objects are the files as they
  are, and whoever can read the bucket can read them. The server logs a warning at every start in
  that case.
- iHub sets no ACL, no object metadata and no server-side encryption header. Every object has the
  type `application/octet-stream`. Server-side encryption of the bucket can be used in addition; it
  does not replace the switch.

**One bucket or prefix per installation.** Two installations on the same prefix delete each other's
objects, because each removes objects it has no record of.

### Bucket policy

iHub sends `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, `ListObjectsV2` and `HeadBucket`.
A policy for the access key that allows this and nothing else:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::ihub/production/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::ihub",
      "Condition": { "StringLike": { "s3:prefix": ["production/*"] } }
    }
  ]
}
```

Replace `ihub` and `production` with your bucket and prefix. Without a prefix use
`arn:aws:s3:::ihub/*` and leave the condition out. On the bucket itself: block public access and
deny requests without TLS. This policy is written from the requests iHub sends; it has not been
tried on AWS S3. Some services answer `HeadBucket` only without a prefix condition; if
`npm run storage:check` fails at the step "Endpoint reachable, credentials accepted, bucket found"
with `S3_ACCESS_DENIED`, remove the condition.

**Versioning and object lock.** iHub deletes objects when a chat, a file or a project is deleted
and when a retention period ends. A bucket with versioning or object lock keeps those objects, with
the keys that open them. Deleted content then stays recoverable for anyone who has the bucket and
the master key. Add a lifecycle rule that expires noncurrent versions, or leave versioning off.
iHub does not check the versioning state of the bucket.

### What happens at start

1. The master key is loaded (`TOKEN_ENCRYPTION_KEY` or `contents/.encryption-key`).
2. The storage provider for documents and logs starts.
3. The blob backend is checked: the settings, the master key, the connection (endpoint, TLS,
   credentials, bucket), the key-check object, and one test object that is written, read back,
   compared and removed.
4. If blobs are still on local disk, a warning names the namespaces and counts
   (`BLOB_LOCAL_LEFTOVERS`).

If step 3 fails, the server logs the step and the code and ends with exit code 1. In a cluster the
primary process checks before it starts workers. **The server never falls back to local disk** and
never serves blobs from `contents/data/blobs` while S3 is configured. Causes that stop a start:

- a missing or malformed setting, or an unset `${VAR}`;
- the endpoint cannot be reached, or its certificate cannot be verified;
- the credentials are rejected, the bucket does not exist, or the access key may not list, read,
  write or delete;
- with encryption on: no master key, a master key that could not be saved to disk, a master key
  other than the one the bucket was written with, or objects in the prefix without a key-check
  object.

While the server runs, an S3 failure does not stop it. Requests that need a blob fail with
`STORAGE_UNAVAILABLE`, and the server log holds the error.

`GET /api/health` reports `storage.blobs: { provider, status }` and nothing else about the bucket,
so it can be read without a login. **The status is the result of the last check, not a live
value.** A check runs at start, when an administrator opens the System Resources page (at most once
a minute) and when "Check again" is used. Nothing checks in the background. To monitor the bucket,
call `GET /api/admin/storage` with an administrator's credentials once a minute or more, or alert
on `STORAGE_UNAVAILABLE` in the server log.

### The key-check object

With encryption on, iHub keeps one small encrypted object, `_ihub/keycheck`, under the prefix. It
ties the bucket to the master key.

| At start                                                                  | Result                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| The object opens with the master key (or `TOKEN_ENCRYPTION_KEY_PREVIOUS`) | The start continues.                                    |
| The object exists and does not open                                       | The start stops: `BLOB_KEY_MISMATCH` or `BLOB_CORRUPT`. |
| No object, and the prefix is empty                                        | The object is written. This is the first start.         |
| No object, and the prefix holds other objects                             | The start stops: `BLOB_KEY_CHECK_MISSING`.              |

The last case protects against writing under a second key into a bucket that belongs to another
key. If you know the objects belong to this installation and this key, set
`IHUB_S3_ADOPT_BUCKET=true` for one start. The server writes the object, logs a warning and
continues. Objects that were written with another key stay unreadable. Remove the variable after
that start.

The check does not notice a copy of an installation that uses the same master key and the same
prefix. Keep to one prefix per installation.

With encryption off the key-check object is not used.

**Decide the encryption switch before the first upload to a bucket.** `npm run storage:encrypt`
converts what is on local disk. It does not convert objects in a bucket. If blobs were uploaded
with the switch off and it is turned on later, the start stops with `BLOB_KEY_CHECK_MISSING`, and
after an adoption the unencrypted objects are refused on read (`CORRUPT_BLOB`). To encrypt blobs
that are in a bucket unencrypted, there is no command yet.

### Checking the configuration: `storage:check`

```bash
npm run storage:check                 # add: -- --json   or   -- --verbose
```

It runs without the server. It reads `contents/config/platform.json` and the environment as a
start would, runs the same check and prints one line per step:

```text
Blob storage check (configuration on disk, not the running server)
  provider    s3, set by platform.json
  endpoint    127.0.0.1:9000
  bucket      ihub-dev   prefix inst1/default/   region us-east-1
  encryption  on: every blob is encrypted before it is stored

  [ok]    1/6 Configuration complete
  [ok]    2/6 Master key available  6 ms
              key 1113f34d (file)
  [ok]    3/6 Endpoint reachable, credentials accepted, bucket found  234 ms
  [ok]    4/6 Encryption key matches the stored blobs  13 ms
              no key check object yet; the first start writes it
  [ok]    5/6 Write, read back and delete a test object  17 ms
  [warn]  6/6 No blobs left on local disk
              BLOB_LOCAL_LEFTOVERS: Blobs are still on local disk (chat-files: 1). They are not served while blob storage is "s3".
              Copy them while the server is stopped: npm run storage:copy-blobs
```

| Exit code | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| 0         | Usable. A start with this configuration works. Warnings do not count. |
| 1         | Not usable. A start with this configuration fails.                    |
| 2         | Unknown argument.                                                     |

It writes one test object and removes it. It never writes the key-check object and never touches a
stored blob. With encryption on and no master key present it creates `contents/.encryption-key`,
as a start would. Run it as the user the server runs as, with the same environment.

Where `npm` or the `scripts/` directory is not present (the container image), call the commands
through their entry point:

```bash
node server/storage/commands/run.js check [--json]
node server/storage/commands/run.js copy-blobs [--dry-run] [--namespace=<name>]
node server/storage/commands/run.js encrypt [--dry-run]
node server/storage/commands/run.js show --doc <namespace> <key>
```

The report goes to standard output and the server's own log lines go to standard error.

### Moving existing blobs: `storage:copy-blobs`

After `storage.blobs.provider` is set to `s3`, the server reads blobs only from the bucket. **There
is no read fallback.** Files uploaded before the switch stay on local disk and users cannot open
them until they are copied. The start, `storage:check` and the System Resources page all report
them.

Procedure:

1. Configure `storage.blobs` and run `npm run storage:check` until it exits with 0.
2. Stop the server.
3. Run `npm run storage:copy-blobs -- --dry-run`. It lists per namespace what would be copied.
4. Run `npm run storage:copy-blobs`.
5. Start the server. Check that old attachments open.
6. Remove `contents/data/blobs` by hand when you are sure. Until then a copy of every file is still
   on the server, unencrypted if encryption was off when it was written.

| Option               | What it does                                                                        |
| -------------------- | ----------------------------------------------------------------------------------- |
| `--dry-run`          | Compares and reports. Copies nothing. One test object is written and removed.       |
| `--namespace=<name>` | Copies one namespace, or several separated by commas. An unknown name exits with 2. |
| `--json`             | Prints the result as one JSON object.                                               |
| `--verbose`          | Also prints the server's own log lines.                                             |

| Exit code | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0         | Every blob is in the bucket. In a dry run: the target is usable and nothing would fail.                                |
| 1         | Not complete: the target is not usable, a blob failed, a conflict was found, or the run was interrupted. Run it again. |
| 2         | Unknown argument or namespace.                                                                                         |

What the command guarantees:

- It never deletes or changes a file on local disk. There is no option for that.
- It never overwrites an object in the bucket. A blob that is there with the same content counts
  as present. A blob that is there with other content is a **conflict**: both sides are left as
  they are, the server serves the one in the bucket, and the command exits with 1.
- Every copy is read back and its SHA-256 is compared. A copy that does not verify is removed from
  the bucket and counted as failed.
- A second run copies only what is missing. An interrupted run (Ctrl+C stops after the blob in
  flight) is run again.
- With encryption on it writes the key-check object when it is the first to write into an empty
  prefix, and `IHUB_S3_ADOPT_BUCKET` applies as at a start.

It copies in one direction, from local disk to the bucket. Going back from S3 to local disk is not
supported: objects written to the bucket in the meantime would not be on disk, and there is no
command that copies them back.

If the server runs during the copy, nothing is damaged, but a blob it stores during the run can be
missed. Run the command again afterwards.

### Limits

- **Object size.** `maxObjectBytes` (128 MiB by default) is the largest blob. The default is above
  the default size limit of an artifact (100 MB). Blobs on local disk have no such limit, so
  `storage:copy-blobs` reports a larger local blob as failed.
- **Whole-object reads and writes.** A blob is read and written in one piece. There is no multipart
  upload, no range read and no streaming. A 25 MiB blob needs about three times its size in memory
  while it is read or written, and encrypting it blocks the server process for a short time. Size
  the memory for the largest files you allow times the number of parallel uploads.
- **Deletes.** A delete of one object costs two or three requests, because S3 does not say whether
  the object existed.
- **Consistency.** The service must return an object right after it was written and list it right
  after. A service that lists keys out of order is detected and refused.
- **Backup.** The admin backup export does not contain the bucket. See
  [Encryption Key Management](encryption-key-management.md#backup-and-restore).
- **Multi-instance.** Not provided by this change, see the start of this section.

### Status in the admin interface and the API

**Admin → System Resources** shows a read-only card "Blob storage": backend, endpoint host, bucket,
region, prefix, status of the last check, encryption, where the setting comes from, a notice when
the saved settings differ from the running ones, and a notice when files are left on local disk.
"Check again" runs the check now. See [Admin interface](admin-ui.md#blob-storage).

| Endpoint                        | What it does                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/storage`        | The status the server holds. The check result is refreshed when it is older than a minute; the call does not contact the bucket every time. In a cluster each worker holds its own result.                     |
| `POST /api/admin/storage/_test` | Runs the check now (key, connection, key-check object, test object) and answers with the same body. No request body. It answers 200 whether the check passed or failed; read `blobs.status` and `blobs.error`. |

Both need an administrator. They answer `503 STORAGE_UNAVAILABLE` when the storage provider is not
running. The response holds no credential and the endpoint only as host and port.

```json
{
  "blobs": {
    "provider": "s3",
    "status": "ok",
    "latencyMs": 41,
    "checkedAt": "2026-11-20T09:12:44.120Z",
    "location": {
      "endpointHost": "s3.example.internal:7070",
      "bucket": "ihub",
      "region": "us-east-1",
      "prefix": "production/default/"
    },
    "encryption": {
      "scope": "all",
      "format": "tink-aes-gcm-hkdf-v1",
      "keySource": "local-file"
    },
    "source": "platform.json",
    "steps": [{ "name": "connect", "status": "ok", "latencyMs": 20 }]
  },
  "documents": { "provider": "filesystem" },
  "restartRequired": false,
  "configuredBlobProvider": "s3",
  "localLeftovers": [
    { "namespace": "chat-files", "count": 12, "capped": false }
  ],
  "encryption": {
    "enabled": true,
    "scope": "storage",
    "conversion": {
      "state": "complete",
      "facets": { "blobs": 1, "documents": 1, "logs": 1, "files": 1 }
    },
    "sealedDataExists": true
  }
}
```

- `blobs.status` is `ok`, `error` or `unknown` (not checked yet). It is the result of the last
  check. When the check failed,
  `blobs.error` holds `code`, `detail`, `step` and `hint`.
- `restartRequired` is `true` when a restart would bring up another backend, bucket, prefix, region,
  endpoint, size limit or encryption setting. It does not notice changed credentials or timeouts.
- `localLeftovers` lists blobs that are still on local disk, as found at start. `capped` means "at
  least this many"; counting stops at 1000 per namespace.
- `encryption.scope` is `storage` (documents, logs and blobs are encrypted), `blobs` or `none`.

### Local development backend

For development and tests, the repository holds a small S3 server:

```bash
npm run s3:dev
```

It serves one bucket from a directory, so data survives a restart, and prints the block to merge
into `platform.json`. It binds to `127.0.0.1`. Settings: `IHUB_S3_DEV_PORT` (9000),
`IHUB_S3_DEV_BUCKET` (`ihub-dev`), `IHUB_S3_DEV_DIR` (`.s3-dev-data` in the repository). Its access
key and secret are both `ihub-dev-not-a-secret`.

**Development only.** It checks that a request carries a signature header and does not verify the
signature. Never expose it to a network. A server that uses its access key against another host
logs a warning.

A second option is a real S3-compatible server in a container, Versity S3 Gateway:

```bash
npm run s3:up      # docker compose -f docker/docker-compose.s3.yml up -d --wait
npm run s3:down    # stops it and deletes its data volume
```

It listens on `127.0.0.1:7070` with the bucket `ihub-test`. It is for tests, is not part of the
production compose files and must not be. This compose file has not been executed yet; expect to
adjust it on first use.

| Command               | What it runs                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:s3`     | The `storage-s3-*` suites against the in-repository server, and also against an external server when `IHUB_TEST_S3_ENDPOINT` and its companions are set. |
| `npm run test:s3:e2e` | Starts a real server process on S3, uploads a file, looks into the bucket, restarts, deletes.                                                            |

The variables for an external server are listed at the top of `docker/docker-compose.s3.yml`.

### Troubleshooting

`storage:check`, the start-up log, `storage:copy-blobs` and the System Resources page report the
same codes.

| Code                      | Meaning                                                                  | What to do                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_CONFIG_INCOMPLETE`    | A `storage.blobs.s3` setting is missing or malformed                     | Correct the setting in `contents/config/platform.json`, or set the environment variable it refers to.                                    |
| `S3_ENDPOINT_UNREACHABLE` | DNS failure, connection refused, timeout or proxy error                  | Check the endpoint URL, the network path and the proxy settings.                                                                         |
| `S3_TLS_UNTRUSTED`        | The certificate cannot be verified, or the host name does not match      | Add the issuing CA to the server's trust store (`NODE_EXTRA_CA_CERTS`), or add the host under Admin → Security → SSL → Domain Whitelist. |
| `S3_CREDENTIALS_REJECTED` | The access key or its signature was rejected                             | Check the access key ID and the secret. A secret with a trailing space or line break also causes this.                                   |
| `S3_CLOCK_SKEW`           | The clocks of iHub and the S3 service differ too much                    | Synchronize the time on the iHub server.                                                                                                 |
| `S3_BUCKET_NOT_FOUND`     | The bucket does not exist                                                | Create the bucket, or correct `storage.blobs.s3.bucket`. iHub does not create buckets.                                                   |
| `S3_ACCESS_DENIED`        | The access key may not list, read, write or delete                       | Give the access key permission to list, read, write and delete objects in this bucket.                                                   |
| `S3_REGION_MISMATCH`      | The bucket is in another region                                          | Set `storage.blobs.s3.region` to the bucket's region.                                                                                    |
| `S3_SERVICE_ERROR`        | The S3 service answered with a 5xx error or asked to slow down           | Check the S3 service and try again.                                                                                                      |
| `S3_PROBE_MISMATCH`       | A test object did not read back as written                               | The S3 service or something between it and iHub changes the data. Blob storage cannot be used like this.                                 |
| `S3_ERROR`                | Any other S3 failure                                                     | See the server log for the cause.                                                                                                        |
| `BLOB_KEY_MISSING`        | No master key is available, or a new one could not be saved              | Restore `contents/.encryption-key` from a backup or set `TOKEN_ENCRYPTION_KEY`. Without the key the stored files cannot be read.         |
| `BLOB_KEY_MISMATCH`       | The store was written with another master key                            | Restore the original key, or set it as `TOKEN_ENCRYPTION_KEY_PREVIOUS`. For a new installation use an empty bucket or prefix.            |
| `BLOB_KEY_CHECK_MISSING`  | The store holds objects but no key-check object                          | Use an empty bucket or prefix, or set `IHUB_S3_ADOPT_BUCKET=true` for one start to adopt the objects as they are.                        |
| `BLOB_CORRUPT`            | A stored object is not an encrypted blob of this store                   | Use one bucket or prefix per installation. If the object was changed, restore it from a backup of the bucket.                            |
| `BLOB_PROVIDER_UNKNOWN`   | `storage.blobs.provider` names no known backend                          | Set it to `default` or `s3`.                                                                                                             |
| `BLOB_STORAGE_ERROR`      | Anything else                                                            | See the server log for the cause.                                                                                                        |
| `BLOB_LOCAL_LEFTOVERS`    | Warning: blobs are on local disk while S3 is active                      | Copy them with `npm run storage:copy-blobs` while the server is stopped.                                                                 |
| `BLOB_COPY_NO_TARGET`     | `storage:copy-blobs` was run while `storage.blobs.provider` is `default` | Set `storage.blobs.provider` to `s3` and fill in `storage.blobs.s3` first.                                                               |

Errors a request can meet while the server runs:

| Code                  | HTTP | Meaning                                                                                                           |
| --------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| `STORAGE_UNAVAILABLE` | 503  | The bucket cannot be reached or refuses the request. Temporary.                                                   |
| `KEY_UNAVAILABLE`     | 503  | An object names a master key this installation does not hold.                                                     |
| `CORRUPT_BLOB`        | 500  | An object was changed, cut short or moved to another key, or it is not encrypted although encryption is enforced. |
| `BLOB_TOO_LARGE`      | 413  | The blob is larger than `maxObjectBytes`.                                                                         |

A blob that cannot be read is never reported as "not found" and its stored bytes are never
returned as they are.

## Errors

| Class                  | `code`                  | `httpStatus` |
| ---------------------- | ----------------------- | ------------ |
| `StorageError`         | caller-supplied         | –            |
| `EtagMismatchError`    | `ETAG_MISMATCH`         | 409          |
| `LockTimeoutError`     | `LOCK_TIMEOUT`          | 503          |
| `InvalidKeyError`      | `INVALID_KEY`           | 400          |
| `NotSupportedError`    | `NOT_SUPPORTED`         | 501          |
| `UnknownProviderError` | `UNKNOWN_PROVIDER`      | –            |

| `CorruptBlobError`     | `CORRUPT_BLOB`          | 500          |
| `KeyUnavailableError`  | `KEY_UNAVAILABLE`       | 503          |
| `CorruptDocumentError` | `CORRUPT_DOCUMENT`      | 500          |
| `PlaintextDocumentError` | `PLAINTEXT_DOCUMENT`  | 500          |
| `CorruptLogError`      | `CORRUPT_LOG`           | 500          |

`StorageError` is also thrown directly for `INVALID_DATA`, `INVALID_SEQ`,
`INVALID_CURSOR`, `PATH_ESCAPE`, `STORAGE_NOT_INITIALIZED`,
`STORAGE_UNAVAILABLE` (503), `BLOB_TOO_LARGE` (413), `INVALID_STORAGE_CONFIG`
and `PLAINTEXT_FILE`.

A blob, a document or a log record that does not decrypt or verify is never
reported as absent: callers treat "absent" as "gone" and may clean up what
refers to it. `CORRUPT_*` and `KEY_UNAVAILABLE` are thrown instead, and stored
bytes are never handed out as they are. The `PLAINTEXT_*` codes mean that
unencrypted data was found where encryption is enforced; see
[Storage Encryption](storage-encryption.md#what-a-read-does-with-unencrypted-data).

## The filesystem provider

The default provider, and the reference implementation. Its base directory is
`contents/data` (`storage.filesystem.dataDir` under `contents/`, or an absolute
`baseDir` in provider config, which is what the tests pass).

```
contents/data/
  <ns>/<key>.json                     the document envelope
  <ns>/.owners/<ownerSegment>/<key>   empty marker file — the per-owner index
  <ns>/.locks/<key>.lock              transient compare-and-set lock
  <ns>/.prefixes/<partition>/<key>    empty marker file — the key-prefix index
  blobs/<ns>/<key>                    a blob: byte for byte, or encrypted (see below)
  blobs/_ihub/keycheck                the key-check object of storage encryption
  blobs/<ns>/.prefixes/<partition>/<key>  the key-prefix index of blobs
  logs/<stream segments>.jsonl        one append-log stream, one JSON per line
  logs/<stream segments>.blobs/       that stream's blobs
  locks/<sha256(name)[0..40]>.lock    LockManager leases
  locks/<sha256(name)[0..40]>.fence   LockManager fencing counter
  .config-locks/<ns>/<key>.lock       compare-and-set locks for the raw namespaces
  .at-rest.json                       state record of storage encryption
```

With `storage.encryption.enabled` the paths and file names stay as shown and
the content changes: a document is an envelope with `"v": 3` whose `data` is
ciphertext, a log line is a sealed record with a readable `seq`, and a blob is
a 512-byte header followed by ciphertext. With `storage.blobs.provider: "s3"`
the `blobs/<ns>/` directories are not used; only `blobs/_ihub/keycheck` is.
[Storage Encryption](storage-encryption.md) has the formats and the list of
what stays readable.

### The key-prefix index

For the namespaces in `KEY_PREFIX_SEGMENTS`, documents and blobs get an empty
marker under `.prefixes/<partition>/`, where the partition is the key up to
its N-th `__`. A listing whose prefix contains N complete `__` reads that one
directory; any other listing reads the namespace directory as before. The
marker is written before the document or blob and removed after it, so a
marker can outlive its entry after a crash (listings skip it) but an entry is
never missing from its partition. Migration V250 built the markers for data
stored before the index existed. A partition directory is not removed when its
last marker goes (removing it would race a write of another key into the same
partition), so deleted chats and projects leave empty directories under
`.prefixes/`; they are harmless and may be removed while the server is stopped.

**Downgrade caveat.** A release older than V250 does not write markers. Data
written by it after a downgrade is missing from scoped listings (one chat's
files, one run's artifacts, one project's blobs) once you upgrade again, and
V250 does not run a second time. To repair, delete the `.prefixes` directories
under `contents/data/chat-files`, `contents/data/artifacts` and
`contents/data/blobs/{chat-files,artifacts,project-files}` and remove the V250
entry from `contents/.migration-history.json` so the migration runs again at
the next start.

### Idle lock counters

Every lock name gets a fencing counter file beside its lease, and lock names
are per chat, per run, per import — so the counters used to accumulate
forever. The provider sweeps counters untouched for 24 hours once a night, at
03:00 local time (`storage.filesystem.fenceSweepHour` in `platform.json`, 0–23).
Only one process sweeps at a time, across all workers and servers sharing the
directory; the others skip that night's round. A counter is only removed while its lease is
held by the sweep and its token is below the current time, and tokens are
seeded from the clock (`max(previous + 1, now)`), so a name locked again after
its counter was removed still gets a larger token than any it had before.

The sweep paces itself at about 50 counters per second, so the first sweep after
the upgrade on an installation with a long history (hundreds of thousands of
counters) takes an hour or two of that night; a day's idle counters afterwards
take minutes. It runs at night because on a server whose data does not fit in
memory, touching that many files pushed chats and projects out of the file cache:
in load tests requests were measurably slower while it ran and for a while after.

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
  "v": 2,
  "key": "…",
  "ownerId": "…" | null,
  "contentType": "application/json",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "etag": "<sha256 hex of the canonical JSON of data>",
  "size": 123,
  "data": {}
}
```

That is the unencrypted envelope. A sealed envelope has `"v": 3`, the members
`enc`, `kp`, `kid`, `wk` and `tag` in place of `etag`, and base64 ciphertext in
`data`; the etag a read reports is the same in both forms.

`etag` and `size` are minted by `put` over the canonical serialization of
`data` (the value the contract defines) and stored before `data`. Every read
reports the stored values, and a metadata-only read (`listMetadata`,
`list`/`scan` with `includeData: false`, and the owner/etag check inside `put`
and `delete`) reads only the start of the file and never parses the body.
Migration V247 added both to the `v: 1` envelopes of earlier releases once. An
envelope that turns up later without them (a restored backup, a rollback that
kept writing, an older release on the same volume) is read whole once, its
`etag` and `size` derived the way earlier releases derived them, and written
back under the document's lock — same `data`, owner and timestamps, no change
event, never over a newer write; one warning per listing counts them. An
envelope whose `etag` or `size` is present but malformed is reported as
corrupt (logged, counted in a page's `skipped`).

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
  blobs: boolean,          // the APPEND LOG can park payloads beside a stream
  blobStore: boolean,      // the provider has a `blobs` facet (key-addressed)
  conditionalWrites: boolean,
  rawNamespaces: string[]   // namespaces served in raw mode; [] when none
}
```

The filesystem provider reports
`{ transactions: false, notifications: 'in-process', locking: 'advisory-single-machine', search: false, multiInstance: false, blobs: true, blobStore: true, conditionalWrites: true }`,
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

Only the filesystem provider ships today. Its blob facet can be replaced by an
S3-compatible bucket ([Blob storage backends](#blob-storage-backends)); that
moves the blobs and changes none of the rows above. Documents, logs and locks
stay on the filesystem, so the installation is still single-instance.

**"Multi-instance" is a property of the provider, not of what runs on it.** A
consumer whose correctness needs one writer at a time has to hold that itself,
and swapping the provider does not supply it. The run ledger is the case in
point: `AppendLog` sequence numbers are allocated by the caller, so two
instances that each read `lastSeq` and allocate the next one are both making a
legal call and no provider can reject it. Today the ledger holds the invariant
with cluster-bus ownership routing plus the `runlog:<runId>` lease, both of
which reach one machine — it becomes multi-instance safe when it takes a
distributed lock, which is step 3, not when the row above turns green.

## Writing a provider

1. Extend `StorageProvider` and the facet base classes from
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
