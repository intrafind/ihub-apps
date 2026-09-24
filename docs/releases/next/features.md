# Features — Unreleased

## iHub Support Bot: Answers What Each Release Changed

The bundled **iHub Documentation** knowledge source now also holds the release notes of every
release — the same breaking changes, new features and fixes as **Admin → What's New**. The
**iHub Support Bot** can therefore answer questions such as "What is new in 5.5.18?" or "What do I
have to check before upgrading from 5.4 to 5.5?", in addition to questions about the
documentation.

- The release notes always match the installed version: every build generates them, and the server
  refreshes the source on startup after an upgrade.
- The source's description now mentions the release notes, so the model knows to look them up. An
  upgrade updates the description only if you have not changed it.

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
- To try it, two example apps ship disabled — **draw.io Diagrams** and **Excalidraw Sketches** —
  along with their MCP servers, also disabled. Enable the server under **Admin → MCP servers**,
  then the app under **Admin → Apps**.
