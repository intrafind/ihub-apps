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

## MCP Servers: Catalog of Preconfigured Hosted Servers

Admins can now add a hosted MCP server from a built-in catalog instead of looking up its URL and
authentication by hand. **Admin → MCP servers → Browse catalog** lists 39 servers that iHub can
connect to with one shared credential, grouped into categories such as documentation,
development, productivity, design, sales and support, data, and finance.

- Picking a server pre-fills the create form with its endpoint, authentication type and tool
  prefix, and shows where to create the key, region-specific URLs and other setup notes.
- Seven servers need no key at all: Microsoft Learn, Context7, DeepWiki, Astro Docs,
  Hugging Face, and the MCP App servers draw.io and Excalidraw, whose diagrams render in the
  chat. Test the connection and save.
- Servers already configured are marked **Added**.
- A new authentication type, **API key in custom header**, sends the key in the header a vendor
  expects (for example `X-Goog-Api-Key`), with an optional prefix such as `Token token=`.
- HTTP servers accept **Additional headers** for non-secret values a vendor wants next to the
  key, such as a scope or account ID. Credentials are refused there and belong under
  Authentication.
- Servers that only allow each user to sign in with their own account (OAuth) are not in the
  catalog yet, because iHub connects with one shared credential per server.

## Models: Reasoning Settings in the Model Form

The model editor has a new **Reasoning** section, so reasoning models no longer have to be
configured by hand-editing their JSON file. Without it, a reasoning model left its thinking in the
middle of the answer instead of behind the **Show thinking** toggle.

- **Enable reasoning** asks the model to think before answering and to return that thinking
  separately from the answer.
- **Reasoning effort** — minimal, low, medium or high, or the provider's default. It is sent as
  `reasoning_effort` (OpenAI, vLLM) or `thinkingLevel` (Gemini); servers that do not support it
  ignore the value, so leave it on the default unless the model documents these levels.
- **Show reasoning** controls whether users can open the thinking at all.
- The bundled **Local vLLM** model now has reasoning enabled. Self-hosted vLLM servers must be
  started with a matching `--reasoning-parser` (for example `qwen3`), otherwise there is no
  separate thinking for iHub to show.

