# Microsoft Teams Bot: chat with iHub from inside Teams

Status: proposal (2026-11-16). Companion of `2026-11-16 Microsoft Teams Connector.md` (iHub acts in
Teams as the user). This concept covers the other direction: a Teams user talks to iHub from a Teams
chat or channel. Revisits #209 ("Teams Integration: app, bot and message extension"), whose app part
shipped in #293 (the tab with SSO, `teams/`) and whose bot part was never built; the 2025 ADR in
`Microsoft Teams Integration/` chose the Bot Framework SDK, which this concept re-opens.

## Problem

A Teams user can reach iHub in three ways today:

1. **The tab** (`teams/`): iHub's web app inside Teams, with SSO through `middleware/teamsAuth.js`.
   It is a place to go, not part of the conversation.
2. **The Microsoft 365 Copilot agent** (`docs/microsoft-365-copilot-agent.md`): Copilot calls iHub's MCP
   gateway as a declarative agent. It needs a Microsoft 365 Copilot licence per user and Copilot
   decides when to call iHub.
3. **The MCP gateway directly** for MCP clients.

Missing: iHub as a participant in the conversation. A user writes to "iHub" in a 1:1 chat, or an
`@iHub` in a channel or group chat, and gets the answer in place. Nothing can also message a user
first (a finished scheduled task, an approval waiting).

## Is it worth building next to the Copilot agent?

The bot covers what the agent cannot:

| | Copilot agent | Bot |
| --- | --- | --- |
| Needs a Microsoft 365 Copilot licence | yes | no |
| 1:1 chat with iHub as a contact | no (inside Copilot) | yes |
| `@iHub` in a channel or group chat | no | yes |
| iHub writes first (task results, approval requests) | no | yes (proactive messages) |
| Approval cards for gated tools | no | yes |
| Who chooses the app | Copilot | the user or the admin default |

Decision to confirm with product: build it only if customers without Copilot licences ask for chat in
Teams, or if "deliver to Teams" (connector concept) needs a bot identity for unattended posts. The
proactive-message part alone justifies a small first step.

## Goals and non-goals

Goals:

- 1:1 chat and `@iHub` in channels and group chats, answered by an iHub app the admin or user chose.
- The user is the same iHub user as in the tab (same Entra `oid`), so groups, apps, sources and
  quotas apply unchanged.
- Approval cards for gated tool calls, answered only by the user who asked.
- Proactive messages as the delivery path for scheduled tasks and approval requests.

Non-goals (v1):

- Message extensions and the "compose box" actions.
- Reading channel history the bot was not mentioned in (needs resource-specific consent).
- Voice and meeting participation.

## Design

### Pieces

```
Teams client --> Azure Bot Service --> POST https://<ihub>/<messaging endpoint>
                                         |  verify the Bot Framework JWT
                                         |  map aadObjectId to the iHub user
                                         |  run a chat turn (ChatService)
                                         v
              reply via the activity's serviceUrl (token from login.microsoftonline.com)
```

- **Azure Bot registration** (single-tenant) in the customer's tenant. The admin enters app id, tenant
  and client secret in iHub; the secret goes to the credential store, never into `platform.json`.
- **Messaging endpoint**, a new server route that receives activities. Its path and shape are fixed by
  the protocol, like `/v1/*` and the OAuth endpoints: an exception to the REST guidelines to record
  with the `api-design` skill when the route is added.
- **Activity verification**: signature and issuer of the Bot Framework token, audience equals the bot's
  app id, tenant allowlist, `serviceUrl` taken from the token's claim and checked against the Microsoft
  hosts. Without this, anyone could post a fake activity as any user.
- **Package**: `teams/manifest.json` gets a `bots` entry (scopes `personal`, `team`, `groupChat`) and a
  command list; `teams/build-teams-package.sh` already builds the zip.

### SDK choice (decide in the first issue)

The 2025 ADR picked the Bot Framework SDK. Microsoft has since moved to the Microsoft 365 Agents SDK,
and community Teams bridges for Claude Code use it. Options:

1. Microsoft 365 Agents SDK (`@microsoft/agents-hosting`): maintained, brings JWT validation and the
   outbound connector client; adds a dependency and its own HTTP agent.
2. No SDK: verify the JWT with `jsonwebtoken` and `jwks-rsa` (already used in `teamsAuth.js`) and call
   the connector REST API with `httpFetch()`. Smallest dependency surface, we own the protocol details.

Whatever is chosen, every outbound call (`serviceUrl`, `login.microsoftonline.com`) must honor
`ssl.ignoreInvalidCertificates` and `ssl.domainWhitelist`: use `httpFetch()`, or spread
`getTlsBypassOptions(url)` into the SDK's agent. A test covers a whitelisted and a non-whitelisted host.

### Identity

- The activity carries `from.aadObjectId` and the tenant id. Map them to an iHub external user the way
  `teamsAuth.js` does for the tab (`validateAndPersistExternalUser`, auth mode `teams`, subject = `oid`),
  so the tab and the bot are one user. Align with #2662 (link external sign-ins by provider and subject).
- **Groups.** The tab gets the user's groups from the Teams SSO token; an activity carries none, so the
  same user could have different permissions in the bot. The bot must obtain authoritative group
  memberships before every turn, from a source decided in the first issue. Candidate: a Graph lookup of
  the user's groups with the app registration's own credentials (needs a group-read permission with
  admin consent), cached for a short time and refreshed on every turn after it expires, then mapped
  with the same group mapping as the tab. Alternative: a one-time sign-in card (OAuth) that yields a
  token with the groups claim. Until a source works the bot refuses, it does not fall back to the
  default groups.
- Unknown user: apply the platform's user-creation rule (auto-create or refuse), same as the tab.
  A disabled account is refused (cf. #1692, #1736).
- **AI-use acknowledgement.** The tab asks each user to confirm the notice before the first message.
  The bot must do the same: first message gets a card with the policy link and a confirm button; the
  confirmation is stored exactly as the web app stores it (`docs/ai-act.md`).

### Running a turn

The bot is another chat client of the existing pipeline (`server/services/chat/ChatService.js`,
`runTurn`), not a second implementation. The first issue decides the entry point; candidates are
`runTurn` directly and `appInvoker.invokeAppInternal` (used by the MCP gateway).

- **Which app answers.** The admin sets a default app for the bot. A user can switch with a command or
  card (`/app`, `/new`, `/help`). Only apps the user's groups allow are offered.
- **Conversation mapping.** The key is Teams conversation id, thread id in channels, **and the user**,
  so every person gets their own iHub chat, even in a shared thread. A chat is readable and continuable
  by its owner only (unless the owner shares it with the existing chat-share feature). A mention from
  another participant starts that person's own chat and never shows the starter's history. `/new` starts
  a fresh chat. History lives in iHub, so the user can open the same chat in the web app.
- **Reply.** Typing indicator while the run goes, then one message (Teams limits message size, so long
  answers are split or sent as a card with a "Open in iHub" link). Streaming and editing the message are
  later improvements.
- **Rendering.** Markdown converted to what Teams renders; sources and citations as an Adaptive Card.
- **Files.** 1:1 attachments (file consent flow) in a later phase, through the existing chat file path.

### Group chats and channels: who sees the answer

This is the main security decision. In a 1:1 chat the answer goes to the asker. In a channel it goes to
everyone, but iHub built it with the asker's permissions (their personal sources, projects, connected
integrations).

Checking the asker's permissions is not enough here: every member sees the reply, including its
citation card, and a shared app can still use sources restricted to a group the other members lack.
The boundary is therefore the **audience**, not the asker.

Default for channels and group chats: **the bot answers only with an app the admin marked as
channel-safe, and only from sources that the `authenticated` group may read**, with personal sources,
projects and per-user integrations switched off. It says so in the first reply. **If the bot cannot
establish that boundary for a request, it refuses** and offers a 1:1 chat. Guests and external members
of a channel are outside `authenticated`, so a channel with them gets no answers unless the admin
allows it.

The boundary covers **history** too, because earlier turns are context for the next answer. A chat
created in a channel or group chat is *audience-bound*: it holds only turns that were visible to that
audience, the owner can open it in the web app read-only or fork it, and no personal source, project or
per-user integration is ever added to it. A 1:1 chat is never used as context for a channel reply. If the
bot cannot tell that a chat is audience-bound, it starts a new one or refuses. A later option is to intersect the groups of all members (roster lookup), which needs a
members permission and is out of scope for v1. Mentions are the only trigger; the bot ignores other
messages.

### Approvals

A gated tool call (`docs/tool-approval.md`) needs a human. The bot draws an Adaptive Card with the
action, target and payload and Approve and Reject buttons. Rules:

- Only the user who started the run can answer; a click by someone else is refused and recorded.
- The answer goes through the same interaction service as the web client
  (`POST /api/runs/:runId/interactions/:id/answer` is the public surface), so audit and expiry are
  unchanged.
- Until this exists the bot is not `toolApprovalCapable`, and gated calls end with
  `APPROVAL_REQUIRED_NO_USER`. v1 can ship with this limitation if the admin sees it in the status card.

### Proactive messages

When a user installs the bot or writes to it in a **personal (1:1) chat**, store the conversation
reference (service URL, conversation id, user id) per user. References from channels and group chats are
never stored for notifications, and a notification is sent only through a personal conversation whose
scope was verified from the activity (otherwise it would show to every member of a channel). Then iHub can message first: a scheduled task finished, an approval
waits, a workflow asks a question.

- Only users who started a conversation with the bot are reachable; no bulk messaging.
- Admin switch and a per-user opt-out; messages carry no more content than a notification and a link by
  default.
- The connector concept's delivery target uses this path for unattended runs (bot identity), and admin
  event webhooks (#3200) can reuse the same card renderer.

### Admin experience

- A card in **Admin → Integrations → Inbound**, next to the Outlook add-in and the Copilot agent, with
  status checks: registration values present, endpoint reachable, token fetch works, last activity.
- A test button that sends a message to the admin's own bot conversation.
- Config in `platform.json` (`teamsBot`: enabled, appId, tenantId, secret reference, default app,
  channel policy). It needs a restart like other platform changes, and a config migration if existing
  `teamsAuth` values are re-used. The secret is encrypted at rest like other platform secrets.

### What has to be reachable

The same constraint as the Copilot agent, and the main adoption risk: Azure Bot Service calls iHub from
Microsoft's cloud, so the messaging endpoint needs a public HTTPS address with a publicly trusted
certificate. A customer who runs iHub on-premises must publish this one path through their proxy or WAF
(as `docs/microsoft-365-copilot-agent.md` describes for `/mcp`). iHub must also reach `serviceUrl`
hosts and `login.microsoftonline.com` outbound. The admin documentation lists both directions.

## Security

- Verify every activity; reject unknown tenants; rate-limit the endpoint (`middleware/rateLimiting.js`).
- Replay: reject activities with a timestamp outside a small window, and deduplicate by activity id
  inside it. The id is recorded before the turn starts, with an atomic check-and-set, so two concurrent
  deliveries of the same activity cannot both start a turn or a tool action (Teams retries deliveries).
  On several pods the record lives in the shared store, not in process memory.
- Message content is untrusted input, as everywhere.
- No chat content in logs; conversation references are personal data and deleted with the user
  (`services/userDeletion.js`).
- Teams throttles bots: honor `Retry-After`, queue proactive messages.

## Plan

Issues: #3729 (parent), #3733 bot core, #3734 approval cards, #3735 proactive messages.

1. **Bot core**: registration values, endpoint and verification, identity mapping, acknowledgement card,
   1:1 chat through the chat pipeline with a default app, channel policy, admin status card, docs,
   manifest and package script.
2. **Approval cards**: Adaptive Card for gated calls, owner-only answer, audit.
3. **Proactive messages**: conversation references, delivery target for scheduled tasks, opt-out.

Each phase needs: license headers, release entry in `docs/releases/next/`, i18n keys, tests with
mocked Microsoft endpoints, and a config migration where `platform.json` changes.

## Acceptance

- [ ] A user writes to the bot in a 1:1 chat and gets an answer from the default app under their own
      iHub identity; the chat is visible in the web app.
- [ ] A user with no iHub access, a disabled user and a foreign tenant are refused.
- [ ] A forged or expired activity is rejected.
- [ ] `@iHub` in a channel answers with the shared app only, without personal sources.
- [ ] The AI-use acknowledgement appears before the first answer.
- [ ] A gated tool call shows an approval card that only the asker can answer.
- [ ] A finished scheduled task reaches a user who opted in.
- [ ] Tests with a whitelisted and a non-whitelisted host; docs; changelog.

## Open questions

1. Is the bot worth it next to the Copilot agent for our customers (licences, on-premises customers who
   cannot publish an endpoint)? Check with customers before phase 2.
2. SDK or no SDK (see above).
3. Which turn entry point: `runTurn` or `invokeAppInternal`?
4. One bot per iHub instance, or several (one per app)? One bot with `/app` is the proposal.
5. Channel policy default: shared app only, or refuse channels in v1?
6. Do approval answers in a group chat need a second factor (the web sign-in), for high-impact writes?
