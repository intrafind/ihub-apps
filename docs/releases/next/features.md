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

