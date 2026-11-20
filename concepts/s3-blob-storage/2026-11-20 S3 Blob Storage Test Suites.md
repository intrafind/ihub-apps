# S3 blob storage: test suites and how to run them

Hand-over notes for whoever continues the testing of the S3 blob backend
(design: `2026-11-19 S3 Blob Storage Backend.md`). Written 2026-11-20.

This file is kept beside the design because it holds what the design does not: the map of test
files, how a suite selects its S3 server, and the rules for adding tests. The suites of storage
encryption (`storage-*-encryption*.test.js`, `storage-sealed-files.test.js`,
`storage-nothing-readable.test.js`, `storage-commands.test.js`, `crypto-*.test.js`) run in
`npm run test:server` and need no S3 server; their design is `2026-11-20 Storage Encryption at
Rest.md`.

## Two S3 servers

| Server | What it is for | Start |
| --- | --- | --- |
| In-repo fake, `server/tests/support/fakeS3Server.js` | Fast, no Docker, can be told to fail (`inject`). Does **not** verify signatures. | Started by each test; `npm run s3:dev` standalone |
| versitygw, `docker/docker-compose.s3.yml` | A real server we did not write: signing, ordering, paging. | `npm run s3:up` / `npm run s3:down` |

A green run on the fake is not proof against S3. `storage-s3-fake-fidelity.test.js` keeps the fake
honest; the external run is the proof.

## Selecting the server

One helper: `server/tests/support/s3TestBackend.js`. `describeS3Targets(title, define)` registers a
suite for the fake and, when `IHUB_TEST_S3_ENDPOINT` is set, for that server too. Variables:
`IHUB_TEST_S3_ENDPOINT`, `_REGION`, `_BUCKET` (name must contain `test`), `_ACCESS_KEY`,
`_SECRET_KEY`, and `IHUB_TEST_S3_REQUIRED=1`, which turns a missing or unreachable server into a
failure instead of a skip. Each run works under its own `test-<hex>` prefix and removes it.

## Files

| File | Covers | Server |
| --- | --- | --- |
| `storage-s3-contract-edges.test.js` | delete raced by two processes, cursor across deletes, prefix/order edges, key limits | fake + external |
| `storage-s3-external-conformance.test.js` | the shared blob contract, encryption on and off | external only |
| `storage-s3-external-nothing-readable.test.js` | every object fetched back is ciphertext | external only |
| `storage-s3-failures.test.js` | bucket gone at runtime and at process start, 403, missing bucket, timeouts, short bodies, size cap, wrong key, adopt override | fake |
| `storage-s3-proxy.test.js` | requests really pass a proxy / bypass it (`support/recordingProxy.js`) | fake |
| `storage-s3-fake-fidelity.test.js` | the fake itself, over plain HTTP | fake |
| `scripts/s3-e2e.js` | real server process: login, upload, read, bucket scan, restart, delete, admin status | fake, or external when configured |
| `storage-stream-s3.test.js` | streamed read and write on S3: the request is aborted when the reader leaves, nothing is downloaded ahead of a reader, a stalled or cut body fails within its bound, a changed object fails as `CORRUPT_BLOB`, one `PutObject` per streamed write and no retry, the copy command's own retry, and the memory held for a 100 MiB object (measured in a child process, `support/streamMemoryProbe.js`, against the fake in a process of its own, `support/fakeS3Process.js`) | fake |
| `storage-stream-blobs.test.js` | streamed encrypted blobs over a store with `get` only and over the filesystem store: every way of changing, cutting, swapping and extending an object, modes, key errors, `putStream`, the one-time encryption as a stream; sealed files as a stream | none |
| `storage-stream-routes.test.js` | the streamed downloads over real HTTP with encryption on: artifact, uploaded file, ZIP, owner and share; a blob changed on disk cuts the transfer | none |
| `crypto-envelope-streams.test.js` | the streaming encryptor and decryptor against the buffered ones and the recorded vectors | none |
| `scripts/s3-perf.js` | 25 MiB (or `--mib N`) `put`/`get` and `putStream`/`openRead`: time, peak memory, memory held, event-loop stall; not in any default run | fake (own process), or external |

Support: `support/scratchContents.js` (the scratch contents directory, see "Test isolation"
below), `support/serverProcess.js` (seed a contents directory, start/stop `server/server.js`),
`support/s3DeleteRaceWorker.js`, `support/readableScanner.js`, `support/httpRoute.js` (a handler
chain over a real HTTP connection, for what a client sees of a broken download),
`support/streamableResponse.js` (lets a response double take a streamed body).

The shared blob contract (`server/storage/__tests__/providerConformance.js`, section "the blob
facet") has the streamed read and write since 2026-11-20: content equal to `get`, size up front,
missing key, empty object, one byte short of, exactly at and one byte over a segment, several
segments, a reader that leaves early, a stream of another length.

## Commands

```bash
npm run test:s3                 # all storage-s3-* suites (fake; plus external when the variables are set)
node --test server/tests/storage-s3-failures.test.js
npm run test:s3:e2e
npm run test:s3:perf
npm run s3:up && export IHUB_TEST_S3_ENDPOINT=http://127.0.0.1:7070 IHUB_TEST_S3_BUCKET=ihub-test \
  IHUB_TEST_S3_ACCESS_KEY=ihub-test-not-a-secret IHUB_TEST_S3_SECRET_KEY=ihub-test-not-a-secret \
  IHUB_TEST_S3_REQUIRED=1 && npm run test:s3 && npm run test:s3:e2e; npm run s3:down
```

CI: `.github/workflows/s3-storage-tests.yml` does the last block and fails when anything was
skipped (the conformance sections reported as `# SKIP not selected` are the only exception).

## Test isolation: no test writes into the real `contents/`

Added 2026-11-20 after a review found that nine storage tests used the real `contents/` of the
checkout and three created `contents/.encryption-key` there.

The cause: `server/config.js` reads `CONTENTS_DIR` once, when it is first loaded. Static `import`
statements run before the body of a test file, so `process.env.CONTENTS_DIR = scratch` in the body
came too late whenever a static import had already loaded server code (the support modules did).

How it is solved, in three layers:

1. **`server/tests/support/scratchContents.js`**: importing it creates a temporary directory, sets
   `CONTENTS_DIR`, removes `TOKEN_ENCRYPTION_KEY` and `TOKEN_ENCRYPTION_KEY_PREVIOUS` from the
   environment, loads `server/config.js` and fails when the server does not use the scratch
   directory. It exports `contentsDir`, `dataDir` and `scratchRoot`. It must be the **first**
   import of a test file. `blobTestSupport.js`, `atRestTestSupport.js` and `s3DeleteRaceWorker.js`
   import it first themselves, so a test that forgets it is still safe when it starts with one of
   them. A test that must set other variables before the configuration loads (`JWT_SECRET`,
   proxy variables) sets them and then writes `await import('./support/scratchContents.js')`;
   see `consentTicket.test.js` and `storage-s3-proxy.test.js`.
2. **`seedContents()` in `support/serverProcess.js`** runs the migrations with `APP_ROOT_DIR`
   pointing at a temporary root whose `contents` is a link to the scratch directory. Migration
   V042 (applied, must not be edited) builds its paths from the installation root and ignores
   `CONTENTS_DIR`; without the link it created four directories in the real `contents/`.
3. **`scripts/lib/realContentsGuard.js`**, called by `scripts/run-server-tests.js`: it records the
   real `contents/` before the tests and compares afterwards. A created, changed or removed
   `contents/.encryption-key*`, or any change below `contents/data`, fails the run and lists the
   paths. Other changes are printed as a notice. `CONTENTS_GUARD=off` turns it off (for a run
   while a development server writes into the same `contents/`). The S3 workflow has its own
   step that fails when `contents/` exists after the run.

To find the test behind a guard failure, run the suspects one at a time
(`node scripts/run-server-tests.js <file name>`); the guard runs for every invocation.

Rules for a new test: import `scratchContents.js` first; never set `CONTENTS_DIR` yourself; never
build a path from the repository root plus `contents`.

Still open (older tests, not part of the S3 work, found with a write-recording hook on a full run):

- `chatAuthRequired-anonymous.test.js` and `ntlmAuth-domain.test.js` write and delete
  `contents/config/groups.json` of the checkout on purpose (the code under test reads that path).
- Fifteen jest files of the admin routes (`admin-chat-history`, `admin-delete-user`,
  `admin-proxy-config`, `admin-users-concurrent-writes`, `admin*RoutesErrors`, `aiAcknowledgement`,
  `llm-timeouts-admin-route`, `rate-limits-admin-route`, `setupRoutesErrors`) create and remove
  `contents/config/.admin-invariants.lock`.
- A full run also creates `contents/.usage-pepper` and `contents/config/integrations.json`.
- A full run appends to `contents/data/audit-log/<date>.jsonl` (chat shares, OAuth client
  registration, login and logout) and writes one line to
  `contents/data/integration-action-usage/<date>.jsonl`. The test files behind this were not
  found: no file does it when it runs alone or in a group of 30 (searched with a script that ran
  every file and looked at `contents/data` after each group). Both paths are listed in
  `KNOWN_DATA_LEAKS` in `scripts/lib/realContentsGuard.js`, so the guard prints them as notices.
  Remove the entries when the tests are found and fixed. A way to find them: run the full suite
  with a preload (`NODE_OPTIONS=--import=...`) that wraps `fs.promises.open` and the `FileHandle`
  write methods as well as `appendFile`, and logs the stack; a first attempt that wrapped only the
  `fs` functions saw 4 of the 45 lines.

The first three are below `contents/config` or beside it, so the guard reports them as notices. They should
move to the scratch directory too; then the guard can fail on any change below `contents/`.

## Rules

- A failing test in these suites points at the product. Fix the product, not the test. (During
  development such tests carried the mark `[PRODUCT DEFECT]`; none is left.)
- Never register a test with `skip` for the external server; leave it out for that target instead
  (see the control case in `storage-s3-contract-edges.test.js`). A skip hides in a green run.
- Do not add S3 files to `QUARANTINED` in `scripts/run-server-tests.js`.
- A call that could hang goes through `within()` in the failure tests.

## Not done yet

- The compose file and the workflow have never been executed (no Docker where they were written).
  First run: check that the bucket directory is accepted as a bucket and that `/health` answers.
- No run against versitygw, AWS S3 or a customer server has happened. The external mode was only
  exercised against the standalone in-repo server.
- "Nothing readable" writes through `provider.blobs`, not through the domain repositories; the
  end-to-end script covers the chat-file path only.
- No connect-timeout case (needs an address that drops packets), no clock-skew case at start.
