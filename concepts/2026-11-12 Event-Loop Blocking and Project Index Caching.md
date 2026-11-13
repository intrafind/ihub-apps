# Event-Loop Blocking and Project Index Caching

**Status:** proposal, from the load test of #3631. Nothing implemented yet.

**Issues:** P1 monitoring #3652 · P2.1 Excel `sheetRows` #3648 · P2.2 configurable caches #3650 · P3 extraction in threads #3649 · P4 project ownership #3651

## 1. Why

The load test (`concepts/2026-11-12 Load Test and Sizing Plan.md`, lab with the stub LLM) found that iHub does not run out of CPU. It runs out of **event-loop time**: single synchronous operations stall a worker for up to a second, and every chat on that worker waits.

| Run | Capacity | What broke | Worker CPU at that point |
| --- | ---: | --- | ---: |
| W=1, 2 vCPU | 100 users | event-loop peak p95 1,029 ms | 48 % |
| W=2, 3 vCPU | 150 users | event-loop peak p95 276 ms | 31 % |
| W=4, 5 vCPU | 150 users | event-loop peak p95 156 ms | 19 % |
| Ingestion, W=4, concurrency 2 or 4 | 2 users | event-loop peak p95 321 ms at 5 users, ~1 s at 20 | 15–44 % |

The primary's SSE relay is not the limit (≤ 5 % CPU at W=4). Adding workers spreads the stalls but does not remove them, so capacity stopped growing after W=2.

## 2. What blocks (measured)

Measured on a developer laptop with the load-test corpus; container workers with 1 vCPU are about 1.3–1.5× slower. "Longest stall" is the longest time the event loop could not run anything else.

| Step | Longest stall | Share of its run time that blocks | Where the time goes |
| --- | ---: | ---: | --- |
| Excel, 30,000 rows | **728 ms** | 94 % | SheetJS `XLSX.read` parses every row; the 2,000-row limit is applied afterwards |
| Excel, 2,000 rows | 106–135 ms | 94 % | same |
| Word, 40-page handbook | 71–110 ms | 43 % | jsdom (≈ 40 % of CPU), jszip, mammoth |
| Project index rebuild, 590k chars | 62 ms | 100 % | `buildCorpusIndex` |
| Scanned PDF in a chat (pdfium) | 128 ms per page, ≤ 5 pages | 100 % | WASM render |
| PowerPoint | 9–30 ms | 19 % | |
| PDF (pdf.js) | 3–17 ms | 6 % | CPU-heavy, but yields often |
| `estimateTokens`, sha256 | ≤ 9 ms, < 1 ms | | negligible |

Project search index (`server/services/knowledge/LocalKnowledgeProvider.js`):

- An index takes **4.5 bytes of heap per character** (measured), not the 5.5 the cache budget assumes (`server/utils/cacheBudgets.js`). A typical 590k-character project is about 2.6 MB.
- The cache holds **32 indexes per process**, a hard-coded constant, within 10 % of the heap (≤ 30M characters).
- **Every worker caches its own copy.** Connections are distributed round-robin, so every worker sees every project and all of them cache the same hot projects. A pod with W workers holds 32 distinct indexes, not 32 × W.
- A miss costs a rebuild (about 60–90 ms of stall) plus decrypting the project's texts. There is no counter, so the hit rate is unknown.

## 3. Proposals

### P1. Measure the working set first (monitoring)

The right cache size depends on how many projects are in use at the same time, which nobody knows today. Add:

| Metric | Meaning | Aggregation |
| --- | --- | --- |
| `ihub.projects.active` (5 / 15 / 60 min windows) | Distinct projects used by a chat turn or a knowledge tool | **Union** across workers (the set of ids), not the sum: the same project is active on several workers |
| `ihub.projects.active.chars` | Text characters of those projects: the index memory the working set needs (× 4.5 bytes) | same |
| `ihub.knowledge.index.cache` hits / misses / evictions, entries, characters | Per worker | per worker and summed |
| `ihub.knowledge.index.build.duration` | Histogram | per worker |
| `ihub.extraction.duration` by format, and its longest stall | Histogram | per worker |

- **Where it shows up:** in the OpenTelemetry/Prometheus metrics and in `GET /api/admin/system/resources`. The load-test harness already samples that endpoint, so later runs report the hit rate as well.
- **Note:** `ActivityTracker` (active users/chats) is per process today. In cluster mode it counts per worker and has the same aggregation problem; fix it together.
- **What we learn:** with these numbers an operator can size the cache, for example "the 15-minute working set is 140 projects / 80M characters → 360 MB of index heap", instead of guessing.

### P2. Quick wins

1. **Excel: pass `sheetRows` to `XLSX.read`** (`server/services/projects/extractText.js:870`). Measured: 663 → 190 ms (−71 %) for the 30,000-row workbook, unchanged for small ones. SheetJS then shortens `!ref`, so the truncation flag must compare against `!fullref`.
2. **Configurable index cache:** `projects.indexCache.maxEntries` and `maxHeapShare` instead of the constant 32 and 10 %, with the bytes-per-character factor corrected to 4.5. Do the same for the item-text cache (6 %, ≤ 96 MB).

### P3. Extraction off the event loop

- Run `extractText` (and the pdfium scan render) in a small `worker_threads` pool per worker process, like document generation already does (`server/services/documents/renderService.js` + `documentWorker.js`, with a timeout and termination).
- The bytes go in as a transfer and only the text comes back.
- This removes every extraction stall in the table above. CPU use stays the same, but chats on the same worker no longer wait. It also gives extraction the timeout it lacks today.
- Optional later: replace jsdom in the Word path with the lighter DOM that turndown already ships (domino). That halves the cost of Word files.

### P4. One index per pod instead of one per worker

The Node cluster cannot route an HTTP request by project: the primary hands out connections before it parses HTTP. So route the **search**, not the request:

- **Ownership:** each project has an owner worker. Use rendezvous hashing over the live workers, so a restart moves only that worker's projects.
- **Search on the owner:** a worker that is not the owner sends the search over `clusterBus` request/reply (`server/clusterBus.js:651`). The owner builds and caches the index and returns the selected excerpts (at most 25k tokens, about 100 KB over IPC).
- **Effect:** a pod with W workers caches up to W × as many distinct projects with the same memory. An index is built once per pod, not once per worker.
- **Risks and how to handle them:**
  - *Hot owner* (one popular project, or one owner that is extracting a large file): cache a project locally too once it exceeds a request rate, and fall back to a local build when the owner does not answer within its timeout (for example 1 s).
  - *IPC latency:* about 1 ms plus the payload, small compared with the LLM.
  - *Uneven key distribution:* rendezvous hashing spreads keys evenly; check with the P1 metrics.
- **Alternatives:**
  - *(a) Persist the index per text hash on disk.* Shared by all workers and survives restarts. Only worth it if loading is much cheaper than rebuilding; measure first.
  - *(b) Build the index in the P3 thread pool.* Removes the stall but not the duplicated memory or CPU; it fits together with P4.

### Order and expected effect

| Step | Effort | Expected effect |
| --- | --- | --- |
| P1 monitoring | small | Working set and hit rate known; basis for P2.2 and P4 |
| P2.1 Excel `sheetRows` | very small | The largest stall drops about 3.5× |
| P2.2 configurable cache | small | Memory can be traded for CPU per installation |
| P3 extraction in threads | medium | No extraction stalls; ingestion no longer slows chats |
| P4 project ownership | medium–large | Distinct cached projects × W; one build per pod |

## 4. Verifying it

After each step, rebuild the lab image and repeat the same runs as the baseline:

- E1 at W=4, baseline 150 users;
- E2 at concurrency 2, baseline fails at 5 users;
- the worker sweep W=1/2/4, to see whether capacity scales with workers again.

The harness needs one addition for P1: show the cache hit rate in the report.

**Representativeness:** the load test spreads project chats evenly over 220 projects (200 own, 20 shared). Real usage is probably skewed (a few shared projects get most of the turns), which helps caches. Use the P1 numbers from production to calibrate the harness's project mix before tuning the cache size from load-test data.

## 5. Open questions

1. Which cache size should the default be once it is configurable: the current behaviour, or derived from the P1 working set?
2. Should P4 also cover the item-text cache, or only the index?
3. Is a persisted index (P4 a) worth measuring, or does P4 make it unnecessary?
