# S3 blob storage: test suites and how to run them

Hand-over notes for whoever continues the testing of the S3 blob backend
(design: `2026-11-19 S3 Blob Storage Backend.md`). Written 2026-11-20.

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
| `scripts/s3-perf.js` | 25 MiB put/get: time, peak memory, event-loop stall; not in any default run | fake (own process), or external |

Support: `support/serverProcess.js` (seed a contents directory, start/stop `server/server.js`),
`support/s3DeleteRaceWorker.js`, `support/readableScanner.js`.

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

## Rules

- A test marked `[PRODUCT DEFECT]` fails on purpose. Fix the product, not the test; the comment
  above each one names the file and the cause.
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
