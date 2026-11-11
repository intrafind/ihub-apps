# Strands Agents memory: what the code does

**Date:** 2026-11-11
**Source:** `strands-agents/sdk-python` at `b17ae40` (2026-11-10), a monorepo holding `strands-py/`, `strands-ts/`, `harness-ts/` and the design docs in `team/designs/`; the public page <https://strandsagents.com/docs/user-guide/sdk/memory/overview/> and its sub-pages. The `strands-agents/sdk-typescript` and `strands-agents/docs` repositories are archived mirrors without memory code.
**Why this note exists:** [`../strands-amendments.md`](../strands-amendments.md) compares the Strands memory feature with this plan. The comparison is only useful if it rests on what ships, and **the shipped code diverges from the two design documents** (`0011-memory-manager.md`, `0017-file-memory-store.md`). Do not cite those designs as precedent for anything listed under "design only" below.

Paths: `PY` = `strands-py/src/strands`, `TS` = `strands-ts/src`. Facts marked † were re-checked by grep when this note was written; the rest come from reading the code with the line references given.

---

## 1. Shape of the feature

`MemoryManager` is a plugin on the agent (`PY/memory/memory_manager.py:72-118`) that owns three jobs, each off or on independently:

| Job | Mechanism | Default |
|---|---|---|
| Recall | A `search_memory` tool (`query`, `max_search_results`, `stores`); results capped per store, default 3 | on |
| Injection | A per-call middleware searches the stores with the last user message and folds the hits into the model request | on, trigger `userTurn`, `max_entries` 5 |
| Extraction | Triggers feed a coordinator that turns new messages into entries and calls `store.add` | **off**; opt-in per store |
| Explicit write | An `add_memory` tool (`entries: list[str]`, `stores`) | off |

A **store** is the backend. `name`, `writable` and `search(query, options)` are required; `add`, `add_messages`, `initialize`, `get_tools` are optional and detected by method presence (`PY/memory/types.py:263-302`). `MemoryEntry` is `{content, store_name, metadata}`.

## 2. Injection

- The text is **appended as a trailing text block of the most recent user message** (`PY/injection/_message_injection.py:150-190`), for that model call only. `agent.messages` is never touched, so nothing is stored and nothing needs stripping (test `test_memory_injection_reaches_model_but_not_durable_history`). †(the fold)
- The reason is prompt caching, stated in the docstring: text ahead of the stable conversation "would invalidate the cache from the first block onward". The middleware reports one per-call trailing block so the Bedrock and Anthropic adapters put the cache point ahead of it.
- Query = the text of the latest user message (the assistant's last text on a tool-result turn). No minimum length, no truncation.
- Default rendering: `<memory><entry source="STORE">escaped text</entry>…</memory>`. Text and source are XML-escaped to blunt stored prompt injection. There is **no preamble** that tells the model to treat the block as data, and no ids, dates or metadata in the block.
- Budget control is an entry count (`max_entries`). Everything fails open: a raising `query`, `format` or `trigger` skips injection.
- The store search is awaited on the critical path of every user turn, **with no timeout**. Stores are queried in parallel and concatenated in registration order, with no cross-store ranking.

## 3. Extraction

(`PY/memory/extraction/coordinator.py`; the TypeScript coordinator is a line-for-line port.)

- A `MessageAddedEvent` hook copies every message into a coordinator buffer with a monotonically increasing `seq`. Each store has a **high-water mark**; only `seq > mark` is processed. The mark moves before the save and rolls back on failure.
- Triggers that **ship**: `InvocationTrigger` (after every agent invocation) and `IntervalTrigger(turns=N)`; the default is every 5 turns (`_DEFAULT_EXTRACTION_TRIGGER_TURNS = 5`). †  `EvictionTrigger` is **design only**: it is in design 0011 and nowhere in the code. †
- The default message filter drops `toolUse` and `toolResult` blocks. The default extractor renders only text blocks.
- The default extraction prompt is short: "extract durable facts … one discrete, self-contained fact … return ONLY a JSON array of `{"content": string}` … `[]` if nothing". The extractor sees **only the new batch**: not the existing memories, not the user.
- **Unparseable model output returns `[]`, which counts as success.** † The mark advances and that batch is never extracted, with only a warning logged (`model_extractor.py:142-156`).
- Saves for one store are serialised on a task chain. Failures are logged and swallowed. After 10 consecutive failures the store backs off and tries only every 3rd request; `flush()` bypasses the backoff. Delivery is at-least-once, so a retried batch can duplicate entries (tests expect it).
- **The buffer, marks and backoff counters live in memory only.** A crash loses unsaved turns. The Python synchronous call flushes after every invocation; `invoke_async`, `stream_async` and the whole TypeScript SDK flush only on `shutdown()`.
- No bound on the buffer (a permanently failing store grows it) and no timeout on the extractor call or the store write.

## 4. What the stores do

| Store | Scoping | Read | Write | Notes |
|---|---|---|---|---|
| `TestMemoryStore` | the file name | token overlap, ties by recency | append; exact-content dedup | one JSON file, rewritten on every add; for tests |
| `FileMemoryStore` | `memory/<name>/` over a `Storage` backend | keyword score over file names and bodies, reads every file per search | append lines to a slug-named markdown file; no dedup | **no frontmatter, no file-listing injector, no `read_<store>_file` tool, no `consolidate()`**: all design only † |
| `BedrockKnowledgeBaseStore` | `scope` → a metadata filter on `Retrieve`, stamped on writes | managed retrieval, optional score bounds | `IngestKnowledgeBaseDocuments` (custom or S3 sources) | eventually consistent; ACL filtering on read is **not** implemented (the docs mention retrieval `userContext`; nothing passes it) |

The key-aware extraction default of `FileMemoryStore` (it lists existing topic slugs so the model reuses a heading) is dropped when a caller passes an explicit `ModelExtractor`, which the harness packages do: files are then named from the first 50 characters of each fact, with no topic grouping.

## 5. Not in the product at all

Verified by grep over the memory and vended-store code. †

- Update or delete of an entry, an entry id, versioning, TTL, "list all".
- A review or approval queue, per-user consent, a forget flow, a deletion cascade, provenance on entries.
- A sensitive-data or PII filter (the only filter is by content-block type).
- Contradiction handling, consolidation (design only), recency decay.
- A token budget on injection (`maxTokens` is design only), a size cap on memory, per-user quotas, rate limits.
- A tenant or user concept in the manager. Isolation is whatever each store's constructor does; the docs say one store per tenant.
- Durable extraction state.
- Any link between conversation compaction and memory: the shipped `SummarizingConversationManager` replaces old messages with a summary, and the extraction coordinator, which buffers raw `MessageAddedEvent`s, never sees that summary. The unreleased context-manager design (0015) names an L1→L2 path but no code connects them.

## 6. Telemetry

Spans `memory.search`, `memory.add`, `memory.inject` and `memory.extract` (a detached root linked to the agent span); the extractor's token usage joins the request total (`PY/telemetry/tracer.py:962-1250`). The query, the results and the written content are always recorded in full, as span events (`memory.query`, `memory.results`, `memory.content`) or as span attributes under the `gen_ai_span_attributes_only` opt-in; no switch that omits the text was found †. So the trace backend holds the memory content. There is no metric for entry count or memory size.

## 7. Test names worth stealing

`test_a_fully_filtered_empty_turn_does_not_reset_the_failure_streak`, `test_a_healthy_store_keeps_saving_every_request_while_a_sibling_is_backed_off`, `test_extractor_route_rolls_back_and_retries_batch_on_entry_failure`, `test_add_messages_keeps_a_message_seq_when_an_earlier_message_is_filtered_to_empty`, `test_extracts_a_json_array_even_when_wrapped_in_prose_or_a_code_fence`, `test_returns_no_entries_on_malformed_json_without_throwing`, `test_adds_the_extraction_usage_to_the_request_total_even_when_the_request_limit_is_used_up`, `test_flush_does_not_re_extract_messages_already_processed`, `test_injection_fails_open_when_custom_query_raises`.
