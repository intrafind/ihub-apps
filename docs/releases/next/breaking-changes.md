# Breaking Changes — Unreleased

## A2A: Draft Methods Removed

The A2A endpoint (`/a2a`) no longer answers the draft methods of its first version,
`agent/info`, `agent/skills` and `tasks/send`. They return JSON-RPC error `-32601` (method not
found). A2A clients use the A2A 0.3 methods instead: the Agent Card at
`/.well-known/agent-card.json`, `message/send`, `message/stream`, `tasks/get` and `tasks/cancel`.

- A2A skills are apps and workflows. Single iHub tools, which `tasks/send` could also run, are
  available through the MCP gateway (`/mcp`).

**Before upgrading:** check whether any integration calls `/a2a` with `agent/info`,
`agent/skills` or `tasks/send`, and move it to `message/send`.

## Direct Tool Calls Need a Tool Permission

A direct tool call (`POST /api/tools/<toolId>`) now runs only a tool the caller may use: one their
groups grant under `tools` in `groups.json`, or one an app they can open lists. Other tools answer
`403` with `Tool not available`. Before, any signed-in user could run any tool this way, including
tools no group or app gave them.

- Grants read like an app's `tools`: an exact tool id, a tool family (`iFinder`), an MCP server
  id, an A2A agent id, or `*` for all tools. Admins can run every tool.
- Chats are not affected: which tools the model may call in an app is still set by the app.

**Before upgrading:** if a script or integration calls `/api/tools/<toolId>` directly, grant that
tool to the group of the account it signs in with (`groups.json` → `permissions.tools`).

