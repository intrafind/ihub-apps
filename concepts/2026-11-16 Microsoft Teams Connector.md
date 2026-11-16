# Microsoft Teams Connector: read and post as the signed-in user

Status: proposal (2026-11-16). Phase 3 backlog of the unified integrations epic (#2911).
Supersedes `third-party-integrations/05-teams.md`, which predates the unified integrations
platform. Companion: `2026-11-16 Microsoft Teams Bot.md` (the other direction: chat with iHub from
inside Teams).

## Problem

An app cannot reach Teams today.

- **Office 365 reads Teams files only.** `Office365Service._buildScopes` asks for
  `Team.ReadBasic.All`, `Channel.ReadBasic.All` and `Files.Read.All` so the file picker can list team
  document libraries. Messages, chats and meetings are out of reach.
- **Entra reads some Teams data app-only** (`EntraService.getTeamMembers`, `getTeamChannels`) for people
  search.
- **Nothing posts.** A scheduled task or an app cannot deliver a result to a channel.
- **The `teams/` package is a tab with SSO.** It requests `User.Read` only and gives iHub no Graph
  access to Teams content.

Customers ask for three things: "what was decided in #project-x this week", "summarize yesterday's
meeting and list the actions", and "post this summary to the team channel".

## Goals and non-goals

Goals:

- Model-callable Teams actions that run **as the signed-in user** (delegated Microsoft Graph), so a
  user sees and does exactly what they could in Teams.
- Posting needs a human's approval by default; the admin can switch posting off.
- Scopes are requested per enabled capability, so a read-only installation never asks for send rights.
- Posting to Teams as a delivery target for scheduled tasks and workflows.

Non-goals:

- Talking to iHub from Teams. That is the bot (companion concept).
- Application permissions and the protected Teams export APIs. They need Microsoft approval and give
  an app more than any single user can see.
- Meetings beyond reading transcripts (creating meetings stays with the calendar tools).

## Why not "just use Composio"

Composio offers a hosted MCP server with about 20 Teams tools behind a per-user Microsoft OAuth. We read
its repository: it holds the client SDK and docs, not the backend or the Teams tool code, so there is
nothing to reuse. Installing it as an MCP integration works today with no code, but:

- Every user would share one Composio identity unless the MCP URL carries a per-user id, which a fixed
  catalog definition cannot do. We did not verify whether its server supports iHub's `oauth-user` mode.
- Teams content and delegated tokens would run through a third party. For our customers that is a
  data-protection decision, not a default.
- We lose the iHub approval, audit, activity display and "who may use this" behaviour for the Teams
  tools, because they would be generic MCP tools.

Decision: build a native connector. Keep the Composio route documented as an interim option for a
customer who accepts the trade-off.

## Current building blocks

| Need | Existing piece |
| --- | --- |
| Native connector contract | `server/services/integrations/protocols/native/connectors/` (Jira and Entra are the closest: `index.js` plus `parameters.json`), registered in `register.js` |
| Per-user Microsoft sign-in | `Office365Service.oauthStrategy()` on `OAuthIntegrationBase`, `auth/OAuthUserClient.js`, `auth/IntegrationConnectionService.js` |
| 401 retry and refresh | `OAuthIntegrationBase` request wrapper |
| Outbound HTTP honoring the SSL whitelist and proxy | `httpFetch()` in `server/utils/httpConfig.js` (mandatory by `CLAUDE.md`) |
| Approval per action | modes `never`, `writes`, `always` per action, with side effect and data flow (`docs/tool-approval.md`) |
| Catalog and install wizard | definitions in `server/services/integrations/definitions/`, marketplace item type `integration` |
| Run activity labels | `server/utils/toolDisplay.js` (`title`, `integration`, `activityKind`) |

## Design

### One installation, capabilities as install values

The connector is an integration definition (`com.intrafind/microsoft-teams`, native protocol) with its
own Azure app registration values (tenant, client id, client secret from the credential store), like
the Office 365 installation. A first version may reuse the Office 365 app registration if the admin
picks it.

Install values switch capabilities on. The OAuth strategy builds the scope list from them, as
`Office365Service._buildScopes` does today:

| Capability | Delegated scopes (verify against the Graph docs in the first issue) | Admin consent |
| --- | --- | --- |
| Teams and channel directory | `Team.ReadBasic.All`, `Channel.ReadBasic.All` | yes |
| Read channel messages | `ChannelMessage.Read.All` | yes |
| Read chats | `Chat.Read` | no |
| Search messages | Microsoft Search, `entityTypes: ["chatMessage"]` | follows the read scopes |
| Meeting transcripts | `OnlineMeetingTranscript.Read.All` | yes |
| Post to channels | `ChannelMessage.Send` | yes |
| Send in chats | `ChatMessage.Send` | no |

The admin page lists, per capability, which scope it needs and whether a tenant admin must consent.
Refresh requests send the same scope list, so a refreshed token never carries more than the admin
enabled (the Office 365 behavior).

### Actions

| Action | Effect | Graph |
| --- | --- | --- |
| `listTeamsAndChannels` | read | `/me/joinedTeams`, `/teams/{id}/channels` |
| `getChannelMessages` | read | channel messages and replies inside a time window |
| `listChats`, `getChatMessages` | read | the user's 1:1 and group chats |
| `searchMessages` | read | Search API |
| `getMeetingTranscript` | read | `/me/onlineMeetings/{id}/transcripts/{id}/content`, VTT turned into speaker-attributed text |
| `postChannelMessage` | write, leaves the house | `POST /teams/{id}/channels/{id}/messages`, replies under `/messages/{id}/replies` |
| `sendChatMessage` | write, leaves the house | `POST /chats/{id}/messages` |

Reads default to approval mode `never`, writes to `writes` (the install wizard preselects this for new
integrations). The approval card shows the target team, channel or chat and the rendered message.

### Safety

- **Message and transcript content is untrusted input.** A message can contain instructions aimed at
  the model. The action results are marked as external content, and no read result can trigger a write
  without the approval card.
- **No approval, no post.** Where nobody can approve (inference API, MCP gateway, workflow nodes
  without approver groups) the call is refused with `APPROVAL_REQUIRED_NO_USER`, as for every gated
  action. Delivery from tasks and workflows uses the parked-approval path or the bot (see below).
- **Size limits.** Transcripts and channel histories are capped; the result says it was cut and how to
  page.
- **SSL and proxy.** Every Graph call goes through `httpFetch()`; a test covers a whitelisted and a
  non-whitelisted host.
- **Content in the audit log** follows the existing rule for tool calls: the action and its target are
  logged, message bodies are not stored by default.

### Delivery target

"Post to Teams" is usable without a model:

- a **scheduled task** notification channel, built on #2521;
- a **workflow** tool node.

Two identities are possible. As the user (this connector) the post carries their name and needs their
token; for tasks that run unattended the user's refresh token may have expired. As the bot (companion
concept, proactive messages) the post comes from "iHub" and needs only a conversation reference. The
delivery target accepts both; v1 ships the user identity.

Admin event webhooks (#3200) are a separate feature (operators, not users) and can later use the same
Teams card renderer.

## Plan

Issues: #3728 (parent), #3730 read actions and sign-in, #3731 write actions, #3732 delivery target.

1. **Read tools and per-user OAuth** (the connector skeleton: definition, `parameters.json`, scope
   builder, connect flow, tests with mocked Graph, docs, migration if an existing installation is
   re-linked).
2. **Write actions and approval** (channel post and reply, chat send, approval card content, admin
   switch).
3. **Delivery target** for scheduled tasks and workflows.

The repository rules apply to each: license headers, config migration for new default entries,
release entry in `docs/releases/next/`, i18n keys, and no new top-level route without the
`KNOWN_ROUTES` entries.

## Acceptance

- [ ] Read actions return only what the signed-in user can see in Teams.
- [ ] A connection holds exactly the scopes of the enabled capabilities; the admin page explains the
      consent each needs.
- [ ] Posting needs approval by default, shows target and message, and can be disabled.
- [ ] Teams as delivery target for a scheduled task and a workflow.
- [ ] Tests with a whitelisted and a non-whitelisted host.
- [ ] Docs, changelog, example app "Meeting recap" (transcript to summary and action items).

## Open questions

1. Transcripts exist only when transcription was on, and access differs for organizers and attendees.
   Is organizer-only access acceptable for v1?
2. Reuse the Office 365 app registration, or require a dedicated one? A dedicated one keeps send scopes
   out of the file-picker consent.
3. Do unattended deliveries use the user's token (may have expired) or wait for the bot?
4. Should the connector also ship as a marketplace integration, or stay built in? Ties into #3603.
5. Graph throttling for message reads: a per-installation budget, as for iFinder?

## Risks

- Several scopes need tenant-admin consent, so rollout stalls in customers whose admins say no. The
  read-only subset with `Chat.Read` and `ChatMessage.Send` must stay usable without admin consent.
- Posting as a user is high-impact. The approval card and the audit entry are the controls; do not relax
  the default.
- Microsoft changes Graph licensing and metering for message APIs; verify in the first issue before
  promising a scope list to customers.
