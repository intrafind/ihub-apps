# Features — Unreleased

## Storage Encryption for Chats, Files and Run History

iHub can now encrypt what it stores before it writes it. One switch in
`contents/config/platform.json`, `storage.encryption.enabled`, covers chats and transcripts, the
run history, uploaded files and their extracted text, artifacts, evidence content, agent memory,
agent inboxes, agent artifacts, tool-job results and short links.

- **Existing installations: off.** Nothing changes after the upgrade until an administrator turns
  the switch on. **New installations: on.**
- Turning it on converts the stored data once, at the next start, before the server accepts
  requests. Run `npm run storage:encrypt -- --dry-run` first: it counts the data, checks the free
  disk space and estimates the duration. For large installations and network volumes, run
  `npm run storage:encrypt` with the server stopped, then start. Stop every server that uses the
  volume first: a second run of the command is refused, a server that starts meanwhile waits, but
  a server that is already running is not detected.
- **The encryption key now protects the content.** If `contents/.encryption-key` (or
  `TOKEN_ENCRYPTION_KEY`) is lost, the encrypted chats and files are lost. The server refuses to
  start without the key instead of creating a new one. A key file that exists but holds no usable
  key (empty, cut short) also stops the start and is never replaced. Back the key up apart from
  the data.
- If `platform.json` is missing on a `contents/` folder that already holds data, it is created
  with the switch off, so existing data is never converted without a decision.
- **There is no way back to an older release** once data is encrypted, except from a backup taken
  before. A release before this one cannot read encrypted data: it treats an encrypted chat, file
  or log as damaged. Turning the switch off stops encrypting new data and decrypts nothing.
  This also holds for a new installation, where the switch is on from the first start.
- With the key file in `contents/` (the default), a copy of that folder still reads everything.
  Keep the key apart, for example in `TOKEN_ENCRYPTION_KEY` from a secret store.
- Not encrypted: file names, user ids, sizes and times, `feedback.jsonl`, temporary upload files,
  iFinder downloads, LLM debug dumps and `contents/.backups`.
- Encrypted files on disk are no longer readable with `cat`. `npm run storage:show` prints one
  stored chat, run or agent file on the server shell.
- After a key change, keep `TOKEN_ENCRYPTION_KEY_PREVIOUS` set and do not change the key a second
  time. Old data is not re-encrypted yet.

Details: `docs/storage-encryption.md` and `docs/encryption-key-management.md`.

## Uploaded Files in an S3-Compatible Bucket

Uploaded files, extracted text, artifacts, evidence content and crawled website pages (the "blobs")
can now be kept in an S3-compatible bucket instead of the local disk.

```json
"storage": {
  "blobs": {
    "provider": "s3",
    "s3": {
      "endpoint": "https://s3.example.internal:7070",
      "bucket": "ihub",
      "accessKeyId": "${IHUB_S3_ACCESS_KEY_ID}",
      "secretAccessKey": "${IHUB_S3_SECRET_ACCESS_KEY}"
    }
  }
}
```

- Chats, logs and the configuration stay in `contents/`. The server still needs its volume, and S3
  does not make iHub multi-instance.
- With storage encryption on, every object is encrypted by iHub before upload. With it off, files
  are uploaded as they are and the server warns at every start. When the switch is turned on for a
  bucket that already holds unencrypted files, the server does not start
  (`REMOTE_BLOBS_PLAINTEXT`) until `npm run storage:encrypt` has encrypted them in the bucket,
  with every server stopped.
- The bucket must exist. If the bucket cannot be reached, the credentials are wrong or the
  encryption key does not match the bucket, the server does not start. It never falls back to the
  local disk.
- `npm run storage:check` tests the configuration without the server and names the failing step.
  It creates no encryption key; on a new installation, start the server once before the check.
- Files uploaded before the switch stay on local disk and cannot be opened until
  `npm run storage:copy-blobs` has copied them, with the server stopped. The command deletes
  nothing.
- **Admin → System Resources** has a new read-only card "Blob storage" with the status, the
  encryption and a "Check again" button. `GET /api/health` reports `storage.blobs` (provider and
  the status of the last check).
- The admin backup export does not contain the bucket. Back up the bucket separately; the backup
  page says so.
- iHub does not check the bucket's versioning, object lock or lifecycle rules, and does not warn
  about them. With versioning or object lock on, deleted files stay in the bucket. Check these
  settings yourself (`docs/storage.md`, "Versioning and object lock").
- The settings need a restart. There is no admin form yet.
- Tested against the S3 server that ships with iHub for development (`npm run s3:dev`). AWS S3 and
  other S3 products have not been tested yet; try your service with `npm run storage:check` and a
  trial installation first.

Details: `docs/storage.md`, section "Blob storage backends".
