# Project Search Worker Threads

**Status:** implemented on branch `perf/search-pool` (on top of `perf/eventloop-1000`). Not yet measured under load.

Follow-up to `concepts/2026-11-12 Event-Loop Blocking and Project Index Caching.md`.

## Why

CPU profiles of the 1,000-user load test (6 workers, steady state) showed event-loop blocks of 20 ms and more in:

| Where | Total | Longest |
| --- | ---: | ---: |
| Project search: `LocalKnowledgeProvider.search` → `collectHits` (`tokenize`, `expandTerm` over every indexed term) | 35.8 s | 651 ms |
| Planning and excerpts: `planKnowledgeScope`, `excerptsFor` (the same search, plus `estimateTokens` of each excerpt section) | 11.3 s + 8.3 s | 562 ms |

The event-loop delay p95 peaked at 155–205 ms against a 150 ms SLO.

## Design

```
event loop (LocalKnowledgeProvider.search)            search thread (searchWorker.js)
------------------------------------------            -------------------------------
key = projectId:fingerprint (no decryption)
searchProjectIndex(key, query, limits)  ───────────►  cache.get(key)
                                        ◄───────────  { miss: true }  or  { hits, totals }
on miss: load + decrypt texts (as before)
searchProjectIndex(key, query, docs)    ───────────►  buildCorpusIndex(docs), cache it, collectHits
                                        ◄───────────  { hits, totals, buildSeconds, evicted }
```

- `server/services/knowledge/corpusSearch.js`: the pure part (LRU of corpus indexes, `searchIndex`, `renderExcerptSection`). Runs on a thread or, with the pool off, on the event loop — same code, same results.
- `server/services/knowledge/searchPool.js`: the threads. A project is routed to `hash(projectId) % threads`, so its index lives on one thread. Every message has an id; the thread handles messages in order, so its message queue is the job queue (no queue on our side). A crashed thread fails its pending jobs and is replaced on the next search with an empty cache.
- `server/services/knowledge/searchWorker.js`: the thread entry; tasks `search` and `evict` (no answer).
- `LocalKnowledgeProvider._rank`: ask by key first; load texts and send them only on a miss. Index-cache metrics are counted on the event loop from the answer (`buildSeconds === null` is a hit).
- `KnowledgeScopePlanner.excerptsFor` asks with `sections: true`; the thread renders each excerpt section and counts its tokens (that counting was the 8.3 s).

### What crosses the boundary

- Per query: the key, the question, `limit`, `budgetChars`, `docIds`, the limits — a few hundred bytes. The answer is the hits, at most `budgetChars` of text (40,000 characters by default). The test `server/tests/knowledge-search-pool.test.js` prints the sizes.
- Per index build (first use, changed items, eviction, a new thread): the project's texts, once. The main thread still decrypts them (`ItemTextService`), because decryption needs the key provider and link items need the network; moving that into the thread would be the next step if the copy shows up in profiles.

### Settings

`platform.json` → `projects.search.threads` (default 2, 0–8, `0` = on the event loop). Each cluster worker has its own threads. The `projects.indexCache` limits (entries and characters) are split evenly across the threads.

## Not done (yet)

- `focusedRemainder` in the planner (a document cut by the hard limit) still runs `selectContent` on the event loop. It only runs when the injected text exceeds 75 % of the context window.
- `LocalKnowledgeProvider.read` with `focus` (`knowledge_read`) and `getContentStats` in `loadAll` still run on the event loop.
- No time budget per search; a thread that hangs is not replaced. The work is bounded by the project's text.
- Changing `projects.search.threads` at runtime moves projects to other threads (their indexes are rebuilt); threads above the new count stay idle until restart.

## How to verify

1. `node --test server/tests/knowledge-search-pool.test.js` (equality with inline, message sizes, eviction, fallback).
2. Load test as in `concepts/2026-11-12 Load Test and Sizing Plan.md`: compare event-loop peak p95 and CPU profiles; `collectHits` should no longer appear on the main thread.
