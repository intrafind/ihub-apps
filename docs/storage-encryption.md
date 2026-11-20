---
description: 'Encrypt stored chats, files and run history with one switch: what is covered, how to turn it on and what to back up.'
audience: admin
type: how-to
---

# Storage Encryption

One switch, `storage.encryption.enabled`, makes iHub encrypt what it stores before it writes it: on
the local disk and, when blobs are kept in an S3 bucket, in the bucket. This page says what the
switch covers, what it does not cover, how to turn it on for an existing installation and what
changes for backup and support.

Read [Encryption Key Management](encryption-key-management.md) as well. With the switch on, the
master key protects the stored content. **If the key is lost, the content is lost.**

## The switch

```json
{
  "storage": {
    "encryption": { "enabled": true }
  }
}
```

| Installation                                | Value                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Existing installation, after the upgrade    | Off. Nothing is converted and nothing changes until an administrator turns it on. |
| Fresh installation (new `contents/` folder) | On. The `platform.json` it starts with contains `"enabled": true`.                |
| The setting is absent                       | Off.                                                                              |

- The setting is in `contents/config/platform.json`. There is no admin form for it and no
  environment variable. `IHUB_PLATFORM__...` overrides do not reach it, because the storage settings
  are read from the file before the rest of the configuration is loaded.
- A change needs a full restart of the server: stop it and start it again. In a cluster the primary
  process reads the switch once per start and hands it to every worker, so a worker that is
  replaced while the server runs keeps the setting the server started with.
- If `platform.json` is missing at start and `contents/` already holds data (files under `data/`
  or `agents/memory/`), the file is created from the defaults **with the switch off**, and the log
  says so (`STORAGE_ENCRYPTION_NOT_DEFAULTED`). Existing data is not converted without a decision.
  Restore your own `platform.json` if it was lost.
- There is one switch for everything. There is no setting per kind of data.
- The key is the master key of the installation: `TOKEN_ENCRYPTION_KEY`, or the file
  `contents/.encryption-key`. No new secret is needed.

## What is encrypted

| What                                                                                                                                                                                                                                                                       | Where                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Documents of every storage namespace: chats with their titles, transcripts, shared chat copies, file metadata with file names, artifact metadata, evidence records, user prompts and skills, workflow state, scheduled tasks and their memory, project metadata, A2A tasks | `contents/data/<namespace>/<key>.json`         |
| The run ledger: every event of a run, and the payloads it stores beside the stream                                                                                                                                                                                         | `contents/data/logs/`                          |
| Blobs: uploaded files (original, extracted text, page texts), project document text, artifact payloads, evidence content, crawled website pages                                                                                                                            | `contents/data/blobs/`, or the S3 bucket       |
| Agent artifacts                                                                                                                                                                                                                                                            | `contents/data/agent-artifacts/<runId>/<name>` |
| Agent memory                                                                                                                                                                                                                                                               | `contents/agents/memory/<profileId>.md`        |
| Agent inboxes                                                                                                                                                                                                                                                              | `contents/data/agent-inboxes/<inboxId>.md`     |
| Results of tool jobs (for example OCR), kept for one hour                                                                                                                                                                                                                  | `contents/data/tool-jobs/<jobId>.result`       |
| Short links with their parameters                                                                                                                                                                                                                                          | `contents/data/shortlinks.json`                |

Every object gets its own random key. That key is wrapped with the master key and stored with the
object. The cipher is AES-256-GCM. An object is bound to its place: a document, a log record or a
file that is copied to another name, another namespace or another owner does not open.

## What is not encrypted

The switch does not cover the following. Anyone who can read the disk or list the bucket can read
it.

**Content that stays readable on disk:**

| Path under `contents/`                                | Holds                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `data/feedback.jsonl`                                 | Feedback entries, including the user's comment and a snippet of the rated answer. See [Feedback](feedback-feature.md). |
| `data/tmp/project-uploads/`                           | Files uploaded to a project while they wait for text extraction. Removed with the request, swept after one hour.       |
| `data/ifinder-downloads/`                             | Documents downloaded from iFinder.                                                                                     |
| `data/debug/llm-request/`, `data/debug/llm-failures/` | Full requests to the language model, only while the LLM debug switch is on. They contain chat content.                 |
| `.backups/`                                           | What a backup import replaced, in the form it had then. Copies made before the switch was turned on are unencrypted.   |
| The operating system's temp directory                 | Upload spools while a request runs.                                                                                    |

The start-up log and `npm run storage:encrypt -- --dry-run` name those of these stores that hold
data.

**Not content, and not encrypted:** the configuration (`config/`, `apps/`, `models/`, `prompts/`,
`workflows/`, `agents/profiles/` and the other hand-edited folders; secrets inside them are
encrypted separately as `ENC[...]`), user accounts in `config/users.json`, the audit log, usage
counters, the application log, and admin-uploaded assets and pages.

**Names and numbers that stay readable, on disk and in the bucket:**

- File and object names. They contain ids: chat ids, project ids, run ids, artifact names, agent
  profile ids, inbox ids and job ids.
- Share tokens. A shared chat is stored under its share token, so the token is part of a file
  name. A share token that is still valid opens the shared chat through the application.
- Owner ids (the user id, often an e-mail address or an OIDC subject) in the head of each document.
- Content type, sizes, creation and change times, and the sequence number of each log record.
- The id of the master key an object was encrypted with.

So a person who can read the disk still learns who uses the system, when, how many chats and files
each user has, which file belongs to which chat and roughly how long each conversation is. They do
not learn titles, messages, file names, file content, prompts, memory, tool arguments or results.

**Other limits:**

- **The key location decides the protection.** By default the key is the file
  `contents/.encryption-key`, in the same folder as the data. A copy of `contents/` then contains
  everything needed to read it. Encryption protects against a reader of the disk only when the key
  is kept apart. See [Encryption Key Management](encryption-key-management.md).
- **Changes are detected, removals are not.** If one stored object is changed, the server notices
  and refuses it. If a file is deleted, or replaced by an older version of itself, the server does
  not notice.
- Earlier backups, volume snapshots and deleted blocks on the disk keep the unencrypted data they
  had. The conversion does not reach them.
- A running server holds decrypted content in memory.

## Turning it on

Turning the switch on converts the stored data once: every unencrypted object is replaced by its
encrypted form. Afterwards the server refuses unencrypted data.

**There is no way back to an older release.** A release before this feature cannot read encrypted
data: it does not know the format and treats an encrypted chat, file or log as damaged. Turning
the switch off does not decrypt anything. The only way back is a backup taken before the switch
was turned on. Take one. A new installation has the switch on from its first start, so it cannot
be moved to an older release at all.

### Before you start

1. Back up `contents/` with the server stopped, or with your snapshot tool. This backup is the
   rollback.
2. Make sure the master key is backed up apart from the data
   ([Encryption Key Management](encryption-key-management.md)).
3. Run the dry run. It can run while the server is running:

   ```bash
   npm run storage:encrypt -- --dry-run
   ```

   Example output:

   ```text
   Data directory  /srv/ihub/contents/data
   Switch          storage.encryption.enabled is off
   Still in plaintext:
     documents     98,211 of 98,211 (1.9 GB)
     log streams   4,410 of 4,410 (612,004 records, 2.3 GB)
     spill blobs   310 of 310 (120.4 MB)
     blobs         20,112 of 20,112
     files         42 of 42 (1.1 MB; agent artifacts, memory, inboxes, tool-job results, short links)
   Free space      212.0 GB free, about 1.5 GB needed
   Estimate        about 160 s on a local disk; 10 to 20 times that on a network volume
   Master key      present and usable
   Not covered     data/feedback.jsonl (stay in plaintext)
   Dry run: nothing was changed. Run without --dry-run, with the server stopped, to encrypt.
   ```

   The dry run counts, checks the master key and the free space and gives an estimate. It changes
   nothing: it converts nothing, writes no state record and creates no key. If the installation
   has no master key yet, the line reads `Master key none yet; nothing was created`; the first
   start, or the command without `--dry-run`, creates `contents/.encryption-key`. With blobs in an
   S3 bucket the dry run also lists the bucket (`bucket blobs`).

### Free disk space

The conversion needs free space of about 35 % of the size of the documents and logs, plus the
largest single object once more. Documents and logs grow by about a third, because the ciphertext
is stored as text. Blobs and files grow by about 570 bytes each. With too little space the dry run
and the conversion stop with a message that says how much is needed.

### How long it takes

| Installation                                        | Estimate         |
| --------------------------------------------------- | ---------------- |
| 10,000 documents and 1 GB of blobs on a local SSD   | under 1 minute   |
| 100,000 documents and 20 GB of blobs on a local SSD | 3 to 8 minutes   |
| The same on a network volume                        | 30 to 90 minutes |

These are estimates from small measurements, not from an installation of that size. Use the
estimate of the dry run for your data.

### Way 1: convert at the next start

1. Set `storage.encryption.enabled` to `true` in `contents/config/platform.json`.
2. Restart the server.

The conversion runs before the server listens. **The server accepts no requests until it has
finished.** The log shows a line at the start with the counts and the estimate, a progress line
every 10 seconds, and a summary at the end:

```text
Encrypting the stored data (blobs, documents, logs, files); the server does not accept requests until this has finished. Estimate on a local disk: about 160 s.
Encrypting the stored data: 41200 of about 123075 objects looked at
Stored data is encrypted at rest: documents, append logs, blobs, and the files of agent artifacts, agent memory, agent inboxes, tool-job results and short links. Not covered and still plaintext where present: data/feedback.jsonl; earlier backups and volume snapshots.
```

Use this way for small installations on a local disk.

### Way 2: convert with the server stopped

1. Stop the server: **every** server process that uses this `contents/` volume or this bucket.
2. Run `npm run storage:encrypt`. In a container: `node server/storage/commands/run.js encrypt`.
3. Set `storage.encryption.enabled` to `true`.
4. Start the server. The start is fast, because nothing is left to convert.

Use this way for large installations and for network volumes. Do step 3 before step 4: with the
switch still off, the server writes unencrypted data again.

**Stop every server on the volume before you run `storage:encrypt` without `--dry-run`.** The
command replaces every unencrypted object. A server that writes at the same time can lose a write.

Only one process converts at a time:

- A second `storage:encrypt`, or one that is run while a server is starting and converting, ends
  with `CONVERSION_IN_PROGRESS` and exit code 1. Wait and run it again.
- A server that starts while the command runs waits for it, logs
  `Another process is encrypting the stored data of this data directory; waiting for it to finish`
  every 10 seconds, and then continues.
- **Known limit:** this protection does not see a server that is already running and serving. The
  command does not refuse in that case. Stopping the servers is your part.

### Blobs in an S3 bucket

With `storage.blobs.provider: "s3"` and the switch on, the start looks into the bucket before it
changes anything on disk: it connects, reads the key-check object and looks at the objects.

| The bucket holds                                           | A start                                                                         | `npm run storage:encrypt`                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| nothing, or only objects encrypted with this key           | continues                                                                       | records the bucket as encrypted                                   |
| unencrypted objects (uploaded while the switch was off)    | is refused: `REMOTE_BLOBS_PLAINTEXT`                                            | encrypts them in the bucket, then writes the key-check object     |
| objects encrypted with a master key this server does not have | is refused: `REMOTE_BLOBS_FOREIGN_KEY`                                       | is refused in the same way                                        |
| a bucket that cannot be reached                            | is refused; the log names the S3 error | is refused in the same way                                        |

So a bucket that was filled with the switch off is converted with the command, with every server
stopped, and never by a start. The command can be interrupted and run again. When it has finished,
the state record names the bucket (`remoteBlobStore`), and later starts do not scan it again.
`IHUB_S3_ADOPT_BUCKET=true` does not get past `REMOTE_BLOBS_PLAINTEXT`: it is only for a bucket
whose objects are already encrypted with this key and whose key-check object is missing.

**Known limit:** the scan and the conversion of a bucket walk the blob namespaces iHub declares
(`project-files`, `chat-files`, `chat-evidence-content`, `run-evidence-content`, `artifacts`,
`website-corpora`). An object under another name in the prefix is not looked at.

Blob files that are still below `contents/data/blobs` while the blobs are in a bucket are not
encrypted by the command: the server does not use them any more. The command counts them, and the
state record keeps the number (`plaintextLeftovers`). Remove the folder when the copy in the bucket
is verified (see [Moving existing blobs](storage.md#moving-existing-blobs-storagecopy-blobs)).

| Option      | What it does                                               |
| ----------- | ---------------------------------------------------------- |
| `--dry-run` | Counts, checks key and free space, converts nothing.       |
| `--json`    | Prints the result as JSON.                                 |
| `--verbose` | Also prints the server's own log lines, to standard error. |

| Exit code | Meaning                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| 0         | Done. In a dry run: the preconditions are met.                                                        |
| 1         | A precondition does not hold (key, free space), unencrypted data is left, or the run was interrupted. |
| 2         | Unknown argument.                                                                                     |

### Interruptions

The conversion is safe to interrupt, in both ways. Each object is replaced in one step and is
recognised by its own format, so the next run skips what is done and continues. A start after a
crash continues by itself. After `Ctrl+C` in `storage:encrypt`, run the command again.

Objects that could not be read before the conversion (a damaged file) are left as they are, named
in the log and counted as "unreadable". They do not stop the conversion.

### Containers and Kubernetes

During the conversion the server does not answer health checks. A liveness probe may restart the
container before the conversion has finished. That does no damage, because the next start
continues, but it can repeat. Either give the container a start-up probe with enough time for the
estimate, or run the conversion first, in a job or a one-off container that mounts the same volume
and has the same key:

```bash
node server/storage/commands/run.js encrypt --dry-run
node server/storage/commands/run.js encrypt
```

In a cluster of worker processes the primary process converts before it starts the workers. A
worker never converts, and it takes the switch from the primary, not from `platform.json`. A worker
that ends right after it was started is replaced after a growing pause instead of at once, so a
worker that cannot start does not fill the log.

### When the start is refused

| The log says                                                                 | Cause                                                                                                           | What to do                                                                                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `The master encryption key is missing or unreadable` (`MASTER_KEY_REQUIRED`) | Encrypted data exists and no key was found. The server does not create a new key in this case.                  | Restore `contents/.encryption-key`, or set `TOKEN_ENCRYPTION_KEY` to the key the data was written with.                      |
| `exists but is not usable` (`MASTER_KEY_INVALID`) | `contents/.encryption-key` is there but does not hold a 64-character hex key (empty, cut short, other text). The file is never overwritten and no new key is generated, with or without encrypted data. | Put the key into the file (no quotes, no other text), restore it from a backup, or set `TOKEN_ENCRYPTION_KEY`. Remove the file only on an installation without encrypted data and without saved credentials. |
| `Another process is encrypting or checking the stored data` (`CONVERSION_IN_PROGRESS`) | Only from `storage:encrypt`: a start or another run of the command holds the conversion. | Wait until it has finished and run the command again. |
| `The encryption state record ... is missing, but the data directory holds encrypted data` (`ENCRYPTION_STATE_MISSING`) | `contents/data/.at-rest.json` is gone, encrypted data is there, and unencrypted objects were found beside it. They cannot be told from content that was put there afterwards. | Restore `.at-rest.json` from the backup the data came from. Only when you know where the unencrypted objects come from: set `IHUB_ENCRYPTION_ACCEPT_PLAINTEXT=true` for one start or one run of `storage:encrypt`; they are then encrypted as they are. Remove the variable afterwards. |
| `The bucket holds ... blobs that are not encrypted` (`REMOTE_BLOBS_PLAINTEXT`) | Blobs were uploaded to the bucket while the switch was off. | Stop every server that uses the bucket and run `npm run storage:encrypt`, then start. Or set the switch to `false`. |
| `encrypted with a master key this installation does not hold` (`REMOTE_BLOBS_FOREIGN_KEY`) | The bucket or prefix holds objects of another key. | Restore that key (`TOKEN_ENCRYPTION_KEY_PREVIOUS` after a key change), or give this installation a bucket or prefix of its own. |
| `does not match the stored blobs` (`KEY_UNAVAILABLE`)                        | The key is not the one the data was encrypted with. The message names both key ids.                             | Restore the right key. After a deliberate key change, set the old key as `TOKEN_ENCRYPTION_KEY_PREVIOUS`.                    |
| `could not be saved to contents/.encryption-key` (`KEY_UNAVAILABLE`)         | A new key was generated and `contents/` is not writable.                                                        | Make `contents/` writable, or set `TOKEN_ENCRYPTION_KEY`.                                                                    |
| `Not enough free space` (`ENCRYPTION_PRECONDITION`)                          | The volume cannot hold the conversion.                                                                          | Free the space the message names.                                                                                            |
| `still in plaintext after the conversion` (`ENCRYPTION_INCOMPLETE`)          | Some objects could not be converted.                                                                            | See the warnings before it in the log, correct the cause, start again.                                                       |
| `holds objects but no key check object` (`KEY_CHECK_MISSING`)                | The record says encrypted data exists, but `data/.at-rest-keycheck` is gone, or the data folder was swapped. | Restore the file from a backup. If you are sure key and data belong together, set `IHUB_S3_ADOPT_BUCKET=true` for one start. |
| `The encryption state record ... is not JSON` (`INVALID_AT_REST_STATE`)      | `contents/data/.at-rest.json` is damaged.                                                                       | Restore it from a backup.                                                                                                    |

In every case the process ends with exit code 1 and writes nothing unencrypted.

## What a read does with unencrypted data

| Switch | Conversion | New data is written | Unencrypted data is | Encrypted data is           |
| ------ | ---------- | ------------------- | ------------------- | --------------------------- |
| off    | any        | unencrypted         | read                | read, when the key is there |
| on     | running    | encrypted           | read                | read                        |
| on     | complete   | encrypted           | an error            | read                        |

After the conversion, unencrypted data in an encrypted installation is refused: `PLAINTEXT_DOCUMENT`
for a document, `PLAINTEXT_FILE` for an agent or short-link file, `CORRUPT_BLOB` for a blob. This is
on purpose. Otherwise anyone who can write to the disk or the bucket could plant a file that the
server serves as content.

Two consequences for operations:

- **Do not restore single unencrypted files into an encrypted installation.** A chat file or a
  memory file copied in from an old backup is refused. Restore a whole backup (data, state record
  and key together), or turn the switch off, restore, and turn it on again.
- **Do not rename or copy encrypted files by hand.** An encrypted file is bound to its store and
  its name. A renamed or copied file does not open.

Blobs in an S3 bucket are strict as well: with the switch on, an unencrypted object in the bucket
is never read by the server. A start refuses a bucket that holds such objects, and
`npm run storage:encrypt` converts them. See [Blobs in an S3 bucket](#blobs-in-an-s3-bucket).

## Turning it off

Set `storage.encryption.enabled` to `false`, stop the server and start it again. A replaced worker
process does not pick the change up; only a full restart does.

- New data is written unencrypted from then on.
- Nothing is converted back. Data that was encrypted stays encrypted and is decrypted when it is
  read.
- **The key is still required**, for as long as encrypted data exists. If the key is missing, the
  server refuses to start, also with the switch off.
- With blobs in S3 and the switch off, the server logs a warning at every start, and the System
  Resources page says that files are stored as they are.
- Turning it on again converts what was written unencrypted in the meantime.

There is no command that decrypts an installation.

## Reading stored data for support: `storage:show`

With the switch on, `cat contents/data/chats/<id>.json` shows ciphertext, and agent memory, inbox
and artifact files and `shortlinks.json` are no longer readable Markdown or JSON. To read one
object:

```bash
npm run storage:show -- --doc chats <chatId>
npm run storage:show -- --stream run:<runId>
npm run storage:show -- --blob run:<runId> <name>
npm run storage:show -- --file agent-memory <profileId>.md
```

| Form                      | Prints                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--doc <namespace> <key>` | One document with its metadata, as JSON.                                                                                                                                                    |
| `--stream <stream>`       | Every record of a run-ledger stream, one JSON object per line, in order.                                                                                                                    |
| `--blob <stream> <name>`  | One payload stored beside a run-ledger stream, as raw bytes. It does not read uploaded files or other blobs of the blob store.                                                              |
| `--file <store> <name>`   | One file of `agent-memory` (`<profileId>.md`), `agent-inboxes` (`<inboxId>.md`), `agent-artifacts` (`<runId>/<name>`), `tool-jobs` (`<jobId>.result`) or `short-links` (`shortlinks.json`). |

Exit code 0: printed. 1: not found, or it cannot be opened. 2: wrong arguments.

The command is for the administrator of the server, on its shell. It needs read access to the data
folder and the master key; whoever has both can read everything anyway. It never creates a key:
without one it reports that an encrypted object cannot be opened. It has no access check of
its own and is not an API. It only reads, works with the server running or stopped, and reads
encrypted and unencrypted objects alike. Each use writes one line to the server log (`STORAGE_SHOW`:
what was shown and by which operating-system user, never the content). In a container:
`node server/storage/commands/run.js show --doc chats <chatId>`.

Change agent memory and inboxes through the application (for inboxes: Admin → Agents → Inboxes).
Editing these files in an editor no longer works while the switch is on: an edited file is
unencrypted and is refused.

## Status

- **Start-up log.** One line per start says whether storage encryption is on and what it covers.
- **Admin → System Resources**, card "Blob storage", line "Encryption". See
  [Admin interface](admin-ui.md#blob-storage).
- **`GET /api/admin/storage`**, member `encryption`:

  ```json
  {
    "enabled": true,
    "scope": "storage",
    "conversion": {
      "state": "complete",
      "facets": { "blobs": 1, "documents": 1, "logs": 1, "files": 1 },
      "keyId": "1a2b3c4d",
      "skipped": 0,
      "completedAt": "2026-11-20T08:14:02.512Z"
    },
    "sealedDataExists": true
  }
  ```

  `scope` is `storage` (documents, logs and blobs), `blobs` or `none`. `sealedDataExists` is `true`
  when encryption was on at some time: the key is then still needed, also with `enabled: false`.

### The state record

`contents/data/.at-rest.json` records how far the conversion has come:

```json
{
  "format": 1,
  "state": "complete",
  "facets": { "blobs": 1, "documents": 1, "logs": 1, "files": 1, "remoteBlobs": 1 },
  "remoteBlobStore": "s3:s3.example.internal:7070/ihub/production/default/",
  "keyId": "1a2b3c4d",
  "startedAt": "2026-11-20T08:11:20.004Z",
  "completedAt": "2026-11-20T08:14:02.512Z",
  "converted": {
    "documents": 98211,
    "streams": 4410,
    "spillBlobs": 310,
    "blobs": 20112,
    "files": 42
  },
  "skipped": 0,
  "plaintextLeftovers": { "localBlobs": 0 }
}
```

- `state` is `converting`, `complete` or `off` (the switch was turned off again).
- `facets` lists what is fully encrypted: `blobs`, `documents`, `logs` and `files` (the agent and
  short-link files). A release that encrypts more adds a name; an installation whose record lacks
  it converts only that part at its next start.
- `keyId` is the id of the master key the data was encrypted with. It stays in the record when the
  switch is turned off.
- `remoteBlobs` in `facets` and `remoteBlobStore` exist only with blobs in a bucket. They say that
  this bucket (backend, endpoint host, bucket and prefix) holds only encrypted blobs. A start
  against another bucket looks into that bucket again.
- `plaintextLeftovers.localBlobs` exists only with blobs in a bucket: the number of unencrypted
  blob files that were left below `contents/data/blobs` because the server no longer uses them.
- `recreatedAt` is set when the record was missing and the server wrote it again after it had
  verified that everything stored is encrypted.

If the record is missing and encrypted data is there, the server does not go back to reading
unencrypted data. It verifies the stored data and writes the record again. Unencrypted objects
found in that situation stop the start (`ENCRYPTION_STATE_MISSING`, see
[When the start is refused](#when-the-start-is-refused)).

The record is not secret. Do not edit or delete it: it decides whether unencrypted data is still
read, and it tells the server that a key must not be replaced. Back it up and restore it with the
data. A record that cannot be read stops the start.

`contents/data/.at-rest-keycheck` is a small encrypted object that proves the key is the right
one. It is checked at every start with the switch on. It exists on local disk also when the blobs
are in S3. Back it up and restore it with the data. It is outside `contents/data/blobs` on purpose:
that folder may be removed after the blobs were copied to a bucket. A file at the earlier place,
`contents/data/blobs/_ihub/keycheck`, is moved to the new place at the next start.

## Cost

Measured on a development machine, one core:

| Operation                   | Added time    |
| --------------------------- | ------------- |
| Write a 20 KB document      | about 0.07 ms |
| Write a 1 MB document       | about 2.2 ms  |
| Write one run-ledger record | 9 to 63 µs    |

Disk use grows by about 33 % for documents and logs.

**Memory.** Encrypted blobs and files are stored in 1 MiB segments, each with its own
authentication tag, so they are decrypted and encrypted a segment at a time where the bytes only
pass through: the download of an artifact, of the original of an uploaded file, of an artifact
ZIP, of an agent artifact and of a tool-job result from another worker process, and the blobs in
`storage:encrypt` and `storage:copy-blobs`. Such a transfer holds a few MiB whatever the size of
the file. Content that is parsed or handed to a model (extracted text, evidence, project texts)
and every upload is still held in memory whole, about two to three times its size while it is
encrypted or decrypted. The list of paths is in
[Storage](storage.md#blobs-whole-or-as-a-stream).

**A damaged file and a download.** A streamed download sends a segment only after that segment
verified, and the first segment is verified before the response starts. A file that cannot be
opened at all is answered with an error status. A file that was changed or cut further in makes
the download break off: the connection is closed before the announced length is reached, which
browsers and HTTP clients report as a failed download. The server never ends such a response as
if the file were complete, and it logs `A stored blob could not be opened` with the code
`CORRUPT_BLOB`.

## Not built yet

- A job that re-encrypts old data after a key change. Until it exists, keep
  `TOKEN_ENCRYPTION_KEY_PREVIOUS` set after a key change and do not change the key a second time.
- Encryption of `feedback.jsonl`.
- Hiding share tokens in file names.
- A key provider that keeps the master key in a key service (OpenBao, Vault, a cloud KMS).
- A command that decrypts an installation.
- A conversion of bucket objects outside the declared blob namespaces, and a check that refuses
  `storage:encrypt` while a server is already running on the same volume.
