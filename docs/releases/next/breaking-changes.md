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

