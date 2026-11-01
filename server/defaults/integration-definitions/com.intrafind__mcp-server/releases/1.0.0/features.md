# MCP server 1.0.0

- First version of the generic MCP server definition: every transport (Streamable HTTP, SSE, stdio, WebSocket), sign-in without credentials, with a shared service account, an OAuth client or per-user OAuth, a tool prefix, MCP Apps and reconnect tuning as install fields.
- The server's tools are the actions; tool ids are `<installation>__<tool>` (or the configured prefix), as before.
- Servers whose endpoint matches a shipped MCP definition (GitHub, Linear, draw.io, …) install that definition instead; this one takes every other server.
