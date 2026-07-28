# Round-Robin Worker-Local State Audit

**Date:** 2026-07-28
**Trigger:** OAuth login for MCP clients failed with `invalid_grant: Authorization code is invalid or expired`
**Status:** OAuth authorization code flow fixed; remaining findings open

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
distributed agreement. Only the SHA-256 of the code is announced, so the raw credential never
leaves the worker that minted it.

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
