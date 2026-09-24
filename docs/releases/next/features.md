# Features — Unreleased

## Chat Header: One Share Button for the Conversation and the App

The chat header now has a single **Share** button in place of the two that sat side by side —
**Share**, which made a short link to the app, and **Share chat**, which made a read-only link to
the conversation. Users could not tell them apart, and the app link looked like it shared the
chat. The dialog now asks what to share and says what each link carries.

- **This conversation** creates the read-only link to the stored chat, as before. It is
  preselected once the chat has a message; before that the tab says to send one first.
- **Link to the app** opens the app for a new chat, optionally with the current model, style and
  input values, and states that the conversation is not part of it. One click creates the link
  with a generated code; a custom code and an expiry are under **More options**.
- Each option appears only where it is available: the conversation needs **Chat Sharing** and a
  durable chat, the app link needs **Short Links**. With just one of them, the dialog shows only
  that one. The canvas view offers the app link.
- Short links copied from the dialog now include the base path on installations served under a
  subpath (for example `/ihub/s/<code>`). Before, the copied link was missing it and did not open.
  
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
