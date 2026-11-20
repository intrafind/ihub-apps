# S3 Blob Storage Backend

Date: 2026-11-19, updated 2026-11-20. Status: built on branch `claude/epic-lamport-5wjqa7`, not
released. Tickets: #2318 (implementation), #2906, #2302, #2312, #2316.

Sections 1 to 10 are the plan. They were updated on 2026-11-20 where the plan had left a point open:
each such point now names the decision (A1 to A15, section 3.1) and what was built. Section 11
records what the requester changed after the plan (R1 to R3) and where the code differs from the
plan. Where this document and the code disagree, the code is right. Operator documentation:
`docs/storage.md` (section "Blob storage backends") and `docs/storage-encryption.md`.

This document consolidates the planning of seven roles and the lead's decisions. The roles are
abbreviated as follows: PM (product manager), UX (UX designer), UI (UI designer), ARCH (architect),
ENG (engineer), QE (quality engineer), SEC (security). Where the role plans disagree, the lead's
decisions (D1 to D19, section 3) win. Where the decisions are silent, the architect's plan wins,
then the security plan.

## 1. Summary

- Built: an S3-compatible backend for the blob facet only, selected with `storage.blobs.provider: "s3"`.
- Built: client-side encryption of every object in every blob namespace. The plan had it always on
  for S3 with no off switch. The requester changed that: encryption is one optional switch,
  `storage.encryption.enabled`, and it also covers filesystem blobs, documents, logs and several
  file stores (section 11).
- Built: a fail-closed start with a key check, an offline copy command for existing blobs, a check
  command, a read-only admin status endpoint and card, a local S3 server for development and CI.
- Not built: S3 for documents, logs and locks. They stay on the configured provider (filesystem).
- Not built: an admin form (#2312), multi-instance support, a rewrap job, a Transit key provider,
  multipart, range reads, hidden object names.
- Not verified: the implementation was run against the in-repository S3 server only
  (`npm run s3:dev`), which does not verify request signatures. The versitygw compose file and the
  CI workflow were never executed. AWS S3 was not tested.

## 2. Context

### 2.1 What the requester asked for

"Implement the S3", a local S3 backend to develop against, and "the content is fully encrypted in S3
as it is today in the filesystem". The team read this as: an S3-compatible backend for the blob
facet, with nothing readable in the bucket. The requester has not confirmed this reading (section 8).

### 2.2 What exists

- The storage abstraction lives in `server/storage/`. One provider ships: `providers/filesystem/`.
  A provider has facets: documents, append logs, locks, change notification, blobs.
- The `BlobStore` contract has `put`, `get`, `delete`, `list`, `scan`, `deletePrefix`, addressed by
  `(namespace, key)`. Its header comment already maps the calls onto S3 operations and names #2318.
- All blob consumers take the facet the same way: `readFacet(getStorage(), 'blobs')`. No caller
  builds a store itself, and no caller reads a blob file by path (ENG).
- The conformance suite is `server/storage/__tests__/providerConformance.js`. It asserts that
  `bytes` and `sha256` describe the plaintext, that `list` reports the payload size, and that of two
  racing deletes exactly one returns `true`.
- The crypto code is `server/services/projects/crypto/streamingAead.js` (format
  `tink-aes-gcm-hkdf-v1`) and `crypto/KeyProvider.js`. `LocalFileKeyProvider` wraps data keys with
  the master key from `contents/.encryption-key` or `TOKEN_ENCRYPTION_KEY`. It also unwraps with one
  previous key from `TOKEN_ENCRYPTION_KEY_PREVIOUS`.
- Configuration is `platform.json` → `storage: { provider: "filesystem", filesystem: {...} }`, with
  the environment override `IHUB_STORAGE_PROVIDER`.
- No admin storage page exists. #2312 is open and depends on a migration command (#2311) that does
  not exist. No `@aws-sdk/*` dependency exists.

### 2.3 Corrections to the first picture

- **Only `project-files` is encrypted on the filesystem today.** `FilesystemBlobStore` writes bytes
  as given. `project-files` is encrypted in the domain layer (`ItemTextStore.js`). Chat files,
  evidence content, artifacts and the website corpus are plaintext on disk. So "as it is today in
  the filesystem" does not describe every namespace. The requirement carried forward is "nothing
  readable in the bucket".
- **There are six blob namespaces, not five.** They are `project-files`, `chat-files`,
  `chat-evidence-content`, `run-evidence-content`, `artifacts` and `website-corpora`. The first
  brief missed `artifacts`. `artifacts` and `website-corpora` are used on the blob facet but are not
  declared in `BLOB_NAMESPACES` (`server/storage/namespaces.js`).
- **Storage starts before the master key is initialised.** `server/startup/worker.js` bootstraps
  storage at line 78 and calls `initializeEncryptionKey()` at line 124 (ARCH, ENG).
- **The config cache is empty at storage bootstrap.** `getSSLConfig()` and `getProxyProvenance()`
  read `configCache.getPlatform()`. An S3 client built at bootstrap would ignore the TLS whitelist
  and the platform proxy unless it gets the raw `platform.json` (ARCH, ENG).
- **A missing key file makes `TokenStorageService` generate a new master key and continue** (SEC, UX).
  With a remote bucket this would make old objects unreadable without an error at start.
- **Only one platform secret is encrypted in `platform.json` today**, `speech.azure.subscriptionKey`.
  The encrypt and decrypt functions are hard-coded to that field (ENG). The `storage` section cannot
  be written through the admin API (`PATCHABLE_PLATFORM_SECTIONS`).
- **Orphan sweeps delete blobs that no document refers to** (`ProjectRepository.js`,
  `ChatFileRepository.js`, `ChatEvidenceRepository.js`). Two installations on one bucket prefix
  would delete each other's objects (SEC).
- **The backup export zips `contents/`.** With S3 it holds the documents and the key, but no blobs (ENG, UX).
- **What a failed storage bootstrap does today is described differently by the sources.** ENG and
  ARCH say `bootstrapStorageOrExit` exits the process. QE cites a comment in `scripts/smoke-boot.js`
  that a failed bootstrap is non-fatal. UX notes that a comment in `/api/health` says the same and
  contradicts `server/storage/bootstrap.js`. Not resolved during planning. D6 requires the start to
  fail.

### 2.4 What was verified during planning, and what was not

Verified by measurement (ENG, Node 22.23.5, scratch directory, repository unchanged):

- `streamingAead` encrypt and decrypt are buffer-based and synchronous. A 25 MB `put` blocks the
  event loop for about 60 ms and holds about three copies of the payload.
- `@aws-sdk/client-s3` 3.1173.0 accepts `httpAgent` and `httpsAgent` as plain handler options.
- A strict agent rejects a self-signed server; an agent with the bypass option connects.
- Three npm S3 emulators were tried. `s3rver` 3.7.1 fails every truncated listing on Node 22.
  `fauxqs` 2.15.0 lists in the wrong order and loses keys between pages. `s3-test-server` 2.2.0
  behaved correctly but was first published on 2026-10-24 and has one maintainer.

Not verified:

- Nothing was run against a real S3 server (AWS S3, versitygw, MinIO, Ceph, NetApp). The session had
  no Docker, and installing a server binary was not permitted.
- The repository asks for Node 24. Planning ran on Node 22.23.5 with `ALLOW_UNSUPPORTED_NODE=1`.
- SEC assumes that chat, project, task and file ids are random and hold no personal data. SEC
  checked the id pattern and the evidence scope hash, not every id generator.
- Whether adding `artifacts` and `website-corpora` to `BLOB_NAMESPACES` is safe (D17 says "if that is safe").
- Whether the versitygw image can be configured through environment variables only (QE).
- QE's statement that MinIO stopped publishing community images in late 2025 ("verify before anyone
  proposes it").

## 3. Decisions

The lead took these decisions after reading the seven role plans. They are binding for the
implementation.

**D2 no longer holds as written.** The requester changed it after the plan (R1 and R3, section
11.1): encryption is one optional switch, `storage.encryption.enabled`, and it covers filesystem
blobs too. The row below keeps the original wording and says what replaced it. Every later
"Stands (D2)" in this document means the part of D2 that is left: a decorator over any blob store,
every namespace, no skip list.

| # | Topic | Decision | Rejected alternative | Reason |
| --- | --- | --- | --- | --- |
| D1 | Scope and configuration | S3 serves the blob facet only. `storage.blobs.provider` is `"default"` or `"s3"`, with the environment override `IHUB_STORAGE_BLOBS_PROVIDER`. The S3 settings are under `storage.blobs.s3`. Documents, logs and locks stay on the configured provider. A thin composed provider in `StorageRegistry` replaces the blob facet. Repositories do not change. | A full `s3` storage provider. | #2302 decision 4 dropped S3 for documents and logs. Append logs and conditional writes fit S3 badly. #2318 reopens S3 for blobs only. |
| D2 | Encryption | **Changed by R1 and R3 (section 11.1).** As decided in the plan: an `EncryptingBlobStore` decorator wraps the S3 store. It is always on for S3, for every namespace, with no skip list and no off switch. Filesystem blobs stay as they are. **What holds now:** the decorator, every namespace and "no skip list" stand. "Always on" and "no off switch" do not: `storage.encryption.enabled` turns encryption on or off for the whole installation, and with it off a bucket receives plaintext (R3). "Filesystem blobs stay as they are" does not: the decorator wraps the filesystem blob store as well (R1). | Encryption inside the S3 adapter. Encrypting filesystem blobs now. | Inside the adapter the format would be tied to one backend. A skip list can be wrong and is a path to plaintext. Encrypting filesystem blobs changes existing behaviour and is a separate decision for the requester. |
| D3 | Object format | Each object is one fixed-length header (magic, version, key provider id, key id, wrapped data key) followed by the `tink-aes-gcm-hkdf-v1` stream with 1 MiB segments. The associated data is built from the request, never read from the object. `bytes` and `sha256` describe the plaintext on `put`, `get` and `list`. `list` computes the plaintext size from the object size. Test vectors are recorded. The header length follows the architect's plan (512 bytes). | S3 user metadata. A sidecar object. | User metadata is limited to 2 KB, is handled differently by backends and is not returned by `ListObjectsV2`. A sidecar is not atomic with the object and doubles every request. Values read from the object are attacker-controlled. Quotas and the conformance suite depend on plaintext sizes. |
| D4 | Object keys | Keys are readable: `<prefix>/<tenant>/<ns>/<key>`, with tenant `default`. This deviates from "opaque object keys" in #2906 and is flagged to the requester. | An HMAC of the key. | The `BlobStore` contract requires prefix listing and ascending key order. An HMAC cannot be listed by prefix or returned as the real key. |
| D5 | Credentials | Static access key and secret only, from `platform.json`. The value may be `ENC[...]` or a `${ENV}` placeholder. The SDK default credential chain is not used in v1. No `logger` is passed to `S3Client`. | Instance role, web identity. | Behaviour stays predictable. The default chain makes outbound calls that bypass `httpConfig.js`, and it would let an iHub admin use the host's cloud identity. The SDK logger logs command input including `Body`. |
| D6 | Startup | Fail closed. Invalid configuration, a missing or mismatching master key, an unreachable bucket or bad credentials make the storage bootstrap fail, exactly as an unknown provider does today. The server never falls back to the filesystem blob store and never writes plaintext. | Start degraded when the remote side fails (UX plan). | A fallback would split the data and write plaintext to disk unnoticed. The existing rule is that a provider that fails to initialise stops the server. |
| D7 | Key check | An encrypted marker object `_ihub/keycheck` under the prefix. It is written on the first start into an empty prefix and checked on every start. Wrong key: refuse to start. Objects present but no marker: refuse to start. The master key must be initialised before storage; the boot order in worker and primary is fixed. | Trust the key file. | A missing key file is silently replaced by a new key today. Writing under a second key into the same prefix cannot be repaired later. |
| D8 | Delete | `delete` takes a lock from the base provider's `LockManager`, calls `HeadObject`, then `DeleteObject`. So one of two racing deletes reports `true`. `deletePrefix` takes no lock. | An in-process mutex only. | `DeleteObject` answers 204 whether or not the key existed. A process mutex fails across cluster workers. `crawlHandover.js` relies on the "one delete wins" rule. |
| D9 | Existing blobs | An offline copy command `npm run storage:copy-blobs` is in scope: dry run, idempotent, hash-verified, filesystem to S3. A boot warning names the namespaces that still hold local blobs while S3 is active. No read-through to disk. Switching back is not supported in v1. | A read fallback to the filesystem. | A read fallback is a compatibility shim, hides an incomplete copy and keeps plaintext files in use. Without a copy the feature is usable on fresh installations only. |
| D10 | Local S3 backend | An in-repo S3-compatible server `server/tests/support/fakeS3Server.js`, usable in tests and as a standalone local backend (`npm run s3:dev`, data in a directory, SigV4 header presence checked, marked as development only). In addition `docker/docker-compose.s3.yml` with versitygw (pinned image, bound to 127.0.0.1, credentials from variables) and a CI workflow that runs the S3 suites against it with `IHUB_TEST_S3_REQUIRED=1`. No npm emulator dependency. | `s3rver`. `s3-test-server`. | `s3rver` is broken on Node 22 and unmaintained. `s3-test-server` was one month old and has one maintainer. |
| D11 | Admin surface | No form and no new page. `GET /api/admin/storage` returns a cached status: running versus configured backend, `restartRequired`, `encryption.scope`, the endpoint host only, no credentials. `POST /api/admin/storage/_test` runs a round-trip probe and answers 200 with `status`. One read-only card on the System Resources admin page, in English and German. The admin-wide red banner is cut. The form stays in #2312. | A `/admin/storage` page with a form. | A backend change needs a restart. A wrong storage setting can stop the server, and then the form is gone. A form invites a switch that orphans existing files. #2312 depends on #2311. |
| D12 | Check command | `npm run storage:check` runs without the server, prints named steps, exits with 0 or 1, and uses the same probe and error classifier as startup and the admin status. | Only the startup log. | An operator must be able to test the configuration before the restart. One classifier makes the log, the command and the card say the same thing. |
| D13 | Crypto location | `streamingAead.js` and `KeyProvider.js` move to `server/crypto/`. Imports are updated; there is no re-export shim. Two fixes: an unknown key provider id throws instead of falling back to `local-file`, and empty associated data throws. Existing project-file behaviour and tests must still hold. | Leave the modules under `services/projects`. | `server/storage` must not import from `server/services`. The repository forbids silent shims. The two fixes close a silent downgrade and objects bound to nothing (SEC findings F5, F6). |
| D14 | Migration | None. The `storage.blobs` block is optional and absent by default. It is not added to `server/defaults/config/platform.json`. The schema gets the optional block. | Migration V260. | A migration is for new required or default fields. A written default block would invite half-configured setups. |
| D15 | Secrets | `storage.blobs.s3.secretAccessKey` is decrypted in the storage bootstrap path when it is `ENC[...]`, redacted on admin config read, restored on save and masked in logs. | Plaintext only. | The storage bootstrap reads the raw file before the config cache exists. Without the decrypt step an encrypted value would be sent as the secret key. |
| D16 | Transport | A dedicated keep-alive agent built from the same proxy and TLS-whitelist code as `httpConfig.js`. It is fed from raw `platform.json`, because `configCache` is empty at bootstrap. Plain http is refused unless the host is loopback or `allowInsecureHttp` is set. `requestChecksumCalculation` and `responseChecksumValidation` are `WHEN_REQUIRED`. The size is checked before a body is buffered. A test covers a whitelisted and a non-whitelisted host. | The shared agent. Bare SDK defaults. | `S3Client.destroy()` destroys the agent it was given, which would break every other outbound call. The shared direct agent has no keep-alive. Newer SDK defaults add checksum headers and trailers that several S3-compatible servers reject. |
| D17 | Namespaces | `artifacts` and `website-corpora` are added to the declared blob namespaces if that is safe. The adapter accepts any valid namespace. | Iterate `BLOB_NAMESPACES` only. | Encryption must not depend on a list. The copy command and the boot warning need the complete list. |
| D18 | Read failures | An integrity failure, plaintext where ciphertext is expected, or an unknown key id throws a distinct storage error (`CORRUPT_BLOB`, `KEY_UNAVAILABLE`). `get` never returns `null` for these and never returns raw bytes. | Return `null`. | Callers treat `null` as "gone" and may clean up metadata. Returning raw bytes would let a bucket writer inject plaintext. |
| D19 | Not in v1 | Admin form and wizard (#2312), Transit key provider, rewrap job, multipart and range reads, HMAC object names, multi-instance claims, a tenant prefix beyond `default`, backup export of the bucket, S3 for documents. Each is a follow-up. No ticket is created without the requester's yes. | (none) | See section 10. |

### 3.1 Addendum: points the plan had left open

The lead decided these after the design document had listed its open points. The last column says
what the code does.

| # | Topic | Decision | As built |
| --- | --- | --- | --- |
| A1 | Associated data | The exact string `ihub/blob/v1\n<tenant>\n<ns>\n<key>\n<segmentBytes>`, newline separated, segment size included. Fixed before the test vectors were recorded. | As decided (`server/crypto/blobEnvelope.js`, vectors in `server/tests/fixtures/blob-envelope/`). |
| A2 | Key-check marker | Object `_ihub/keycheck` under the prefix, encrypted like any blob. Payload `{ format: 1, naming: "plain", installationId, createdAt }`. Whoever first writes into an empty prefix writes it: the server at start or the copy command. Objects present and no marker: refuse, unless `IHUB_S3_ADOPT_BUCKET=true` is set for that one start (logged as a warning). | As decided. `storage:check` never writes it. With storage encryption the same object also exists on local disk (`data/blobs/_ihub/keycheck`). |
| A3 | Object size cap | `storage.blobs.s3.maxObjectBytes`, default 64 MiB of plaintext, checked before buffering on `put` and against `ContentLength` on `get`. | The default is **128 MiB**, so that it is above the default size limit of an artifact (100 MB). Range 1 byte to 4 GiB. A larger `put` is `BLOB_TOO_LARGE` (413). |
| A4 | Configuration fields | Besides D1's list: `maxObjectBytes`, `connectTimeoutMs` (5000), `requestTimeoutMs` (60000), `maxAttempts` (3). `maxSockets` is a constant. The key provider is the platform's, with no setting of its own. | As decided. `maxSockets` is 32. |
| A5 | Copy command | Never deletes a source file. No `--delete-source`. | As decided. |
| A6 | Boot warning | Names the namespaces with counts. | As decided. Counting stops at 1000 per namespace ("1000+"). |
| A7 | CI | A new workflow `s3-storage-tests.yml` that uses the compose file with `IHUB_TEST_S3_REQUIRED=1` and fails on skipped tests. No nightly run, no count floor. | The file exists. It has never run. |
| A8 | `GET /api/admin/storage` | Shape per the UI plan, plus `localLeftovers` (namespaces with counts, from the boot check). Probe result cached, refreshed at most once a minute. No `pendingDeletes`. | As decided. See 4.11 for the shape. |
| A9 | Wording | "Blob storage" / "Blob-Speicher" for admins. | As decided. |
| A10 | Public `/api/health` | Additive `storage.blobs: { provider, status }`, nothing else. | As decided. The status is the last check result; nothing refreshes it in the background (section 11.2). |
| A11 | Error codes | One classifier with the UX code table for operator and admin output. User-facing codes and the UX-only behaviours (blocked turn, delete retry queue, backend-changed memory) are not in v1. A notice on the backup page is, if it is a text change only. | The classifier is `server/storage/blobProbe.js`, the hints are `server/storage/blobOperatorGuide.js`. The backup page has the notice. |
| A12 | Smithy handler | No direct `@smithy/node-http-handler` dependency; handler options are passed as a plain object. | As decided. |
| A13 | Runtime SSL or proxy change | The client is built once; a change needs a restart. | As decided, and documented. |
| A14 | Docs | Extend `docs/storage.md`; add the key-loss and backup text to `docs/encryption-key-management.md`. | Done. Storage encryption has its own page, `docs/storage-encryption.md`. |
| A15 | Failed bootstrap | Whatever the code does for an unknown provider is what S3 failures do. The invariant: never serve blobs from local disk when S3 is configured. | The process logs the failing step and code and ends with exit code 1. In a cluster the primary checks before it forks. |

## 4. Design

Details below come from the decisions, then from the architect's plan, then from the security plan.
Where a detail has no source, the text says "not specified".

### 4.1 Configuration shape

```json
"storage": {
  "provider": "filesystem",
  "filesystem": { "dataDir": "data" },
  "blobs": {
    "provider": "s3",
    "s3": {
      "endpoint": "https://s3.example.internal:7070",
      "region": "us-east-1",
      "bucket": "ihub",
      "prefix": "",
      "accessKeyId": "${IHUB_S3_ACCESS_KEY_ID}",
      "secretAccessKey": "${IHUB_S3_SECRET_ACCESS_KEY}",
      "forcePathStyle": true,
      "allowInsecureHttp": false
    }
  }
}
```

- `blobs.provider` is `"default"` (the base provider's own blob facet) or `"s3"`. An absent block
  means `"default"`.
- `IHUB_STORAGE_BLOBS_PROVIDER` beats `storage.blobs.provider`, with the same precedence as
  `IHUB_STORAGE_PROVIDER`.
- Other values use the existing `${VAR}` placeholders. Documented names: `IHUB_S3_ENDPOINT`,
  `IHUB_S3_BUCKET`, `IHUB_S3_ACCESS_KEY_ID`, `IHUB_S3_SECRET_ACCESS_KEY`. `resolveStorageConfig`
  must deliver and resolve the `blobs` block; today it returns only `storage[<provider name>]`.
- `endpoint` is optional (AWS). `region` defaults to `us-east-1`. `forcePathStyle` defaults to
  `true`. `allowInsecureHttp` defaults to `false`.
- The plan had no `encryption.enabled` setting. Built (R3, section 11): `storage.encryption.enabled`,
  one switch beside `storage.blobs`. The tenant is the constant `default` and is not configurable.
- The architect's plan also lists `connectTimeoutMs` (5000), `requestTimeoutMs` (60000),
  `maxAttempts` (3), `maxSockets` (32) and `encryption.keyProvider` (`local-file`). D1 does not name
  them. Decided (A4): `maxObjectBytes`, `connectTimeoutMs`, `requestTimeoutMs` and `maxAttempts` are
  configuration fields; `maxSockets` (32) is a constant; there is no key provider setting.
- Endpoint validation (SEC): scheme `http` or `https` only; no user info, query or fragment; no
  redirect to another host. Bucket name and prefix match a strict pattern. Link-local targets
  (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`) are refused. Built without the `ssrf.allowedHosts`
  exception: a link-local endpoint is always refused.
- An unresolved `${VAR}` placeholder is an error at start, not an empty string (SEC).
- Schema: `server/validators/platformConfigSchema.js` gets the optional block. No migration (D14).
- Secret (D15): add `storage.blobs.s3.secretAccessKey` to `PLATFORM_SECRET_PATHS`
  (`server/utils/redactedSecrets.js`) and to `encryptPlatformSecrets` / `decryptPlatformSecrets`
  (`server/utils/configSecrets.js`), which must be generalised to a list of paths. The S3 factory
  calls `decryptIfEncrypted` itself. `isSecretName('secretAccessKey')` returns `false` today (ENG);
  add the name to `server/utils/secretNames.js` or never log the block.
- A change needs a restart.
- Known limit (ENG): `IHUB_PLATFORM__...` overrides are applied by `configCache` and do not reach
  the storage bootstrap. Document it.

### 4.2 Composition

```text
domain repositories (unchanged)
   └─ readFacet(provider, 'blobs')
        └─ ComposedStorageProvider
             ├─ documents, logs, locks, notifier → base provider (filesystem)
             └─ blobs → EncryptingBlobStore → S3BlobStore → S3 client → bucket
                          │                     └─ locks (base provider) for delete
                          └─ key provider (injected) → master key
```

- `StorageRegistry.initializeStorage` builds the base provider as today. If `blobs.provider` is not
  `"default"`, it builds the blob backend and wraps both in `ComposedStorageProvider`.
- The composed provider reports the base provider's `name` and capabilities, with `blobStore: true`.
  It has a getter `blobBackend` (`'s3'`) for logs and health details. No new capability key.
- `EncryptingBlobStore` is a decorator over any `BlobStore`. `S3BlobStore` stores opaque bytes and
  knows nothing about keys.
- Blob backends are registered in `server/storage/blobBackends.js` (`registerBlobBackend`,
  `createBlobBackend`). The factory receives `(config, { platformConfig, locks, keyProvider })`.
- Dependency rule: `server/storage` never imports `server/services`. The key provider is injected.
  The architect proposes an ESLint `no-restricted-imports` rule for the directory.
- `timeFacetMethods` moves from `FilesystemStorageProvider.js` to `server/storage/facetTiming.js`
  and is applied to the composed blob facet, so blob timings stay in the admin diagnostics.
- Key validation (`assertValidNamespace`, `assertValidKey`) moves from
  `providers/filesystem/paths.js` to `server/storage/keys.js`.
- `healthCheck()` returns the base result plus `details.blobs = { backend, status, latencyMs,
  bucket, endpointHost }`. Base error gives `error`. Base ok with a failed blob probe gives `degraded`.
- `shutdown()` closes the blob side first (`client.destroy()`, which closes the dedicated agent),
  then the base.

Planned new modules (ARCH):

| File | Content |
| --- | --- |
| `server/crypto/streamingAead.js`, `server/crypto/KeyProvider.js` | Moved (D13). `streamingAead` gains `ciphertextLength` and `plaintextLength`. |
| `server/crypto/blobEnvelope.js` | Header constants, `blobAssociatedData`, `encodeHeader`, `decodeHeader`, `storedLength`, `plainLength`. |
| `server/storage/EncryptingBlobStore.js` | The decorator, with `verifyKey()`. |
| `server/storage/ComposedStorageProvider.js` | The composition. |
| `server/storage/blobBackends.js`, `keys.js`, `facetTiming.js` | Registry, key validation, timing. |
| `server/storage/providers/s3/S3BlobStore.js`, `s3Client.js`, `s3Errors.js`, `index.js` | Adapter, client factory, error mapping. |
| `server/scripts/copyBlobs.js` | The copy command. |
| `server/tests/support/fakeS3Server.js` | The local S3 server (D10). |
| `docker/docker-compose.s3.yml` | versitygw. |

Dependencies: `@aws-sdk/client-s3` (Apache-2.0, needs Node 20 or later) in `server/package.json`,
loaded with `await import()` inside the client factory. Pin an exact version that is at least seven
days old (`.npmrc` has `min-release-age=7`). The architect's plan also adds
`@smithy/node-http-handler` as a direct dependency. ENG measured that the SDK accepts the handler
options as a plain object, so the direct dependency may not be needed. Decided (A12): no direct
dependency; the handler options are a plain object.

### 4.3 Object format and associated data

One object, no sidecar, no S3 user metadata. Layout of envelope version 1 (ARCH, confirmed by D3):

```text
offset 0    4   magic "IHB1"
       4    1   envelope version = 1
       5    1   length of key provider id (n1)
       6    1   length of key id (n2)
       7    2   length of wrapped key (n3, big-endian)
       9   n1   key provider id, ASCII ("local-file")
            n2   key id, ASCII (8 hex characters for local-file)
            n3   wrapped data key (61 bytes for local-file)
       ..  pad  zero bytes up to offset 512
     512   ..   tink-aes-gcm-hkdf-v1 stream, segment size fixed at 1 MiB
```

- The header is always 512 bytes and the segment size is always 1 MiB. Both are constants of
  envelope version 1. So the plaintext length is a function of the object size alone.
- Size arithmetic (ENG): let `C` be the object size minus the header. With
  `n = ceil(C / segmentBytes)`, the plaintext length is `C − 40 − 16 × n`. An object shorter than
  568 bytes is invalid.
- Header rules (SEC): reject any other magic or version, non-zero padding, and lengths that leave
  the header. Do not parse JSON from the bucket.
- A change of the constants needs a new version with its own magic. The old test vectors must keep
  passing.
- Each object has its own random 256-bit data key, wrapped by the master key with AES-256-GCM. The
  wrap format is unchanged.

Associated data:

- D3 fixes it as `ihub/blob/v1/<tenant>/<ns>/<key>` "plus what security.md requires". The security
  plan requires the segment size to be part of the associated data and writes the value as
  `ihub/blob/v1\n<tenant>\n<ns>\n<key>\n<segmentBytes>`. The exact encoding (separator, position of
  the segment size) is not resolved by the decisions. It must be fixed before the test vectors are
  recorded.
- The associated data is used for the HKDF key derivation and for the key wrap.
- It is the logical address, never the bucket or the prefix. Moving a bucket or changing `prefix`
  keeps every object readable. An object copied to another key, namespace or tenant does not decrypt.
- Tenant, namespace and key are validated against `[A-Za-z0-9._-]` before the string is built.
- The prefix `ihub/blob/v1` differs from `ihub/project-files/` and `ihub/project-crawls/`. An
  adapter-level object cannot be confused with a domain-level one.
- There is no version in the associated data, because `BlobStore` has none. A bucket writer can put
  back an older object that was stored under the same key. This is accepted (section 6).

`bytes` and `sha256`:

- `put` returns the plaintext length and the SHA-256 of the plaintext, computed before encryption.
- `list` and `scan` return the plaintext length computed from the object size. No extra request per key.
- The plaintext hash is never sent to S3. It would let a bucket reader confirm a known file.
- `list` reports an object with an impossible size with `bytes: 0` and logs once per key (ARCH).
  Names that do not parse back to a valid key under the expected prefix are dropped (SEC).

Never stored in the bucket in clear: content type, file name, user id, plaintext hash. Every object
has `Content-Type: application/octet-stream`. The caller's `contentType` hint is ignored. No user
metadata, no SSE headers, no ACL. `ETag` is never used as an integrity value.

Double encryption: `project-files` objects and crawl hand-over objects are already encrypted in the
domain layer. They are encrypted a second time by the decorator. An "already encrypted, skip" branch
is not allowed. The cost is CPU only.

Key rotation: new writes use the current master key. Old objects stay readable while
`TOKEN_ENCRYPTION_KEY_PREVIOUS` is set. Only one previous key is read. No rewrap job exists; a
rewrap would re-upload every object. The decorator has no key cache (SEC).

Fixes to the moved crypto modules (D13): an unknown key provider id throws; empty or missing
associated data throws. SEC also asks that `TOKEN_ENCRYPTION_KEY_PREVIOUS` is trimmed and that an
unusable value is logged once (finding F12). F12 is not in the decisions and is not a blocker in the
security plan.

### 4.4 Object key layout

- Object key: `[<prefix>/]<tenant>/<ns>/<key>`, tenant `default`.
- `ns` and `key` are validated with the same `isValidId` rule as the filesystem: ASCII letters,
  digits, `.`, `_`, `-`, at most 100 characters. The filesystem's reserved keys (`.prefixes`,
  `.tmp_*`) are rejected too.
- `_ihub` is a reserved namespace for the key check and probe objects.
- `list`: `ListObjectsV2` with `Prefix`, `MaxKeys = clamp(limit, 1, 1000)` and `StartAfter`. The
  cursor is the same `base64url({k})` the filesystem store uses. S3 continuation tokens are not
  used; they are backend-specific and can expire.
- Order: S3 returns keys in UTF-8 byte order. For the allowed ASCII keys this equals the contract's
  order. `list` checks that each page is ascending and throws `IO_ERROR` if not. S3 Express
  directory buckets do not sort and are not supported.
- `scan` uses the base implementation, which pages `list` with 1000 keys.
- The backend must offer strong read-after-write and list-after-write consistency.
- No key segment may hold personal data. SEC asks for a test that an e-mail-shaped id is rejected.

What a bucket reader sees in the keys: namespace names, random ids (for example
`chat__<chatId>__file_<24 hex>.txt`, `<projectId>__<itemId>__<versionId>`), hash-derived scopes for
evidence and crawls. No file names, no user names, no URLs.

### 4.5 Delete semantics

- `delete`: take a lock for the key, `HeadObject`, `DeleteObject`, release. The result is whether
  `HeadObject` found the object.
- The lock comes from the base provider's `LockManager`, injected by the composition. Lock name
  (ARCH): `blob-delete:<first 32 hex of sha256(ns/key)>`.
- "Only one racing delete reports true" holds as far as `capabilities.locking` reaches. Today that
  is all cluster workers on one machine. It does not hold across two instances.
- Without an injected lock manager (unit tests), an in-process promise chain per key is used.
- `deletePrefix`: list the prefix, then `DeleteObject` per key with concurrency 8, and count the
  successful deletes. No `HeadObject`, no lock, no batch `DeleteObjects` call.
- Conditional deletes (`If-Match`) are not used. One tested emulator ignored them.
- The adapter logs delete failures. Many callers swallow delete errors (ENG).
- Cost: every single-blob delete is one lock and two requests.

### 4.6 Startup and key check

Order at start:

1. The master key is initialised before storage. `tokenStorageService.initializeEncryptionKey()`
   moves before `bootstrapStorageOrExit` in `server/startup/worker.js` and `server/startup/primary.js`
   (helper `ensureEncryptionKey()` in `server/startup/bootstrap.js`). The key check, an `ENC[...]`
   secret key and an `ENC[...]` proxy URL all need the key at bootstrap.
2. The base provider is initialised.
3. The S3 client is built.
4. The key check runs.
5. One write, read and delete probe of `_ihub/probe-<uuid>` runs through the encrypting store. It
   proves endpoint, TLS, credentials, bucket and the three permissions with one code path.
6. The boot warning is logged if the base provider's blob facet still holds blobs in a known
   namespace (D9).

Any failure in steps 1 to 5 makes the bootstrap fail (D6). The message says which step failed. The
bucket is never created by iHub; a missing bucket is a configuration error.

Key check rules (D7, with the security plan's rule set):

| Situation | Result |
| --- | --- |
| Marker `_ihub/keycheck` exists and decrypts with the current or the previous key | Continue. |
| Marker exists and does not decrypt | Refuse to start. The message names the key id in the object and the key id in use. |
| No marker and the prefix is empty | Write the marker. |
| No marker and the prefix holds objects | Refuse to start. |
| The master key was generated in this start and is not persisted (`keySource` is `generated-unpersisted`) | Refuse to start (SEC). |

Open points of the key check:

- The security plan proposes an override `IHUB_S3_ADOPT_BUCKET=true` for one start in the fourth
  case. Decided (A2): built as proposed, with a warning in the log.
- The copy command (4.9) writes objects before the first start with S3. Decided (A2): whoever
  first writes into an empty prefix writes the marker, so the copy command does. A dry run and
  `storage:check` do not.
- The marker's name is `_ihub/keycheck` (D7). Decided (A2): its payload is
  `{ format: 1, naming: "plain", installationId, createdAt }`.
- The marker is used only when encryption is enabled (R3).
- A cloned installation with the same master key is not caught. The rule is: one prefix per
  installation.

Bucket versioning (SEC): the plan had the adapter call `GetBucketVersioning` at start and warn when
versioning is enabled. **Not built.** The adapter never asks for the versioning state, the object
lock configuration or the lifecycle rules, and nothing is logged about them. The documentation
tells operators what versioning and object lock mean for deleted objects, and that they have to
check these bucket settings themselves (`docs/storage.md`, "Versioning and object lock").

### 4.7 Transport and credentials

- Agent (D16): a new helper `createDedicatedAgent(url, { keepAlive: true, maxSockets }, platformConfig)`
  in `server/utils/httpConfig.js`. It uses the same routing and bypass code as `createAgentWithTls`
  (`describeProxyRouting`, `getTlsBypassOptions(url)`, `guardedLookup`,
  `TlsForwardingHttpsProxyAgent`) and returns an agent that the caller owns.
- `getSSLConfig` and `getProxyProvenance` / `getProxyConfig` get an optional `platformConfig`
  argument. The storage bootstrap passes the raw `platform.json`.
- `ssl` is editable at runtime (`/api/admin/ssl/config`). ENG proposes to rebuild the client when
  the SSL or proxy settings change. The architect's plan builds the client once. Decided (A13): the
  client is built once and a change of these settings reaches it after a restart.
- The bypass is decided per host. With virtual-hosted addressing the host is `<bucket>.<endpoint>`,
  which may not match the whitelist entry. Path-style addressing is the default.
- Plain `http://` is refused at start unless the host is loopback (`localhost`, `127.0.0.0/8`,
  `::1`) or `allowInsecureHttp` is `true`. The opt-in logs a warning at every start.
- Client options: static `credentials`, `forcePathStyle`, `region`, `maxAttempts: 3` (standard retry
  mode), connection timeout 5 s, request timeout 60 s, both checksum settings `WHEN_REQUIRED`,
  `followRegionRedirects` off.
- Requests: `PutObject` with a `Buffer` body and explicit `ContentLength`. `GetObject` body via
  `transformToByteArray()`. Operations used: `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`,
  `ListObjectsV2`, and `HeadBucket` (at start, in the check, and in `delete` to tell a missing key
  from a missing bucket). `GetBucketVersioning` was planned and is not sent.
- Size check (D16, SEC finding F11): reject a `put` above a maximum. On `get`, compare
  `Content-Length` with the maximum before reading the body, and stop reading at the limit when the
  header is missing. The plans name 20 MB (PM, project limit), 25 MiB (QE, ENG, default upload
  limit) and "a configured maximum" (SEC). Decided (A3): a setting, `maxObjectBytes`, default 64 MiB.
  Built with a default of 128 MiB.
- Credentials (D5): static only. The default credential chain, session tokens, instance roles and
  web identity are not used.
- Logging (SEC): never log the secret key, the `Authorization` header, keys of any kind, plaintext,
  ciphertext, plaintext hashes, whole SDK error objects or whole config objects. Log the error
  `name`, the HTTP status and the request id. Namespace and key may be logged at warn and error.
- One module owns the SDK import. SEC proposes a lint rule that forbids `@aws-sdk/client-s3` elsewhere.

Least-privilege bucket policy for the docs (SEC): `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`
on `BUCKET/PREFIX/*`; `s3:ListBucket` on the bucket with a prefix condition. The plan also listed
`s3:GetBucketVersioning`; it is not needed, because that request is not sent. Bucket side: block public access, deny requests without TLS, one bucket or one prefix
per installation.

### 4.8 Error mapping

| S3 or SDK result | iHub result |
| --- | --- |
| `NoSuchKey`, 404 on `GetObject` | `get` returns `null` |
| `NotFound`, 404 on `HeadObject` | "did not exist" |
| `NoSuchBucket`, `AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`, 401, 403 | `StorageError` code `STORAGE_UNAVAILABLE` (503). The message names the cause. |
| Timeouts, `ECONNREFUSED`, `ENOTFOUND`, TLS errors, 5xx, `SlowDown` after retries | `StorageError` code `STORAGE_UNAVAILABLE` |
| Envelope or AEAD failure, plaintext where ciphertext is expected | `StorageError` code `CORRUPT_BLOB` (new, 500) |
| Key cannot be unwrapped, unknown key id | `StorageError` code `KEY_UNAVAILABLE` (new, 503). The message names the key id the object wants. |
| Invalid namespace or key | `InvalidKeyError` |
| Bad cursor | `StorageError` code `INVALID_CURSOR` |
| Anything else | `StorageError` code `IO_ERROR` |

- `CORRUPT_BLOB` and `KEY_UNAVAILABLE` are added to `STORAGE_CODE_STATUS` in `server/storage/errors.js`.
- A 403 or a missing bucket is never mapped to "not found".
- A write whose key provider fails throws before any upload.
- API responses for storage failures carry a registry code and a generic detail. They carry no
  endpoint, bucket, object name or remote message (SEC).
- The UX plan proposes two user-facing registry codes, `FILE_STORAGE_UNAVAILABLE` (503, temporary)
  and `FILE_UNREADABLE` (500, permanent), with English and German texts. Decided (A11): not in v1.
  Built: the registry codes `CORRUPT_BLOB`, `KEY_UNAVAILABLE`, `BLOB_TOO_LARGE` and
  `INVALID_STORAGE_CONFIG` have English and German texts.

### 4.9 Existing blobs and the copy command

- After the switch the server reads blobs only from the bucket. Blobs written before the switch
  stay on disk and are not read. Nothing is deleted on disk.
- `npm run storage:copy-blobs` (built as `server/storage/commands/copyBlobs.js`, also reachable as
  `node server/storage/commands/run.js copy-blobs`) copies from the filesystem to S3.
  For each known blob namespace it scans the source, reads each blob, writes it to the target
  through the encrypting store, reads it back and compares the SHA-256.
- It has `--dry-run`. It is idempotent: a second run copies nothing.
- It prints copied, skipped and failed counts.
- It needs the complete namespace list (D17).
- Procedure: stop the server, run the copy, set `storage.blobs.provider`, start.
- Boot warning (D9): while S3 is active and local blobs exist, one warning names the namespaces and
  the copy command. PM and UX also want the count per namespace in the warning. Decided (A6): the
  warning carries the counts.
- Switching back to the filesystem is not supported in v1. The docs must say that objects written
  to the bucket in the meantime are not visible on disk.
- After a successful copy, a plaintext copy of every file is still on the server until the operator
  removes `contents/data/blobs` by hand.

Differences between the plans that D9 narrows or leaves open: the architect's plan has the command
work in both directions and has a `--delete-source` flag. D9 limits the direction to filesystem to
S3. PM requires that the command never deletes a source file. Decided (A5): there is no
`--delete-source`; the command never deletes. Built in addition: a blob that is in the bucket with
other content is a conflict, is left alone on both sides and makes the command exit with 1;
`--namespace=<name>` limits the run; exit codes are 0, 1 and 2 (wrong usage).

### 4.10 Local backend and CI

- In-repo server (D10): `server/tests/support/fakeS3Server.js`. It uses `node:http`, path-style
  addressing, the five operations, `list-type=2` with `prefix`, `max-keys` and `start-after`, and
  sorted output. It has hooks for fault injection (status code, delay, cut body) and a request log.
  It can serve HTTPS with a self-signed certificate for the whitelist test.
- The same server runs standalone as `npm run s3:dev` with data in a directory. It checks that a
  SigV4 header is present. It does not verify signatures. It is marked as development only.
- versitygw: `docker/docker-compose.s3.yml`. Apache-2.0, named in spike SP-2 of #2906. Pinned image,
  port bound to `127.0.0.1`, credentials from variables with obviously fake defaults, a "development
  only" comment, not referenced by the production compose file. The dev bucket is created by a
  script, not by the adapter.
- Inside compose the app reaches the service by service name, which is not loopback. The dev
  configuration sets `allowInsecureHttp` there (SEC).
- CI: a workflow starts versitygw and runs the S3 suites with `IHUB_TEST_S3_REQUIRED=1`. With that
  variable a missing or unreachable endpoint fails the suite instead of skipping it.
- The S3 conformance runner builds a composed provider (filesystem base, encrypting store over the
  S3 store) and runs the sections `'the blob facet'`, `'key-prefix listings'` and `'prefix deletes'`
  of the unchanged conformance suite. A second run targets `IHUB_TEST_S3_ENDPOINT` when it is set.
- Suites on the in-repo server run in the existing unit test job. They are not proof of S3
  compatibility. Only the versitygw run exercises SigV4, path-style and checksum settings.

Decided (A7): a new workflow `.github/workflows/s3-storage-tests.yml` starts the compose file, sets
`IHUB_TEST_S3_REQUIRED=1` and fails on skipped tests; no nightly run and no test-count floor. The
in-repo server stays at the path D10 names, with its helpers under `server/tests/support/`. Neither
the compose file nor the workflow has been executed yet. The test files and how to run them are in
`2026-11-20 S3 Blob Storage Test Suites.md`.

Rejected backends: `s3rver` (unmaintained, fails paging on Node 22), `fauxqs` (wrong list order,
lost keys), `s3-test-server` (one month old, one maintainer), MinIO (AGPL), `aws-sdk-client-mock`
(mocks the client, so request handler, TLS and proxy are never exercised).

### 4.11 Admin status endpoint and card

- `GET /api/admin/storage` (admin only, `Cache-Control: no-store`): returns the last probe result
  the server holds. It does not call the bucket on every request. Content (D11): running versus
  configured backend, `restartRequired`, `status`, `encryption.scope`, the endpoint host only, no
  credentials (not even a redaction mask).
- `status` is `ok`, `degraded`, `error` or `unknown` (UI). `encryption.scope` is `all`,
  `project-files` or `none`; the filesystem backend today is `project-files`. The server computes
  the scope; the client never derives it from the provider name.
- `POST /api/admin/storage/_test` (no body): runs a live round trip against the running backend
  (write a probe object, read it, decrypt and compare, delete it). A failed probe is a 200 with
  `status: "error"`. Only "the test could not run" is a problem+json error.
- Card: read-only, on `/admin/system-resources`, under "Disk space", in English and German. It shows
  backend, endpoint host, bucket, region, prefix, status, the encryption line, where the setting
  comes from, and a restart notice when configured and running backend differ. One action runs the
  test. No new route, so the known-routes lists do not change.
- Accessibility (UI): status is icon plus text, rows are a definition list, the test result goes to
  a live region, polling does not announce, and the axe baseline stays unchanged.
- The admin-wide banner is cut (D11).

Decided (A8 to A10) and built:

- The response shape follows the UI plan: `blobs` (`provider`, `status`, `latencyMs`, `checkedAt`,
  `location`, `encryption`, `source`, `error`, `steps`), `documents`, `restartRequired`,
  `configuredBlobProvider`, `localLeftovers`, and a top-level `encryption` for the whole
  installation (`enabled`, `scope`, `conversion`, `sealedDataExists`). No `pendingDeletes`.
- `blobs.encryption.scope` is `all` or `none`. The top-level `encryption.scope` is `none`, `blobs`
  or `storage`. The planned value `project-files` does not exist.
- The card title is "Blob storage" / "Blob-Speicher".
- The held check result is refreshed when it is older than a minute, on a read of the endpoint. A
  read waits at most two seconds for the refresh. Each cluster worker holds its own result.
- `/api/health` has `storage.blobs: { provider, status }`.
- `restartRequired` compares backend, bucket, prefix, region, endpoint, size limit and the
  encryption switch. It does not see changed credentials or timeouts.

### 4.12 Check command

- `npm run storage:check` runs without the server. It reads the configuration from disk and
  environment as the server would after a restart.
- It prints one line per named step and exits with 0 or 1.
- It uses the same probe and the same error classifier as startup and the admin status (D12).
- Steps in the UX plan: configuration complete; endpoint reachable with TLS verified; credentials
  accepted and bucket found; write, read back and delete a test object; encryption key matches the
  bucket; files still on local disk (warning only).
- The UX plan defines a classifier table with a code, an English and German sentence and a hint per
  failure (`S3_CONFIG_INCOMPLETE`, `S3_ENDPOINT_UNREACHABLE`, `S3_TLS_UNTRUSTED`,
  `S3_CREDENTIALS_REJECTED`, `S3_CLOCK_SKEW`, `S3_BUCKET_NOT_FOUND`, `S3_ACCESS_DENIED`,
  `S3_REGION_MISMATCH`, `S3_ADDRESSING`, `S3_PROBE_MISMATCH`, `BLOB_KEY_MISSING`,
  `BLOB_KEY_MISMATCH`). D12 requires one classifier but does not fix the code list.
- Logs and command output are English. German goes into the docs and the UI.
- Built: `server/storage/commands/storageCheck.js`, with `--json` and `--verbose`. Where `npm` is
  not present: `node server/storage/commands/run.js check`. Exit codes 0 (usable), 1 (not usable),
  2 (wrong usage). The built code list is the table in `docs/storage.md`; `S3_ADDRESSING` was not
  built, and `S3_SERVICE_ERROR`, `S3_ERROR`, `BLOB_KEY_CHECK_MISSING`, `BLOB_CORRUPT`,
  `BLOB_PROVIDER_UNKNOWN` and `BLOB_STORAGE_ERROR` were added. It never writes the key-check marker.

## 5. Requirements and acceptance criteria

From the product manager's user stories and the quality engineer's definition of done, adjusted to
the decisions. "Tier A" is the in-repo S3 server. "Tier B" is versitygw.

Configuration:

- [ ] With `storage.blobs.provider: "s3"` and complete settings, the startup log has one line that names the blob backend, the endpoint host and the bucket, and never the secret.
- [ ] A chat file upload creates an object under `default/chat-files/…` and no new file under `contents/data/blobs/chat-files/`.
- [ ] With no `storage.blobs` block, behaviour and the `contents/` tree are identical to the previous release. Existing byte-identity and conformance tests stay green.
- [ ] An existing `platform.json` from the previous release validates and keeps blobs on the filesystem. No migration runs (D14).
- [ ] `IHUB_STORAGE_BLOBS_PROVIDER` selects the blob backend and beats the file.
- [ ] Invalid settings are rejected: missing bucket, endpoint that is not a URL, endpoint with embedded credentials, bucket with `/` or upper case, prefix with `..` or a leading `/`, access key without secret and the reverse.
- [ ] No configuration value turns encryption off for the S3 store. If such a switch exists, a test fails.
- [ ] The docs say that a change of the blob backend needs a restart.

Nothing readable in the bucket:

- [ ] A known plaintext marker is written once through each of the six namespaces, through the domain repositories. A raw read of every object in the bucket does not contain the marker as UTF-8, UTF-16LE, base64 or hex.
- [ ] No 16-byte window of a random payload occurs in any object.
- [ ] Every object starts with the envelope magic and decrypts with the test key provider.
- [ ] The namespace list of the test comes from code. A guard test fails when a new `blobs.put` namespace is not covered.
- [ ] A mutation check proves the scanner: one plaintext object written with the raw client is reported.
- [ ] Object keys contain ids only. A file named `geheim-vertrag.pdf` does not occur in any key or in the S3 user metadata.
- [ ] Every object has `Content-Type: application/octet-stream`, whatever hint was passed.
- [ ] With S3 active, `contents/data/blobs/` stays empty.
- [ ] No object is uploaded unencrypted, also not on a retry or an error path.

Encryption layer:

- [ ] A read returns the exact bytes written, for 0 bytes, 1 byte, exactly 1 MiB, 1 MiB + 1 byte and 20 MB, and at the segment boundaries.
- [ ] One flipped byte in header, salt, any segment or tag makes the read fail with `CORRUPT_BLOB`. No partial plaintext is returned.
- [ ] Truncated, extended and reordered objects are rejected. So are a zero-byte object and a plaintext object.
- [ ] An object copied to another key, namespace or tenant does not decrypt.
- [ ] Missing associated data, an unknown key provider or a missing master key makes `put` throw. Nothing is uploaded.
- [ ] `bytes` on `put`, `get` and `list` is the plaintext size. A listing issues no `GetObject`.
- [ ] An object written under the old master key reads with `TOKEN_ENCRYPTION_KEY_PREVIOUS` set, and fails with a message that names the key id without it.
- [ ] Recorded envelope vectors are committed and pass: empty, 1 byte, boundary, boundary + 1, multi-segment, written with a previous key.
- [ ] A `project-files` blob round trips through the envelope and `readText` still verifies its hash.

Conformance and contract:

- [ ] The blob sections of the conformance suite pass against the S3 backend, with the suite file unchanged, on tier A and tier B.
- [ ] Of two racing deletes exactly one reports `true`, also in a two-process test.
- [ ] 1001 keys are all returned by `scan` and all removed by `deletePrefix` (tier B).
- [ ] `get` of a missing key returns `null`. `get` against a missing bucket or with a 403 throws.
- [ ] Path-like keys and `deletePrefix('')` are rejected before any request is sent.
- [ ] `put` is one request, `get` is one request.

Credentials and secrets:

- [ ] After an admin save, `platform.json` on disk holds the secret key encrypted.
- [ ] An admin read of the platform config returns the redacted placeholder. Saving the placeholder back keeps the stored secret.
- [ ] A `${ENV}` placeholder is resolved at runtime and left alone by encryption. An unresolved placeholder fails at start with a message that names the variable.
- [ ] The secret never appears in logs, error bodies, `healthCheck()` details or the admin status. A logger spy test covers put, get and a failed get.

Failure behaviour:

- [ ] An unreachable endpoint, a missing bucket or rejected credentials at start make the bootstrap fail with a `StorageBootstrapError` that names the failing setting, in bounded time. In a cluster the primary checks once before forking.
- [ ] The server never comes up on a local filesystem blob store instead.
- [ ] The adapter never sends `CreateBucket`.
- [ ] When the bucket fails at runtime, an upload answers a problem+json 503 with a registry code. The chat stays usable. Nothing is written to local disk. After the bucket is back, the next call works without a restart.
- [ ] Timeouts and retries are bounded. A truncated body is never returned as a file.
- [ ] A TLS endpoint with a private CA works when its host is on `ssl.domainWhitelist`, and fails with a certificate error when it is not. With a proxy configured, S3 traffic goes through it.
- [ ] The S3 provider directory contains no `rejectUnauthorized` literal.
- [ ] Plain http is refused, loopback is allowed, the opt-in is allowed.
- [ ] An oversized object is refused before the body is buffered.
- [ ] The key check rules of section 4.6 each have a test. A server with a different master key on the same bucket does not serve garbage bytes.

Existing files, deletion, key:

- [ ] With S3 active and local blobs present, one startup warning names the namespaces and the copy command.
- [ ] After the copy command, every filesystem blob exists in the bucket encrypted. The command prints copied, skipped and failed counts. A second run copies nothing.
- [ ] When a chat is deleted, no object with that chat's prefix remains in the bucket, for chat files, evidence and artifacts.
- [ ] The docs state: losing the master key makes every object in the bucket unreadable; back the key up separately from the bucket; the admin backup export does not contain the bucket; do not enable versioning or object lock; a rollback to the filesystem does not show objects written to the bucket.

Development and end to end:

- [ ] One documented command starts a local S3 endpoint and one documented config snippet points iHub at it.
- [ ] The S3 conformance suite runs without Docker.
- [ ] One end-to-end run through the real server entry point passes on tier B: upload, read, restart, read again, delete, bucket empty for that chat.
- [ ] The S3 workflow has zero skipped tests.
- [ ] The envelope module has 100 % branch coverage. The S3 adapter has 90 % line coverage (QE target).
- [ ] The binary build (`npm run build:binary`) still works.
- [ ] One run against real AWS S3 by hand before release, with the result recorded in the ticket (QE).

Admin status and check command (from the UX and UI plans, for D11 and D12):

- [ ] `GET /api/admin/storage` is admin only, contains no credential, shows the endpoint as host only, and reports `restartRequired: true` after the file was edited without a restart.
- [ ] The card shows "all content encrypted" for S3 and the honest "only project files are encrypted" line for the filesystem.
- [ ] The card is complete in English and German, operable by keyboard, and the axe baseline is unchanged.
- [ ] `npm run storage:check` exits 1 with the same code that the startup log shows for the same failure.

Non-functional (proposals, not agreed budgets):

- Performance: PM asks that a 20 MB put or get against a local endpoint adds at most 1 second over the filesystem backend. QE proposes budgets relative to the filesystem run on the same machine (fail above 3 times the filesystem time plus 2 s), measured nightly, not in pull requests.
- Memory: PM states "held in memory once on write and once on read". ENG measured about three copies on `put`. QE proposes peak RSS growth under 4 times the payload. The docs must state the real factor.
- Compatibility: only the five object operations. No checksum mode that non-AWS servers reject.

## 6. Threat model in short

Source: the security plan. The claims and the table below describe an installation with
`storage.encryption.enabled` on. The plan had no off switch (D2); since R3 (section 11.1) the
switch can be off, and then a bucket reader reads the content. The defensible claims are:

- Someone who can read the bucket learns no content.
- Someone who can write the bucket cannot make iHub accept changed, swapped, moved, truncated or
  plaintext content. They can delete, withhold and, for keys that are overwritten, roll back.
- Object names, sizes, counts and timing stay visible.

| Attacker | Can do | Cannot do |
| --- | --- | --- |
| Bucket reader (leaked read key, public bucket by mistake, bucket backup) | List names. Read ciphertext. See sizes, counts, modification times. See which master key generation wrapped an object (key id). | Read content, content types or file names. |
| Bucket writer: change, truncate or extend bytes | Make the object unreadable. | Get the change accepted. Every segment has a GCM tag, and nothing is returned until all segments verify. |
| Bucket writer: swap or move objects | Make the object unreadable. | Get it accepted. Tenant, namespace and key are in the associated data. |
| Bucket writer: replay | Put back an older object that was stored under the same key. This is accepted. Keys are reused at least in `website-corpora`. | Forge new content. |
| Bucket writer: resurrect a deleted object | Put a saved copy back. The orphan sweep deletes it later. Erasure is undone until then. | Make iHub serve it; the referring document is gone. |
| Bucket writer: delete or withhold | Delete anything. This cannot be told from real loss. Bucket backups are the only defence. | (none) |
| Bucket writer: plaintext object | Store plaintext under a valid name. | Get it accepted, as long as reads fail closed (D18). |
| Bucket writer: huge object | Try to exhaust memory on read. | Succeed, if the size is checked before buffering (D16). |
| Network attacker, TLS on | See traffic volume and timing. | Read or change anything. |
| Network attacker, plain http | Read names and ciphertext. Replay a signed PUT or DELETE inside the signature validity window. | Read content. Learn the secret key. |
| S3 operator | Everything a reader and writer can. Keep copies forever. | Read content. |
| Holder of stolen S3 access keys | Read and write within the bucket policy. Delete everything. | Read content. |
| Holder of the master key alone | Decrypt `platform.json` secrets, including the S3 secret key, if they also hold that file. | Read the bucket without bucket access. |
| Holder of the master key plus bucket read | Decrypt everything, including old versions and bucket backups. Forge valid objects. | (none) Only a rewrap would help, and it does not exist. |
| Holder of a `contents/` backup | Has the key file, the config and the S3 credentials. Total access. | (none) |
| Second installation on the same prefix | Its orphan sweeps delete the other installation's objects. | Read them, if its master key differs. The key check refuses the start in that case. |

What stays visible in the bucket: namespace names, ids in object names, the grouping and number of
files per chat or project, the plaintext size to within 16 bytes per MiB, write times and activity
over time, and the key id (8 hex characters, the same value as the start of the key fingerprint in
the server log).

Further points:

- The master key protects the bucket and the S3 credentials. One secret opens both. All tenants
  would share one master key and one credential; tenant isolation is logical only.
- A delete is an erasure only if the delete is real. With bucket versioning, object lock,
  replication or bucket backups, old versions keep their wrapped key and open with the master key.
- SSE-S3 and SSE-KMS are defence in depth only. The adapter has no option for them. SSE-C is not used.
- The wrap uses a random 96-bit IV under the master key. That is safe up to about 2^32 wraps per
  master key. A rewrap counts against this bound.
- The master key is used for config secrets, token files and key wrap without domain separation
  (SEC finding F15). No attack was found. Not changed in this work.
- The release note must not say "iHub data is fully encrypted". It may say "everything in the bucket
  is encrypted". Chat documents and append logs on disk are plaintext (#2316).
  **Overruled by R2 and R3 (section 11.1):** with `storage.encryption.enabled` on, chat documents
  and append logs are encrypted too; with it off, nothing is, the bucket included. What is and is
  not encrypted is listed in `2026-11-20 Storage Encryption at Rest.md`.

## 7. Consolidated pre-mortem

The question to each role was: it is six months later and this failed; what were the causes? The
table merges the seven lists. "v1 covers" says whether the decided scope prevents the cause.
Different likelihoods from different roles are kept.

| # | Cause | Raised by | Likelihood | Damage | Prevention | v1 covers |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | The master key is lost, was not backed up, or a redeploy with an empty `contents/` volume or a second pod generated a new one. | ARCH, SEC, UX, PM, ENG, QE | High (ARCH, SEC, UX). Medium (PM, ENG, QE). | All blobs unreadable, permanently. | Key check marker and refusal to start. No start with a freshly generated key. Docs: back up the key separately; use `TOKEN_ENCRYPTION_KEY` from a secret store. | Yes for a wrong or missing key at start (D6, D7). The key backup is the operator's task; docs only. |
| 2 | The previous key is removed before objects are rewrapped, the key is rotated twice, or a malformed `TOKEN_ENCRYPTION_KEY_PREVIOUS` is ignored silently. | ARCH, PM, ENG, QE, SEC | Medium | Objects written under the old key are unreadable. | Docs: keep the previous key; do not rotate twice. Rotation test. Trim and log an unusable value. | Partly. Docs and test. No rewrap job. The trim-and-log fix is not in the decisions. |
| 3 | An existing installation is switched to S3 without a copy. Old files look deleted. The operator rolls back and loses the uploads made since. | ARCH, PM, ENG, UX, UI | High | Looks like data loss. Support cases. Real loss on rollback. | Boot warning, copy command, check command step, docs and release note. | Yes for the forward path (D9). Switching back is unsupported and only documented. |
| 4 | The operator expects a stateless container and removes the volume, or the release note or sales promise multi-instance without a shared volume. | UX, PM | Medium (UX). High (PM). | Chats and configuration lost, or a wrong architecture at the customer. | Say in docs, check output, release note and tickets what stays on disk. Reviewers check every text for the multi-instance claim. | Docs and wording only. |
| 5 | "Fully encrypted" is read as "the filesystem too" or "chat messages too", or the release note says "all data encrypted". | PM, SEC | Medium | Rework, loss of trust, contract damage. | Exact wording in hand-over and release note. The card shows the encryption scope honestly. | Yes, by wording and `encryption.scope` (D11). The question to the requester is open. |
| 6 | The requester wanted S3 as the whole storage provider. | PM | Low to medium | The wrong thing was built. | Put the reading first in the hand-over. | No. It is an assumption (section 8). |
| 7 | A customer backend behaves differently from the test servers: checksums, path style, `StartAfter`, list order, paging, 404 shape, signing, error names. A workaround then switches off verification. | ARCH, PM, ENG, QE, SEC, UX | Medium (ARCH, ENG, SEC, UX). High (PM, QE). | The feature does not work at that customer, or integrity checks are weakened. | Checksums `WHEN_REQUIRED`, path style by default, order assertion in `list`, env-gated conformance run against any endpoint, versitygw in CI, a manual run on AWS S3 and one customer backend. Integrity never depends on S3 features. Classify errors on HTTP status and S3 code. | Partly. versitygw in CI (D10). AWS S3 and customer backends are not tested. |
| 8 | Only the in-repo server was tested. The work is reported done without a run against a real server. | ARCH, PM, QE | High | Ships broken against real S3. The requester finds the first bug. | The versitygw job is a merge gate. The hand-over lists what was verified and what was not. | Partly. The gate is planned (D10). At planning time nothing was verified against a real server. |
| 9 | The S3 suites are skipped in CI for months (no endpoint, paths filter, `describe.skip`). | QE | High | A regression ships: unreadable data or plaintext in a bucket. | `IHUB_TEST_S3_REQUIRED=1`, a skipped-test count, a test-count floor, tier A always in the unit job. | Partly. The variable is decided (D10). The count and the floor are in the QE plan only. |
| 10 | The TLS whitelist or the proxy is ignored because the client is built before the config cache exists. Someone then "fixes" it with a global `rejectUnauthorized: false`. | ARCH, ENG, QE | High if not designed for (ARCH, ENG). Medium (QE). | Server does not start at customers with a private CA, or TLS verification is off for everything. | Raw `platform.json` passed to the dedicated agent. A test through the real bootstrap path. A static guard on the literal. | Yes (D16). |
| 11 | The secret is `ENC[...]` at bootstrap and is sent as the secret key. | ENG | High | Start fails after the first admin save. | Decrypt in the storage path. Initialise the key before storage. Test with an encrypted value. | Yes (D15, D7). |
| 12 | `S3Client.destroy()` destroys a shared agent, or an import cycle `storage → httpConfig → configCache → storage` appears. | ARCH | Medium | All outbound calls fail after a storage shutdown, or the server does not boot. | Dedicated agent only. Dynamic import of `httpConfig` in the client factory. Boot check. | Yes for the agent (D16). The import cycle needs a check during implementation. |
| 13 | No keep-alive agent. Every blob call opens a TLS connection. | ENG | Medium | Slow chats with many evidence packs. | Own keep-alive agent. | Yes (D16). |
| 14 | S3 is down at boot. | ARCH, UX, QE | Medium | iHub does not start although chats without files would work. | Accepted and documented. Timeouts 5 s and 60 s, 3 attempts, clear errors. | Accepted. UX wanted a degraded start and was overruled (D6). QE's concern that the server comes up on a plaintext local store is covered by D6. |
| 15 | S3 fails at runtime and nobody notices: credentials rotated on the S3 side, health looks green, the card is not opened. | UX, UI, ENG | Medium | Uploads fail for days. | Status in the admin endpoint, error log on state change, a field in `/api/health` for monitoring, a round-trip test instead of a passive check. | Partly. Cached status and `_test` (D11). `/api/health` has the field (A10), but it holds the last check result and nothing checks in the background, so this risk is still open for monitoring. The admin-wide banner is cut. |
| 16 | Deleted content stays in the bucket: versioning or object lock is on, a delete fails during an outage and is never retried, or a crash leaves an orphan. | SEC, PM, UX, ENG | Medium | A deletion request is not met. Compliance or privacy finding. | `GetBucketVersioning` warning at start. Docs and lifecycle rule. Log delete failures in the adapter. Orphan sweeps. UX proposes a retry queue with a visible count. PM proposes a reconciler. | Partly. Docs and logging. The `GetBucketVersioning` warning was **not built** (section 11.2): the operator has to check versioning, object lock and lifecycle rules. No retry queue and no reconciler. |
| 17 | The delete race is not excluded: two crawl hand-overs both claim a page, or neither does. | ENG, QE | High without the lock (ENG). Medium in a two-instance deployment (QE). | Duplicate or lost project items, hard to reproduce. | Lock, `HeadObject`, `DeleteObject`. Conformance race test. Two-process test. | Yes on one machine (D8). Not across instances. QE warns that a green single-process suite is not proof. |
| 18 | The delete lock creates thousands of lock files. | ARCH | Low | Slower deletes, more files until the nightly sweep. | `deletePrefix` takes no lock. Measure. | Yes, with a measurement during implementation. |
| 19 | Plaintext reaches the bucket: a namespace missed by a hard-coded list, a new write path that skips the adapter, a retry path, a content type, a file name in a key. The card still says "encrypted". | PM, QE, SEC, UI | Medium | The central promise is broken. A false security statement in the product. | Encryption in the decorator with no skip list. Nothing-readable test with namespaces from code and a guard on `blobs.put`. One module owns the SDK import. The server computes the encryption scope. | Yes (D2, D17, D11). The lint rule and the guard test are in the role plans only. |
| 20 | A developer adds "if it does not start with the magic, return it" to ease a migration. | SEC | Medium | Plaintext injection. False encryption claim. | Reads fail closed. Tamper test with the plaintext case. Review rule. | Yes (D18). |
| 21 | Two installations share one prefix (staging cloned from production). The sweeps of each delete the other's files. | SEC | Medium | Silent loss of production files. | Key check marker. One prefix and different credentials per installation. | Partly. A clone with the same master key is not caught. |
| 22 | Large uploads exhaust memory or block the event loop, several at once, or a hostile large object does. | ARCH, PM, ENG, QE, SEC | Medium (ARCH, PM, QE, SEC). Low at 25 MB (ENG). | Worker out of memory. Latency spikes. | Size check before buffering. Existing upload limits. Document the memory factor. Nightly memory and event-loop checks. Streaming as a follow-up. | Partly. Size check (D16). No streaming path. The maximum is `maxObjectBytes`, 128 MiB by default (A3). |
| 23 | The envelope format or its constants change in a refactor. Old objects stop opening, or `list` sizes are wrong. | ARCH, QE | Low (ARCH). Medium (QE). | Existing installations lose files after an upgrade. Wrong quotas. | Recorded vectors that must keep passing. Version byte. A new magic for a new version. | Yes (D3). |
| 24 | The header becomes variable, or someone "fixes" `list` with a `HeadObject` per key. | ENG | Medium | Listings far slower. Evidence size wrong. | Fixed header. Unit test for the size formula at segment borders. Request count test. | Yes (D3). |
| 25 | The secret key or a request body appears in a log or an admin read. An unrelated admin save writes `***REDACTED***` back as the secret. An endpoint URL with credentials is rendered. | SEC, QE, UX, UI | Medium (SEC, UX). Low to medium (QE). Low (UI). | Credential leak, or an outage after an unrelated save. | No logger on the client. Logger spy test. Redaction and encryption wiring. Endpoint host only in the status. | Yes (D5, D11, D15). |
| 26 | A 403 or a missing bucket is mapped to "not found". Files seem to disappear and cleanup jobs report success. | QE | Medium | Data looks deleted. Slow discovery. | Error mapping of section 4.8 with tests on `get`, `list` and `delete`. | Yes (architect's error mapping). |
| 27 | A truncated download is returned as a file. | QE | Low | Corrupt documents reach users and the model. | The AEAD rejects it. Truncated-body tests on both layers. | Yes. |
| 28 | Error messages are raw SDK text. Every customer setup needs a support call. | UX | High if the classifier is skipped | Slow adoption, support cost. | One classifier with a test per row. Raw cause only in the log. | Yes for the classifier (D12). The code table is in the UX plan only. |
| 29 | The master key leaks (support bundle, backup). No rewrap exists, so the key cannot be retired. | SEC | Low to medium | Every past and present object is readable by whoever holds a bucket copy. | Rewrap job as a follow-up. Key in a secret store. | No. |
| 30 | The default credential chain is on, and an admin redirects storage to another bucket of the same cloud account. | SEC | Low | Data loss in an unrelated bucket. | Do not offer the chain. | Yes. The chain is not used (D5). |
| 31 | A customer's privacy officer judges object names to be personal data. | SEC | Low to medium | Rollout blocked at that customer. | Make the decision visible. Reject ids that look like e-mail addresses. Keep the format open for a later naming mode. | Partly. The exposure is accepted and flagged to the requester (D4). |
| 32 | The backup export is taken for a full backup. `contents/` is restored without the bucket, the bucket without the key, or from an export with an older key. | PM, ENG, UX | Medium (PM, ENG). Low to medium (UX). | Restore gives missing or unreadable files. | Backup section in the docs. A flag in `backup-metadata.json`. A notice on the backup page. | Docs, and a notice on the backup page (A11). No flag in `backup-metadata.json`. Bucket export is out of scope (D19). |
| 33 | Nobody uses the feature: configuration only in JSON, no page, no test button. | PM | Medium | Low. Effort without adoption. | Good startup errors. #2312 next. | Partly. Check command and status card (D11, D12). |
| 34 | A file cannot be loaded during a chat turn. The turn goes to the model without it. | UX | Medium | Confident answers that ignore the document. Nobody can tell afterwards. | A file that cannot be loaded blocks the chat turn. | Not in v1 (A11). |
| 35 | Admins confuse "Blob storage" with "Storage providers" (Office 365, Google Drive). | UX | Medium | Wasted time, wrong tickets. | One naming table used in UI, docs and release note. | "Blob storage" for admins (A9), used in the card, the docs and the release note. |
| 36 | The status is green although writes fail, or polling hits the bucket from every open admin tab. | UI | Medium | Admins trust a wrong status. Cost and noisy bucket logs. | The test does a write, read and delete. `GET` serves a cached result. | Yes (D11). |
| 37 | Screen reader users hear the status on every poll, or never hear the test result. | UI | Medium | Accessibility audit fails. | Live region rules of the UI plan. Unit test on roles. | Yes, if the card follows the UI plan. |
| 38 | The scope grows into the full #2312 page and the adapter slips. | UI | Medium | Late release, half-built form. | No form in v1. | Yes (D11). |
| 39 | The card is on System Resources, which is hidden when that admin page is disabled. | UI | Low | Low. Nobody sees the status. | The UI plan relied on the banner, `/api/health` and logs. | No. The banner is cut; logs remain. |
| 40 | German strings are missing or the two i18n files drift. | UI | Low | Low | Both files in the same commit. | Yes. |
| 41 | The binary build misses the dynamically imported SDK. | ARCH | Medium | S3 fails only in binary installations. | Check the build before merge. | Open. ENG states that the build copies `server/` and bundles nothing, so no change is needed. The two plans disagree; check during implementation. |
| 42 | Flaky timing tests are quarantined and the gate erodes. | QE | Medium | The suite stops meaning anything. | Deadlines instead of sleeps. No S3 entries in `QUARANTINED`. | Depends on the test implementation. |
| 43 | A young npm emulator package is compromised or abandoned. | ENG | Low | Supply-chain incident in development and CI. | No npm emulator dependency. | Yes (D10). |

## 8. Questions the team did not ask the requester

Each role listed what it would have asked and the assumption it made instead. Where roles assumed
different things, both assumptions are shown.

| # | Question | Assumption made instead | Raised by |
| --- | --- | --- | --- |
| 1 | Does "implement the S3" mean S3 for blobs, or S3 as the whole storage provider? | Blobs only. #2302 decision 4 stays. | PM, ARCH |
| 2 | "Encrypted as it is today in the filesystem": only project texts are encrypted on disk today. Should everything in the bucket be encrypted, and should the filesystem backend change too? | Everything in the bucket is encrypted. The filesystem backend does not change. | PM, ARCH, QE |
| 3 | Does "fully encrypted" include object names? Are names with chat ids, project ids, counts, sizes and times acceptable, although #2906 asks for opaque keys? | Yes, acceptable for v1. Content and user-supplied text are unreadable; ids are visible. | PM, ARCH, ENG, QE, SEC |
| 4 | Are chat, project, task and file ids random and free of personal data? | Yes. Not fully verified. | SEC |
| 5 | Is there a named customer and a named S3 product (AWS, MinIO, NetApp, Ceph, Dell ECS, versitygw)? | No named customer. Design for the smallest common subset. versitygw is the reference. SEC assumed "AWS S3 and versitygw must work"; ENG noted that none was verified. | PM, ARCH, ENG, QE, SEC |
| 6 | Must existing installations be able to switch with their files? May the server be stopped for the copy? | The roles assumed differently. ARCH and UX: yes, with an offline copy command. PM: eventually; the copy command is "Should". ENG, QE, SEC: no, fresh or empty installations only. D9 puts the copy command in scope. | PM, ARCH, ENG, QE, SEC, UX |
| 7 | Must switching back from S3 to the filesystem work? | Not in v1. Documented as unsupported. | UX |
| 8 | If S3 is unreachable at start, should iHub refuse to start or start without files? | The roles assumed differently. ARCH: refuse. UX: start without files, loudly. QE: keep today's behaviour, but never fall back to local plaintext. D6: refuse. | ARCH, UX, QE |
| 9 | Should a lost master key ever allow a start with empty storage? | Only with a new prefix, chosen by the operator on purpose. | UX |
| 10 | Is a static access key enough, or are IAM roles or the credential chain required? Should credentials live in `platform.json` or only in the environment? | Static key and secret. Both places allowed; environment placeholders recommended. | PM, ARCH, ENG, UX |
| 11 | How large can one stored object get, and what concurrency is expected? | The roles assumed differently. PM: 20 MB, as for projects. ENG: 25 MB class. QE: 25 MiB default limit and 8 concurrent uploads as the stress case. ARCH: below the existing upload limits. SEC: existing limits plus a hard cap in the adapter. | PM, ARCH, ENG, QE, SEC |
| 12 | Is the local key file enough as the key source, or does a customer need Vault or KMS now? Is one master key for config secrets and all blobs acceptable? | Yes for v1. A Transit provider is a follow-up. | PM, SEC |
| 13 | Is one previous master key enough for rotation? Is a rewrap job part of this delivery? | One previous key is enough until a rewrap job exists. The rewrap job is a follow-up. | ARCH, SEC |
| 14 | Will several iHub instances or installations share one bucket? Is it shared with iFinder? | The roles assumed differently. ARCH: no second instance soon; documents on the filesystem forbid it. QE: yes eventually (#2313), so the delete race is tested across processes. SEC: several instances of one installation yes, with the same key; several installations no, one prefix each. UX: possibly shared, so a prefix per installation is documented practice. | ARCH, QE, SEC, UX |
| 15 | Must iFinder read these objects directly? | No. #2906's revision says the products talk over REST. | ARCH |
| 16 | Is the bucket operated by a third party the customer does not trust? | Untrusted for confidentiality and integrity, trusted for availability. | SEC |
| 17 | Must a deleted file be gone for good, and how fast? May we require that bucket versioning is off? | Gone on delete, limited by the bucket's own backups and versions. We recommend; we do not enforce. The planned warning at start was not built (section 11.2): the documentation tells the operator to check versioning and lifecycle rules. | SEC |
| 18 | Is there a bucket-side expectation: server-side encryption, object lock, lifecycle rules? | None. Client-side encryption only. The operator may add SSE on the bucket. | PM, QE |
| 19 | Must an admin be able to configure S3 in the browser in the first release? Who switches the backend at customers, and who may change the storage configuration? | No. Someone with shell access switches. File and environment only until #2312. The `storage` section is not patchable through the admin API. | PM, UX, UI, ENG, SEC |
| 20 | Does the requester expect to see the S3 setting in the admin UI as proof that it works end to end? | A read-only status card is enough for v1. | UX |
| 21 | Is it acceptable that the UI says plainly that chat files and evidence are unencrypted on the filesystem backend? | Yes. It is true. | UI |
| 22 | Who sees the status card? May bucket name and endpoint host be shown to admins? | Everyone who passes `adminAuth` and has the `system` admin page enabled. Yes; the access key id is not shown. | UI |
| 23 | Should a failing bucket alert every admin on every page? Should the Overview page show the backend too? | UI assumed yes for `error` and no for the Overview page. D11 cut the banner. | UI |
| 24 | Is "File storage" the right term for admins, or "Blob storage" or "Object storage"? | UI: "File storage". UX: "Blob storage" for admins, "file storage" for users. Decided (A9): "Blob storage". | UI, UX |
| 25 | Will tenant prefixes other than `default/` exist soon? | No. | UI |
| 26 | May the boot order change (key before storage)? Should the bucket be created by iHub? | Yes; it is internal. No. | ARCH |
| 27 | Is the double encryption of project texts acceptable? | Yes. Simpler and cheap. | ENG |
| 28 | Is rollback of an overwritten object by a bucket admin a concern? | Not for v1. The associated data has no version. | ENG |
| 29 | Should the health endpoint show the blob backend? Does a monitoring system read `/api/health` today, and would a new value break it? | Yes, as an additive nested field. The top-level `status` stays `OK`. | ENG, UX |
| 30 | Is a test double acceptable as "a local S3 backend to develop against", or is a real server meant? Is a one-month-old dev dependency acceptable? | Both a test server and a compose service with versitygw. The dev dependency question no longer applies (D10). | PM, ENG |
| 31 | Can CI run Docker containers, and may a required check be added? | Yes to both. If not, the real-server run becomes a nightly job and the pull-request gate is the in-repo server only. | QE |
| 32 | Who keeps the master key backup, and has a restore ever been rehearsed? | The operator. Not rehearsed. | QE |
| 33 | Which release should this ship in, and may it ship as a preview? | Next release, as a feature, default off. | PM |
| 34 | Does "tickets updated" include new follow-up tickets? | Edits and comments on the existing tickets. Follow-ups are proposed and created after the requester's yes. | PM |
| 35 | Is FIPS or BSI conformity of the crypto required? | No. No certification is claimed. | SEC |
| 36 | May log lines be German? Do users need to be told that their files are encrypted and stored outside the server? | No; logs are English. No user-facing text; it belongs in the operator docs. | UX |
| 37 | Do the single-binary and Docker distributions have `npm`? | Not always. The check must also be callable with `node`. | UX |

## 9. Decisions roles made on their own

Each role listed decisions it took without asking. "Stands" means the lead's decisions confirm it or
are silent and precedence keeps it. "Overruled" names the decision that replaced it.

### Product manager

| Decision | Rejected alternative | Status |
| --- | --- | --- |
| The blob backend is configured separately from `storage.provider`. | A provider named `s3` that wraps the filesystem provider. | Stands (D1). |
| Encryption for all namespaces; `project-files` is encrypted twice. | Encrypt only what is plaintext today, or leave it to each service. | Stands (D2), when the switch is on (R3). |
| No fallback: no read from disk when an object is missing, no write to disk when the bucket is down. | A read-through to old filesystem blobs. | Stands (D6, D9). |
| The first release may ship without the copy command, but never without the startup warning. | Block the release until migration exists. | **Overruled by D9**: the copy command is in scope. |
| The release note does not claim multi-instance support. | Use #2318's sentence "removes the shared-volume requirement". | Stands (D19). |
| #2318 is the implementation ticket; #2906 gets a comment and stays open. | Close or tick #2906. | Stands; not covered by the decisions. |
| No admin UI in this release; #2312 gets a comment. | A small S3 form now. | Stands for the form. D11 adds a status endpoint and a read-only card. |
| Object keys keep the `(namespace, key)` shape under `default/`. | Random opaque keys with a mapping document. | Stands (D4). |
| `bytes` is the plaintext size everywhere. | Report the stored size. | Stands (D3). |
| Two local backends: an npm endpoint for tests, versitygw for the requester. | Only one of them. | **Overruled in part by D10**: the test server is in-repo, not from npm. |
| One single put, whole object in memory, a stated limit. | Streaming and multipart now. | **Changed after delivery (section 11.5)**: streamed reads and writes exist; one `PutObject` per object, no multipart. |
| `artifacts` and `website-corpora` are in scope. | Follow the brief's list. | Stands (D17). |
| A config migration is part of "Must". | (none stated) | **Overruled by D14**: no migration. |

### UX designer

| Decision | Rejected alternative | Status |
| --- | --- | --- |
| No admin page in v1: config file, check command, logs, status card. | Build `/admin/storage` now. | Stands (D11, D12). |
| A read-only status card on System Resources. | Nothing in the UI; or the Overview page. | Stands (D11). |
| Remote failures at start do not stop the server; local config errors and a key mismatch do. | Always refuse. | **Overruled by D6**: every failure stops the start. |
| No reading fallback to local disk after the switch. | Read from the bucket, then from disk. | Stands (D9). |
| "Blob storage" for admins, "file storage" for users. | "Storage provider", "Cloud storage", "Object storage". | Accepted (A9). |
| Logs and command output in English only. | Localised logs. | Stands; repository convention. |
| The public health endpoint shows provider and status only. | Endpoint and bucket in `/api/health`. | Accepted (A10). |
| User messages never name the cause beyond "file storage not reachable" and never show codes. | Show the error code to users. | Not in v1 (A11). |
| A file that cannot be loaded blocks the chat turn. | Continue without the file and add a note. | Not in v1 (A11). |
| Two file errors for users: temporary with "Try again", permanent with "contact your administrator". | One message. | Not in v1 (A11). |
| The re-check action is `POST /api/admin/storage/_check`. | #2312's `_test`. | **Overruled by D11**: the action is `_test`. |

### UI designer

| Decision | Rejected alternative | Status |
| --- | --- | --- |
| Read-only card, no form. | A minimal S3 form now. | Stands (D11). |
| Card on `/admin/system-resources`. | A new page `/admin/storage`; a row on Chat History. | Stands (D11). |
| New endpoint `GET /api/admin/storage`. | Add fields to `/api/admin/system/resources`. | Stands (D11). |
| `POST /api/admin/storage/_test` tests the running backend, without a body. | A separate `_check` action. | Stands (D11). |
| A failed probe is HTTP 200 with `status: error`. | A 502 problem response. | Stands (D11). |
| No credential, not even the mask, in the status response. | Show `***REDACTED***`. | Stands (D11). |
| Encryption state is a server-sent `scope`, with an honest "project files only" line. | Show encryption only when S3 is active. | Stands (D11). |
| A red admin-wide banner for `error`, with its own dismiss key. | No banner; reuse the disk dismiss key. | **Overruled by D11**: the banner is cut. |
| `aria-disabled` and `motion-safe:animate-spin` on the test button. | The existing `disabled` and `animate-spin`. | Stands; not covered by the decisions. |
| A body-only component wrapped by the page's local `Section`. | Export `Section` to a shared file. | Stands; not covered by the decisions. |

### Architect

| Decision | Rejected alternative | Status |
| --- | --- | --- |
| `storage.blobs.provider` plus a thin `ComposedStorageProvider`. | A full `s3` provider; a generic facet-mixing provider; `storage.s3` beside `storage.filesystem`. | Stands (D1). |
| Encryption as a decorator over any `BlobStore`. | Encryption inside the adapter. | Stands (D2). |
| Encrypt every namespace, `project-files` twice. | An exemption list. | Stands (D2), when the switch is on (R3). |
| A fixed 512-byte header inside the object. | S3 user metadata; a sidecar; a JSON header. | Stands (D3). |
| `bytes` and `sha256` describe the plaintext. | The stored size. | Stands (D3). |
| Associated data is `ihub/blob/v1/<tenant>/<ns>/<key>`. | Include bucket or prefix; include a version id. | **Amended by D3**: plus what the security plan requires (the segment size). |
| Readable keys `<prefix>/<tenant>/<ns>/<key>`. | HMAC keys. | Stands (D4). |
| Own cursor with `StartAfter`. | The backend continuation token. | Stands. |
| Delete is lock, `HeadObject`, `DeleteObject`, with the lock from the base provider. | Conditional requests; in-process only; change `crawlHandover`. | Stands (D8). |
| No batch `DeleteObjects`. | Batch delete. | Stands. |
| AWS SDK with a dedicated agent. | Hand-written SigV4 over `httpFetch`; the shared agent. | Stands (D16). |
| Checksums `WHEN_REQUIRED`, path style on by default. | SDK defaults. | Stands (D16, D1). |
| Fail to start when S3 or the key check fails. | A degraded start. | Stands (D6). |
| The key check writes the marker whenever it is missing. | (none stated) | **Amended by D7**: objects present but no marker refuses the start. |
| Encryption key initialised before storage. | A lazy key check on first use. | Stands (D7). |
| Offline copy command in scope, working in both directions. | A read-through fallback; no migration. | Stands for the command (D9). **Narrowed by D9**: filesystem to S3 only. |
| In-repo server for CI, versitygw compose and CI job for real tests. | `s3rver`; MinIO; an SDK mock. | Stands (D10). |
| Move crypto to `server/crypto/` without a re-export. | Leave it under `services/projects`; add a shim. | Stands (D13). |
| Migration `V260__storage_blobs_defaults.js` writes `storage.blobs = { "provider": "default" }`. | (none stated) | **Overruled by D14**: no migration. |
| No new REST route, no admin UI. | Storage admin endpoints. | **Overruled by D11**: two admin routes and a card. |
| Reserved namespace `_ihub` for key check and probes. | Reuse `_health`. | Stands (D7). |

### Engineer

| Decision | Rejected alternative | Status |
| --- | --- | --- |
| Fixed-length object header with the wrapped key inside the object. | S3 user metadata; a sidecar; a JSON header. | Stands (D3). |
| Claim deletes with the filesystem lock facet. | A conditional delete; a per-process mutex. | Stands (D8). |
| Pass `ssl` and `proxy` into the store from the raw config. | Skip the bucket check at start and connect lazily. | Stands (D16, D6). |
| Plain handler options and an own keep-alive agent, without `@smithy/node-http-handler` as a direct dependency. | `createAgent()` for every case; the direct dependency. | The agent stands (D16). The dependency question is open; the architect's plan lists the direct dependency. |
| Own cursor with `StartAfter`. | S3 continuation tokens. | Stands. |
| No migration. | A migration that writes a default S3 block. | Stands (D14). |
| `s3-test-server` for tests and local use, plus a compose service. | `s3rver`, `fauxqs`, mocking the SDK client. | **Overruled by D10**: an in-repo server, no npm emulator. |
| Every object has content type `application/octet-stream`. | Forward the caller's hint. | Stands. |
| Copying existing blobs is out of scope unless the requester wants it. | (none stated) | **Overruled by D9**: the copy command is in scope. |
| Benchmarks and emulator probes ran in a scratch directory. | Installing into the repository. | Stands; planning only. |

### Quality engineer

| Decision | Rejected alternative | Status |
| --- | --- | --- |
| Two tiers: in-repo server plus versitygw from a compose file. | `s3rver` as an npm dev dependency. | Stands (D10). |
| The same compose file for developers and CI, started in a step. | A GitHub `services:` container. | Accepted (A7). |
| Fail instead of skip when `IHUB_TEST_S3_REQUIRED=1`, plus a skipped-count check. | `describe.skip` when the backend is missing. | The variable stands (D10). The count check is not in the decisions. |
| `node:test` for all new server tests. | jest. | Stands; repository convention for storage tests. |
| The conformance suite must pass unchanged. | Relax the racing-delete or listing-size cases for S3. | Stands (D3, D8). |
| The nothing-readable test writes through the domain repositories and scans every object. | Write through `blobs.put` and check only the keys written. | Stands. |
| Search for 16-byte windows of the payload and check entropy. | Marker only. | Stands. |
| The restart scenario runs in a Playwright API suite in `tests/e2e-s3/` that owns the server process. | A spec in `tests/e2e/`; only extending `smoke-boot.js`. | Stands; not covered by the decisions. |
| Performance as a nightly script with budgets relative to the filesystem run. | Absolute time limits in the pull-request suite. | Stands; not covered by the decisions. |
| 100 % branch coverage for the envelope module, 90 % lines for the adapter. | The general 80 % target. | Stands; not covered by the decisions. |
| Migration of existing blobs is out of scope for testing. | (none stated) | **Overruled by D9**: the copy command is in scope and needs tests. |
| Test helpers under `server/tests/helpers/`. | (none stated) | **Overruled in part by D10**: the server is `server/tests/support/fakeS3Server.js`. |

### Security

| Decision | Rejected alternative | Status |
| --- | --- | --- |
| Wrapped key in a fixed-size header inside the object (256 bytes, magic `IHUBBLOB`). | S3 user metadata; a sidecar; the metadata document only. | The header stands (D3). **Overruled in the layout by D3**: the architect's 512 bytes and magic `IHB1`. |
| Encrypt for every namespace, also where the domain already encrypts. | Skip namespaces that are "already encrypted". | Stands (D2), when the switch is on (R3). Location: D2 puts it in a decorator, not in the adapter. |
| Object names stay readable in v1. | HMAC per segment; HMAC of the whole key with a local index. | Stands (D4). |
| Associated data is version, tenant, namespace, key and segment size, built from the request. | Read the fields from the object header; use the S3 path. | Stands (D3). The exact encoding is open (4.3). |
| An integrity failure throws; it never returns `null`. Code `BLOB_INTEGRITY`. | Treat as missing. | Stands (D18). **Overruled in the name**: `CORRUPT_BLOB`. |
| Refuse to start when the key does not open the bucket marker `.ihub-bucket`. | Warn and continue. | Stands (D7). **Overruled in the name**: `_ihub/keycheck`. |
| Reuse the v1 wrap with the master key as it is. | Derive a separate wrap key with HKDF. | Stands. |
| The default credential chain only with a host-level environment switch. | Allow it from config; forbid it. | **Overruled by D5**: the chain is not used in v1. |
| Plain http refused except loopback or explicit opt-in. | Allow http because the content is encrypted anyway. | Stands (D16). |
| No SSE option in the adapter; bucket default encryption in the docs. | `serverSideEncryption` and `kmsKeyId` settings. | Stands. |
| No key cache in the adapter. | Reuse the ten-minute cache of `ItemTextStore`. | Stands. |
| The rewrap job is not a release blocker. | Block the release on it. | Stands (D19). |
| Dev backend: in-repo server for tests plus a versitygw compose file. | An npm S3 mock; MinIO. | Stands (D10). |
| The adapter never creates a bucket and never sets ACLs. | Create on first start. | Stands. |
| Build the agent with `createAgent(endpointUrl)`. | (the architect's own agent, as an allowed option) | **Overruled by D16**: a dedicated agent, never the shared one. |
| Crypto modules move under `server/storage/crypto/`. | (architect's call) | **Overruled by D13**: `server/crypto/`. |

## 10. Out of scope and proposed follow-ups

Out of scope for v1 (D19 and the role plans):

- S3 for documents, append logs, locks and change notification. #2302 decision 4 stays.
- The admin form, the "test unsaved settings" action and the migration wizard (#2312). The UI plan
  holds a short form specification for it.
- Multi-instance. With documents on the filesystem a second instance is still not supported. S3
  blobs remove one of the blockers of #2313. The shared `contents/` volume is still required.
- Encrypting blobs on the filesystem backend, and encrypting chat documents and logs (#2316), were
  out of scope in the plan. Both were built after the requester's change (section 11).
- Transit key provider (OpenBao, Vault, KMS). Per-tenant keys. A tenant prefix beyond `default`.
- Rewrap job.
- Multipart upload, range reads, presigned URLs, S3 versioning APIs, batch `DeleteObjects`,
  server-side encryption settings, lifecycle rules. (Streamed reads and writes were out of scope
  in the plan and were built afterwards: section 11.5. Multipart and range reads are still not
  built.)
- HMAC or otherwise hidden object names. Padding of sizes.
- Instance roles, web identity and the SDK default credential chain.
- Copy from S3 back to the filesystem. Reading through to the filesystem.
- Backup export of the bucket.
- Run-ledger spill blobs (`AppendLog.putBlob`). They belong to the log facet and stay on disk. With
  storage encryption they are encrypted there (section 11).
- The iFinder sidecar scheme and direct interop with iFinder.
- S3 Express directory buckets and buckets with object lock.

Proposed follow-ups. None is created as a ticket without the requester's yes.

| Follow-up | Source |
| --- | --- |
| Admin UI for the blob backend, folded into #2312. | PM, UX, UI |
| Transit key provider behind `KeyProvider` (phase 3 in #2906). | PM, SEC |
| Rewrap job over bucket objects after a master key rotation. Until then one previous key is the limit, and a leaked master key cannot be retired. | PM, ARCH, SEC |
| Decision for the requester: encrypt blobs on the filesystem backend too. Done: R1, section 11. | PM, D2 |
| Backend matrix: versitygw, AWS S3, one customer backend (SP-2 of #2906). | PM, QE, SEC |
| Large objects: multipart above the single-put limit, and range reads. The streaming path is built (section 11.5); what still holds a whole object in memory is listed there. | PM, ARCH, ENG |
| Backup: the admin export and the bucket; a flag in `backup-metadata.json`; a notice on the backup page; an orphan reconciler for objects without a document. | PM, ENG, UX |
| Remaining file stores onto the blob facet (#2389) and the ledger spill blobs. | PM |
| Per-tenant prefix and key context (#2392). | PM |
| Hidden object names with a key index, as #2906 describes. | SEC |
| Retry queue for failed object deletions, with a visible count. | UX |
| Copy command in the direction S3 to filesystem. | UX, ARCH |
| Domain separation of the master key (a derived wrap key). | SEC |
| Bucket usage in the disk and storage monitoring. Today only `contents/data` is measured. | ENG |

The open points of the plan and how each was closed (details in section 3.1 and in section 4):

| Open point | Closed by |
| --- | --- |
| The exact encoding of the associated data (4.3). | A1. |
| The key-check marker: payload, the adoption override, and who writes it when the copy command runs before the first start (4.6). | A2. |
| The value of the object size maximum (4.7). | A3: a setting. Built with a default of 128 MiB, not 64 MiB. |
| Whether the timeouts, retry count and socket limit are configuration fields (4.1). | A4. |
| `--delete-source` on the copy command (4.9). | A5: no. |
| The workflow file for the versitygw run and the skipped-test checks (4.10). | A7. |
| The response shape of `GET /api/admin/storage`, the card title, the refresh interval, and the `/api/health` field (4.11). | A8, A9, A10. |
| The classifier code list and the two user-facing error codes (4.8, 4.12). | A11: one classifier; no user-facing codes in v1. |
| Whether a file that cannot be loaded blocks the chat turn (section 7, row 34). | A11: not in v1. |
| Whether the S3 client is rebuilt when SSL or proxy settings change at runtime (4.7). | A13: no, a restart. |
| What a failed storage bootstrap does today (2.3). | A15: the process ends with exit code 1. |
| The binary build and the dynamically imported SDK (section 7, row 41). | Still open. Not checked in a binary build. |

Ticket updates proposed by the product manager, not posted: #2318 gets a new body and becomes the
implementation ticket; #2906 gets a comment that records the deviations (encryption for all
namespaces, wrapped key inside the object, readable keys, SP-2 done for one local backend only) and
stays open; #2302 gets a note on decision 4; #2312, #2313, #2316 and #2905 get one comment each.

## 11. Changes after the plan

### 11.1 Requester changes R1 to R3

After the plan was reported, the requester wrote: "Chats and artifacts should be encrypted in the
filesystem too. Everything that is user generated and can have confidential data." And later: "we
should make the encryption optional".

| # | Topic | Decision | What it overrules |
| --- | --- | --- | --- |
| R1 | Filesystem blobs | The `EncryptingBlobStore` decorator wraps the filesystem blob store as well, every namespace, same format. Blobs already on disk in plaintext are encrypted in place by a one-time, idempotent, resumable step. After it has completed, a plaintext blob is an error (D18). | D2: "Filesystem blobs stay as they are." |
| R2 | Documents and append logs | User-generated content in documents and append logs is encrypted at rest on the filesystem provider with the same key provider (#2316). | Section 10: "Encrypting chat documents and logs" out of scope. |
| R3 | Encryption is optional | One switch, `storage.encryption.enabled`, for blobs (filesystem and S3), documents and append logs. Schema default `false`; `server/defaults/config/platform.json` sets `true`. Enabled: every write is encrypted and plaintext is an error once the conversion has completed. Disabled: writes are plaintext and an encrypted object is still decrypted. S3 with encryption off is allowed, logs a warning at every start, and the status reports `scope: "none"`. The key-check marker is used only when encryption is enabled. | D2: "always on for S3 … no off switch". 4.1: "There is no `encryption.enabled` setting." |

The requester also accepted that there is no rollback after enabling other than restoring a backup.

During implementation the scope grew by one more step: five file stores outside the storage layer
(agent artifacts, agent memory, agent inboxes, tool-job results, short links) are encrypted by the
same switch.

The design of R1 to R3 as built, with the inventory of what is and is not encrypted, the formats,
the conversion and the follow-ups, is in **`2026-11-20 Storage Encryption at Rest.md`**.

What this changes in the sections above:

- D2 and the summary: encryption is the switch, not a property of the S3 backend. With the switch
  off the S3 store receives plaintext, and the start-up check has a step `detect` in place of the
  key and key-check steps.
- 4.3: the envelope format is unchanged and is now also the format of filesystem blobs, of spill
  blobs and of the sealed file stores (each with its own associated-data label).
- 4.6: the master key is loaded before storage in every start, and the conversion step runs
  between the key and the storage bootstrap.
- 4.9: the copy command reads a local blob as it is or decrypts it first, and writes it encrypted
  for the bucket or plain, following the switch.
- 4.11: the status has a top-level `encryption` object for the whole installation.
- New commands: `npm run storage:encrypt` and `npm run storage:show`.

### 11.2 Where the code differs from the plan

| Plan | Built |
| --- | --- |
| A3: `maxObjectBytes` defaults to 64 MiB. | 128 MiB. |
| 4.6, 4.7: `GetBucketVersioning` at start, with a warning. | Not sent. No warning. Documented instead. |
| 4.1: link-local endpoints are refused unless on `ssrf.allowedHosts`. | Always refused. |
| 4.11: `encryption.scope` is `all`, `project-files` or `none`. | `blobs.encryption.scope` is `all` or `none`; the top-level `encryption.scope` is `none`, `blobs` or `storage`. |
| Pre-mortem row 15 and the UX plan: an error is logged on a state change and `/api/health` shows the state for monitoring. | The health field holds the last check result. A check runs at start, on a read of `GET /api/admin/storage` (at most once a minute) and on `_test`. Nothing checks in the background. |
| 4.5: delete is lock, `HeadObject`, `DeleteObject`. | A delete of a key that does not exist sends one more request, `HeadBucket`, to tell a missing key from a missing bucket. |
| 4.9: `server/scripts/copyBlobs.js`. | `server/storage/commands/copyBlobs.js`, with the entry point `server/storage/commands/run.js` for installations without `npm`. |
| 4.12: codes of the UX table. | `S3_ADDRESSING` dropped; six codes added (see 4.12). |
| D2: objects in a bucket are always ciphertext. | With the switch off they are plaintext. When the switch is turned on later, the start refuses a bucket that holds plaintext objects (`REMOTE_BLOBS_PLAINTEXT`); `npm run storage:encrypt` encrypts them in the bucket (section 11.4). |
| 4.1: `IHUB_PLATFORM__...` overrides do not reach the storage bootstrap ("document it"). | Unchanged, and documented. |

### 11.3 What was verified, and what was not

- Verified: the unit, conformance, failure, proxy and TLS-whitelist suites and the end-to-end
  script, against the in-repository S3 server. That server checks that a signature header is
  present and does not verify the signature.
- Not verified: the versitygw compose file (`docker/docker-compose.s3.yml`) and the workflow
  `.github/workflows/s3-storage-tests.yml` were never executed, because no Docker was available
  where they were written. Nothing was run against AWS S3, MinIO, Ceph or a customer service. SigV4
  signing, path-style addressing and the checksum settings are therefore unproven against a real
  server.
- Not verified: the least-privilege bucket policy in `docs/storage.md` is written from the list of
  requests the store sends and was not tried on a real service.
- Not verified: the binary distribution with the dynamically imported SDK (section 7, row 41).

### 11.4 Changes after the review of 2026-11-20

A review of the built change led to these changes in behaviour. They replace what the sections
above say on the same points; the operator documentation (`docs/storage.md`,
`docs/storage-encryption.md`, `docs/encryption-key-management.md`) describes them in full.

| Topic | Now |
| --- | --- |
| Key file without a key | A `contents/.encryption-key` that exists and holds no 64-character hex key stops the start (`MASTER_KEY_INVALID`). It is never replaced. |
| Who creates a key | Only a server start, and `storage:encrypt` without `--dry-run`. `storage:check`, `storage:show` and `storage:encrypt --dry-run` create none; `storage:check` reports a failed key step. |
| Plaintext objects in a bucket (4.6, D7, D18) | With the switch on, the preparation step of a start contacts the bucket and refuses plaintext objects (`REMOTE_BLOBS_PLAINTEXT`) and objects of another key (`REMOTE_BLOBS_FOREIGN_KEY`). `storage:encrypt` converts the bucket and writes its key-check object. `IHUB_S3_ADOPT_BUCKET` is only for a bucket already encrypted with this key. The earlier "decide before the first upload, there is no command" no longer holds. |
| One conversion at a time | The conversion runs under a lease (`storage-at-rest-conversion`). A second `storage:encrypt` refuses (`CONVERSION_IN_PROGRESS`); a start waits. |
| Local key check | `contents/data/.at-rest-keycheck`, outside the blob tree, so `contents/data/blobs` can be removed after `storage:copy-blobs`. A file at the old place (`blobs/_ihub/keycheck`) is moved at the next start. |
| State record | New fields `facets.remoteBlobs` and `remoteBlobStore` (the bucket recorded as encrypted), `plaintextLeftovers` (local blob files left unencrypted because the bucket is used), `recreatedAt`. |
| Missing state record | With encrypted data present the directory is treated as converted. Plaintext found then is refused (`ENCRYPTION_STATE_MISSING`) unless `IHUB_ENCRYPTION_ACCEPT_PLAINTEXT=true` is set for one run. |
| S3 timeouts (4.7, A-decisions on timeouts) | New settings `operationTimeoutMs` (30 s) and `minThroughputBytesPerSecond` (1 MiB/s): one blob call is bounded by the first plus its size divided by the second. The lock wait of a delete is that budget plus a slack. |
| Missing objects (4.8) | A `GetObject` counts as "no object" only with the S3 error `NoSuchKey`. Any other 404 is an error. |
| Plain http (4.1) | Only the name `localhost`, `127.0.0.0/8` and `::1` count as this machine. `x.localhost` needs `allowInsecureHttp`. IPv4-mapped link-local addresses are refused like the IPv4 ones. |
| Missing `platform.json` | Created from the defaults with encryption **off** when the contents directory already holds data. |
| Cluster | The primary decides the switch once per start and hands it to each worker. Workers that end right after their fork are replaced with a growing pause. A change of the switch needs a full restart. |
| Error responses | A storage error with a 5xx status answers with a fixed text per code; object names and key ids stay in the log. |
| Unknown `projects.encryption.keyProvider` | Stops the start (`UNKNOWN_KEY_PROVIDER`) instead of falling back to `local-file`. |

Known limits that were accepted:

- The conversion lease does not see a server that is already serving. `storage:encrypt` does not
  refuse in that case; stopping the servers is the operator's part.
- The scan and the conversion of a bucket walk the declared blob namespaces only. Other objects
  below the prefix are not looked at.

Test side of the same review: no test works on the real `contents/` any more
(`server/tests/support/scratchContents.js`, the guard in `scripts/run-server-tests.js`); see
`2026-11-20 S3 Blob Storage Test Suites.md`, section "Test isolation".


### 11.5 Streamed reads and writes (added 2026-11-20)

The requester decided that streaming is done now and not as a follow-up. The stored format did
not change: an object is still the 512-byte header followed by the `tink-aes-gcm-hkdf-v1` stream
in 1 MiB segments, and the recorded vectors open unchanged. Because each segment carries its own
tag, a reader decrypts and hands on one segment at a time.

**Contract** (`server/storage/BlobStore.js`):

```text
openRead(ns, key)                                   -> { key, bytes, stream } | null
putStream(ns, key, stream, { bytes, contentType? }) -> { key, bytes, sha256 }
```

`bytes` is the payload size and is known before the first byte. Both have a base implementation
over `get` and `put`, so every store has them. `get` and `put` are unchanged.

**Integrity rule.** A segment is handed out only after its tag verified. `openRead` resolves
after the first segment verified, so an object that cannot be opened at all (strict mode and no
envelope, key not here, wrong address, changed header) rejects before a caller has sent anything.
A change, a cut or an extension further in makes the stream fail with `CORRUPT_BLOB` after the
genuine segments before it; a stream never ends cleanly on such an object. Whether a segment is
the last one is part of its nonce, so the reader holds a full segment back until it sees more
data or the end; a stream cut at a segment boundary fails there. A consumer treats the content
as read only at the end of the stream. A route destroys its response on a late failure
(`server/utils/streamResponse.js`) and never ends it.

**Per store.**

| Store | `openRead` | `putStream` |
| --- | --- | --- |
| Filesystem | file read stream over the open file | temp file beside the blob, fsync, rename (as `put`) |
| S3 | the `GetObject` body. No whole-body deadline: an idle bound and a bound on the total time spent waiting for the bucket (`s3BodyStream.js`), neither of which counts time the consumer takes. Destroying the stream destroys the connection. | one `PutObject` with the stream as its body and the stored length (`storedLength(bytes)`) as `Content-Length`. Sent once: the SDK does not retry a stream body. A failing source aborts the request. |
| Encrypting store | header read, key unwrapped once, segments decrypted in a transform | segments sealed in a transform, plaintext SHA-256 computed on the way |

**Where it is used.** Artifact and uploaded-file downloads (chat, share, scheduled task,
inference API), the artifact ZIP (payloads appended one after the other), agent artifact and
cross-worker tool-job downloads (`openSealedStream` in `storage/atRest/sealedFiles.js`),
`storage:copy-blobs` and the blob step of `storage:encrypt`.

**What still holds a whole object in memory, and why.**

| Path | Reason |
| --- | --- |
| Uploads while their text is extracted (chat files, inference files, project files) | **Changed after delivery:** a multipart upload is received into a spool file (`contents/data/tmp/chat-uploads/`) and its original is stored from there with `putStream`. Every extractor takes a `Buffer`, so the file is read whole for the scan and the extraction, for at most `uploads.extraction.concurrency` uploads at a time (2 by default), with a bounded queue and a retryable `503 UPLOAD_BUSY` beyond it. |
| Uploads as JSON base64, files fetched from connected systems | The body parser or the connector delivers them in memory; they share the extraction cap. |
| OCR uploads (`multer` memory storage, 20 files of 200 MB), image provenance, document template files | The OCR job renders pages from the PDF buffer for as long as it runs and has no queue; spooling the upload would move the read by milliseconds. Not changed. |
| Extracted text, page maps, evidence packs, corpus pages, project texts, crawl hand-overs | The content is parsed or put into a prompt. |
| File tools, document templates, A2A and inference file parts, image provenance, the embed page | The bytes go to a model, a parser or a page. |
| The finished archive of `create_zip` (at most 25 MB) | **Changed after delivery:** the archive is built into a spool file (`contents/data/tmp/zip-spool/`), stored members read as streams. It is then read once, because a generated file is handed to the chat from memory (`holdGeneratedFile`: the turn sends it to the client and stores it as an artifact). Storing it with `putStream` needs generated files that live on disk. |
| HTML artifacts in a ZIP or a share download | The library-kit references are rewritten, which needs the whole file. |
| The ledger spill blobs (`putBlob`/`getBlob` of the append log) | Another facet; payloads are small. |

**Not built.** Multipart upload (one `PutObject` is limited by `maxObjectBytes`, 128 MiB by
default, and by the service's single-request limit of 5 GiB). Range requests: no blob route
answered them before, and none does now; a range of a sealed object would be served by decrypting
only the segments it covers, which the format allows.

**Measured** (`npm run test:s3:perf -- --mib 100`, in-repo S3 server in its own process, 4 CPUs):

| Call, 100 MiB | Time | Held in ArrayBuffers | Longest event-loop stall |
| --- | --- | --- | --- |
| S3 `put` | 798 ms | 100 MiB above the payload | 102 ms |
| S3 `putStream` | 672 ms | under 8 MiB | 8 ms |
| S3 `get` | 360 ms | 200 MiB | 133 ms |
| S3 `openRead` | 270 ms | 5 MiB | 10 ms |
| Filesystem `get` | 215 ms | 202 MiB | 134 ms |
| Filesystem `openRead` | 182 ms | 6 MiB | 14 ms |
