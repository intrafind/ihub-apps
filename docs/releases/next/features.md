# Features — Unreleased

## MCP Apps: Interactive Views From MCP Servers in the Chat

When a chat app calls a tool on an external MCP server that ships an interactive view, the view
now renders right in the answer — for example a draw.io diagram (`https://mcp.draw.io/mcp`) or a
hand-drawn Excalidraw sketch (`https://mcp.excalidraw.com/mcp`). iHub implements the MCP Apps
extension (`io.modelcontextprotocol/ui`), so any server built for it works.

- Depending on the app, users can zoom, edit or open a view full screen. A view can call its own
  server's tools, open links in a new tab, post a follow-up message into the chat, and tell the
  model on the next turn about changes the user made.
- Views are saved with the answer and drawn again when a stored chat is reopened. Shared chats
  show where a view was without running it.
- Views run in an isolated sandbox with no access to iHub's session, and may only load from and
  connect to the domains their server declares.
- Admins control it per server with **Render interactive views (MCP Apps)** under
  **Admin → MCP servers** (on by default). The connection test marks tools that render a view.
  Add the server's tools to an app as usual, e.g. `"tools": ["drawio"]`.
