# Features — Unreleased

## MCP Apps: Views Built for mcp-ui Now Receive Their Data

Interactive views from MCP servers that were written against the older mcp-ui protocol — they
announce themselves with an `appReady` message instead of the MCP Apps `ui/initialize` handshake —
now receive the tool's input and result in iHub and render with data. Before, such a view loaded
but stayed empty (a blank map, an empty ticket panel or diagram). The Langdock Cookbook app
servers (draw.io, Google Maps, ArcGIS, ServiceNow) are examples of this style.

- Spec-compliant views behave exactly as before; a view never receives its data twice.
- Each use of the fallback is logged with `component: McpApps` and `handshake: legacy`, naming
  the server and tool, so admins can see which servers still rely on it.
- A view that loads external scripts (maps, CDN libraries) still has to declare those origins in
  its resource's `_meta.ui.csp`; the MCP integration guide's _Sandbox_ section now has a
  troubleshooting note for blank views.

## MCP Tools Can Receive Chat Attachments

A tool of an external MCP server that declares a parameter with `format: "file"` now receives a
file the user attached to their message — the PDF, image or text file itself, as
`{ fileName, mimeType, base64, size }` — instead of a description of it. The model refers to the
attachment by its file name or as `attachment:<n>`; iHub resolves the reference before the call.

- Only attachments of the current message can be handed over; a file from an earlier turn has to
  be attached again.
- Admins cap the size of one such file per server with **Max. file size for tools (MB)** on the
  MCP server form (default 20 MB). Existing servers get the default on upgrade.
- The tool preview in the server dialog marks tools with file inputs and names the parameters.
- Documents uploaded in the chat now travel with their bytes (up to the app's document size
  limit) so a PDF can reach such a tool; the model still sees the extracted text only, and
  stored chats keep only the upload's name, type and size.
- Tools reached through the MCP gateway or the A2A endpoint have no attachments to draw from and
  report a clear error instead.

## A2A 0.3: iHub Apps and Workflows as Skills of an A2A Agent

The Agent-to-Agent endpoint now speaks A2A 0.3, so A2A clients (the A2A Inspector, Langdock's
"Connect Remote Agent", Google ADK and others) can connect to iHub: an Agent Card at
`/.well-known/agent-card.json` describes the agent, and the caller's apps and workflows appear as
its skills. Enable it under **Admin → MCP gateway → A2A**; it uses the gateway's OAuth clients,
personal API keys (also as `X-API-Key`) and `mcp:*` scopes.

- `message/send` runs an app or workflow and returns the answer as a task; `message/stream`
  streams it; `tasks/get` and `tasks/cancel` work on every worker.
- Which skill runs: the per-skill endpoint `/a2a/skills/<skillId>`, `metadata.skillId` on the
  message, the conversation's earlier choice, or the new **A2A default skill** setting.
- Follow-up messages with the same `contextId` continue the conversation with the app.
- The earlier draft methods (`agent/info`, `agent/skills`, `tasks/send`) still answer but are
  deprecated.

## App API: Call an iHub App From Outside, OpenAI-Style

A new API under `/api/v1` runs an iHub **app** — with its prompt, variables, sources, tools and
skills — for external programs, in the request and response shape of the OpenAI chat-completions
API, streamed or not. Until now the API surface reached raw models only; an app could be called
from outside just through MCP `tools/call`, without streaming and without its tool loop.

- `POST /api/v1/apps/{appId}/chat/completions`: authenticate with a personal API key or an OAuth
  token; the caller's groups decide which apps it may call, as in the UI.
- `POST /api/v1/attachments`: upload a PDF, text file or image (up to 20 MB) and reference it on
  a user message; inline `image_url` and `file` data URLs work too.
- `chat_id` stores the conversation server-side and continues it later; the chat shows up in the
  caller's history.
- Documented in the new **App API** page of the docs and in the running server's API docs.

