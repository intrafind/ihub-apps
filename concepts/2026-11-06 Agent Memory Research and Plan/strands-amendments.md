# Strands Agents memory compared with this plan: findings and proposed amendments

**Date:** 2026-11-11
**Status:** Accepted on 2026-11-11, with one change: **M21 adds no keyword, BM25 or ranked search to memory** (see §3). The six amendments are written as ADRs M21–M26 in the format of `architecture.md` §11 and have been folded into the README (§5 decisions 16–21, §6.3, §6.4, §6.6, §7), the architecture (§2.2.1, §4.5, §5.3, §5.7, §6.1–§6.3, §6.5, §7.1, §8.6, §8.7, §10.8, §11), the engineering and product plans and `tickets.json`. M22 stays conditional on a Phase 1 spike. Nothing outside this folder has been changed.
**Input:** [`research/strands_agents_memory.md`](research/strands_agents_memory.md), the verified account of what `strands-agents/sdk-python` ships (the public docs page and the design documents describe more than the code does).
**Method:** the Strands feature set was set against README §5–§7, `architecture.md` §0–§11 and the open memory issues (epic #3365, phases #3374–#3378). Every claim about this plan below cites the section it comes from.

---

## 1. Verdict

1. **The direction holds.** Strands confirms the two choices that were most debated here: build on the owned service rather than adopt a library (ADR-M01), and an always-on budgeted block rather than recall by model judgment (ADR-M06). Strands defaults to a recall tool plus a per-turn search injection, and its own design notes list "active recall depends on model judgment" as an open weakness.
2. **What this plan spends most of its effort on, Strands does not have.** Entry ids, update and delete, provenance, invalidation, review queue, consent and pause, deletion cascade, sensitive-data filter, budgets and quotas, redacted telemetry, versioned writes, durable extraction state and the link between compaction and extraction are all absent from the shipped Strands memory (research note §5). That is the governance the epic puts first; it is not available off the shelf, and the Phase 0 work is not over-engineering.
3. **Strands is ahead in four narrow places**, all failure and cost mechanics, not product shape: how an injected block interacts with prompt caching, what happens to an extraction batch that keeps failing, how a design that relies on timers survives a restart, and how a consolidation plan is validated before it is applied. Those are ADRs M22–M25. Two smaller gaps (the overflow read path and the read timeout) are M21 and M26.
4. **One inconsistency inside this plan** surfaced while reading §6.5 against §2.6 (ADR-M25).

Priority if only some are taken: **M23, M25, M22** (correctness or cost that appears only after launch), then **M24, M21**, then **M26**.

---

## 2. Side by side

"Strands" means what ships, not what its designs propose.

| Dimension | Strands (shipped) | This plan | Reading |
|---|---|---|---|
| Tenancy and scope | None in the manager; each store's constructor scopes it; docs say one store per tenant | Scope from the trusted principal, never from an argument (ADR-M02, M19) | Ours is stronger; nothing to take |
| Entry identity, update, delete | No id, no update, no delete; correction means "add a newer fact" | Ids, `memory_update/delete`, invalidate instead of delete (ADR-M05) | Ours is stronger |
| Read path | Search tool plus per-turn search injection, keyword or managed retrieval, top 3–5 | Whole valid set in a budgeted block; `memory_list` for overflow (ADR-M06) | Ours is simpler and does not depend on the model; overflow path is thin (M21) |
| Injection placement | Trailing block of the last user message, per call, never stored; cache point placed ahead of it | System prompt, between projects and skills (§6.3); ledger placeholder (§6.7) | Different trade-offs; ours is unanalysed for mid-chat changes (M22) |
| Injection budget | Entry count only | `promptBudgetChars`, priority order, visible `shown` / `entries` (§6.2) | Ours is stronger |
| Block wording | XML-escaped entries, no preamble, no dates | Neutralised text, "data, not instructions" preamble, dates, access mode (§6.1) | Ours is stronger |
| Extraction trigger | Every invocation or every N turns (default 5); eviction trigger is design only | Debounced per chat after the turn; flush before compaction drops turns (§7 Phase 3) | Ours covers the eviction case that Strands only designed |
| Extractor input | New batch only, no existing memories | Oldest unprocessed turns, current entries, rolling summary (§6.3) | Ours is stronger |
| Dedup and retries | At-least-once; retried batches duplicate; unparseable output counts as success and is lost | CAS, tombstones, per-operation checks, `controlsVersion` guard (§6.3) | Ours is stronger on duplicates; **weaker on a batch that always fails** (M23) |
| Durability of extraction state | Buffer and marks in memory; crash loses turns; flush on shutdown | Watermark in the stored document (durable), debounce timers in memory (§6.3, engineering-plan) | Watermark is better; the timer loss is the same class of problem (M24) |
| Failure backoff | 10 consecutive failures, then probe every 3rd request | Daily call cap and slot accounting (§2.2); no consecutive-failure policy | Ours has a cost ceiling but no backoff (M23) |
| Consolidation | Design only; plan-then-execute with validation of every referenced path | Phase 4: operations plus rewritten notes, loss fraction, `baseVersion` (§6.5) | Ours ships a proposal flow; validation is thinner than the design Strands only drafted (M25) |
| Compaction and memory | Independent; extraction never sees the summary | Summary feeds extraction; flush before drop (ADR-M10) | Ours is stronger |
| Review, consent, deletion | None | Review queue, pause, per-chat off, cascade (§6.5–6.7) | Ours is stronger |
| Telemetry | Spans for search, add, inject, extract; the memory text is always recorded in them | Redacted, hash-only ledger rules (§6.7, ADR-M12) | Ours is stronger |
| Backends | Pluggable `MemoryStore`: `search` required, everything else optional | Scope handlers; no retrieval layer until a database provider exists (ADR-M01) | Strands' minimal interface is a possible seam for a later retrieval concept; not planned now (decision 2026-11-11) |

---

## 3. Proposed amendments

Each entry gives the evidence, the change, the tickets it touches and the alternative that was weighed.

### ADR-M21: a bounded overflow read, without search

**Gap.** When the valid set exceeds `promptBudgetChars`, §6.4 shows the highest-priority entries and tells the model to call `memory_list`. `memory_list` takes `category`, `includeInvalidated` and `limit` (default 100, maximum 200; `architecture.md` §4.5), so with the default `maxEntries` of 100 it can return one partition's whole set (up to 100 entries of 500 characters, about 50 KB, more with an app and a project partition) into the model's context. `limit` bounds the count, not the size. And the block only says that entries are missing, not which kind.

**Decision of 2026-11-11.** No free-text query, no BM25 over entries and no `search` method on the handler contract. The original proposal reused the projects BM25 provider and reserved `search(scope, query, { limit })` as the seam for a later retrieval backend (Strands' one required store method). That is dropped: ranked or keyword retrieval stays a later concept (ADR-M01, #2389, #2906) and this plan does not prepare a seam for it.

**Change.**
- `memory_list` serialises at most `2 × promptBudgetChars` characters (8 000 by default), in the selection order of §6.2, and returns `truncated: true` when entries were cut. `category` is how the model narrows a result; `limit` stays.
- When `shown < entries`, the trailing paragraph of the block names the unshown entries per category ("3 entries are not shown (profile 1, reference 2); call memory_list with a category to see them") instead of only saying that some exist.

**Touches.** #3394 (tool), #3392 (block text), architecture §4.5, §6.1, §6.2.
**Size.** Small. No new infrastructure and no new setting.
**Rejected.** Keyword or BM25 search over entries (decided against, above), embeddings (ADR-M01), and injecting the top-N entries by relevance to the last message every turn, as Strands does: it puts retrieval on the critical path of every turn and depends on query quality, which the always-on block avoids.

### ADR-M22: entries added during a chat do not enter that chat's block

**Gap.** §6.3 says "the block changes only when entries change (not per turn) … prefix caching therefore survives across turns of a chat". That holds in Phase 1 only until the chat itself saves something: after `memory_save` in turn 6, turn 7 has a different system prompt, and a provider that caches the system prompt and the message prefix together re-reads the whole chat uncached. Phase 2 makes this routine, because extraction adds entries between turns of the chat it is learning from. The repository's adapters do implement prompt caching (`server/adapters/promptCaching.js`; `prompt_cache_key` per app and model).

**What Strands shows.** It injects as a trailing block of the last user message, per call, never stored, and reports the trailing block count so the adapter puts the cache point before it: its injection can change every turn without costing the cache.

**Options.**
1. Status quo. Cheapest to build; the cost grows with chat length and extraction frequency.
2. **Pin the chat to the entries that existed when it started.** Store `memoryAsOf` (a timestamp) in the chat's `settings` at the first memory-enabled turn. `buildUserMemoryBlock` renders only entries with `createdAt <= asOf`. Removals take effect at once (invalidate, delete, pause, clear, account deletion must never wait for a cache), so only *additions* are deferred. `memory_list` stays live, and a fact the model just saved is already in its history through the tool result. `memoryAsOf` resets on `/compact` (compaction rebuilds the prefix anyway) and in a new chat.
3. Strands' approach: a per-call trailing block in the last user message. Insensitive to every kind of change, but the block's tokens are billed uncached on every turn, and the ledger placeholder and `{{user_memory}}` placement (§6.3) have to be redone for a message instead of the system prompt.

**Proposal.** Option 2, decided as a gate before Phase 2, not before Phase 1. Phase 1 adds one spike: confirm in `anthropic.js` and `bedrock.js` where the cache breakpoint sits (if the system prompt is not part of a cached prefix together with the messages, this ADR is moot), and record cached-token counts per chat for memory-enabled turns if the usage normaliser exposes them. The attributes `entries`, `shown` and `updated` in the block (§6.1) become "as of" values.

**Touches.** #3395 (injection), #3392 (block: `asOf`), #3396 (chat settings key), #3385 (replay: `renderBlock(doc, { version, asOf })`), #3417 (reset on checkpoint).
**Rejected.** Option 3 as the default: it moves the cost to every turn to save a cost that only some chats incur.

### ADR-M23: an extraction failure policy for batches that keep failing

**Gap.** §5.3 and §8.6 end a malformed or failing call as `failed`: no write, no reschedule, watermark unmoved. The next turn schedules extraction again, and the batch always starts at the **oldest unprocessed turn**. If one turn deterministically breaks the extractor (a very long paste, a refusal, text the model cannot put into the schema), every later turn of that chat spends up to two slots (the call plus the one `jsonInstruction` retry) on the same head-of-line batch, makes no progress, and drains the daily cap until midnight. Provider outages are handled (slot kept, no reschedule, cap as ceiling), but nothing distinguishes an outage from a poison turn, and nothing backs off.

**What Strands shows, both ways.** Its failing batch is retried and the high-water mark rolls back, so a poison batch blocks too; its backoff (10 consecutive failures, then one attempt per three requests) is the cost control this plan lacks. And its parser returns `[]` on unparseable output, which counts as success, so such a batch is dropped without a trace. Both extremes are wrong; the contract here must say what happens at each failure class.

**Change.**
- Per chat, `extractionState: { watermarkSeq, failures }` on the budget document `user-memory-budget/<userId>` (it already takes CAS writes). Only **content-class failures** (malformed output after the retry, schema rejection, `finishReason: 'length'`, provider content refusal) count as failures of a batch. Connection errors, timeouts and 5xx are **availability-class** and never count toward skipping a batch.
- After 2 content-class failures at the same watermark, the next attempt halves `messageWindowSize` (down to one turn). A one-turn batch that fails again is **skipped**: the watermark advances past it, the skip is recorded in the activity summary (`skipped: 1`) and logged with the chat and turn id, and the failure counter resets. A skip is visible; it is never the silent drop Strands' parser produces.
- A per-user breaker: 5 consecutive failed calls of either class pause extraction for that user for 1 hour (`pausedUntil` on the budget document). A fully filtered or `noop` result does not reset the streak (Strands has a test for exactly this case).
- `maxCallsPerUserPerDay` stays the hard ceiling.

**Touches.** #3409 (extractor), #3408 (budget document shape), architecture §2.2, §5.3, §8.6.
**Tests.** A poison turn at the head of a backlog: converges after at most 4 calls, the later turns are extracted, the skip is shown in the activity row. Outage: never skips. Breaker: opens after 5, closes after an hour.

### ADR-M24: durable catch-up for extraction

**Gap.** The debounce map is per worker and in memory (engineering-plan: `MAX_PENDING_EXTRACTIONS = 1000`, cancel-and-reschedule, "immediate on chat close"). iHub has no chat-closed or chat-idle event (README §4.5), so "immediately on chat close" has no trigger. After a restart, a deploy or a worker crash, pending timers are gone; the watermark is durable, so the next turn of that chat catches up, but a chat that simply ends after its last turn is never extracted. The same applies to the Phase 3 flush: nothing flushes a chat's backlog if the person never returns.

**What Strands shows.** The same failure class with a smaller blast radius: its buffer is in memory, a crash loses unsaved turns, and it mitigates with `flush()` after each synchronous invocation and on `shutdown()`.

**Change.**
- When a debounce is first scheduled for a chat, add `{ chatId, dueAt }` to a bounded `due` list (at most 20 per user) on the budget document; remove it when that chat's extraction finishes, is skipped or is cancelled. Write only when the chat is not already in the list, so a long chat costs one extra CAS write, not one per turn.
- A catch-up sweep under `ownsClusterSingletons` (the `startChatRetentionSweep` pattern, §4.5) runs every 5 minutes, takes `due` entries older than `2 × debounceSeconds`, and schedules them through the normal path (same slot reservation, same guards).
- Graceful shutdown runs due extractions for at most a few seconds each; it is an optimisation, not a guarantee, because the sweep is the guarantee.
- "Immediately on chat close" is replaced in the plan by "the sweep" wherever it appears.

**Touches.** #3409, #3408, #3384 (`postTurn` registry), engineering-plan (extractor module), README §6.3.
**Rejected.** Scanning all chats for `seq > watermark`: it reads every chat of every user.

### ADR-M25: consolidation proposals are validated plans, and the operations are authoritative

**Inconsistency.** README §2.6 lists "context collapse": the defence is "consolidation emits operations, not replacement prose; cap prior-entry loss". §6.5 of the architecture then has the model return the **complete consolidated notes** *and* a list of operations, and `lossFraction` "compares the number of retained bullets". Nothing checks that the two agree: the notes can drop a bullet no operation names (silent loss the fraction counts only if it crosses 25%), keep a bullet an operation says to drop, or merge two bullets into text that is neither. Operation lines refer to prompt-assigned bullet numbers (`[1]`, `[2]`) and nothing checks that those numbers exist.

**What Strands shows.** Its consolidation is design only, but the design is the right shape: the model returns a plan, a validator checks it against a snapshot of the input (every referenced item exists, no item is both written and deleted, action count under a cap, the input under a size bound, any failure throws before anything is mutated), and a deterministic executor applies it, writes before deletes.

**Change.**
- The `operations` are authoritative. The consolidator builds the new notes by applying them to the numbered input bullets; the model supplies text only for `merge` results and `add-lesson`. A `<notes>` block in the reply is accepted only as a cross-check: bullets present in the input and absent from both the notes and the operations are **unexplained loss**, and any unexplained loss rejects the proposal.
- Validation before a proposal is stored: every referenced bullet number exists; no bullet appears in two operations; action count ≤ `maxOperations` (default 50); input (notes plus `maxRunsRead × maxHistoryReadChars`) ≤ `maxInputChars`, otherwise the run is `skipped: input_too_large` and recorded, never truncated silently. `maxPriorEntryLossFraction` then applies to **explained** loss.
- A `drop` of the bullet that carries the newest `(seen YYYY-MM-DD)` date fails validation unless a `merge` result keeps that date; the composer's "always keep the latest watermark" rule (§4.6 of the task-memory concept) becomes a check instead of a prompt request.
- The proposal stores the operations next to the diff, so the review card can say "merged 3, dropped 2" and the owner can inspect each.

**Touches.** #3422 (consolidator), #3423 (sweep and routes), #3424 (review card), architecture §5.7, §6.5, README §2.6 wording.
**Note on evidence.** The Strands consolidation is a draft, so this is borrowed design, not borrowed experience. The case for it rests on the inconsistency above, not on Strands.

### ADR-M26: a time bound on the prompt-path read

**Gap.** §8.6 makes the read fail open when storage is unavailable, and §8.7 budgets 10 to 25 ms on the filesystem provider, but nothing bounds a slow read: a stalled provider, a lock, or a key service would delay the first token of every memory-enabled turn. Strands awaits its store search on the critical path with no timeout and has no answer either; its parallel fan-out only helps across stores.

**Change.** `platform.memory.readTimeoutMs` (default 1500, bounds 200–10000). On expiry the turn proceeds without the block, `meta.extra.memory.reason: 'timeout'` is recorded, and a warning is logged. The same bound applies to the replay expansion. One line in the §8.6 table.

**Touches.** #3395, #3393 (handler), #3387 (settings), architecture §7.1, §8.6.

---

## 4. Tests to add (from Strands' suite and from the failure classes above)

| Test | Where it belongs |
|---|---|
| A retried batch after a partial failure does not duplicate an entry (Strands `…rolls_back_and_retries_batch_on_entry_failure`) | #3409 extractor tests |
| A turn that filters to nothing leaves a gap in `seq`; the next batch skips it (Strands `…keeps_a_message_seq_when_an_earlier_message_is_filtered_to_empty`); also does not reset the failure streak | #3409, M23 |
| Model output wrapped in prose or a code fence still parses; output with no JSON is a content-class failure, not a success | #3409, M23 |
| The usage of an extraction call that ends in a content-class failure is still recorded under `surface: 'memory'`, because the provider billed it (Strands `…usage_to_the_request_total_even_when_the_request_limit_is_used_up` makes the same point for its own accounting) | #3408, #3409 |
| An override of `extraction.modelId` never drops the current entries from the prompt (the Strands harness drops its key-aware extractor when a custom one is passed) | #3409 |
| Block rendering with `asOf`: an entry added after `asOf` is absent, an entry deleted after `asOf` is absent, `shown` / `entries` agree | #3392, M22 |
| `memory_list` never returns more than `2 × promptBudgetChars` characters and sets `truncated` when entries were cut; the block trailer names the unshown count per category | #3394, #3392, M21 |
| A consolidation reply whose notes drop an unnamed bullet is rejected; one that references a missing bullet number is rejected; the newest watermark cannot be dropped | #3422, M25 |
| A restart between the turn and the debounce firing: the sweep extracts the chat within two intervals | #3409, M24 |

---

## 5. Considered and not adopted

| Strands feature | Why not |
|---|---|
| Multi-store fan-out with rank-position merge | Partitions already union under one budget (§6.4); a second ranking has nothing to rank |
| A store per tenant as the isolation boundary | Isolation here comes from the principal (ADR-M02), which cannot be misconfigured per deployment |
| `add_memory` with a list and `wait_for_writes: false` | Fire-and-forget swallows failures; writes here fail closed (§8.6). A batch parameter on `memory_save` is possible later, if the Phase 1 eval shows turns with several facts; it would need one Undo per entry |
| The file-listing injector and `read_<store>_file` tool | Design only in Strands. `memory_list` with a query (M21) covers the same need with one tool |
| An eviction trigger for extraction | Design only in Strands; the Phase 3 flush before compaction already covers it, and Strands' own shipped code does not connect compaction to extraction at all |
| Consolidation operations `deriveInsights` and `reorganize` | An unreviewed generalisation is the "wrong reflection sticks" failure of README §2.6; lessons stay review-gated (Phase 4) |
| A `query` on `memory_list`, BM25 over entries, a `search` method on the handler contract | Decided 2026-11-11: no ranked or keyword retrieval in memory yet; revisit with the retrieval concept after #2389 and #2906 (ADR-M01) |
| Search and add as the default agent surface | Recall by model judgment is the weakness the always-on block exists to avoid |

---

## 6. Decisions of 2026-11-11 and what is still open

- **Accepted:** M21 (without any search), M22 (conditional, below), M23, M24, M25, M26.
- **M22 is conditional** on the Phase 1 spike in ticket P1-09: where the Anthropic, Bedrock and OpenAI adapters put the cache breakpoint relative to the system prompt and the messages, and whether the usage normaliser exposes cached-token counts. If the system prompt is not part of a cached prefix together with the messages, M22 is withdrawn and `architecture.md` §6.3 and README Decision 17 revert.
- **Measured in P2-01:** the listing cost of the catch-up sweep (M24) at 10 000 budget documents; the interval is a constant and can be lengthened.
- **Not done here:** the GitHub issue bodies still carry their original text. `tickets.json` holds the amendments; the epic #3365 has a comment that lists them.
