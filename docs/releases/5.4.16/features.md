# Features — 5.4.16

## MCP clients can connect reliably after sign-in

Fixed the MCP gateway rejecting every request that followed a successful OAuth login, which left
clients such as the Claude Code CLI stuck at "could not connect" even though the browser consent
step had completed.

- Requests the gateway cannot match to a live session now get the status the MCP spec prescribes,
  so clients recover on their own: an unknown or expired `Mcp-Session-Id` returns
  `404 Session not found` (the client simply opens a new session), and `GET /mcp` outside a session
  returns `405`. Previously all of these returned `400 Bad Request: Server not initialized`, which
  MCP clients treat as a fatal protocol error.
- The session is registered the moment the handshake is accepted, closing a window in which a
  client already held its session id but the gateway did not yet recognise it.
- New **Stateless mode** toggle under **Admin → MCP gateway → Transports** for installations that
  run several load-balanced replicas. Each request is then served independently, so no session
  affinity is required. Trade-off: no server-initiated SSE stream (the gateway does not use one).
- Every request the gateway turns away is now logged under the `McpGateway` component with the
  reason, and abandoned sessions are released after an hour instead of being held for the lifetime
  of the process.
- Only the user who opened a session can terminate it via `DELETE /mcp`.
- Authorization-code tokens no longer log a misleading `JWT verification failed — jwt audience
  invalid` warning on every MCP request; those tokens are audience-scoped to their OAuth client by
  design and were always being accepted.
