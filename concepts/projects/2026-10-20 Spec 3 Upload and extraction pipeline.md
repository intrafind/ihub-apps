# Spec 3: Upload and extraction pipeline (text-only storage in the iHub tier)

Resolves [#2905](https://github.com/intrafind/ihub-apps/issues/2905) · Part of
[#1036](https://github.com/intrafind/ihub-apps/issues/1036) · Phase 1 · 2026-10-20

How a file enters a local project. Today chat attachments are extracted in the browser, sent as
text in the JSON body (50 MB global body limit) and discarded after the turn; multer is used
only for admin assets, backups and the OCR tool. Project uploads need a server-side path, and
the same path serves picked documents and workflow write-back.

Decisions carried in: the iHub tier stores **extracted text only**, encrypted per object; the
original is discarded after extraction and never kept; limits 25 files, 20 MB per file, 200 MB
per project, 50 files hard ceiling, admin-configurable.

## 1. The pipeline

```
receive ──► scan hook ──► extract ──► encrypt ──► blobs.put('project-files') ──► item ready
   │                                                                    │
   └── temp file on local disk (multer diskStorage, size-limited)       └── temp file unlinked
```

One function, `ProjectIngestService.ingest(project, item, input, ctx)`, runs the four steps for
every way text enters a project:

| Entry | `input` | Who calls it |
| --- | --- | --- |
| Upload (`POST /items`, multipart) | `{ path: tempFile, contentType, name, bytes }` | the route, after multer |
| Pick (`POST /items`, JSON, cloud kinds) | `{ bytes: Buffer, contentType, name }` from the kind's `fetch` | `ProjectService.addItem` |
| Refresh (`POST /items/:id/refresh`) | same as pick | `ProjectService.refreshItem` |
| Write-back (`put`, spec 2) | `{ text, contentType: 'text/markdown', name }` | the local provider |
| Admin text item (`POST /items`, JSON `{ kind: 'upload', text, name }`) | `{ text }` | the admin editor (replaces the sources file editor) |
| Startup import of migrated and default admin items | `{ path }` under `contents/` or `server/defaults/` | `ProjectService.importPending()` (spec 1 §8.4) |

`item.status` moves `pending → extracting → ready | failed`. The item document is written at
each transition under the project lock, so a client polling `GET /items/:id` sees progress and
a crashed worker leaves a visible state (§8).

## 2. Receive: the multipart route

`POST /api/projects/:projectId/items` with `Content-Type: multipart/form-data`, field `file`
(exactly one; several files are several requests, so each has its own status and error),
optional fields `name` and `pinned`.

- multer `diskStorage` into `contents/data/tmp/project-uploads/<uuid>/` (a private directory
  per request, as the backup import does), `limits: { fileSize: limits.maxFileBytes, files: 1 }`.
  Nothing is buffered in memory on the receive path; `LIMIT_FILE_SIZE` maps to
  `413 QUOTA_FILE_BYTES` and `recordUpload('project', 'rejected_size')`.
- The quota check (spec 1 §9.4) runs in a `fileFilter` **before** the first byte is accepted:
  `QUOTA_FILES` and `QUOTA_PROJECT_BYTES` (using the declared `Content-Length` as the upper
  bound) answer `413` without writing the temp file. A second check with the real size runs
  after receive.
- Accepted types are the union of what extraction supports (§3.1); anything else is `415
  UNSUPPORTED_TYPE` from the `fileFilter`. The type is decided by the file's magic bytes where
  they exist (PDF, zip-based Office, images are refused) and by the declared type for text.
- The route answers `202 { item }` with `status: 'pending'` as soon as the file is on disk and
  the item document is written. Extraction continues in-process (§2.1). Link kinds (JSON body,
  `url`, `page`, iFinder) answer `201` with a `ready` item and never enter this pipeline.

### 2.1 Job execution

`ProjectIngestService` keeps a per-worker queue (concurrency 2, so two 500-page PDFs cannot
starve the event loop together; `pdfjs` and `mammoth` are CPU-bound) and runs the job on the
worker that received the file: the temp file is local, and a second instance could not read it.
The job holds no HTTP connection, so a client that closes the tab loses nothing. A job that
fails writes `status: 'failed'` with the error code and unlinks the temp file; the original is
gone in every outcome.

Multi-instance: nothing is shared on the receive side. The text blob goes to the `BlobStore`,
which needs a shared volume until the S3 adapter (#2906, spec 1 §8.3).

## 3. Extract

### 3.1 Formats

`server/services/projects/extractText.js` wraps `server/services/documentExtraction.js` and
the shared extractors in `shared/documentExtraction/`:

| Type | Extractor | Notes |
| --- | --- | --- |
| `application/pdf` | `extractPdfDocument` (pdfjs-dist, `[Page N]` markers) | `MAX_PDF_PAGES` 500; a PDF with no text layer → `NO_TEXT` (§3.2) |
| DOCX | `extractDocxDocument` (mammoth → markdown) | zip-bomb guard `assertSafePackage` |
| PPTX | `extractPptxDocument` with speaker notes | guard as above |
| XLSX | **new server adapter** over `shared/documentExtraction/xlsx.js` (the browser already has one; the server did not) | sheets rendered as markdown tables, cell limit from `sheets.js` |
| ODT, ODS, ODP | `extractOdfDocument` | guard as above |
| `text/*`, `application/json`, `application/xml`, `text/csv`, markdown, source code types from `mimetypes.json` | UTF-8 decode (BOM stripped; a byte sequence that is not valid UTF-8 → `UNSUPPORTED_TYPE`) | |
| `text/html` | `html-to-text` as `URLHandler` uses | scripts and styles dropped |
| EML, MSG | the chat upload's parsers (`shared/documentExtraction/markers.js` path) | attachments are not followed |
| images, audio, video, archives, executables | refused at receive (`UNSUPPORTED_TYPE`) | OCR is §3.2 |

Output is one UTF-8 string, normalized (`\r\n` → `\n`, NUL stripped), capped at
`MAX_TEXT_CHARS` 2 000 000 (about 500 000 tokens; a 20 MB PDF of pure text can exceed what a
project should hold) with `text.truncated: true` on the item and a warning in the UI. Headings
are preserved as markdown where the extractor produces them, because the BM25 provider splits on
headings.

### 3.2 OCR decision

**None in v1.** A PDF whose extraction yields fewer than 50 non-whitespace characters over more
than one page is `failed` with `error.code: 'NO_TEXT'` and the message "This PDF has no text
layer (scanned). Run it through OCR and upload the result." The two later options are recorded,
not built: the existing LLM-based OCR tool service (`server/routes/toolsService/ocrRoutes.js`,
a job per file, would plug in as an `extract` fallback behind `projects.ocr: 'tools-service'`),
and iFinder's converter when the installation has one (phase 2, together with the push indexer).

## 4. Pick path

`POST /items` with `{ kind, ref, name?, pinned? }` for a text kind (`office365`, `google-drive`,
`nextcloud`):

1. `kind.refSchema.parse(ref)`; quota check on `ref.size` when the picker supplied it.
2. The item is written `pending`, with `provenance { origin: 'picked', by: caller, at, source:
   { site, url, lastModified } }`.
3. `kind.fetch(item, { user: caller, purpose: 'pick' })` downloads through the integration
   service with the **caller's** stored OAuth token (`OAuthIntegrationBase.getUserTokens`,
   refreshed automatically; `OAuthRefreshError` → `SOURCE_FORBIDDEN` with "connect <provider>
   first"). The bytes go through the same scan → extract → encrypt steps as an upload, with
   `snapshotAt = extractedAt`.
4. A `404`/`410` from the source is `SOURCE_GONE`, a `401`/`403` is `SOURCE_FORBIDDEN`; the
   item is `failed` and can be removed or retried.

Refresh runs the same steps with `purpose: 'refresh'`, keeps the old blob readable until the
new one is stored, then deletes the old blob (new version id in the key, spec 1 §8.1). When the
source's `lastModified` is older than or equal to `snapshotAt` the refresh is a no-op that
clears `stale`.

Link kinds (`url`, `page`, `ifinder-document`, `ifinder-query`) skip this pipeline: `POST
/items` validates the ref, runs the kind's `test` when it has one (a `HEAD` for URLs, a page
exists check, an iFinder metadata call with the caller's JWT) and writes a `ready` item.

## 5. Encrypt and store

The extracted text is encrypted with a fresh per-object data key and stored as one blob:

- `dataKey = randomBytes(32)`; `ciphertext = encryptStream(text, dataKey, associatedData)` in
  the format of §6; `wrapped = keyProvider.wrap(dataKey, aad)`.
- `blobKey = <projectId>__<itemId>__<versionId>` with `versionId` a ULID (time-ordered, so a
  prefix listing of `<projectId>__<itemId>__` shows versions in order; the newest is the one
  the item names). `blobs.put('project-files', blobKey, ciphertext)`.
- The item document is written **after** the blob (artifact pattern): `text: { blobKey, bytes,
  chars, tokens, sha256 (plaintext), format, segmentBytes, key: { provider, keyId, wrapped },
  extractedAt, original: { contentType, bytes, pages } }`, `status: 'ready'`. A failed document
  write deletes the blob it just stored.
- `associatedData = 'ihub/project-files/' + tenant + '/' + projectId + '/' + itemId + '/' +
  versionId` with `tenant = 'default'` until the SaaS plan's phase 1 adds a tenant id to the
  request context. The AAD binds the ciphertext to its object: a blob copied under another key
  does not decrypt. Never a path.
- Decrypt: `unwrap` the data key (cached in memory with a 10-minute TTL per `blobKey`, so a
  project read on every turn does not hit the provider every time), `decryptStream`, verify
  `sha256`.

`contents/sources/*.md` written by the migration are **not** encrypted in place; they are
imported (read, extracted as text, encrypted into `project-files`) and left where they are
(spec 1 §10.3).

## 6. KeyProvider and the ciphertext format

### 6.1 `KeyProvider`

```js
// server/services/projects/crypto/KeyProvider.js
export class KeyProvider {
  id;                                        // 'local-file' | 'transit' (phase 3) | 'hsm' (later)
  async currentKeyId()                       // the master key a new wrap uses
  async wrap(dataKey, aad)                   // → { keyId, wrapped: Buffer }
  async unwrap(wrapped, keyId, aad)          // → dataKey; throws KeyAccessDenied (audited)
  async rotate()                             // phase 3: new master key; rewrap job re-wraps every item
}
```

`LocalFileKeyProvider` (phase 1, default, `projects.encryption.keyProvider: 'local-file'`):
the master key is the 32-byte key `TokenStorageService` already holds (`TOKEN_ENCRYPTION_KEY`
or `contents/.encryption-key`), so an installation gets envelope encryption with no new
secret and the existing rotation documentation (`docs/encryption-key-management.md`) still
describes the master key. `wrap` = AES-256-GCM of the data key with a random 12-byte IV and the
AAD, serialized as `v1 || iv || tag || ciphertext` (base64 in the item); `keyId` = the key
fingerprint `TokenStorageService.getKeyFingerprint()`; `unwrap` with a `keyId` that is not the
current fingerprint tries the previous key when `TOKEN_ENCRYPTION_KEY_PREVIOUS` is set
(rotation by rewrap is phase 3; this is the minimum that keeps data readable across a key
change). #2316 (chat message encryption) and any later blob encryption must go through this
interface, so the product has one key hierarchy.

`TransitKeyProvider` (OpenBao, Vault, cloud KMS through a Transit-style API) is the phase 3
implementation of #2906; its configuration block is reserved under `projects.encryption.transit`.

### 6.2 Ciphertext format v1 (`tink-aes-gcm-hkdf-v1`)

The Tink `AesGcmHkdfStreaming` format, implemented on `node:crypto` in
`server/services/projects/crypto/streamingAead.js`, so the Java side can read iHub objects with
Tink unchanged once the products share a store (not before phase 2; #2906 owns the conformance
vectors and SP-1):

```
header   = headerLength (1 byte, = 40) || salt (32 bytes, random) || noncePrefix (7 bytes, random)
derived  = HKDF-SHA256(ikm = dataKey, salt = salt, info = associatedData, length = 32)
segments = ciphertextSegmentSize 1 048 576 bytes;
           first plaintext segment = segmentSize − headerLength − 16,
           every other = segmentSize − 16, the last may be shorter
nonce_i  = noncePrefix || i (4 bytes big-endian, from 0) || lastSegmentFlag (1 byte, 0x01 on the last)
segment_i = AES-256-GCM(derived, nonce_i, plaintext_i, aad = empty) || tag (16 bytes)
blob     = header || segment_0 || segment_1 || …
```

The associated data enters through the HKDF `info`, as Tink does, and each GCM segment uses an
empty AAD. Decryption fails on a wrong segment order, a truncated stream (the last-segment
flag), or a wrong AAD (derived key mismatch). Tests cover the empty text, a text exactly one
segment long, one byte over, and three segments, and keep the vectors in
`server/tests/fixtures/streaming-aead/` for SP-1.

The key spec of #2906 may still change the salt length or the header for the shared repository;
the item records `format`, so a later format reads old blobs and new writes use the new one.

## 7. Malware scan hook

```js
// server/services/projects/scan/MalwareScanner.js
export class MalwareScanner {
  id;                          // 'none' | 'command' | 'icap' (later)
  async scan({ path, contentType, name, bytes }) // → { verdict: 'clean' | 'infected' | 'error', detail }
}
```

Phase 1 ships `none` (always clean) and `command` (`projects.scan: { provider: 'command',
command: 'clamdscan --no-summary --fdpass {path}', timeoutMs: 30000 }`, exit code 0 clean, 1
infected, anything else `error`). The hook runs on the temp file before extraction, in a child
process, never on the event loop. `infected` is `failed` with `SCAN_REJECTED`, audited as a
failure event with the scanner's detail; `error` follows `projects.scan.onError: 'reject' |
'allow'` (default `reject`). An ICAP client (the integration most enterprise scanners offer)
is a later provider behind the same interface.

## 8. Consistency and the reconciler

The storage concept's `PENDING → ACTIVE` rule, applied to items:

- An item is `pending` or `extracting` while its job runs. `ProjectIngestService.reconcile()`
  runs at startup and every 15 minutes on the scheduler lock owner: items in `pending` or
  `extracting` for longer than `projects.ingest.staleAfterMinutes` (default 30) become `failed`
  with `INTERRUPTED` ("the server restarted during extraction, upload the file again"); their
  temp directories are removed.
- Orphan blobs (a blob whose `project-files` key no item names, left by a crash between
  `blobs.put` and the document write, or by a delete cascade that was interrupted) are listed
  by prefix per project during the same sweep and deleted when older than one hour.
- Temp directories under `contents/data/tmp/project-uploads/` older than one hour are removed
  at startup.

## 9. Errors and status in the UI

| Code | HTTP | Where | What the UI shows |
| --- | --- | --- | --- |
| `QUOTA_FILES`, `QUOTA_PROJECT_BYTES`, `QUOTA_FILE_BYTES`, `QUOTA_PROJECTS` | 413 / 409 | receive, pick, write-back | the limit and the current usage beside the dialog's quota bar |
| `UNSUPPORTED_TYPE` | 415 | receive | the accepted types |
| `KIND_DISABLED`, `KIND_UNKNOWN`, `INVALID_REF` | 400 | pick | the kind's tab is hidden or the ref error |
| `SOURCE_FORBIDDEN` | 403 | pick, refresh | "connect <integration>" or "you have no access to this document" |
| `SOURCE_GONE` | 404 | refresh | item marked stale, "the source document was removed" |
| `NO_TEXT` | item `failed` | extract | "no text layer; OCR and upload again" |
| `EXTRACTION_FAILED` | item `failed` | extract | the extractor's message |
| `SCAN_REJECTED` | item `failed` | scan | "rejected by the malware scanner" |
| `INTERRUPTED` | item `failed` | reconciler | "upload the file again" |
| `STORAGE_UNAVAILABLE` | 503 | any | "projects are not available on this installation" |

Per-item status display: `pending` grey dot "waiting", `extracting` spinner "extracting text",
`ready` the size in tokens and the snapshot date for picked items, `failed` red with the
message and a retry (re-add) action, `stale` amber with "newer version at the source" and a
refresh action.

## 10. Telemetry

`recordUpload('project', outcome, bytes)` with outcomes `accepted`, `rejected_size`,
`rejected_type`, `rejected_quota`, `rejected_scan`, `failed`, `ready`; histogram
`ihub_project_extract_seconds{type}` and gauge `ihub_project_bytes{ownership}` beside the
existing source metrics.

## 11. Decisions a reviewer may want to challenge

1. **One file per request** instead of a multi-file multipart: each file gets its own status,
   error and audit event, and the browser can show per-file progress; the add-items dialog
   sends files in parallel (at most 3).
2. **Extraction in the web worker process**, not a job service: the OCR tool service shows the
   job-store pattern, but a separate process would need the temp file or the bytes handed over,
   and at 20 MB and 2 concurrent jobs the worker copes. Revisit with the S3 adapter, when the
   bytes can be staged in the object store.
3. **The master key is the existing `.encryption-key`.** A fresh key file would be a second
   secret to back up and a second rotation story. Envelope encryption gives the per-object
   property the concept asks for either way.
4. **2 000 000-character text cap** per item. Without it a single text-heavy PDF could put half
   a million tokens into one project; BM25 copes, load-all never would.
5. **No OCR, with a clear error**, rather than a silent empty item.
