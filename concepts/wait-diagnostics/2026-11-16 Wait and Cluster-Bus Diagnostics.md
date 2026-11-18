# Wait and cluster-bus diagnostics

Status: implemented on `perf/wait-diagnostics` (not pushed). Goal: a load test
shows where requests *wait*, not only where CPU goes, so we can find what stops
iHub before 1,000 concurrent users (the limit is event-loop delay p95 > 150 ms,
not average CPU).

## What is counted, and where

All counters live in `server/telemetry/waitDiagnostics.js` (no dependencies).
They are cumulative since process start and always on. Readers diff two
snapshots; histograms expose raw bucket counts so percentiles can be computed
for a window (`percentileFromBuckets`).

| Group | Key | Fields | Recorded in |
|---|---|---|---|
| `busTypes` | channel (`sse:event`), presence kind (`presence:sse`) or IPC kind (`presence:sync`) | `published`, `received` (workers), `relayed`, `broadcasts` (primary) | `server/clusterBus.js` |
| `busRequests` | channel | `count`, `nullReplies`, `timeouts`, `unsent`, `latency` (answered only) | `clusterBus.request` |
| `busGathers` | channel | `count`, `replies`, `fullTimeouts`, `latency` | `clusterBus.gather` |
| `busLookups` | presence kind | `count`, `mirrorHits`, `hits`, `misses`, `timeouts`, `latency` | `clusterBus.lookupRemote` |
| `locks` | lock-name prefix before `:` (`chat`, `project`, `evidence`, `run`…), else the component (`FileLock`, `FilesystemDocumentStore`…); in-process locks as `mem:<component>` | `acquisitions`, `timeouts`, `waiters` (gauge), `wait`, `hold` | `utils/fileLock.js#acquireLease` (every file lease), hold in `withFileLock` and `FilesystemLockManager.withLock`, `utils/jsonlAppender.js#withWriteLock` |
| `throttle` | throttle id (model / tool) | `requests`, `queued`, `fallbacks` (no slot from primary), `wait` | `server/requestThrottler.js` |
| `storage` | `documents.<op>:<ns>`, `blobs.<op>:<ns>`, `appendLog.<op>`, `appendLog.flush:<component>` | `count`, `errors`, `timeouts`, `latency` | `FilesystemStorageProvider` (wraps facet methods), `jsonlAppender.flush` |
| `gauges` | `busPendingRequests/Gathers/Lookups`, `throttlePrimaryQueued/Active`, `throttleLocalQueued` | numbers | registered by the owning module |

Plus `uvThreadpoolSize` (env `UV_THREADPOOL_SIZE`, default 4) and `bucketBoundsMs`.

Exposed per process as `processes[].diagnostics` in
`GET /api/admin/system/resources` (`services/systemResources.js#getProcessSnapshot`).
Additive field; no new endpoint.

## Load-test harness

- `tests/load/lib/sampler.mjs`: shard 0 calls `metrics.diag()` with every process's diagnostics.
- `tests/load/lib/metrics.mjs`: keeps only the first and last snapshot per stage.
- `tests/load/lib/waits.mjs`: per-stage difference (baseline = previous stage's last snapshot), summed over processes, rendered as the "Waits and cluster bus" section (top 10 per table).

## Cost

Measured on an M-series laptop: a counter increment (Map lookup + `+= 1`)
≈ 10 ns; a timed operation (`performance.now()` pair + bucket scan) ≈ 50–75 ns.
Records are created once per key; the token relay allocates nothing extra.
`append`/`appendBatch` on the append log are intentionally not timed (they run
per run event and only queue in memory); the flush that writes them is.

## Not done / next steps

- Bytes per bus message: Node serialises inside `process.send` and does not
  report the size; measuring it would need a second `JSON.stringify` per
  message. Add only if message counts do not explain the primary's load.
- In-process chains not instrumented (low traffic): `ConfigStore#serialize`,
  `personalApiKeyManager` owner locks, `ExecutionRegistry._enqueue`,
  `WorkflowStateRepository._serialize`. Use `lockStats('mem:<name>')` the same
  way as `jsonlAppender` if one shows up.
- Tests: `server/tests/waitDiagnostics.test.js` (helpers),
  `server/tests/systemResources.test.js` (snapshot carries `diagnostics`).
