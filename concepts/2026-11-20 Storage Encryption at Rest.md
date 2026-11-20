# Storage Encryption at Rest

Date: 2026-11-20. Status: built on branch `claude/epic-lamport-5wjqa7`, not released. Tickets:
#2316 (encryption of chats and logs), #2318 (S3 blob backend), #2906.

This document records the design of storage encryption as it was built. It is the condensed form of
the architect's plan for requester changes R1 to R3 (see section "Changes after the plan" in
`2026-11-19 S3 Blob Storage Backend.md`). The operator documentation is `docs/storage-encryption.md`
and `docs/encryption-key-management.md`.

## 1. Summary

- One switch, `storage.encryption.enabled`, in `platform.json`. Schema default `false`, so an
  existing installation is unchanged. `server/defaults/config/platform.json` sets `true`, so a fresh
  installation is encrypted.
- With the switch on, iHub encrypts before it writes: documents, append logs with their spill
  blobs, blobs (filesystem and S3) and five file stores outside the storage layer.
- Existing data is converted once, before the server listens. The conversion is idempotent and
  resumable. `npm run storage:encrypt` runs it with the server stopped.
- After the conversion, plaintext is an error. With the switch off, writes are plaintext and
  encrypted data is still decrypted.
- The key is the platform's master key (`TOKEN_ENCRYPTION_KEY` or `contents/.encryption-key`)
  through the existing `KeyProvider`. A missing key is never replaced while encrypted data exists.
- Goal: confidentiality against someone who can **read** the disk or the bucket. Not a goal:
  protection against someone who can write them, and hiding who uses the system.

## 2. Requester decisions

| #   | Decision                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The encrypting blob store wraps the filesystem blob store too, every namespace, same format as on S3. Blobs already on disk are encrypted in place by a one-time step.                                                                              |
| R2  | Documents and append logs are encrypted on the filesystem provider with the same key provider: "everything that is user generated and can have confidential data".                                                                                  |
| R3  | Encryption is optional. One switch. Enabled: every write is encrypted, plaintext is an error once the conversion has completed. Disabled: writes are plaintext, encrypted objects are still decrypted. S3 with the switch off is allowed and warns. |
| —   | No rollback after enabling other than restoring a backup. Accepted by the requester.                                                                                                                                                                |

## 3. Inventory

What holds user content, and what the switch does with it.

### 3.1 Encrypted

| Store                                | Where                                          | Holds                                                                                                                                                                                                                                       | Format               |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Documents, every enveloped namespace | `contents/data/<ns>/<key>.json`                | Chats and titles, transcripts, share copies, evidence records, artifact and file metadata (file names), task memory, scheduled tasks, user prompts and skills, workflow state, interactions, A2A tasks, project metadata, integration state | `ihub-doc-v1`        |
| Append log                           | `contents/data/logs/<kind>/<id>.jsonl`         | The run ledger: every event of a run. This is the chat content a second time.                                                                                                                                                               | `ihub-log-v1`        |
| Spill blobs of the log               | `contents/data/logs/<kind>/<id>.blobs/<name>`  | Payloads too large for a record                                                                                                                                                                                                             | blob envelope `IHB1` |
| Blobs, every namespace               | `contents/data/blobs/<ns>/<key>` or the bucket | Uploaded files, extracted text, evidence content, artifact payloads, crawled pages. `project-files` is encrypted by its domain service already and is encrypted a second time.                                                              | blob envelope `IHB1` |
| `agent-artifacts`                    | `contents/data/agent-artifacts/<runId>/<name>` | Outputs of agent runs                                                                                                                                                                                                                       | file seal (`IHB1`)   |
| `agent-memory`                       | `contents/agents/memory/<profileId>.md`        | Notes an agent keeps                                                                                                                                                                                                                        | file seal            |
| `agent-inboxes`                      | `contents/data/agent-inboxes/<inboxId>.md`     | Work items users write for agents                                                                                                                                                                                                           | file seal            |
| `tool-jobs`                          | `contents/data/tool-jobs/<jobId>.result`       | Results of tool jobs (OCR), one hour                                                                                                                                                                                                        | file seal            |
| `short-links`                        | `contents/data/shortlinks.json`                | Short links with their parameters                                                                                                                                                                                                           | file seal            |

There is no list of exempt namespaces: a list can be wrong, and sealing a small document costs
less than 0.1 ms.

### 3.2 Not encrypted

| Store                                                        | Holds                                           | Why                                                              |
| ------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------- |
| `data/feedback.jsonl`                                        | Feedback with the comment and an answer snippet | Read with `jq` and `grep` and rotated by hand. Follow-up.        |
| `data/tmp/project-uploads/`                                  | Uploads waiting for extraction                  | Temporary, removed with the request, swept after one hour.       |
| `data/ifinder-downloads/`                                    | Downloaded documents                            | Saved for use outside iHub.                                      |
| `data/debug/llm-request/`, `data/debug/llm-failures/`        | Full LLM requests while the debug switch is on  | A debug dump is meant to be read.                                |
| `.backups/`                                                  | What a backup import replaced                   | Same form as the data it copied. Old copies stay plaintext.      |
| Operating-system temp directory                              | Upload spools                                   | Outside `contents/`.                                             |
| Raw namespaces: `config/`, `apps/`, `models/`, `prompts/`, … | Configuration, hand-edited                      | Must stay readable and editable. Secrets in them are `ENC[...]`. |
| `data/audit-log/`, usage and quota files                     | Actors, ids, counters. No content.              | Not content.                                                     |
| `data/change-history/`                                       | Before and after of configuration changes       | Configuration.                                                   |
| Application log                                              | Log lines                                       | Rule stays: no content in logs.                                  |

The conversion and the dry run name the stores of the first five rows that hold data.

### 3.3 Readable metadata

Readable on disk and in the bucket with the switch on, because the store needs it without a
decrypt:

- namespace directories and file names, which hold ids: chat id, `<scopeType>__<scopeId>__<id>`,
  project id, run id, task id, artifact name, profile id, inbox id, job id;
- share tokens: `chat-shares` is keyed by the token. A live share token opens the shared transcript
  through the application;
- `ownerId` in the document head (an e-mail address or an OIDC subject), and the owner index
  `.owners/<sha256 prefix>/<key>`. The hash is unsalted, so a known user id can be confirmed;
- `.prefixes/` markers, `createdAt`, `updatedAt`, `contentType`, `size`, file sizes and times;
- `seq` on every log line, the number and size of records, the key lines;
- key provider id and key id.

A reader of the disk learns who uses the system, when and how much, and which file belongs to
which chat. They do not learn titles, messages, file names, prompts, memory, tool arguments or
results, or file content.

## 4. Formats

All formats use the stream cipher that project files already used (`tink-aes-gcm-hkdf-v1`,
AES-256-GCM, 1 MiB segments, `server/crypto/streamingAead.js`), one random data key per write, and
the key provider for wrapping. The associated data binds every ciphertext and every wrapped key to
its address. It is built from the request, never read from the stored object. Test vectors are
recorded under `server/tests/fixtures/`.

| Object               | Module                          | Stored form                                                                                                                                            | Associated data                                                                           |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Blob                 | `server/crypto/blobEnvelope.js` | 512-byte header (`IHB1`, version, key provider id, key id, wrapped key, zero padding) followed by the stream                                           | `ihub/blob/v1\n<tenant>\n<ns>\n<key>\n1048576`                                            |
| Document             | `server/crypto/documentSeal.js` | Envelope `"v": 3`. Head unchanged (`key`, `ownerId`, `contentType`, times, `size`). `enc`, `kp`, `kid`, `wk`, `tag` (the sealed etag), `data` (base64) | `["ihub/doc/v1", tenant, ns, key, ownerId, contentType, 1048576]`, and `ihub/doc-etag/v1` |
| Log record           | `server/crypto/logSeal.js`      | `{"$key":1,…}` line with a wrapped key at the start of each flushed batch, then `{"$enc":1,"seq":…,"k":…,"c":…}` lines                                 | `["ihub/log-key/v1", tenant, stream, id]`, `["ihub/log/v1", tenant, stream, id, seq]`     |
| Spill blob           | `server/crypto/logSeal.js`      | Blob envelope                                                                                                                                          | `ihub/logblob/v1\n<tenant>\n<stream>\n<name>\n1048576`                                    |
| File of a file store | `server/crypto/fileSeal.js`     | Blob envelope                                                                                                                                          | `["ihub/file/v1", tenant, store, name, 1048576]`                                          |

Design decisions:

- **Documents are sealed inside the filesystem store**, not by a decorator. A decorator would see
  etag and size of the ciphertext; compare-and-set and metadata-only listings need the plaintext
  values without reading the body. Consequence: a later SQL provider calls `documentSeal.js` at its
  own boundary.
- **The etag is sealed.** It is a hash of the plaintext and would let a reader confirm a guessed
  body. A read reports the same etag in every mode.
- **`ownerId` and `contentType` are part of the associated data.** A document whose owner was
  edited in the head does not open.
- **Log records are sealed at flush time, one key per flushed batch.** The ledger's rule "queued
  before the first await" stays. `seq` stays readable, so a read selects by it and opens only what
  it returns. A fresh salt per record means a repeated `seq` never repeats a nonce.
- **Recognition is by format, never by trial.** A document is sealed when `v` is 3. A log line is
  sealed when it has the own property `$enc` or `$key`; `append` rejects a caller's record that has
  one of them. A blob or file is an envelope when it is at least 568 bytes long and starts with a
  well-formed header.
- **Blobs keep the decorator** (`EncryptingBlobStore`), because the blob contract has no etag, no
  compare-and-set and no metadata-only read.

## 5. Modes and the state record

`contents/data/.at-rest.json`:

```json
{
  "format": 1,
  "state": "off | converting | complete",
  "facets": { "blobs": 1, "documents": 1, "logs": 1, "files": 1 },
  "keyId": "1a2b3c4d",
  "startedAt": "…",
  "completedAt": "…",
  "disabledAt": "…",
  "previousKeyId": "…",
  "converted": { "documents": 0, "streams": 0, "spillBlobs": 0, "blobs": 0, "files": 0 },
  "skipped": 0
}
```

`facets` lists what is fully encrypted, each with a format number. A facet is added when its
conversion has been verified. A release that encrypts more adds a facet name; an installation
whose record lacks it converts only that part. The record is plain and not authenticated: its
integrity is that of `platform.json`, which holds the switch.

| Switch | State record                    | Mode         | Writes    | Plaintext on read | Sealed on read              |
| ------ | ------------------------------- | ------------ | --------- | ----------------- | --------------------------- |
| off    | any                             | `off`        | plaintext | read              | read, when the key is there |
| on     | not complete, preparing process | `converting` | sealed    | read              | read                        |
| on     | `complete`                      | `enforced`   | sealed    | error             | read                        |
| on     | not complete, any other process | refuse start |           |                   |                             |

Errors in the mode `enforced`: `PLAINTEXT_DOCUMENT`, `CORRUPT_LOG`, `CORRUPT_BLOB`,
`PLAINTEXT_FILE`. In every mode an object that does not verify is `CORRUPT_*`, and an object that
names a key that is not present is `KEY_UNAVAILABLE`. Neither is reported as "absent".

Blobs on S3 are strict from the first write (`plaintextReads: 'reject'` whenever the switch is on):
a bucket starts empty and has no conversion.

## 6. Start-up and conversion

Order of a start (`server/startup/primary.js`, `server/startup/worker.js`,
`server/startup/bootstrap.js`):

1. Configuration migrations (`prepareContents`). From here to the end of step 3 the process is
   "preparing": a migration that starts storage reads plaintext and sealed data side by side.
2. `ensureEncryptionKey()`. If the key is missing or unreadable and sealed data exists, the process
   ends (`MASTER_KEY_REQUIRED`).
3. `prepareStorageEncryptionOrExit()` → `server/storage/atRest/prepare.js`. In the cluster primary
   before the fork, or in the single process. A cluster worker never converts.
4. Storage bootstrap. Workers find `complete` and read strictly.

What step 3 does:

| Switch | State record               | Action                                                                                     |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| off    | none or `off`              | Nothing.                                                                                   |
| off    | `complete` or `converting` | The record is set to `off`, `facets` is cleared, `keyId` stays. Nothing is converted.      |
| on     | `complete`                 | The master key is checked against the key-check object.                                    |
| on     | anything else              | Preconditions, record `converting`, conversion per facet, verification, record `complete`. |

Preconditions: the master key is loaded and persisted (a key generated in this run that could not
be saved is refused); the key-check object `data/blobs/_ihub/keycheck` opens or does not exist yet;
free space of at least 1.35 times the largest object plus 35 % of the plaintext document and log
bytes.

The conversion engine (`server/storage/atRest/convert.js`) walks the data directory, recognises
each object by its format, and replaces a plaintext object by its sealed form in one rename.
Modification times of streams and blobs are restored, because sweeps judge by them. After each
facet a second walk must find no plaintext; then the facet is recorded. Objects that are not
readable in any form are counted in `skipped`, named in the log and do not block completion.
Progress is logged every 10 seconds.

The key guard (`server/storage/atRest/keyGuard.js`) is what stops key generation: the state record
names a key id (in any state, also `off`), the record exists and cannot be read, or the key-check
object exists.

Commands (`server/storage/commands/`): `encrypt` (the conversion, with `--dry-run`), `show` (print
one object decrypted, logged as `STORAGE_SHOW`). Both are reachable as `npm run storage:*` and as
`node server/storage/commands/run.js <command>`.

## 7. Key handling

- The master key now protects all stored content. Loss of the key is loss of the content.
- No new key over sealed data (section 6).
- Rotation: new writes use the current key; old objects need `TOKEN_ENCRYPTION_KEY_PREVIOUS`. Only
  one previous key is read. Documents that are written again move to the new key; finished streams,
  cold documents and blobs do not. A start with a changed key logs a warning and records
  `previousKeyId`.
- With the key file in `contents/` (the default), a reader of the whole directory reads
  everything. The protection depends on keeping the key apart.
- The admin backup export contains the ciphertext and, when the key is a file, the key. It does
  not contain an S3 bucket.

## 8. What was measured

Node 22.23.5, one core, development machine.

| Operation                       | Added by sealing    |
| ------------------------------- | ------------------- |
| 20 KB document write            | 0.07 ms             |
| 1 MB document write             | 2.2 ms              |
| One log record                  | 9 to 63 µs          |
| Disk growth, documents and logs | about 33 % (base64) |

Conversion duration is an estimate from an fsynced rewrite of a 5 KB document (1.1 ms serial,
0.35 ms with 16 in flight): 3 to 8 minutes for 100,000 documents plus 20 GB of blobs on a local
SSD, 30 to 90 minutes on a network volume. No installation of that size was converted.

## 9. Deviations from the plan

| Plan                                                                                      | Built                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Three changes: blobs first, then documents and logs, then the file stores.                | One branch holds all three. The scope value `blobs` exists only for a provider that does not encrypt documents.                                                                            |
| File stores outside the storage layer are a later change and stay plaintext.              | Agent artifacts, agent memory, agent inboxes, tool-job results and short links are sealed (facet `files`). `feedback.jsonl`, `ifinder-downloads` and `tmp/project-uploads` stay plaintext. |
| State record facets `blobs`, `documents`, `logs`.                                         | Adds `files`, `converted.spillBlobs`, `converted.files`, `disabledAt`, `previousKeyId`. An installation recorded complete without `files` converts only the files at its next start.       |
| Switch off with sealed data and a missing key: a warning, and `KEY_UNAVAILABLE` per read. | A missing or unreadable key stops the start whenever sealed data exists, also with the switch off. A key that is present but wrong is not checked with the switch off and fails per read.  |
| Status field `encryption.state`; `storage:check` reports state, scope and counts.         | The admin status has `encryption.conversion.state` with `facets`, `keyId`, `skipped`, `completedAt`. `storage:check` reports the switch and the key only.                                  |
| The admin card says in one sentence that a key in `contents/` protects little.            | The card does not say it. The documentation and the release note do.                                                                                                                       |
| `storage:check` exits 1 while `skipped > 0`.                                              | Not built. `skipped` is in the log and in the admin status.                                                                                                                                |
| Not in the plan.                                                                          | Sealed artifact downloads and cross-worker tool-job downloads are read into memory whole.                                                                                                  |
| Not in the plan.                                                                          | Objects that are in an S3 bucket in plaintext (uploaded with the switch off) are not converted. With the switch on they are refused on read.                                               |
| Not in the plan.                                                                          | `storage:encrypt --dry-run` creates `contents/.encryption-key` when the installation has no key at all.                                                                                    |
| The plan file was to be copied to `concepts/at-rest-encryption/`.                         | This file, beside the S3 design.                                                                                                                                                           |

## 10. Accepted limits

- Tampering with one object is detected. Deleting an object, cutting the tail of a log and putting
  back an older copy of a whole file are not.
- Someone who can write the data directory can also replace `platform.json`. The state record has
  the same trust.
- `.backups/`, earlier backups, volume snapshots and deleted disk blocks keep plaintext.
- Once any object is sealed, a release before this feature cannot read the data: documents read as
  corrupt and sealed log lines as events without a type.
- No lazy conversion on read, no per-namespace switch, no plaintext read path after `complete`.
  Each would be a compatibility shim and needs the requester's decision.

## 11. Follow-ups

None is a ticket yet.

| Follow-up                                                                                                            | Why                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Rewrap job: re-wrap objects that name an earlier key id. The conversion engine can carry it as a second task.        | Until then one previous key is the limit and an exposed key cannot be retired.    |
| Streaming reads for sealed blobs and files, and multipart on S3.                                                     | Whole-object reads hold about three times the payload in memory.                  |
| Seal `feedback.jsonl`.                                                                                               | It holds comments and answer snippets. Needs a replacement for the `jq` workflow. |
| Hash share tokens in the keys of `chat-shares`.                                                                      | A share token in a file name is a credential readable on disk.                    |
| Transit key provider (OpenBao, Vault, KMS) behind `KeyProvider`.                                                     | Keeps the master key off the server.                                              |
| Admin form for the blob backend and the switch (#2312).                                                              | Today both are edited in `platform.json`.                                         |
| Verification against real S3: versitygw (compose file and CI workflow not yet executed), AWS S3, a customer service. | Only the in-repository S3 server was used, and it does not verify signatures.     |
| A command that encrypts plaintext objects in a bucket, and a `storage:decrypt` command.                              | No way today to convert a bucket or to leave encryption.                          |
| An option to leave the key out of the admin backup export.                                                           | The export with a key file is as sensitive as plaintext.                          |
| A lint rule or test against new stores that write user content with `fs` beside the storage layer.                   | Otherwise plaintext stores appear again over time.                                |
