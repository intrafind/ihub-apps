# Artifacts

An **artifact** is content a run produced that is worth keeping in its own
right: the image a chat turn generated, and — as producers adopt the store —
the report a workflow wrote or the output an agent produced.

It is deliberately not a chat concept. A chat turn is one producer among
several, and "what did this produce" is the same question whether the thing
that produced it was a conversation, a workflow execution or an agent run. So
there is one store, addressed by a **scope**, and every producer writes through
it.

> **Status.** Chat turns are the first producer. The legacy agent artifact tree
> under `contents/data/agent-artifacts/` is a separate, older mechanism and has
> **not** moved yet — see [What has not moved yet](#what-has-not-moved-yet).

## The model

An artifact is **two things under one key**: a small metadata document and the
payload itself, in two different storage facets.

```js
// document — artifacts/<scopeType>__<scopeId>__<artifactId>
{
  version: 1,
  scope: { type: 'chat', id: '7f3c…' },   // what it belongs to
  kind: 'image',                          // what it is
  mimeType: 'image/png',
  bytes: 1483204,                         // of the payload, decoded
  sha256: '…',                            // integrity, recorded on write
  name: 'a cat.png',                      // when the producer gave one
  runId: 'run-…',                         // what made it
  createdAt: '2026-09-15T09:00:00.000Z'
}

// blob — artifacts/<scopeType>__<scopeId>__<artifactId>
//   the bytes, raw
```

On the filesystem provider that is
`contents/data/artifacts/<key>.json` for the metadata and
`contents/data/blobs/artifacts/<key>` for the payload.

**The payload is never inlined in the producer's own documents.** A chat
transcript and a workflow state document are single documents that their
producer re-reads, re-serializes and re-hashes on every step, and that ship
back whole when the thing is opened. One artifact inlined there is paid for on
every step for as long as the producer lives. The producer records a
descriptor instead — `{ id, kind, mimeType, bytes }` — and the payload is
fetched only when a viewer actually looks at it.

**And it is not in the artifact's own document either.** Metadata is small,
listable and filterable; a payload is megabytes written once and read whole.
Keeping them apart is what lets `list()` answer "what did this produce" without
touching a single byte of content — and it is what makes the payload store
swappable, which is the subject of [the next section](#swapping-the-payload-backend).

**No base64.** The bytes are stored raw. A producer may hand the store base64 —
that is how a model reports a generated image — but it is decoded at the
boundary, so the 33% encoding tax is paid once on the way in rather than on
disk and again on every read. `bytes` is therefore the real size of the
content, which is also what the caps are measured on.

**No locking.** An artifact is written once, read many times and never
modified, so there is nothing for two writers to lose — and a multi-megabyte
write never queues behind the producer's own lock.

## Swapping the payload backend

The payload goes through the storage provider's **blob facet**
(`provider.blobs`, the `BlobStore` contract) — the seam
[#2318](https://github.com/intrafind/ihub-apps/issues/2318) exists for. It is
deliberately the smallest surface every candidate backend already has:

| Operation | Filesystem        | S3-compatible   | PostgreSQL           |
| --------- | ----------------- | --------------- | -------------------- |
| `put`     | atomic file write | `PutObject`     | large object/`bytea` |
| `get`     | read file         | `GetObject`     | read                 |
| `delete`  | unlink            | `DeleteObject`  | delete               |
| `list`    | readdir + filter  | `ListObjectsV2` | `LIKE` on key        |

No transactions, no locking, no streaming semantics, no filesystem
assumptions. An S3 adapter implements those four calls, declares
`blobStore: true`, and **nothing in `ArtifactRepository` or above it changes** —
which is what takes uploads and artifacts off the shared-volume requirement
that pins a deployment to one machine today.

Two rules keep it that way, and the conformance suite enforces both:

- **The blob facet stores bytes, not meaning.** Media type, display name,
  producer and timestamps live in the metadata document. `put` accepts a
  `contentType` hint so an object store can set it on the object (an S3
  presigned URL needs it to serve correctly), but the document stays
  authoritative and a backend that cannot persist it simply ignores it.
- **Prefix listing is part of the contract.** It is how a scope is swept, and
  the only way to reach a payload whose metadata document never landed.

`server/storage/__tests__/providerConformance.js` runs the facet's contract
against any provider that declares the capability, so a future backend is
tested against the same expectations the filesystem one meets.

> `blobStore` is a different capability from `blobs`, which says the *append
> log* can park payloads beside a stream — the run ledger's spill files. The
> two are unrelated stores.

## Scopes

A scope is the thing whose lifetime the artifact follows. The set is closed,
because the scope type is part of a storage key and a typo in one producer
would otherwise create a scope nothing else can find or sweep.

| Scope  | Id             | Used by                                              |
| ------ | -------------- | ---------------------------------------------------- |
| `chat` | chat id        | a durable chat's turns; swept when the chat is deleted |
| `run`  | run/execution id | a workflow execution or an agent run                |

Every artifact of one scope shares a key prefix, which is what makes
"everything this chat produced" and "everything this run produced" the same
cheap prefix walk — and what lets the delete sweep find an artifact whose
descriptor never landed on a message.

A scope id that cannot be a storage key simply has no artifacts: a headless
agent chat is `agent:<runId>:<hex>`, and a colon is not a valid document key.
That is a no-op, never an error.

## Kinds

A kind says what an artifact is, and carries the media types it may be served
as. The type comes from whatever produced the artifact — a model response, a
tool — and ends up in a `Content-Type` header on a same-origin URL, so an
allowlist per kind is what keeps a producer from having the server hand a
browser something executable.

| Kind       | Media types                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `image`    | `png`, `jpeg`, `webp`, `gif`, `avif`, `bmp`, `heic`, `heif`              |
| `document` | `text/markdown`, `text/plain`, `text/csv`, `application/json`, `application/pdf` |

Anything else is stored and served as `application/octet-stream` with
`X-Content-Type-Options: nosniff`. Two absences are deliberate:
`image/svg+xml` is not an image here and `text/html` is not a document — both
are documents that can run script, and `nosniff` does not help when the type is
honest.

**Adding a kind** is an entry in `ARTIFACT_KINDS` (`artifactPolicy.js`) plus a
renderer on the client. Nothing in the storage path, the caps, the endpoints,
the listing or the delete cascade is kind-specific. A kind brings its own
allowlist and cannot widen another's.

## Configuration

`platform.json → artifacts`, read fresh on every write so an admin's change
takes effect without a restart:

| Key           | Default    | Meaning                                                      |
| ------------- | ---------- | ------------------------------------------------------------ |
| `enabled`     | `true`     | Master switch for every producer; `false` stores nothing      |
| `maxBytes`    | `10485760` | Largest single artifact, in bytes of content; `<= 0` uncapped |
| `maxPerBatch` | `8`        | Artifacts one producer records in one go; `<= 0` uncapped     |

Migration V106 seeds the block into existing installations at its defaults, so
an upgrade changes nothing on its own.

The settings live here rather than under `chats` precisely because a workflow
reading its own limits must not have to reach into the chat settings to find
them.

## Authorization

The store has no opinion about who may read an artifact. A route authorizes the
**scope** — the chat, the run, the execution — exactly as it would to read
anything else about it, and only then asks for the bytes. An artifact id is
minted server-side and is never a capability on its own; a chat that is not
yours answers `404`, like every other chat endpoint.

A [share](chat-sharing.md) is the one other scope a route authorizes: it
serves the artifacts its frozen transcript named — an allow-list of ids
recorded when the share was created — out of the chat's scope, and nothing
else in that scope.

## API

Today the surface is the chat's, because chats are the only producer:

| Method & path                                  | Purpose                                              |
| ---------------------------------------------- | ---------------------------------------------------- |
| `GET /api/chats/:chatId/artifacts`             | What this chat produced, newest first, as descriptors |
| `GET /api/chats/:chatId/artifacts/:artifactId` | The bytes of one, as its own media type              |
| `GET /api/shares/:shareId/artifacts`           | Through a [share](chat-sharing.md): the ones its snapshot named |
| `GET /api/shares/:shareId/artifacts/:artifactId` | The bytes of one of those; `?download=1` attaches    |

The listing never carries payloads — it is the index, and the bytes are a
separate request per entry. It walks the artifact keys rather than the
transcript, so it also sees an artifact whose descriptor never landed on a
message.

The bytes response is `private, max-age=31536000, immutable`: an artifact
document is written once, never modified, and keyed by a fresh uuid, so what is
behind one URL cannot change. `private` because it is scope-scoped and a shared
cache holding it would serve one user's content to another.

A client fetches through its API client rather than pointing an `<img src>` at
the URL: the URL is credentialed, and a bearer token in `localStorage` only
travels on a request the client makes itself.

## Lifetime

An artifact goes when its scope goes, and when whatever named it goes:

- **Scope deleted** — `deleteScope()` empties it by key prefix, so a payload
  whose descriptor never landed is collected too. The chat delete cascade calls
  this.
- **Reference dropped** — a chat edit that rewrites history from a message, or
  the per-chat message cap pushing a message out, deletes the artifacts those
  messages named.

There is no age-based sweep of the namespace itself; artifacts are reclaimed
through their scope.

## Using it from a new producer

```js
import { getArtifactRepository } from '../artifacts/ArtifactRepository.js';

const descriptor = await getArtifactRepository().put(
  { type: 'run', id: executionId },
  { kind: 'document', mimeType: 'text/markdown', data: base64, name: 'report.md', runId }
);
// Record `descriptor` wherever the producer records its own output, and
// call `deleteScope({ type: 'run', id: executionId })` when that output goes.
```

Three things a producer owes the store: record the descriptor somewhere it can
find again, empty the scope when the scope's own data is deleted, and expose a
route that authorizes the scope before serving the bytes.

## What has not moved yet

The agent artifact tree — `contents/data/agent-artifacts/<runId>/<name>`,
written by `server/agents/runtime/artifactStore.js` and the `write_artifact`
tool, read by `GET /api/agents/runs/:runId/artifacts` — predates this store and
still runs on its own. It is not a drop-in swap:

- it stores **text only** (`writeArtifactDirect` requires a string), while this
  store is base64 and binary-capable;
- its read route **hardcodes `text/markdown`**, so the `contentType` it records
  is already inaccurate for anything else;
- its quotas are per run and counted against in-state bookkeeping, not against
  what is on disk;
- it has **no retention at all**, and the workflow-state sweep deletes the
  state its authorization check depends on — leaving files that are unreadable
  by their owner and never collected.

Moving it is a data migration plus changes to the admin UI, the SSE projection
and the `write_artifact` tool, and is worth doing on its own rather than inside
a bug fix. The store above is shaped to receive it: `run` is already a scope,
and `document` is already a kind.

Workflow outputs are the other obvious producer. Today a workflow's real
deliverable — the Markdown/PDF/DOCX a user downloads from the execution page —
is generated **in the browser** and never persisted; the `template-render` node
is the only one that writes a file, and it writes into the agent tree.

## Code map

| File                                                | Responsibility                                         |
| --------------------------------------------------- | ------------------------------------------------------ |
| `server/storage/BlobStore.js`                       | The payload contract an S3 or database backend implements |
| `server/storage/providers/filesystem/FilesystemBlobStore.js` | It, on files                                  |
| `server/services/artifacts/ArtifactRepository.js`   | The store: scopes, keys, put/get/list/delete            |
| `server/services/artifacts/artifactPolicy.js`       | Kinds, media-type allowlists, caps and the master switch |
| `server/services/chat/chatMaterializer.js`          | The chat producer: a turn's images become artifacts     |
| `server/routes/chats.js`                            | The chat-scoped endpoints                               |
| `client/src/features/chat/components/GeneratedImage.jsx` | Renders a live, a stored or an unavailable image   |

```bash
node --test server/tests/artifact-repository.test.js
npm run test:storage   # includes the blob facet's conformance tests
```

See also [Chat Persistence](chat-persistence.md) and
[Storage Providers](storage.md).
