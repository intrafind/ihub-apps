# Storage Provider & Durable Chats — Design

**Date:** 2026-09-09
**Status:** Approved design, ready for issue creation
**Author:** Daniel Manzke / Claude
**Supersedes:** [2026-03-18 Pluggable Persistence Layer PRD](./2026-03-18%20Pluggable%20Persistence%20Layer%20PRD.md), issues #1490, #1022, #1464, #475, #1499, PR #2053

---

## 1. Summary

iHub Apps gets a pluggable **StorageProvider** abstraction used for runtime data — **chats first** — and configuration. The filesystem remains the default provider with byte-identical behavior. Once chat persistence is active, an authenticated user can close the browser mid-answer, and the run completes and is stored; when they return they see the finished answer, can browse their chat history, continue any chat, and delete chats. Step 2 adds SQLite, PostgreSQL, and OpenSearch providers with migration tooling and an admin UI. Step 3 enables true multi-instance deployments (N instances behind a load balancer, coordinated via PostgreSQL).

### Decision log

| # | Decision | Choice |
|---|----------|--------|
| 1 | Default mode for chat persistence | **On for authenticated users**; anonymous users stay ephemeral/client-side. The per-chat `ephemeral` toggle remains the user escape hatch. |
| 2 | Relation to existing issues | **Fresh issue stack.** Supersede #1490/#1022/#1464/#475/#1499, close stale PR #2053. #1495 (job queue) stays open, out of scope. #1497/PR #2047 cross-linked as adjacent. |
| 3 | Step 1 scope | **Chat first.** Config read/write migration is its own step (before DB providers matter for config, and a hard prerequisite for multi-instance). |
| 4 | Provider lineup | **Filesystem (default), SQLite, PostgreSQL, OpenSearch.** S3 dropped (poor fit for append-heavy data; interface stays extensible). |
| 5 | UI scope | **Minimal UI in this epic**: history list, open, continue, delete, unseen-answer indicator. Folders/search/auto-titles are follow-up issues. |
| 6 | Data lifecycle in step 1 | **User delete + configurable retention** (max age / max chats per user). Admin purge tooling and encryption-at-rest are follow-ups. |
| 7 | Multi-instance | **In scope, must ship** (step 3 of the epic). |
| 8 | Architecture | **C: Ledger for the live window, ChatStore for durable history** (see §3). |
| 9 | Admin UI | Status page **plus** provider configuration forms **plus** guided migration wizard (step 2). |
| 10 | Chat request protocol | **Server-side history assembly in step 1.** When persistence is active, the client sends only the new message; the server owns the request context. Client-sent full history remains only for anonymous/ephemeral chats. Rationale: persisted history must not be client-asserted, and the continue-after-away flow guarantees client/server divergence. |

---

## 2. Current state (verified 2026-09-09)

What exists on `main` today, from a full code exploration:

- **The run ledger already exists**: `server/services/loop/RunLog.js` — append-only JSONL per run under `contents/data/run-log/` (`runs/<runId>.jsonl`), a per-day index (`index/<date>.jsonl`), spill files for large payloads, cursor-paged reads (`GET /api/runs/:id/events?after=<seq>`, `server/routes/runs.js:131`), client replay (`client/src/shared/run/ledgerPages.js`, `useRunStream.js` `resync()`), 90-day retention with daily cleanup, `deleteRun` with cascade hooks, and cluster-aware per-run sequence ownership over the IPC `clusterBus`. Events are typed and Zod-validated (`shared/runEvents.js`: `run/start`, `message/user`, `message/assistant`, `tool/call`, …). **It ships dark**: feature flag `runLog`, `default: false`, `preview: true` (`server/featureRegistry.js:171`).
- **Chat is the exception among run kinds**: `server/routes/chat/sessionRoutes.js:374-389` **aborts the LLM generation when the SSE client disconnects** (`abortChatRequest`). Workflow and agent SSE close handlers only detach listeners — those runs keep executing.
- **Chat history is client-side only**: browser `sessionStorage` keyed `ai_hub_chat_messages_<chatId>` (`client/src/features/chat/hooks/useChatMessages.js`); the client re-sends the full messages array on every POST. There is no server-side list/load-chat endpoint. The only resume path is the external iAssistant Conversation API proxy.
- **Workflows already survive user absence**: state checkpointed to `contents/data/workflow-state/<executionId>/latest.json` after every node (`StateManager.js`), resume-on-boot (`resumeManager.js`) + orphan sweep (`orphanSweeper.js`) gated by a scheduler-owner lock, durable interactions (`InteractionService`), and `chatBridge.recordPendingFinish` stashes finished results for 10 minutes so a reconnecting chat client can drain them.
- **Weak spots**: `ExecutionRegistry` (the only per-user run index) is a single JSON file written non-atomically with a 1 s debounce by every worker (last writer wins); workflow state has no time-based retention; `InteractionService` couples to `runLog.baseDir` path construction; `runAccess.js` authorizes by reading the first physical line of the run file; `ConversationStateManager` (iAssistant conversation ids) is memory-only.
- **Shared file utilities that become the filesystem provider's internals**: `utils/atomicWrite.js`, `utils/jsonlAppender.js`, `utils/debouncedJsonStore.js`, `utils/fileLock.js`. Cross-worker coordination: `server/clusterBus.js` (presence maps, publish/subscribe, correlated request/respond over Node cluster IPC; transport deliberately abstracted).

---

## 3. Architecture: ledger for the live window, ChatStore for durable history

During a run, events flow through `RunLog` exactly as today — that powers streaming, mid-run reconnect, and replay. At turn end, `ChatService` **materializes** the final messages into a chat-shaped store via the StorageProvider.

```
                     live run                          durable history
 ┌─────────┐   events   ┌──────────┐  materialize   ┌───────────────┐
 │ChatService│ ───────▶ │ RunLog   │ ─────────────▶ │  ChatStore    │
 └─────────┘            │ (ledger) │   at run end   │ (documents)   │
      ▲                 └──────────┘                └───────────────┘
      │ SSE + ledger replay   │                            │
      │ (return mid-run)      │                            │ GET /api/chats[/:id]
      └───────────────────────┘                            ▼ (return later)
```

- Return **mid-run** → SSE reconnect + existing ledger replay resumes the live stream.
- Return **later** → one document read loads the chat, including answers that finished while away.
- Browser closed **mid-run** → the run is no longer aborted (see §5); it completes under its existing budget/timeout guards and is materialized.

This formalizes what `chatBridge.pendingFinish` already does as a 10-minute in-memory hack.

**Consequence:** enabling chat persistence also enables run-ledger persistence — the `runLog` feature graduates from dark preview to the replay backbone.

---

## 4. The StorageProvider abstraction

One provider, two facets (documents vs. append-logs — forcing both through one document-KV interface was the old PRD's design flaw), plus the two multi-instance primitives.

```
StorageProvider (server/storage/)
├─ documents : DocumentStore
│    get(ns, key) → Document | null
│    put(ns, key, data, { ownerId?, etag?, contentType? }) → Document
│    delete(ns, key) → boolean
│    list(ns, { ownerId?, prefix?, limit?, cursor? }) → { items, nextCursor }
├─ logs      : AppendLog
│    append(stream, entry, seq) / appendBatch(stream, entries)
│    read(stream, { afterSeq, limit }) → entries
│    lastSeq(stream) / deleteStream(stream)
│    sweep({ olderThan })                    — retention
│    putBlob(stream, name, bytes) / getBlob  — spill payloads
├─ notifier  : ChangeNotifier
│    publish(event) / subscribe(handler)     — push or poll per provider
├─ locks     : LockManager
│    withLock(name, fn, { ttlMs, waitMs })   — leases with TTL
└─ lifecycle : initialize / shutdown / healthCheck / getCapabilities
```

Key choices:

1. **Sequence allocation stays with the run owner, not the provider.** `RunLog.append()` assigns `seq` synchronously in memory (SSE projection depends on it); the provider persists `(seq, event)` and answers `lastSeq()` for crash recovery. The live streaming path is unchanged for every provider.
2. **Domain repositories on top; routes never touch the provider.** `ChatRepository`, `RunLedgerStore` (the persistence half of `RunLog`), `WorkflowStateRepository`, `InteractionRepository`. `RunLog`'s in-memory event-stream layer is untouched.
3. **`ownerId` is first-class document metadata** so "list my chats/runs" is provider-indexed, never a scan. Filesystem: per-owner subdirectories; PostgreSQL: indexed column; OpenSearch: term query.
4. **Conformance suite**: ~40 abstract tests every provider must pass (CRUD semantics, owner listing, cursor paging, seq recovery, lock TTL/expiry, notifier delivery). It is the acceptance gate for step 2.

The filesystem provider wraps the existing utilities (`atomicWrite`, `jsonlAppender`, `debouncedJsonStore`, `fileLock`) — behavior stays byte-identical for current deployments.

### Namespaces (this epic)

| Namespace | Key | Owner-scoped | Contents |
|-----------|-----|--------------|----------|
| `chats` | chatId | yes | chat metadata (§5) |
| `chat-messages` | chatId | yes | the chat's messages document (§5) |
| `runs` | runId | yes | run summaries — replaces ledger index files **and** `ExecutionRegistry` (§6) |
| `workflow-state` | executionId | yes | workflow execution state (`latest.json` equivalent) |
| `interactions` | interactionId | via principal | pending interactions (replaces `run-log/interactions.json`) |
| `integration-conversations` | chatId | yes | iAssistant conversation state (replaces in-memory `ConversationStateManager`) |
| *(step: config)* `config`, `apps`, `models`, `prompts`, `workflows`, `pages`, … | id | no | configuration documents |

Log streams: `run:<runId>` (ledger events, with spill blobs). Usage tracking, feedback, audit log, shortlinks stay on their current file stores — they migrate namespace-by-namespace later if wanted; their utilities become the filesystem provider anyway.

**Blobs:** uploads (`contents/uploads`) and agent artifacts (`contents/data/agent-artifacts`) stay on the local filesystem in this epic. Multi-instance deployments require a shared volume for them (documented); a provider-backed blob facet is a follow-up issue.

---

## 5. Chat persistence

### Data model

- `chats/{chatId}` — `{ id, ownerId, appId, modelId, title, createdAt, lastMessageAt, messageCount, activeRunId, hasUnseenActivity, status }`. Title defaults to the truncated first user message; LLM auto-title is a follow-up (build on `server/agents/runtime/titleGenerator.js`).
- `chat-messages/{chatId}` — `{ version, messages: [{ id, role, content, ts, runId, usage?, error? }] }`. One read loads a chat; one atomic document rewrite per turn stores it. Per-message rows are a provider-internal option (PG/OpenSearch) behind the same logical model.

### Request protocol: server-side history assembly

When persistence is active (authenticated, non-ephemeral), the client sends **only the new message**; the server loads the stored history from `chat-messages/{chatId}` and assembles the model request itself. The persisted record is therefore never client-asserted, and stale client state (browser closed mid-run, second device, second tab) cannot fork or overwrite history — the server's copy is the request context by construction.

**Edit/regenerate semantics** become explicit: the new message may carry `replaceFromMessageId`, which truncates the stored history from that message onward before appending — covering "edit an earlier message and resend" and "regenerate this answer" without the client ever rewriting history wholesale.

Anonymous and ephemeral chats keep today's protocol (client sends the full messages array); that path has no server-side history by design, so dual-mode is inherent, not transitional.

### Write path (materialization)

`ChatService` writes the user message at run start (a pending chat shows its question) and the final assistant message at `run/end` — **including when the run ends with nobody connected**. Materialization reads from the run's own events, never from a client-supplied array. Abort/error outcomes are recorded on the last message. Ephemeral chats and anonymous users never touch the store.

### The disconnect behavior change

When chat persistence is active and the user is authenticated, `sessionRoutes` **no longer aborts the run on SSE close** (today: `sessionRoutes.js:374-389`). The run finishes under existing budget/timeout guards; `hasUnseenActivity` is set if no client was connected at completion. The Stop button remains an explicit abort (`POST …/stop`, exists today). For anonymous users and persistence-off deployments, today's abort-on-disconnect behavior is preserved.

### API

- `GET /api/chats` — my chats, cursor-paged, sorted by `lastMessageAt`
- `GET /api/chats/:id` — metadata + messages (clears `hasUnseenActivity`)
- `PATCH /api/chats/:id` — rename
- `DELETE /api/chats/:id` — cascade: chat documents + its ledger runs (`refs.chatId`) + their artifacts/spill

### Retention

`platform.json → chats: { retentionDays, maxChatsPerUser }`, enforced by the daily sweep alongside the existing ledger cleanup (`RunLog.startCleanupScheduler`). Deleting by retention uses the same cascade as user deletion.

### Minimal UI (this epic)

Chat history list in the sidebar (grouped by recency), open a past chat, continue it, delete it, and a "finished while you were away" indicator driven by `hasUnseenActivity`. When persistence is on, the client hydrates from `GET /api/chats/:id` instead of `sessionStorage` and sends only the new message per request (the client half of the protocol in §5). Folders, colors, search, auto-titles: follow-ups.

---

## 6. Runtime store consolidation

- **Ledger onto the provider**: `RunLog` events → `logs.append('run:<runId>', …)`; spill → `putBlob`; per-day index files **replaced by run-summary documents** in the `runs` namespace, written at `run/start` and updated at `run/end`.
- **Run index consolidation**: the `runs` namespace replaces `ExecutionRegistry`'s fragile single-file store. One owner-indexed namespace is *the* per-user index of everything that ran (chats, workflows, agents). Fixes the non-atomic, multi-writer, last-writer-wins file.
- **Workflow state**: `StateManager` keeps its in-memory-primary + checkpoint pattern; `latest.json` writes become `documents.put('workflow-state', executionId, …)`. Resume-on-boot and orphan sweeper read through the same repository. **New:** time-based retention for terminal workflow states (gap today — state accumulates forever).
- **Decoupling fixes** (required for any non-file provider):
  - `InteractionService`: documents namespace instead of `runLog.baseDir` path math; answer claims via `LockManager` instead of `O_EXCL` marker files.
  - `runAccess`: `RunLedgerStore.getRunStart(runId)` instead of reading the run file's first physical line.
  - `ConversationStateManager`: persisted via `integration-conversations` namespace (the surviving kernel of #1464), keeping its in-memory Map as a cache.

---

## 7. Configuration onto the provider (own step)

- Reads: `configLoader.js` `loadFile`/`resolvePath` go through `documents.get/list`.
- Writes: all ~15 admin route files replace direct `atomicWriteJSON` with `documents.put(...)` followed by the existing `configCache.refreshCacheEntry(...)`.
- `configCache` subscribes to the `ChangeNotifier` for invalidation (in-process notifier on filesystem/SQLite; cross-instance on PG — the hook that makes multi-instance config work later).
- Pages keep per-language files on the filesystem provider; the pages namespace models a page as one document with all translations (per old PRD §3.2).
- This step is a **prerequisite for multi-instance** (step 3), not for chat persistence (step 1).

---

## 8. Providers (step 2)

| | Filesystem | SQLite | PostgreSQL | OpenSearch |
|---|---|---|---|---|
| Durable chats/runs/config | ✅ | ✅ | ✅ | ✅ |
| Transactions | ❌ | ✅ | ✅ | ❌ (per-doc versioning) |
| Change notification | in-process | in-process | LISTEN/NOTIFY (push) | poll (change-log index, ~5 s) |
| Distributed locks | ❌ | ❌ | advisory locks | TTL documents (create-if-absent) |
| Full-text search | ❌ | ❌ | JSONB GIN | ✅ native |
| Multi-instance | ❌ | ❌ | ✅ first-class | ⚠️ supported, polling caveats documented |
| Best for | default, dev, single instance | small installs, one-file backup | production HA | search-centric orgs; chat search follow-up |

- **SQLite**: `contents/data/ihub.db`, WAL mode; tables `documents`, `log_entries (stream, seq, data, PRIMARY KEY(stream, seq))`, `change_log`, `locks`. Prefer Node's built-in `node:sqlite` (zero native dependency — matters for `npm run build:binary`) if the runtime floor allows, else `better-sqlite3`; decide at implementation time.
- **PostgreSQL**: `pg`, dedicated schema; `documents (namespace, key, owner_id, data JSONB, etag, version, updated_at, PRIMARY KEY(namespace, key))` with owner index and GIN; `log_entries`; `change_log` + NOTIFY trigger on channel `ihub_changes`; advisory locks. Ships its own **SQL schema-migration runner** — versioned, separate from the JSON config migrations in `server/migrations/`.
- **OpenSearch**: index per namespace (`{prefix}-{ns}`), `seq_no`/`primary_term` optimistic concurrency, change-log index for the polling notifier, `refresh=wait_for` on critical writes.
- **Selection/bootstrap**: `platform.json → storage.provider`, override `IHUB_STORAGE_PROVIDER`. Boot on filesystem, read platform config, switch if configured (provider change requires restart). Connection secrets encrypted at rest via `TokenStorageService`; multi-instance supplies `IHUB_ENCRYPTION_KEY` via env.
- **Docker**: compose services for postgres and opensearch, wired via env.

### Migration tooling

CLI: `ihub-storage migrate --from filesystem --to postgresql` (+ `export`, `import`, `verify` comparing document counts and etags; timestamped `contents/` backup before migrating). The admin migration wizard (§9) drives the same operations.

---

## 9. Admin UI (step 2)

Route `/admin/storage` (added to `knownRoutes` in `runtimeBasePath.js`), following the thin-page + component convention (`AdminIntegrationsJiraPage.jsx` / `JiraConfig.jsx`):

1. **Status overview** — active provider, health/latency, document counts per namespace, recent change events. `GET /api/admin/storage`, `GET /api/admin/storage/events`.
2. **Provider configuration** — form + JSON dual mode; provider selector rendering provider-specific fields; secrets masked with the existing `***REDACTED***` restore pattern; **Test Connection** before save (`POST /api/admin/storage/_test`: throwaway provider, `initialize` → `healthCheck` → `shutdown`); restart-required banner on provider change.
3. **Migration wizard** — analyze (source/target counts) → dry-run → migrate → verify (counts + etags) → activate; surfaces the CLI equivalents for scripted use.

---

## 10. Multi-instance (step 3, must ship)

Replaces the three single-machine assumptions:

1. **Bus transport**: `clusterBus` gains a provider-supplied transport — PostgreSQL LISTEN/NOTIFY for the control plane. Presence maps (`sse`, `request`, `run` ownership) and correlated request/respond span instances. SSE delivery keeps today's model (any instance appends events; the instance holding the socket delivers) → **no sticky sessions**.
2. **Singleton election**: `isSchedulerOwner()`, resume-on-boot + orphan sweep, retention sweeps, migration lock — all move from worker-0/lock-file to `LockManager` leases.
3. **Config invalidation**: admin saves on instance A → ChangeNotifier → B…N refresh (requires §7 landed).

Requirements documented for operators: shared volume for `contents/uploads` + `contents/data/agent-artifacts` (until the blob facet follow-up); `IHUB_ENCRYPTION_KEY` + JWT keys via env. Officially first-class on PostgreSQL; OpenSearch multi-instance is supported with documented polling-latency caveats.

---

## 11. Issue stack

**Epic:** *Pluggable storage & durable chats* — design summary, capability matrix, decision log. Supersedes #1490, #1022, #1464, #475, #1499; closes PR #2053. Cross-links #1495 (job queue, out of scope) and #1497/PR #2047 (adjacent).

| # | Issue | Depends on |
|---|-------|-----------|
| 1 | Storage abstraction + filesystem provider (interfaces, registry, `storage` platform section + config migration, conformance suite) | — |
| 2 | Chat persistence backend (ChatRepository, materialization from run events, **server-side history assembly + `replaceFromMessageId` edit semantics**, no-abort-on-disconnect, `/api/chats`, retention, `runLog` graduation, delete cascade) | 1 |
| 3 | Minimal chat history UI + client protocol switch (list, open/continue, delete, unseen indicator; hydrate from server, send only the new message) | 2 |
| 4 | Runtime store consolidation (`runs` namespace replaces index + ExecutionRegistry; workflow-state repo + retention; interactions/runAccess/ConversationStateManager decoupling) | 1 |
| 5 | Config onto the provider (reads + admin writes + ChangeNotifier invalidation) | 1 |
| 6 | SQLite provider | 1 |
| 7 | PostgreSQL provider (+ SQL migration runner, compose) | 1 |
| 8 | OpenSearch provider (+ polling notifier, compose) | 1 |
| 9 | Migration CLI (export/import/verify/backup) | 6–8 |
| 10 | Admin Storage UI (status, provider config forms, migration wizard) | 9 |
| 11 | Multi-instance enablement (bus over LISTEN/NOTIFY, lock-elected singletons, cross-instance SSE, operator docs) | 5, 7 |

**Follow-up issues (created with the epic, labeled):** LLM auto-titles · folders + full-text chat search · encryption-at-rest for messages · admin view/purge & compliance tooling · blob storage facet.

### Suggested sequencing

Step 1 = issues 1→2→3 (user value ships) with 4 and 5 parallel after 1. Step 2 = 6/7/8 in parallel, then 9→10. Step 3 = 11.

---

## 12. Testing strategy

- **Conformance suite** against every provider (in-memory/tmp-dir fixtures for filesystem/SQLite; containerized PG/OpenSearch in CI, skipped when unavailable).
- **Behavioral tests for the disconnect change**: SSE close mid-run → run completes → chat document contains the answer → `hasUnseenActivity` set; reconnect mid-run → replay resumes.
- **Protocol tests**: persistent chat request carries only the new message and the server-assembled context matches the stored history; `replaceFromMessageId` truncates-and-forks correctly; a stale client cannot overwrite server history; anonymous/ephemeral keep the full-array path.
- **Cascade tests**: chat delete removes messages, ledger runs, spill, artifacts.
- **Migration tests**: filesystem → each provider → verify counts/etags; migrated install boots and serves identical config.
- **Multi-instance integration test** (step 3): two instances + PG — instance A writes config/chat, instance B observes; SSE delivered across instances; single sweep owner.
- Existing suite must stay green with the filesystem provider (byte-identical default behavior).
