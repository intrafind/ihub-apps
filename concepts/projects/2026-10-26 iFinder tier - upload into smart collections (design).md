# iFinder tier: upload into smart collections (phase 2 of #1036)

Status: design proposal, nothing implemented. Cut into three iterations (read-only collections, manage
membership, upload); see section 1. Replaces the "push indexer" wording of decision 7 in #1036 and the
scope of spec 5 (#2907). Read it with spec 4 (#2906), spec 5 (#2907) and spec 6 (#2908).

The iFinder findings below come from reading `intrafind/ifinder` at `main` (6.9.0-SNAPSHOT, commit
`1f20761`). Section 12 lists what was read and what stayed inferred.

## 1. Goal and scope

An iHub project can be backed by an iFinder **smart collection**. The work is cut into three
iterations, each shippable on its own. Sections 4 to 7 and 9 describe iteration 3 only. Section 8
(smart collections) is needed from iteration 2, and section 10 is split by iteration.

| Iteration | What users get | What changes in iFinder |
|---|---|---|
| **1. Read-only** | The user's smart collections appear in the projects list as read-only projects. The documents of a collection are `ifinder-document` items and behave exactly like an iFinder document added to a project today (search, read, citations, "unavailable for you"). | Nothing. |
| **2. Manage membership** | iHub creates collections, adds iFinder documents to a collection (through the existing iFinder document picker) and removes them again. Removing only removes the membership, never the document. | Hardening of the utilities service (section 8). |
| **3. Upload** | Upload files into a collection. The original is stored encrypted, so preview and download work through the access service. | Upload endpoint, key wrapping, storage handler, processor changes (sections 4 to 9). |

Decided on 2026-10-26 and 2026-10-29, for every iteration:

- **No sharing.** Collections stay private to their owner. Uploaded documents carry ACLs that name one
  user. Viewers stay unenforced in iFinder (TCC-1832) and iHub never sets them.
- **No deleting a collection from iHub.** Creating, renaming, adding and removing documents are allowed.
- **Items are iFinder documents only** in an iFinder-tier project: no url, page, picked cloud files or
  written text.
- Promotion between tiers is out of scope.

The upload variant without any storage (iHub extracts the text and writes it straight into the index) was
considered and dropped: preview and download need the original, so upload waits for iteration 3.

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
| D9 | Three iterations: read-only collections, then membership management, then upload (section 1). | Taken |
| D10 | iHub creates collections, adds iFinder documents to them and removes them from them. It never deletes a collection and never shares one. | Taken |
| D11 | No upload without storage: preview and download need the encrypted original, so upload is iteration 3. | Taken |

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

**Principal type.** The upload route and the collection-editing routes accept only the token of an
interactive user: the per-user JWT iHub or the webapp mints for a signed-in person. They reject
personal API keys, OAuth clients, agents and any other delegated or machine principal with `403`,
before any collection, document or storage lookup, so the response does not reveal whether a
resource exists. The check reads the principal type from the token, never from a request field. Letting
a scheduled agent or a workflow upload on a user's behalf is a separate decision, with its own
audit trail, and is off until it is taken.

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

1. Check rate limit, size and type. Then, in **one atomic step**, claim the idempotency key and reserve
   the upload's bytes against the retained-byte quota, so concurrent uploads cannot all pass the same
   quota check. Persist an **upload intent** (document id, object key with a version id so re-uploads
   never overwrite, collection id, owner, the reserved byte count, state `reserved`). The intent is the
   recovery record for every later step. The reservation is released when the intent expires, is
   compensated, or the reconciler removes its objects.
2. Encrypt and write the blob to a `pending/` prefix, then the sidecar. State `stored`.
3. Create the document with status `pending`, scan status `pending`. State `indexed`.
4. Add the id to the collection (no existence check, so this works before indexing). State `complete`.
   A failure here keeps the state `indexed` and is retried from the intent record with backoff.
5. Return `202` with the document id and status URL. The status resource reports `queued` only once the
   state is `complete`, and `failed` (reason `collection`) if the retries are exhausted.

A reconciler works through the intents: it deletes `pending/` objects and sidecars of intents that
never got past `reserved` or `stored` after a day, retries step 4 for `indexed` intents, and after the
retry limit compensates: it removes the document id from the collection (idempotent, because the add
may have succeeded although its response or the state update was lost, and a dangling member would use
a slot of the 200-document cap), then deletes the document, blob and sidecar, releases the reserved
bytes, and only then marks the intent `failed`. Each compensation step persists its completion on the
intent, so a crash resumes where it stopped. The reconciler also removes documents whose blob is gone.
A document without a collection membership therefore never survives unnoticed.

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
- **The sidecar is also the manifest, and it holds immutable fields only.** A reindex rebuilds the index
  from sources, and here the blob and sidecar are the source, so the sidecar carries every field a
  rebuild needs: the owner and the ACL principal, the collection id, the original file name, size and
  media type, `sourceName` and the upload time. These are written once, before the document exists
  (step 2 of the upload), and never change (collections are private and not transferable), so the
  sidecar is never updated by a scan, an extraction or a reprocessing. Scan and processing state live in
  the index document only. A rebuild reads the manifest, re-creates the document with those fields,
  scan status `pending` and extraction status `pending`, so every rebuilt document is **scanned again
  before it is extracted**. Anything the manifest does not hold (processing state, scan result, ranking
  signals) is not promised by a rebuild.
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
  `error`). A **separate scan job** in the document processor runs first: its query selects uploads with
  `processing.scan.status.keyword:pending` (and the retryable `error`), and it writes `passed`,
  `failed` or `error`. `contentExtractionJob` is enabled with the query
  `processing.contentExtraction.status.keyword:pending AND processing.scan.status.keyword:passed`, so it
  only ever sees scanned documents, and `prerequisites` make the embedding job wait for the text.
  OCR, conversion, preview, thumbnails and
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

- iHub creates a collection with the public API (`fi_smartcollections`). The owner is the principal of
  the caller's JWT.
- **Owner mapping (verified in the iFinder code).** Every service reads the owner name from the JWT claim
  named by `spring.security.oauth2.resourceserver.jwt.principal-claim-name`, which defaults to `sub`
  (`AuthenticationUtils`; the webapp converter uses the same property). The iFinder docs say this value
  must match exactly the user name format the Userinfo service expects. iHub signs `sub` from its
  admin setting `jwtSubjectField` (default `email`, `server/utils/iFinderJwt.js`). So the owner is
  whatever iHub puts in `sub`, and a collection lines up with the same person in the iFinder UI only if
  both sides produce the same string.
- **Case.** The owner is stored as `owner` with a plain `owner.keyword` subfield, without a normalizer.
  The list call matches it with an exact term query, so it is case-sensitive. The webapp's per-collection
  checks (`equalsIgnoreCase`) and ragtime are not. A collection whose owner differs only in case from
  the caller's `sub` is missing from the list but still opens by id. The fix is on the iFinder side: a
  lowercase normalizer on `owner.keyword` (needs a reindex) or a lowercased term query. Until then iHub
  must configure `jwtSubjectField` to match the iFinder login exactly, and test it with a mixed-case
  user.
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
| `deleting` | deletion in progress (tombstone written); `404` only once it is finished |

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
   answers `deleting` (and `404` only once the tombstone is `deleted`, step 5), the access service
   refuses preview and download, and the processor must not write
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

Per iteration. The collection calls use the public Smart Collections API (v1 OpenAPI paths, not the stale
v0 paths in the 6.8 docs) with the per-user RS256 JWT (`server/utils/iFinderJwt.js`). Its default scope is
`fi_index_read`, so the calls request `fi_smartcollections` explicitly, and the user needs that role.
All outbound calls use `httpFetch()`, so the SSL whitelist and the proxy config apply, with a whitelisted
and a non-whitelisted host test (CLAUDE.md).

### Iteration 1: read-only collections

- `tierPolicy` accepts `both` and `ifinder` for real. Today every value acts as `ihub`
  (`projectSettings.js`, `docs/projects.md`). The tier is read from a capability call to iFinder
  (version with the Smart Collections public API, GA since 6.8), so an older iFinder never shows the tier.
- A collections client next to `iFinderService`: list and get.
- **Project list:** `GET /api/projects` merges the local list with the user's collections as projects
  with `tier: 'ifinder'`, a namespaced id and a read-only flag, with a short timeout and a cache. The
  cache key contains the tenant and the principal, an entry is never shared between users, and the
  response is built for the requesting principal on every call, including cache hits (no collection id or
  name from another user's entry). If iFinder is slow or down, the local list still returns, with a
  warning. Collections created in iFinder appear too. The list shows document counts only. The documents
  are fetched when the project is opened, with their titles cached per user.
- **Items:** every document id of the collection becomes an `ifinder-document` item, resolved by the
  existing link-kind fetch with the reading user's rights. A document the user cannot open is named as
  unavailable, as today. No new knowledge provider is needed: the scope is the collection's id list, so
  there is no dependency on the 6.9 retrieval scope. How the existing iFinder document search treats
  more than 100 ids still has to be checked.
- **Read-only UI:** no edit, rename, share, delete, instructions, pins or upload. A chat can use the
  collection as knowledge. Instructions and chat membership have no place in a smart collection, so
  chats in a collection need a small local reference record keyed by the collection id (created on first
  use), or they stay outside iteration 1.
- Anonymous users are blocked. A user without a stable principal (local auth without an email) cannot use
  the tier.

### Iteration 2: manage membership

- **Create** a collection from iHub (name, description). The owner is the JWT identity.
- **Add** iFinder documents through the existing iFinder document picker. iHub checks first that the user
  can read each document, because iFinder does not validate ids. The 200-document cap is shown against
  the project limits and an overflow is a clear error.
- **Remove** documents from a collection. This only removes the membership, never the document.
- **Rename** a collection. There is no delete and no share in iHub.
- Collection writes in iFinder are an unversioned read-modify-write. The serialization described next
  must hold **across all iHub instances**: a lock or queue inside one instance does not stop two
  instances from losing each other's updates. Until utilities gains `if_seq_no`, multi-instance writes
  stay disabled unless a cluster-wide lock or queue is in place. iHub serializes the writes per
  collection until utilities gains `if_seq_no` (section 8).
- iHub does not delete collections. What happens to a user's collections when the user leaves is a
  question for iFinder.

### Iteration 3: upload

- New services next to `iFinderService`: an upload client and a status poller, with the upload authority
  added to the token scope.
- **Kind registry** gets a `tiers` property. An iFinder project offers `upload` and `ifinder-document`
  only. "Edit text" and the cloud kinds are hidden. The project page shows the tier and the fact that
  the original is kept (and downloadable by the owner).
- **Knowledge provider** for uploads: read through `getContent` (`document.content`), search through the
  collection's id list or the 6.9 retrieval scope `ifinder_smart_collection` (RAG-892). Load-all is out
  for this tier.
- **User deletion** also deletes the user's uploads in iFinder.
- Release note and a doc update under `docs/projects.md` when each iteration ships, per CLAUDE.md.

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
whether `s3://` item ids work end-to-end in the filesystem
handler, whether `GET /docs/{id}` is real time, and whether the embedding job waits for the text
without `prerequisites`. The file launcher module was not read.

## 13. Work split

| Team | Iteration 1 | Iteration 2 | Iteration 3 |
|---|---|---|---|
| iHub | Capability call, collections client, project list merge, read-only project view, tier policy, docs | Create, rename, add and remove, picker reuse, per-collection write serialization | Upload and status clients, kind `tiers`, UI states |
| iFinder Core / webapp | None | Utilities hardening (owner checks, `if_seq_no`, 4xx for the cap, case rule) | Upload endpoint, wrap component, status resource, capability call |
| iFinder access | None | None | Storage handler plugin, evict endpoint, cache policy |
| iFinder document processor | None | None | Job enablement, optimistic concurrency, missing-blob handling, retry |
| iFinder search / RAG | None | None | `sourceName` handling in profiles, retrieval scope check, optional collection-id field |

## 14. Open questions

1. Identity (answered, see section 8): the owner is the JWT `sub` (configurable claim), and the list
   matches it case-sensitively. Still to test with a real installation: a collection created in the
   iFinder UI by a user whose login differs in case from iHub's `jwtSubjectField` value. Whether iFinder
   adds a lowercase normalizer on `owner.keyword` is a request to the iFinder team, not a blocker for
   iteration 1.
2. Over 100 ids: how does the existing iFinder document search by id behave for a collection with more
   than 100 documents?
3. Option A or B for the upload path (section 4)? Iteration 3.
4. Which component wraps keys, and who may call it (section 6)? Iteration 3.
5. Name and scope of the upload authority. Iteration 3.
6. Is `GET /docs/{id}` real time, and what does the status resource read from? Iteration 3.
7. Which storage provider do iFinder and iHub share in production, and who owns its credentials?
   Iteration 3.
8. What happens to a user's collections and uploads when the user leaves? iFinder decides; iHub never
   deletes a collection.
