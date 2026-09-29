# Features — Unreleased

## Proxy Auth: Look Up User Groups From LDAP

When a reverse proxy identifies the user but cannot forward group memberships,
proxy authentication can now query an LDAP or Active Directory server for the
user's groups and merge them with any groups already supplied via header or JWT.

- New **LDAP Group Lookup Provider** setting on **Admin → Authentication** for
  proxy auth, mirroring the existing NTLM option. Pick any configured entry from
  `ldapAuth.providers` — `ldapAuth.enabled` does not need to be on.
- Results are cached per user (default 10 minutes, configurable) so the directory
  server is not queried on every request. Set the TTL to 0 to disable caching.
- LDAP groups are combined with groups from `X-Forwarded-Groups` and JWT `groups`
  claims before the usual external → internal mapping in `groups.json`.
- If the lookup fails, the request still succeeds using the header/JWT groups.

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

## Inference API: Call iHub Apps With Structured Output, Responses and Conversations

The OpenAI-compatible inference API (`/api/inference/v1`) can now run iHub apps, not just models,
so a custom frontend built on the standard `openai` SDKs gets an app's answer — typed JSON
included — while its prompt, variables, sources, tools, output schema and model stay configured in
iHub.

- **Apps as models:** `model: "app:<appId>"` runs an app on its configured model;
  `app:<appId>/<modelId>` picks one of the models the app allows. `GET /models` lists the apps a
  caller may use. App and model permissions apply as in the chat UI, and the response names the
  model that ran.
- **App variables** go in `prompt.variables` and are checked against the app's variable
  definitions; every problem is reported at once. The app's prompt template wraps the first turn
  of a conversation, and follow-ups only when they send variables again.
- **Structured output is validated on the server.** An app's output schema, or a
  `response_format` / `text.format` sent to a plain model, is enforced by the provider and checked
  before the answer is returned; an answer that does not match gets one corrected attempt and is
  otherwise refused (`422`). `/chat/completions` used to ignore `response_format`; it is now
  applied, and a model that cannot do structured output answers `400`. Callers can switch the
  check off with `validate=false`.
- **Responses API:** `POST /responses` supports a subset of OpenAI's Responses API, streaming
  included; the tools an app runs appear as their own output items.
- **Conversations API:** `/conversations` stores multi-turn conversations. A conversation is an
  iHub chat: it appears in the caller's chat history (for an OAuth client, under that client) and
  records that it was created through the API. It keeps its app variables where the chat UI keeps
  a start form's, so a chat continues with the same values in either. It needs chat persistence
  to be on.
- Validation outcomes are counted in the new `ihub.structured_output.validation` metric.

See [OpenAI-Compatible API](../../openai-compatible-api.md) and
[Structured Output → External API usage](../../structured-output.md#external-api-usage).

## Apps Can Start Chats With a Form

Apps with variables can now open a new chat with a form instead of the chat input. Users fill in
the variables, optionally drop files onto the form, and send it: the app's prompt template is
filled in once and sent as the first message. The form then disappears, and the conversation
continues like any other chat — follow-up messages are sent as typed, without the template being
added again.

- Switch it on under **Admin → Apps → (app) → Variables → Start chats with a form**, and
  optionally give the send button its own label per language (default: **Start**).
- The form shows a drop zone for files when the app allows uploads.
- Required variables must be filled in before the form can be sent.
- Works in the Outlook add-in and the browser extension too, with the email or page going along
  with the form's message. In compare mode, one form is sent to both models.
- A new chat, or clearing the chat, shows the form again.
- The variables are kept with the chat, so follow-up messages no longer send them and a chat
  reopened from the chat history continues with them.
- Also for apps that show their variables beside the chat: reopening a chat now puts its values
  back in the variables panel instead of the app's defaults.

## Outlook Add-in: Chat History

With chat history enabled (**Admin → Platform → Features → Durable Chats**), the Outlook add-in
now lists your recent chats, so a discussion from earlier can inform the email you are answering
or writing. Pick a chat and it opens in the task pane with its full conversation; the next message
goes out with the email that is open now.

- **Chat history** in the pane's menu lists your chats by date, with search and **Show older
  chats**. The start page shows the three most recent under **Recent chats**.
- The list holds chats started in the browser and in Outlook alike: chats in the add-in are now
  saved like chats in the web app, and show up in the web app's history too.
- Only chats whose app the add-in offers are listed, since a chat continues in its own app.
- The browser extension's side panel gets the same history.
- Without chat history enabled, the add-in keeps its chats in the pane as before.

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
