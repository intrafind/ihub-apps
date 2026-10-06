# Features — 5.5.36

## Outlook Add-in: Chat in a Larger Window

The chat in the Outlook task pane can move into a window of its own that users can move and
resize. In Outlook on the web and the new Outlook for Windows the task pane has a fixed width that
add-ins cannot change; **Open in a larger window** (⤢) in the chat's header now opens the same
chat at 70 % × 85 % of the screen.

- The window works like the pane: the open email goes along with every message, and reply,
  forward, insert into the draft and attaching documents act on the email in Outlook.
- The pane stays open behind the window, which reaches Outlook through it — users should pin the
  pane so it stays open when they select another email.
- **Back to the Outlook pane** (⤡), or closing the window, brings the chat back with everything
  that happened in the window. Shown in Outlook clients with DialogApi 1.2 (not in
  volume-licensed Outlook 2016/2019).

## Outlook Add-in: Open in Web App for Every Chat

**Open in web app** now also works for chats that are not stored on the server — with durable
chats switched off, or in an app marked `ephemeral`. The pane hands the chat to the browser, which
continues it as a new chat, together with the email the conversation was about.

- The hand-off lives in the server's memory for at most ten minutes, can be opened once, and only
  by the user who started it; nothing is written to disk.
- Opened by another account, the web app says so and leaves the chat for its owner.

## Microsoft 365 Copilot Agent

iHub can now be an agent in Microsoft 365 Copilot. Users pick it in Copilot Chat or in Copilot's
pane in Outlook, Teams and Word, and Copilot runs iHub's apps for them, signed in with their own
iHub account and limited to the apps their groups allow.

- Set it up under **Admin → Integrations → Microsoft 365 Copilot**: enabling creates the OAuth
  client Copilot signs in with and turns on the OAuth server and the MCP gateway; the page lists
  the values to register in the Teams Developer Portal and builds the agent package to upload in
  the Microsoft 365 admin center.
- Copilot discovers iHub's apps at runtime, so apps added or changed later need no new package.
- Off by default; see `docs/microsoft-365-copilot-agent.md`.

## Rate Limits in the Admin UI, and OAuth Limits Sized for Real Traffic

Admins can now change every rate limit under **Admin → Security → Rate limits**: how many requests
one address may send, per how many minutes, and whether all, only failed or only successful
requests count. Changes apply after a server restart, and the page says when one is due.

- The OAuth server (`/api/oauth`) now allows 300 requests per minute per address instead of 50
  per 15 minutes. Browsers behind one corporate NAT address and server-side clients such as
  Microsoft 365 Copilot, which refreshes all its users' tokens from a few Microsoft addresses, are
  no longer throttled. Installations that kept the old default are moved to the new one; values
  an admin set stay.
- The token and introspection endpoints have their own limit, `rateLimit.oauthTokenApi`, of 30
  failed requests per 15 minutes. Wrong client secrets are stopped quickly, and clients that
  authenticate correctly are never counted. It replaces a fixed limit of 20 requests per 15
  minutes on the token endpoint that could not be changed.
