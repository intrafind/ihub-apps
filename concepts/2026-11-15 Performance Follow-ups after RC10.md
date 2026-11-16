# Performance Follow-ups after RC10

Status: plan (2026-11-15). Source: RC8–RC10 load tests (#3631), sizing guide (`docs/sizing.md`).
Merged since RC10: #3684 (ledger), #3685 (usage limits), #3686 (storage).

One pod is limited by **event-loop delay** (150 ms p95 at 40–60 % CPU), not by CPU. The items
below are ordered by expected gain per effort. Each is measured in the load lab (company mix,
800 test users, 8 workers, aged data) against the #3684–#3686 baseline: ELD p95 130 ms,
overhead p95 ~300 ms.

| # | Item | What it removes | Effort | Issue |
| --- | --- | --- | --- | --- |
| 1 | Chat uploads ahead of project ingestion | A chat upload waits behind a project's batch in the shared extraction queue (`extractionPool.js`, FIFO) | S | new |
| 2 | Load-test SLO counts the extraction thread correctly | Wrong "CPU full" verdicts | S | #3675 |
| 3 | Memory accounting: extraction thread and index cache | Workers sized for the heap only (~650 MB outside it); the index cache uses about twice its budget | M | #3673, #3681 |
| 4 | Usage limits: one document per user, relaxed check | `quota-usage.json` grows with every user; exact check on every request | M | new |
| 5 | Send the chat POST to the worker holding the stream | Every token of an answer relayed through the primary when POST and stream land on different workers | M | new |
| 6 | One project index per pod | Each worker loads and holds the same project indexes | L | #3651 |
| 7 | Password and refresh-token hashing | `bcryptjs` runs on the event loop at login and token refresh | S | new, measure first |
| 8 | Dashboard and alerts | ELD, overhead, disk growth, page-cache fit | S | new |
| 9 | Load lab beyond one pod | Several pods behind an ingress, dedicated nodes, multi-day soak | M | #3631 |

## Notes per item

1. **Upload priority.** Two queues in the pool, chat jobs first; a project job never waits more
   than N chat jobs (no starvation). Measure: chat-file time to first token while a project
   build runs.
4. **Usage documents.** One storage document per user, written by the primary only for users that
   changed. A check reads the cached document and is exact only above ~80 % of a limit.
   Trade-off as today: tokens counted on other pods in the last seconds can be missed.
5. **Stream owner.** The worker that receives the POST asks the bus which worker holds the
   chat's stream and, if another, hands the run to it, so tokens are produced where they are
   sent. Alternative: run on the receiving worker and send the stream directly worker to worker.
   Measure the primary's CPU and IPC lag first; at 800 users the IPC queue lagged > 500 ms.
6. **Project ownership.** Projects are hashed to one worker per pod; other workers forward
   searches to it. Largest change; removes N copies of each hot index and its cold loads.
7. **Hashing.** `bcryptjs` async yields between rounds but the CPU stays on the event loop. Move
   to the native `bcrypt` package or a worker thread only if a login burst shows in ELD.

## Not planned

- Raising `maxHeapShare` before #3681 is fixed.
- A cache in front of the chat list beyond the per-user memo from #3686.
