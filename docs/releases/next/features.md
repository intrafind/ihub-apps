# Features — Unreleased

## MCP Apps: Views Built for mcp-ui Now Receive Their Data

Interactive views from MCP servers that were written against the older mcp-ui protocol — they
announce themselves with an `appReady` message instead of the MCP Apps `ui/initialize` handshake —
now receive the tool's input and result in iHub and render with data. Before, such a view loaded
but stayed empty (a blank map, an empty ticket panel or diagram). The Langdock Cookbook app
servers (draw.io, Google Maps, ArcGIS, ServiceNow) are examples of this style.

- Spec-compliant views behave exactly as before; a view never receives its data twice.
- Views whose server bakes the data into the page — the tool result embeds the tool's own declared
  `ui://` resource with the data in its HTML, as the ServiceNow ticket panel does — now render that
  embedded copy instead of the empty static page. It gets the same sandbox and content security
  policy; an embedded page under a different URI, or too large to render, is not used.
- Tools that declare no view at all but return a `ui://` page in their result, as mcp-ui servers
  do, now show that page as an interactive view. It may load only from the origins its own
  `_meta.ui.csp` declares and never gets camera, microphone, location or clipboard access.
  Turning MCP Apps off for a server (`apps.enabled: false`) turns these views off too.
- Each use of the fallback is logged with `component: McpApps` and `handshake: legacy`, naming
  the server and tool, so admins can see which servers still rely on it.
- A view that loads external scripts (maps, CDN libraries) still has to declare those origins in
  its resource's `_meta.ui.csp`; the MCP integration guide's _Sandbox_ section now has a
  troubleshooting note for blank views.

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

## A2A: Connect Remote Agents as Tools

Admins can now connect remote agents that speak the Agent-to-Agent protocol (A2A 0.3) — a
Langdock agent, an agent built with Google ADK, another iHub — under **Admin → Integrations → A2A
agents**. Each skill on the agent's Agent Card becomes a tool; apps enable the agent as a whole in
the app editor's new **Remote A2A agents** list, and users see it as one entry in the chat's tool
menu.

- Add an agent by its Agent Card URL; authenticate with an API key (the header the card names, e.g.
  `X-API-Key`), a bearer token or OAuth client credentials from the credential store.
- **Test connection** shows the card and its skills; choose which skills apps may use.
- Answers stream when the agent supports it and show its progress in the chat; long-running tasks
  are polled and cancelled after the agent's timeout (default 60 s).
- Follow-up calls from the same chat continue the conversation with the agent, also after a
  restart and on another worker: the conversation is kept in iHub's storage for 30 days.
- An app or group can reference an agent as `a2a__<agentId>`. This always means the agent, even
  when a tool or MCP server has the same id; the app editor uses it in that case.
- Every user of an agent shares its configured credential; per-user sign-in is not available yet.

## MCP Servers With Per-User Sign-In

iHub can now connect to MCP servers that require every user to sign in with their own account
(for example servers built on Okta, Microsoft Entra ID or Keycloak). Set the server's
authentication to **OAuth — each user signs in** under **Admin → MCP servers**; iHub finds the
server's authorization server, registers itself automatically and keeps separate, encrypted
tokens for every user.

- When a user asks for one of the server's tools before connecting it, the chat shows a
  **Connect** card; after signing in, the user sends the request again.
- **Settings → Integrations** lists these servers with **Connect** and **Disconnect**.
- Admins see how many users connected each server; **Test connection** uses the admin's own
  account and loads the server's tools for everybody.
- Behind a reverse proxy, or when iHub is reached under more than one address, set the MCP
  gateway's **Public URL**. Every server has its own sign-in callback,
  `<Public URL>/api/mcp/oauth/callback/<server id>`; register exactly that URL for a client you
  registered by hand.

## Outlook Add-in: Choose Which Apps the Add-in Offers

Admins can now see and change which apps the Outlook add-in offers right on **Admin → Office
Integration**. The new **Available Apps** card shows at a glance whether the add-in offers all apps
or is limited to a selection, and lets you switch between the two and pick the apps without leaving
the page.

- Limits set earlier on the add-in's OAuth client (**Allowed Apps**) show up on the card unchanged —
  it is the same setting, now reachable from the page where you configure the add-in. A link leads
  on to the OAuth client for **Allowed Models** and **Allowed Prompts**.
- Choosing **Only selected apps** with nothing selected cannot be saved: an empty list would mean
  no restriction at all.
- The **Start Page** card warns when its default chat app or a default app is not on the list,
  because the task pane skips apps the add-in does not offer.
- Changes apply to signed-in users right away; no new sign-in or manifest redeploy is needed.

## Opening an App Starts a New Chat

With chat history enabled, clicking an app now always opens a new, empty chat instead of the last
conversation held for that app. The previous chat stays in the chat history and opens from there.

- Once the first message is sent, the address changes to the chat's own link, so reloading the
  page keeps the conversation.
- Without chat history (for example anonymous users), opening an app still restores the
  conversation from the current browser tab, as before.

## Document Actions for Answers From the iFinder Search Tools

Answers researched with the iFinder tools (the **iFinder Search** app, or any app using
`iFinder_search`) now list the documents they found in the **Documents** panel under the answer,
the same way iAssistant answers do. Each document has the full menu: **Preview**, **Download**,
**Details**, **Open in App**, **Open in browser** and, in the Outlook task pane, **Add to email**.

- Documents are fetched with the signed-in user's own iFinder permissions, from the search profile
  the tool searched.
- The documents the answer links to are marked **Referenced** and listed first. Other search hits
  fold away behind **Show N more documents**, so a turn that ran several searches does not bury
  the few documents it used.
- Documents read or looked up with `iFinder_getContent` and `iFinder_getMetadata` are listed too.
- With chat history on, the documents are stored with the answer and come back when the chat is
  reopened. Shared links leave them out, since they were found with the owner's iFinder
  permissions.
