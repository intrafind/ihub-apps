# Outbound A2A Client — Implementation Notes (#2546)

Hand-over notes for the outbound A2A client: iHub calls remote A2A 0.3 agents and offers each of
their skills as a tool. User-facing documentation is `docs/a2a-agents.md`; this file explains how
the code fits together and where to continue.

## Where things live

| Concern | File |
|---------|------|
| Config file (shipped empty, copied on boot, no migration) | `server/defaults/config/a2aAgents.json` |
| Zod schema (agent + file) | `server/validators/a2aAgentConfigSchema.js` |
| Pure helpers: slugging, tool defs, parts → text, SSE parser, stream collector, card checks | `server/services/a2a/a2aTools.js` |
| One remote agent: card fetch/cache, auth, JSON-RPC, streaming, polling, timeout | `server/services/a2a/A2aAgentConnection.js` |
| Singleton over all agents: diff reload, tool list, dispatch, `contextId` memory, admin probes | `server/services/a2a/A2aClientManager.js` |
| Cache registration + `getA2aAgents()` | `server/configCache.js` (`criticalConfigs`, `CONFIG_LOADERS`) |
| Reload on other workers | `server/configReloadHooks.js` (watcher `a2aClientManager`) |
| Boot | `server/server.js` (after the MCP client block) |
| Tool merge + dispatch | `server/toolLoader.js` (`discoverA2aTools`, `if (tool._a2a)` in `runTool`) |
| Selection by agent id, no `a2a` base id | `server/utils/toolSelection.js`, `server/services/mcp/permissions.js` |
| Gateways never re-export remote agents | `a2aHandler.isRawToolExposable`, `McpServerService.isToolAllowed` |
| Admin API | `server/routes/admin/a2aAgents.js` (registered in `adminRoutes.js`) |
| Admin page | `client/src/features/admin/pages/AdminA2aAgentsPage.jsx`, route `admin/a2a/agents` |
| App editor list | `client/src/features/admin/components/A2aAgentsSelector.jsx` in `McpToolsConfigSection.jsx` |
| Chat tool menu grouping | `client/src/features/chat/utils/groupToolsByMcpServer.js` (`_a2a` → group `a2a-<id>`) |
| i18n | `shared/i18n/{en,de}.json`: `admin.a2a.*`, `admin.nav.a2aAgents`, `admin.apps.edit.a2aAgents.*` |
| Tests | `server/tests/a2a/` (`npm run test:a2a`), `tests/unit/client/group-tools-by-mcp-server.test.jsx` |

## Request flow

1. The model calls `a2a__<agent>__<slug>` → `toolLoader.runTool` sees `tool._a2a` →
   `a2aClientManager.callTool(toolId, params)`.
2. The manager finds the connection by the id prefix (only that agent's card is consulted), reads
   `message` / `data` from the params (everything else — `user`, `chatId`, `appConfig` — stays in
   iHub) and looks up the remembered `contextId` for `(user.id, chatId, agentId)`.
3. `A2aAgentConnection.sendMessage` builds the A2A `Message` (`metadata.skillId` = the card's skill
   id) and either streams (`message/stream`, when the card says `capabilities.streaming` and the
   agent is not set to `streaming: "never"`) or calls `message/send` and polls `tasks/get`. One
   `AbortController` bounds the whole exchange by `timeoutMs`; on abort it sends `tasks/cancel`
   without waiting and throws `A2A_TIMEOUT`.
4. Status updates call `onProgress`, which the manager turns into `emitToolProgress(chatId, {
   phase: 'a2a.status', … })` — a `tool/progress` SSE frame the chat already records.
5. The answer's `contextId` is stored (`a2a-client-contexts` on the storage provider) for the next
   call from the same chat.

Every HTTP request goes through `server/services/mcp/safeFetch.js` with the file's `security`
block. Auth headers are computed per request (`_authHeaders`), so a credential change in the store
applies without a restart; an OAuth token is cached on the connection until 5 s before expiry.

## Decisions worth knowing

- **Agent ids are capped at 48 characters** (not 64 like MCP servers), so `a2a__<id>__` leaves at
  least 9 characters for the slug within the 64-character function-name limit.
- **`_a2a` marker instead of reusing `_mcp`.** Reusing `_mcp` would have needed no selection
  changes, but the MCP code paths (views, `mcpClientManager.findTool`, `toMcpArguments`) would then
  treat A2A tools as MCP tools. Selection helpers check `_a2a.agentId` explicitly and never match
  A2A ids by base id.
- **Diff reload** replaces a connection when `cardUrl`, `auth` or the file's `security` change;
  other edits (allowlist, timeouts, name) keep the cached card and just rebuild the tools.
- **A failed card fetch is remembered for 30 s** so an unreachable agent does not add a network
  round trip to every chat turn's tool listing.
- **`input-required`** is returned as a normal result (the agent's question) rather than an error,
  so the model can relay it. `auth-required` fails at once with `A2A_AUTH_REQUIRED`.
- **Conversation memory is on the storage provider** (`a2a-client-contexts`, one document per
  `(user, chat, agent)`, owned by the user, 30-day retention; `a2aClientContextStore.js`), so a
  follow-up call continues the conversation on any worker and after a restart. Without a provider
  it falls back to a per-process LRU of 5000 entries.

## How to continue

- **Per-user OAuth (#2545):** add an `oauthUser` member to `authSchema` in
  `a2aAgentConfigSchema.js`, resolve a per-user token in `A2aAgentConnection._authHeaders`
  (`params.user` would need to reach `sendMessage`), and cache cards per user if the agent's
  authenticated card differs by user.
- **File parts:** `params._attachments` (see `McpClientManager.callTool` / `mcpFileInputs.js`)
  could be sent as A2A `file` parts; add an opt-in per agent and a size cap.
- **Group permission picker:** `GET /api/admin/groups/resources` lists only configured tools; it
  does not offer agent ids yet (the same is true for MCP servers).

## Testing

- `npm run test:a2a` — schema, helpers, connection (scripted `safeFetch`), manager, admin routes,
  and an end-to-end test that points the client at iHub's own inbound `/a2a` routes over real HTTP.
- The end-to-end test is the one to extend when either side of the protocol changes: it fails if
  the client and iHub's server disagree on the wire.
