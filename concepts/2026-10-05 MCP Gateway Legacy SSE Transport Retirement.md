# MCP Gateway: Retire the Legacy SSE Transport

**Status:** Proposal, not implemented
**Scope:** iHub as an MCP **server** (the gateway in `server/routes/mcpServer.js`). iHub as an MCP
**client** of third-party servers is out of scope and keeps its SSE support (see
[What stays](#what-stays)).
**Related:** `concepts/2026-07-28 Round-Robin Worker-Local State Audit.md` (finding #1),
`docs/mcp-integration.md`, migration `V081__add_mcp_streamable_http_stateless.js`, and the
companion proposal `concepts/2026-10-05 Chat Streaming on the POST Response.md`.

## Summary

The gateway serves two MCP transports. **Streamable HTTP** (`/mcp`) is the current one. The
**legacy HTTP+SSE** transport (`/mcp/sse` and `/mcp/messages`) is the 2024-11-05 transport that
the MCP specification replaced in revision 2025-03-26. We keep it only for clients that were
never updated.

It should go:

- **The specification replaced it.** Our own code already calls it legacy
  (`mcpServer.js:19`, `McpServerConnection.js:265`, `mcpServerConfigSchema.js:213` carries
  `deprecated: true`).
- **It does not work reliably in the default deployment.** iHub starts 4 round-robin workers
  by default. The legacy transport needs its stream and its message POSTs to reach the same
  process, and nothing ensures that (details below).
- **It has no stateless mode and no resume.** A reconnect replays in-flight requests, which the
  admin toggle already warns about.
- **It is a second code path to secure.** It has its own auth binding, its own session map and
  its own error handling next to Streamable HTTP.

Proposal: deprecate it in the next release (log its use, switch it off for new installs, say so
in the admin UI and the docs), then remove it one release later.

## The two transports

| | Legacy HTTP+SSE (2024-11-05) | Streamable HTTP (2025-03-26 to 2025-11-25, what iHub implements) |
| --- | --- | --- |
| Endpoints | `GET /mcp/sse` stream plus `POST /mcp/messages?sessionId=…` | One endpoint: `POST /mcp`, optional `GET /mcp`, `DELETE /mcp` |
| Where a response arrives | On the long-lived GET stream; the POST only gets `202 Accepted` | On the POST's own response: JSON, or an SSE stream when there are progress events first |
| Connection lifetime | One stream per client for the whole session | Per request; the GET stream for server-initiated messages is optional |
| Session state | The open socket, held in one process | `Mcp-Session-Id` header, or none in stateless mode |
| Load balancing | Stream and POSTs must reach the same process | Stateless mode: any worker or replica can answer |
| Resume after a dropped connection | None; requests are replayed | SSE event ids plus `Last-Event-ID` |

Streamable HTTP still uses `text/event-stream` as its streaming format. What it drops is sending
the answer on a different connection from the request.

The 2026-07-28 revision of Streamable HTTP goes further. A server offers only POST: the
standalone GET stream, `Mcp-Session-Id` sessions and `Last-Event-ID` resume are gone, and GET or
DELETE gets `405 Method Not Allowed`. iHub implements the 2025 revisions. Its stateless mode
already behaves much like the new revision.

## Current state

| Piece | Where |
| --- | --- |
| Stream endpoint | `GET /mcp/sse`, `server/routes/mcpServer.js:436` |
| Message endpoint | `POST /mcp/messages?sessionId=…`, `mcpServer.js:466` |
| Session registry | `sseSessions` Map, worker-local, `mcpServer.js:434` |
| Config | `platform.mcpServer.transports.sse.enabled`, `true` in `server/defaults/config/platform.json:186` |
| Schema | `mcpGatewayConfigSchema.transports.sse` with `deprecated` defaulting to `true` (`server/validators/mcpServerConfigSchema.js:213`) |
| Admin toggle | "SSE (legacy)", `client/src/features/admin/pages/AdminMcpGatewayPage.jsx:437`; strings `admin.mcp.gateway.transportSse*` in `shared/i18n/{en,de}.json` |
| Discovery | `GET /mcp/.well-known` lists `sse` in `transports` and sets `mcp_sse_endpoint` (`mcpServer.js:494`) |
| Error hint | A sessionless `GET /mcp` answers 405 and tells legacy clients to use `/mcp/sse` (`mcpServer.js:358`) |
| Docs | `docs/mcp-integration.md` endpoint list (~line 705) and troubleshooting (~line 1388) |
| Tests | `server/tests/mcp-gateway-sessions.test.js` and the gateway tests under `server/tests/mcp/` |

## Why it fails in the default cluster setup

- `WORKERS` defaults to 4 (`server/config.js:105`). Without `STICKY_SESSIONS=true`, Node's
  round-robin scheduler hands each new TCP connection to the next worker
  (`server/server.js:147-154`).
- A legacy client holds its `GET /mcp/sse` connection open for the stream. Its
  `POST /mcp/messages` therefore goes out on another connection, which usually lands on another
  worker.
- That worker has no entry in its `sseSessions` Map and answers
  `404 No active SSE session`.

`STICKY_SESSIONS=true` makes the transport work, but at a price. Behind a reverse proxy every
request has the same peer address, so all connections go to one worker. That keeps the stream
and its POSTs together, and it also puts all traffic on that one worker
(`server/clusterSticky.js:28-39`). Behind several replicas it still needs load-balancer
affinity.

The round-robin audit found the same thing (finding #1): "Legacy SSE transport has no stateless
mode." That finding came from reading the code. It has not been reproduced against a running
cluster for this document.

Streamable HTTP has a fix for this (`transports.streamableHttp.stateless`). The legacy transport
cannot have one, because its design needs the stream and the POSTs to share a process.

## Who could still depend on it

Clients that only implement the 2024-11-05 transport: MCP clients and SDKs from before the
2025-03-26 revision that were never updated. We don't know how many still connect. Phase 1
measures that.

Two things suggest real use is low:

- In a default 4-worker deployment the transport already fails most of the time.
- The admin toggle already labels it legacy.

It does work on single-process deployments (`WORKERS=1`, the binary build), so we can't assume
nobody uses it.

A client stuck on the old transport can connect through a local bridge that speaks Streamable
HTTP to iHub and stdio to the client (for example `mcp-remote`). The docs should name this
option when the transport is removed.

## Plan

### Phase 1: deprecate (next release)

1. **Measure.** Log one `info` line each time a legacy session opens: `userId`, `User-Agent`,
   and the client name and version from its `initialize` request when available. Use
   `component: 'McpGateway'` and `reason: 'legacy_sse_session'`, so admins can grep their logs
   before the removal release.
2. **Switch it off for new installs.** Set `mcpServer.transports.sse.enabled` to `false` in
   `server/defaults/config/platform.json`. Defaults only seed new installs, so existing installs
   keep their current value. No migration is needed.
3. **Say so in the product.**
   - Admin toggle description: deprecated, to be removed in the next release.
   - `docs/mcp-integration.md`: mark the two endpoints deprecated and point to Streamable HTTP
     and to the bridge option.
   - A release note in `docs/releases/next/`.
4. **Optional:** send a `Deprecation` response header (RFC 9745) on `/mcp/sse`. Most MCP clients
   won't show it, but it is cheap and makes the status visible in HTTP traces.

### Phase 2: remove (the release after)

1. Delete `GET /mcp/sse`, `POST /mcp/messages`, `sseSessions` and the `SSEServerTransport`
   import from `mcpServer.js`.
2. For one more release, answer requests to the two old paths with `410 Gone` and a JSON-RPC
   error naming Streamable HTTP and the bridge. A bare 404 looks like a misconfiguration and
   sends admins searching. A 410 says what happened. This isn't a compatibility shim: nothing
   behaves as before.
3. Discovery: drop `sse` from `transports` and drop `mcp_sse_endpoint`. *(Decision 3.)*
4. Change the 405 hint at `mcpServer.js:358` so it no longer points to `/mcp/sse`.
5. Add a migration that deletes `mcpServer.transports.sse` from `platform.json`, and drop the key
   from `mcpGatewayConfigSchema`. Following the repo rules, the migration is new and forward-only.
6. Remove the admin toggle and the `admin.mcp.gateway.transportSse*` strings (en and de).
7. Update the docs and tests, and add a release note under breaking changes.

## What stays

- **Outbound SSE** (`SSEClientTransport`, `server/services/mcp/McpServerConnection.js:265`).
  This is iHub connecting *to* third-party MCP servers, some of which still only offer SSE. We
  don't control them, and supporting them costs one transport constructor. The admin MCP server
  form can keep labelling it legacy (`mcpServerConfigSchema.js:119` already has a `deprecated`
  flag). A later improvement could try Streamable HTTP first and fall back to SSE, as the spec's
  backward-compatibility section describes. That is separate work.
- **A2A `message/stream`** also streams over SSE, but it is a different protocol and not
  affected.

## Related: stateful Streamable HTTP has the same problem

Removing the legacy transport doesn't make the gateway cluster-safe on its own. The default
stateful Streamable HTTP mode keeps sessions in a worker-local Map (`mcpServer.js:44`). Under
round-robin, an `initialize` on one worker followed by a `tools/call` on another gets
`404 Session not found` (audit finding #1). Stateless mode avoids that.

Making stateless the default for new installs, or making sessions cluster-aware, is the natural
next step. Stateless is also where the specification has gone: the 2026-07-28 revision has no
sessions at all. It is listed here so it isn't lost, but it is not part of this proposal.

## Decisions needed

1. **Timeline.** Deprecate in the next release and remove in the one after, or wait longer?
2. **New-install default.** Switch legacy SSE off for new installs in phase 1? (Recommended:
   yes.)
3. **Discovery field.** On removal, drop `mcp_sse_endpoint` from `/mcp/.well-known`, or keep it
   as `null` for a release? Anything that reads the field would see the change. (Recommended:
   drop it; the field is iHub-specific, not part of the MCP spec.)
4. **410 period.** Answer the removed paths with `410 Gone` for one release, as proposed?
