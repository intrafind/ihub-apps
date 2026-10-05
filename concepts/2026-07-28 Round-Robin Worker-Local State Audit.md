# Round-Robin Worker-Local State Audit

**Date:** 2026-07-28
**Trigger:** OAuth login for MCP clients failed with `invalid_grant: Authorization code is invalid or expired`
**Status:** OAuth authorization code flow fixed; most remaining findings fixed on 2026-10-05
(see [Follow-up](#follow-up-2026-10-05)); a few low-impact ones open

## Root cause class

`server/server.js` forks `config.WORKERS` workers (default **4**). Since #2146 the default
connection routing is **round-robin** (`STICKY_SESSIONS` defaults to `false`), so consecutive
requests from the same client are handled by *different* worker processes.

Any mutable state kept in a worker's own process memory is therefore invisible to the requests that
follow. Where request A writes state and a later request B reads it, B fails.

Two properties make this worse than it first looks:

- **It is not "1 in N".** Round-robin hands each new TCP connection to the next worker in sequence.
  Two requests made back-to-back over separate connections land on *adjacent* workers, so a
  two-request handshake fails close to **100%** of the time rather than `(N-1)/N`. This was measured:
  the OAuth token exchange failed 12/12 against a 4-worker cluster before the fix.
- **`npm run dev` pins `WORKERS=1`.** None of this reproduces in development. It appears only in
  production, `start:prod`, Docker, and binary deployments.

`#2148` (config cache) and `#2146` (chat/SSE state) fixed two instances of this class. The findings
below are the remainder.

## Fixed in this change

### OAuth authorization codes — `server/utils/authorizationCodeStore.js`

`POST /api/oauth/authorize/decision` minted the code into a per-process `Map`; the client's
`POST /api/oauth/token` arrived at another worker whose map was empty, and
`server/routes/oauth.js` returned `invalid_grant: Authorization code is invalid or expired`.

Replicating codes to all workers would have destroyed the security property — reading a code
*consumes* it, so N copies means N valid redemptions. Instead the code stays on the minting worker,
ownership is announced over `server/clusterBus.js`, and a worker receiving the token request asks
the owner to consume it. Exactly one process ever holds a code, so single-use stays atomic with no
distributed agreement.

A code is now `<handle>.<secret>` — 128 bits of routing handle, 256 bits of secret. Ownership
announcements are broadcast to every worker and retained for the code's lifetime, so they carry only
the handle, which grants nothing on its own. The secret crosses the IPC boundary once, in the single
directed consume message to the owner, which verifies it in constant time and destroys it. An
earlier revision announced a SHA-256 of the whole code instead; the split is better because the
broadcast value was never secret to begin with, and it avoids hashing a request-derived credential
(which CodeQL's `js/insufficient-password-hash` flags, and GitHub code scanning cannot suppress
inline — the `lgtm[...]` comments elsewhere in this repo are decorative, LGTM.com is retired).

This required a request/reply primitive on the bus (`request()` / `respond()`), built on the
existing pub/sub with correlation ids so the primary remains a dumb repeater.

### Consent screen CSRF + PKCE — `server/routes/oauthAuthorize.js`

The consent CSRF token and the PKCE `code_challenge` lived in an `express-session` backed by a
per-worker `MemoryStore` (`server/middleware/setup.js`). A decision POST reaching another worker
saw no session, giving `403 CSRF token missing` — or, if CSRF happened to pass, a code minted with
an **empty** `codeChallenge` that the token endpoint later rejected.

Replaced with a signed, self-contained consent ticket (`server/utils/consentTicket.js`) carried in
the form. Side benefit: `redirect_uri`, `scope`, `code_challenge` and `nonce` are now
integrity-protected instead of trusted from the POST body.

## Open findings

Ordered by severity. Each was confirmed by reading the declaring code.

| # | Location | State | Breaking flow |
| --- | --- | --- | --- |
| 1 | `routes/mcpServer.js:36`, `:402` | `sessions` / `sseSessions` Map | `initialize` on worker 1 → `tools/call` on worker 2 → `404 Session not found`. MCP clients connect then fail on the first tool call. Mitigation exists: `mcpServer.transports.streamableHttp.stateless = true`. Legacy SSE transport has no stateless mode. |
| 2 | `middleware/setup.js:271` | OIDC session `MemoryStore` | passport writes OAuth `state` + PKCE `code_verifier` here (`middleware/oidcAuth.js:72`). Callback on another worker → `Failed to verify request state`. SSO login broken. |
| 3 | `middleware/setup.js:310` | Integration session `MemoryStore` | Jira / Office 365 / Google Drive / Nextcloud write `{state, codeVerifier, userId}` before redirect and read it in the callback → `invalid_state`, integration never connects. |
| 4 | `shortLinkManager.js:16` | `createDebouncedJsonStore` | `debouncedJsonStore.js:32` caches forever (`if (data) return data`) and `load()` runs at import, so each worker snapshots at boot and never refreshes. A created link 404s on 3 of 4 workers **permanently**. Also last-writer-wins: each worker flushes its stale snapshot, deleting links created elsewhere. |
| 5 | `services/workflow/ExecutionRegistry.js:52` | `executions` Map | Run registered on worker 1 → any per-execution endpoint on worker 2 → `404 Execution`. Blocks stream attach, cancel, checkpoint replies, and `my-executions`. Same clobbering-on-write problem as #4. |
| 6 | `routes/toolsService/jobStore.js:4` | `jobs` Map | OCR upload → progress → download. Progress and download 404 from other workers; `job.result` is RAM-only so it is unrecoverable. |
| 7 | `middleware/rateLimiting.js:79` | `rateLimit()` with no `store` | Per-worker counters, so the effective limit is `WORKERS ×` the configured value — `authApiLimiter` allows ~200 credential attempts per 15 min instead of 50. Security weakening, and nondeterministic 429s for legitimate users. |
| 8 | `services/integrations/ConversationStateManager.js:14` | `states` Map | iAssistant turn 1 stores the upstream conversation id; turn 2 on another worker sees nothing and starts a **new** upstream conversation, losing all context. |
| 9 | `services/workflow/WorkflowEngine.js:143` | `abortControllers` Map | Cancel routed to a non-owning worker cannot fire the run's abort signal; the in-flight LLM node runs to completion and keeps billing. |
| 10 | `services/updateService.js:143` | `updateState` object | Admin update progress polling hits other workers and reports `idle / 0%`; download errors never surface. The update itself is fine (state derived from disk). |
| 11 | `requestThrottler.js:9-12` | `queues` / `actives` / `lastCompleted` | Outbound provider rate limits enforced per worker, so a configured 1 req/s becomes `WORKERS` req/s. Causes upstream 429s despite correct config. |
| 12 | `services/AuditLogService.js:40` | JSONL appender batch queue | An audit query flushes only its own worker's queue, so it can miss recently buffered entries from other workers. Self-healing, low severity. |

Also observed: four workers race for the migration lock at boot, so
`server/migrations/runner.js` logs `Configuration migration failed — Migration lock held by PID …`
on the losers. Harmless (one worker applies migrations) but noisy and misleading in logs.

### Confirmed safe — do not change

- `utils/consentStore.js`, `utils/refreshTokenStore.js`, `utils/oauthClientManager.js` — every read
  and write goes to disk with `atomicWriteJSON`; no in-memory cache.
- `services/workflow/chatBridge.js:36` — mirrored across workers over `clusterBus`.
- `services/workflow/StateManager.js:94` — reads fall back to `latest.json` and repopulate.

### Benign — performance only

`services/searchCache.js`, `services/azureSpeechToken.js`, `middleware/proxyAuth.js` (JWKS),
`middleware/teamsAuth.js` (JWKS), `services/tools/OpenApiToolRunner.js`, `configLoader.js`,
`services/ModelDiscoveryService.js`, `sources/SourceHandler.js` — pure memoization; a miss
re-derives from disk or upstream. `PromptService.js` and the adapter `streamingState` maps are
intra-request only.

## Recommended sequencing

1. **#1 (MCP sessions)** — document/default stateless mode; it blocks the MCP gateway outright.
   Doc corrected in this change; the default is still stateful.
2. **#2, #3 (OAuth/OIDC + integration sessions)** — a shared session store, or apply the same
   signed-state approach used for the consent ticket. Both break user-visible login flows.
3. **#7 (rate limiters)** — a shared store; this is a security control that silently does not hold.
4. **#4, #5, #6** — these need a shared/authoritative store rather than a per-worker cache; #4 and
   #5 additionally lose data on write.
5. **#8–#12** — correctness and cost issues, lower user impact.

A general fix for several of these is a cluster-aware store abstraction (bus-backed now, Redis
later for cross-pod), which `clusterBus.js` was already shaped to allow.

## Follow-up (2026-10-05)

Triggered by Office 365 failing to connect with `invalid state` on a 4-worker k3s deployment. The
integration sign-ins were fixed with a signed OAuth state (`utils/integrationOAuthState.js`); a
re-audit of `server/` then found the same class of bug in the places below. Every fix was checked
on a real 4-worker cluster (fresh connection per request, so round-robin spreads them) and, where
it applied, against the code before the fix.

### Fixed

| Finding | Fix | Before → after on 4 workers |
| --- | --- | --- |
| #2 OIDC session `MemoryStore` | `utils/oidcLoginState.js`: passport state store with an HMAC-signed state (provider, return URL, encrypted PKCE verifier, expiry), bound to the browser by an `oidcLoginNonce` cookie | 0/16 → 16/16 logins |
| #3 Integration session `MemoryStore` | `utils/integrationOAuthState.js` (signed state bound to the signed-in user) | — |
| `/api/oauth` session | `oauthParams` was written to `oauth.session` but read from `oidc.session`, so it never worked; removed — `returnUrl` already carries the authorize URL | — |
| NTLM `ntlmRequested` in `app.session` | `ntlmRequested` cookie | — |
| All of the above | No `express-session` left: `setup.js` mounts none, `express-session` and `memorystore` removed | — |
| #1 MCP gateway `sessions` / `sseSessions` | Presence maps on the bus: a POST for a session another worker holds is served there statelessly, GET answers 405, DELETE is forwarded, legacy SSE messages are relayed to the stream's worker | follow-up calls 12/12 |
| OAuth clients cache window (new) | `loadOAuthClientsFresh` / `findClientByIdFresh`: a miss (or a secret mismatch) re-reads the file once; writes start from the file | create client → token: 0/3 → 4/4 |
| Workflow / agent stream events (new) | `actionTracker.watchRun()` + relay of `fire-sse` events to watching workers | streams seeing the end: 1/4 → 4/4 |
| `StateManager.activeStates` stale forever (new) | for executions not running here, `get` takes a newer checkpoint (`updatedAt`) | status after completion: `paused` on 3/4 → `completed` on 4/4 |
| Shared presence kinds (new, `clusterBus.js`) | the primary tells the first holder when a second joins and the last holder when it is alone again | needed for the relay above |
| #6 `toolsService/jobStore.js` | job ownership on the bus; snapshots, cancel relay, gathered list; result written to `data/tool-jobs/` when clustered | — |
| #4 `shortLinkManager.js` | `utils/sharedJsonFile.js`: locked read-modify-write of the file, reads re-validate by inode/mtime/size | — |
| usage counters (`usageTracker.js`) | per-worker deltas added to `usage.json` under the lock; averages recomputed | — |
| `refreshTokenStore.js` lost updates (new) | changes under a lock file; a redemption deletes only the entry it verified | 3 of 4 concurrency tests fail before |
| #8 `ConversationStateManager` | `loadState` reads the store unless a local change is pending, and keeps the newer entry | — |
| #7 rate limiters (auth, OAuth) | `utils/clusterRateLimitStore.js`: counters in the primary | 120/120 → 30/30 with a limit of 30 |
| #11 `requestThrottler.js` | slots held by the primary when a limit is configured | concurrency 1: 6 at once → 1 |
| #10 `updateService.js` | status gathered from every worker | — |

#5 `ExecutionRegistry` and #9 `WorkflowEngine.abortControllers` had been fixed in between
(storage-backed registry, `cancelAnywhere`).

### Still open

- General API rate limiters (public, admin, inference) still count per worker — documented in
  `docs/rate-limiting.md`; a primary round trip on every request is not worth it.
- Realtime voice caps, the per-chat clarification cap (`ChatService.clarificationCounts`) and the
  personal API key cap (`personalApiKeyManager` owner locks) are per worker.
- `mcpOAuthService.pendingRegistrations` single-flights outbound DCR per worker only, so two workers
  can register twice.
- `ChatRepository._ownerChats` (5 s memo) and `McpClientManager.userConnections` eviction are local:
  a sidebar can lag 5 s, a pooled MCP connection lives until its idle timeout.
- #12 audit log query flush, and the noisy migration lock at boot.
- Everything here spans one process tree. Several pods behind a load balancer still need session
  affinity for chat streaming and the MCP gateway (or `stateless: true`); the sign-in flows above are
  stateless and work across pods.

