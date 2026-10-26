# iFinder tier: upload into smart collections (phase 2 of #1036)

Status: design proposal, nothing implemented. Replaces the "push indexer" wording of decision 7 in #1036
and the scope of spec 5 (#2907). Read it with spec 4 (#2906), spec 5 (#2907) and spec 6 (#2908).

The iFinder findings below come from reading `intrafind/ifinder` at `main` (6.9.0-SNAPSHOT, commit
`1f20761`). Section 12 lists what was read and what stayed inferred.

## 1. Goal and scope

An iHub project can be backed by an iFinder **smart collection**. A user creates the collection from
iHub, uploads files into it, and chats against it. The uploaded file is a first-class iFinder document:
stored encrypted, extracted and indexed asynchronously, visible only to its uploader, and previewable
and downloadable through the access service.

In scope for this phase:

- Create, list, rename and delete smart collections from iHub.
- Upload files into a collection and show their processing status.
- Add existing iFinder documents (the `ifinder-document` kind) to a collection.
- Encryption of every uploaded file with its own data key.

Out of scope, decided on 2026-10-26:

- **Sharing.** Collections stay private to their owner. Uploaded documents carry ACLs that name one user.
  Viewers stay unenforced in iFinder (TCC-1832) and iHub never sets them.
- **Other item kinds** in an iFinder-tier project: no url, page, picked cloud files or written text. Only
  uploads and iFinder documents.
- Promotion between tiers, and the S3 adapter on the iHub side (see option A in section 4).

## 2. What the iFinder code gives us, and what it does not

| Area | Today | Consequence |
|---|---|---|
| Original content | The document processor reads `accessInfo.source`, `accessInfo.download.itemType`, `accessInfo.download.itemId` from the document and calls the access service, which picks a `DownloadHandler` per source (`intrafind.access.sources.<src>.download.reference`). | A storage-backed document needs a handler plus those fields. Processor, OCR, preview, thumbnails and download then work unchanged. No new indexer is needed for extraction. |
| Async trigger | No queue. Cron jobs poll for `processing.contentExtraction.status = pending` (every minute when configured). `contentExtractionJob` is not enabled by default. Statuses: `pending`, `success`, `none_found`, `failed`, `skipped`, with an error field. | The "mark for async indexing" step is a field, and a status read exists only as `GET /docs/{id}` or a search. |
| Public Indexing API | `fa_index_write` writes any field of any document id: ACL, `sourceName`, `accessInfo.*`, `processing.*`, `processing.callback.url`. Delete and overwrite work on any id. POST ids are random UUIDs, PUT with a chosen id is the idempotent route. | Not usable with end-user tokens (section 5). |
| Config-store `/encrypt` | Stock Spring Cloud endpoint, unauthenticated, `/decrypt` denied. Text encryptor (inferred: AES-CBC, random IV, no tag), no associated data, no key id, no rotation. Other services decrypt locally with the shared `encrypt.key`. | Not a key-wrap API (section 6). |
| Smart collections | One OpenSearch document per collection, up to 200 document ids. Adding an id checks nothing (no existence, no ACL). Only the webapp public API enforces the owner. The utilities service trusts its caller. Viewers are dead data. Writes have no version check. | Usable for v1 if the utilities service is hardened (section 8). |
| Refresh | `refresh: false` by default, index `refresh_interval` 10 s. | A new document is searchable after about 10 s plus the next cron tick. |
| Delete | `IndexService.delete` only deletes in OpenSearch. The access service has no evict endpoint. Its `pdf` and `thumbnail` caches keep decrypted content for 10 h. | Needs an explicit deletion path (section 9). |
| Storage library | None. No S3 SDK, no Tink streaming use (Tink 1.15 pinned), no shared blob code. `aws-java-nio-spi-for-s3` is a runtime dependency of the standard download handlers. | The Java side starts from zero. |

## 3. Decisions

Decisions the product owner has taken, and the proposals this document adds:

| # | Decision | Status |
|---|---|---|
| D1 | Uploaded files go to a storage provider, then a document is created and indexed asynchronously by the document processor. | Taken |
| D2 | Each file is encrypted with its own data key. The wrapped key is stored next to the blob (sidecar object), not only in the index. | Taken |
| D3 | The storage handler in the access service and the extraction in the document processor decrypt. iHub does not decrypt iFinder documents: it reads `document.content`. | Taken |
| D4 | iFinder-tier projects take iFinder documents only. | Taken |
| D5 | Collections are private. No sharing in this phase. | Taken |
| D6 | iHub creates collections, and `GET /api/projects` also lists the user's collections. | Taken |
| D7 | Upload path: iFinder owns storage, wrapping, ACL and status behind one upload endpoint (option A). | **Proposed**, to confirm |
| D8 | The data key is wrapped inside iFinder, with a key version stored, not through the open `/encrypt` endpoint. | **Proposed**, to confirm |

D7 supersedes decision 7 of #1036 ("a push indexer with its own API"): the processor and the existing
`accessInfo` mechanism do the indexing, and the new endpoint only creates the document safely. D8
revises decision 12 for the iFinder tier: its keys are wrapped by iFinder, not by iHub's `KeyProvider`.

## 4. Upload path: two options

```
Option A (recommended)                         Option B
iHub ──file over TLS──▶ webapp upload endpoint   iHub ─ encrypt, wrap ─▶ storage
                         │ encrypt, wrap key                    │
                         ▼                                      ▼
                       storage (+ sidecar key)            create-document call
                         │ create document, add to collection   (needs a safe endpoint anyway)
                         ▼
                      doc processor ─▶ access service handler ─▶ decrypt ─▶ converter
```

**Option A: an upload endpoint in the iFinder webapp (public API).** iHub sends the file with the user's
JWT. The webapp generates the data key, encrypts with Tink streaming, wraps the key, writes blob and
sidecar, creates the document with server-forced fields, adds it to the collection, and returns a
document id and a status URL.

- iHub needs one HTTP client. No S3 adapter, no storage credentials, no wrapping key, and no write
  access to the bucket.
- The endpoint is the one place that enforces the ACL, the owner, the source and the quota.
- Cost: plaintext travels from iHub to iFinder over TLS, and the request streams through iHub. With the
  20 MB default file limit this is acceptable.

**Option B: iHub writes the storage itself.** iHub encrypts with `streamingAead.js`, wraps the key
through a remote wrap call, writes blob and sidecar, then asks iFinder to create the document.

- Needs the S3 adapter for the iHub `BlobStore` (#2318), write-only credentials on the iFinder bucket,
  a `ConfigStoreKeyProvider`, the SSL whitelist on the S3 client (`getTlsBypassOptions`) and a
  create-document endpoint that is just as restricted as in option A.
- Choose it only if plaintext must not leave iHub.

The rest of this document describes option A. Option B differs in sections 4 to 6 only.

## 5. The upload endpoint

A new endpoint, separate from the Indexing API, for example
`POST /public-api/smart-collections/api/v1/smart-collections/{id}/uploads`.

**Authorization.** A dedicated authority (for example `fa_upload`) plus the existing smart collection
authority. `fa_index_write` is never given to end users.

**Server-forced values, never taken from the request:**

- `aclAllows` = the caller's principal. `aclDenies` empty. Never the public marker.
- `sourceName` = a fixed value for uploads, so search profiles can include or exclude them.
- `accessInfo.source`, `accessInfo.download.itemType`, `accessInfo.download.itemId` = the storage
  location the endpoint wrote.
- `uploaded = true`, the owner, the collection id, the original file name, size and media type.
- `processing.contentExtraction.status = pending`. No `processing.*` or `processing.callback.url` from
  the client. This closes the callback-URL request path and the SSRF path of the HTTP download handler.

**Client-supplied:** the file, a display name, an optional title, and an idempotency key.

**Idempotency contract.** The key is stored under tenant, principal and collection, never by its raw
value, so one user's key can never return another user's document id. The server claims the key
atomically before it reserves anything and records a digest of the content. A retry with the same key
and the same digest returns the original document id and writes no second blob. The same key with a
different digest is rejected (`409`). A claim that was never completed expires, and a retry after the
expiry starts over.

**Rate limits.** Per principal and per tenant, enforced before the storage reservation: requests per
minute, concurrent streams and bytes per hour. An exceeded limit returns `429` with `Retry-After`. They
are separate from the storage quota, which only limits retained bytes.

**Order of operations**, so a failure never leaves a visible half state:

1. Check rate limit, quota, size and type, and claim the idempotency key. Persist an **upload intent**
   (document id, object key with a version id so re-uploads never overwrite, collection id, owner,
   state `reserved`). The intent is the recovery record for every later step.
2. Encrypt and write the blob to a `pending/` prefix, then the sidecar. State `stored`.
3. Create the document with status `pending`, scan status `pending`. State `indexed`.
4. Add the id to the collection (no existence check, so this works before indexing). State `complete`.
   A failure here keeps the state `indexed` and is retried from the intent record with backoff.
5. Return `202` with the document id and status URL. The status resource reports `queued` only once the
   state is `complete`, and `failed` (reason `collection`) if the retries are exhausted.

A reconciler works through the intents: it deletes `pending/` objects and sidecars of intents that
never got past `reserved` or `stored` after a day, retries step 4 for `indexed` intents, and after the
retry limit deletes the document, blob and sidecar together (compensation) and marks the intent
`failed`. It also removes documents whose blob is gone. A document without a collection membership
therefore never survives unnoticed.

## 6. Encryption

- **Format:** `tink-aes-gcm-hkdf-v1`, Tink `AesGcmHkdfStreaming`, 1 MiB segments, as spec 4 fixes it.
  iHub already ships a Node implementation in `server/services/projects/crypto/streamingAead.js`. The
  Java side uses Tink 1.15, which the repo pins, and which contains the streaming primitive.
- **Associated data:** tenant, object key, version id. Both sides derive it from fields stored on the
  document, never from a path.
- **Data key:** random 256-bit, one per object.
- **Wrap:** the config-store key, through an iFinder-internal component with these properties the stock
  `/encrypt` endpoint lacks: authenticated callers, associated-data binding, a stored key id, and an
  integrity tag. The wrapped key, key id, format id and associated-data inputs go into the **sidecar
  object**. A copy in the index is allowed for speed, never the only copy.
- **The sidecar is also the manifest.** A reindex rebuilds the index from sources, and here the blob
  and sidecar are the source, so the sidecar carries every field a rebuild needs: the owner and the ACL
  principal, the collection id, the original file name, size and media type, `sourceName`, the upload
  time, the scan result and the last known processing state. The ACL and the collection id are written
  once at step 3 of the upload and never change (collections are private and not transferable). A
  rebuild reads the manifest, re-creates the document with those fields and status `pending`, and the
  processor extracts again. Anything the manifest does not hold (for example ranking signals) is not
  promised by a rebuild.
- **Unwrap:** document processor and access service, through the same component. Today they can only
  decrypt `{cipher}` strings with a local copy of `encrypt.key`. A cached unwrapped key lives for a
  short TTL.
- **Do not put the wrapped key in `itemId`.** Item ids travel in tickets, URLs and debug logs.
- **Master key custody:** back up the iFinder master key together with the storage, or the sidecars
  are useless. Rotation is a rewrap job over the sidecars, keyed by the stored key id.
- **Test vectors:** shared by both products (empty file, exact segment boundary, one byte over).
  SP-1 of #2906 becomes blocking, because Java reads what Node wrote only in option B, but Java writes
  and Java reads in option A and the vectors still guard format drift.

If the stock `/encrypt` is used anyway (option B, short term): send the key as base64, store your own
key version and an HMAC over wrapped key and object id, and restrict the endpoint by network policy.
The wrap output has no integrity tag and no associated data.

## 7. Access service handler and document processor

- A `DownloadHandler` plugin (own factory, registered in `AutoConfiguration.imports`) reads the blob
  and the sidecar, unwraps the key and returns a decrypting `StreamedFile`. It is configured as
  `intrafind.access.sources.<uploads>.download.reference`.
- The handler must close the underlying object on all paths, and its stream must allow the head read
  that media-type detection performs.
- Preview buffers the whole PDF in memory. `size-limit.pdf-conversion` bounds it. Keep the upload limit
  at or below it.
- The **PDF and thumbnail caches** hold decrypted content for ten hours, per instance, with no ACL
  check. Either skip the cache for encrypted sources or add an evict on delete (section 9).
- **Malware scan is a gate.** Every upload carries a scan status (`pending`, `passed`, `failed`,
  `error`). A scan step in the processor runs first. `contentExtractionJob` is enabled with the query
  `processing.contentExtraction.status.keyword:pending AND processing.scan.status.keyword:passed`, with
  `prerequisites` so the embedding job waits for the text. OCR, conversion, preview, thumbnails and
  download do not run before `passed`: the storage handler refuses to open a source whose scan status
  is not `passed`. A `failed` scan quarantines the document (blob and sidecar stay for audit, no
  access) and sets the status resource to `failed` with reason `scan`. An `error` is retried, then
  treated as `failed`.
- A **missing blob** throws and today leaves the document `pending`, so it is retried every run. The
  processor must mark it `failed` with a reason after a bounded number of tries.
- **Lost update:** the processor rewrites the whole document and does not send `primary_term` and
  `seq_no`. A delete or edit during processing can be undone or the document can reappear. The
  write needs optimistic concurrency, and a deleted document must not be re-created.
- `failed` is final until an operator acts. Add a retry that a user can start (reprocess).

## 8. Smart collections

- iHub creates a collection with the public API (`fi_smartcollections`). The owner is the JWT identity.
  The identity string iHub signs must equal the ACL principal and the collection owner. Utilities
  compares case-sensitively (`owner.keyword`), the webapp and ragtime case-insensitively. Fix one rule
  (lowercase) in all three places.
- **Hardening the utilities service** before it holds user uploads: enforce the owner on every read,
  update and delete (today it trusts any caller), add `if_seq_no` to writes (concurrent adds lose
  updates), and return a 4xx for the document cap (an unhandled `IllegalArgumentException` today).
  `moveDocumentsBetweenCollections` has no owner check and drops its `failed` list.
- **Membership** stays an id list in v1: add-document needs no existence check, so an upload can be
  added before it is indexed, and retrieval trims by ACL. The 200 cap holds against the iHub ceiling of
  50 files per project. The `document_ids` limit of 100 is only an OpenAPI limit.
- A **collection-id field on documents** replaces the list later, if the cap matters. It needs a
  partial-update path from utilities to the index, protection against crawler overwrites, and a
  migration. Not part of this phase.
- **Deleting a collection** deletes its uploaded documents (blob, sidecar, index document, access
  service caches). Documents the user only added by reference stay.
- A deleted collection makes ragtime treat the scope as empty and tell the model so. iHub shows the
  chat a clear "collection deleted" state instead of an answer without knowledge.

## 9. Status, refresh lag and deletion

**Status model** (an owner-only read on the upload endpoint, mapped from `processing.*`):

| State | Meaning |
|---|---|
| `uploading` | blob being written (iHub-side only) |
| `scanning` | malware scan pending or running |
| `queued` | scan passed, extraction `pending`, not yet picked up |
| `processing` | extraction, OCR or embedding running |
| `searchable` | text extracted, passages and embeddings present, visible to retrieval |
| `failed` | with a reason: unsupported type, empty text, too large, scan, blob missing |

- iHub keeps its own item record with the document id, the state and the time it asked, so a new
  upload shows up immediately even though search sees it only after about 10 s plus the cron tick.
  `GET /docs/{id}` is real time (unverified), search is not.
- iHub polls the status resource with backoff. In a cluster only the scheduler-lock owner polls
  and writes the state back. A stuck `queued` or `processing` item turns `stale` after a timeout and
  offers retry.
- A chat that starts while items are not yet `searchable` says how many documents are still
  processing, through the `knowledge/scope` event.

**Deletion** is a resumable operation with a persisted state, not a sequence that can stop halfway:

1. Write a **tombstone** for the document id (state `deleting`). From this point the status resource
   answers `404`, the access service refuses preview and download, and the processor must not write
   the document: its write checks the tombstone, and uses `primary_term`/`seq_no` (section 7).
2. Evict the access-service caches. The access service needs an evict endpoint that finds keys by
   source and item id (the cache key also holds `lastModified` and the sub-item path) and reaches
   **every instance**. Retry until every instance has acknowledged.
3. Remove the collection membership, then the index document (passages and embeddings with it).
4. Remove the blob, then the sidecar (the key is shredded here).
5. Mark the tombstone `deleted` and keep it for a retention period, so a late processor write is still
   refused.

Each step is idempotent, and the reconciler resumes a tombstone that is stuck in `deleting`. The
operation reports success to the caller only when step 5 is done; before that it reports `202` and the
status resource shows `deleting`. Deleting a collection runs this for each of its uploads.

## 10. iHub side

- `tierPolicy` accepts `both` and `ifinder` for real. Today every value acts as `ihub`
  (`projectSettings.js`, `docs/projects.md`). The tier is read from a capability call to iFinder
  (version, upload authority, handler configured), so an older iFinder never shows the tier.
- New services next to `iFinderService`: a collections client, an upload client and a status poller.
  Calls use the per-user RS256 JWT (`server/utils/iFinderJwt.js`) with `fi_smartcollections`,
  `fi_iassistant` and the upload authority. All outbound calls use `httpFetch()`, so the SSL whitelist and the proxy config apply, with a
  whitelisted and a non-whitelisted host test (CLAUDE.md).
- **Kind registry** gets a `tiers` property. An iFinder project offers `upload` and `ifinder-document`
  only. "Edit text" and the cloud kinds are hidden. The project page shows the tier and the fact that
  the original is kept (and downloadable by the owner).
- **Project list:** `GET /api/projects` merges the local list with the user's collections, with a short
  timeout and a cache. The cache key contains the tenant and the principal, an entry is never shared
  between users, and the response is built for the requesting principal on every call, including cache
  hits (no collection id or name from another user's entry). If iFinder is slow or down, the local list
  still returns, with a warning. Collections created
  elsewhere appear as projects. Instructions, pins and chats have no place in a smart collection, so
  iHub keeps a reference record keyed by the collection id (created on first open).
- **Knowledge provider** for the tier: search through the retrieval scope `ifinder_smart_collection`
  (6.9, RAG-892), read through `getContent` (`document.content`), list through the collection.
  Load-all is out for this tier.
- **User deletion** also deletes the user's collections and uploads in iFinder.
- Anonymous users are blocked. A user without a stable principal (local auth without an email) cannot
  use the tier.
- Release note and a doc update under `docs/projects.md` when it ships, per CLAUDE.md.

## 11. Risks that remain

| Risk | Mitigation |
|---|---|
| Identity mismatch between iHub's JWT, the ACL principal and the collection owner (renamed user, case) | One normalization rule in all places, a test with a renamed user |
| Master key loss makes every upload unreadable | Back up key and storage together, document it in the compliance statement (#2910) |
| Doc processor load: user uploads compete with connector crawls | Separate job instance and query for uploads, queue-depth metric |
| Version skew across webapp, doc processor and access service | The capability call hides the tier until all three support it |
| Plaintext in the access-service cache after delete | Evict endpoint, or no cache for encrypted sources |
| Search leakage: uploads surface in every search profile of the owner | Fixed `sourceName`, profiles exclude it unless wanted |
| Upload quota, rate limits and malware scan are missing in iFinder | Quota in the endpoint. Per-principal and per-tenant rate limits before the storage reservation (`429`). A scan gate in the doc processor: nothing is extracted, previewed or downloaded before the scan passes (section 7). iHub already has a scan hook to reuse |
| A failed step leaves a document, blob or cache entry behind | Upload intents with a reconciler (section 5), resumable deletion with a tombstone (section 9) |

## 12. Evidence and gaps

Read in `intrafind/ifinder`: `IndexingController`, `IndexingService` (authorities), the document
processor jobs (`ContentExtractionJobConfiguration`, `SourceDocumentItemProcessor`,
`IndexDocumentItemProcessor`, `IndexDocumentItemWriter`), the access service download SPI and caches,
the config store `SecurityConfiguration`, the smart collection controller, handler and index handler,
and the ragtime resolver and `FilterBuilder`. Checked directly: the `permitAll` on `/encrypt`, the
`denyAll` on `/decrypt`, `fa_index_write`, and `refresh: false`.

Inferred and still to confirm: the cipher details of the config store encryptor (jar not inspected),
how utilities maps the JWT claim to the owner, whether `s3://` item ids work end-to-end in the filesystem
handler, whether `GET /docs/{id}` is real time, and whether the embedding job waits for the text
without `prerequisites`. The file launcher module was not read.

## 13. Work split

| Team | Work |
|---|---|
| iFinder Core / webapp | Upload endpoint, wrap component, status resource, collection hardening, capability call |
| iFinder access | Storage handler plugin, evict endpoint, cache policy |
| iFinder document processor | Job enablement, optimistic concurrency, missing-blob handling, retry |
| iFinder search / RAG | `sourceName` handling in profiles, retrieval scope check, optional collection-id field |
| iHub | Tier policy, collections and upload clients, poller, project list merge, kind `tiers`, UI states, docs |

## 14. Open questions

1. Option A or B for the upload path (section 4)?
2. Which component wraps keys, and who may call it (section 6)?
3. Name and scope of the upload authority.
4. Is `GET /docs/{id}` real time, and what does the status resource read from?
5. Which storage provider do iFinder and iHub share in production, and who owns its credentials?
6. Does the collection delete remove uploads silently, or ask first?
