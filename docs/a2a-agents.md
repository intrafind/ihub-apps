# Remote A2A agents as tools

iHub can call agents that speak the [Agent-to-Agent protocol (A2A) 0.3](https://a2a-protocol.org)
— a Langdock agent, an agent built with Google ADK or the `@a2a-js/sdk`, or another iHub — as
tools. Every **skill** a remote agent lists on its Agent Card becomes a tool that apps can use: the
model decides when to delegate, sends the agent a message, and gets the agent's answer back as the
tool result.

This is the client side of A2A. For the opposite direction — other agents calling iHub — see
[Agent-to-Agent (A2A) — iHub as an A2A agent](mcp-integration.md#agent-to-agent-a2a--ihub-as-an-a2a-agent).

## Configuration

A remote agent is an **installed integration**: an installation of the shipped definition
**"A2A agent"** (`com.intrafind/a2a-agent`) under **Admin → Integrations → Installed**
(`/admin/integrations/installed`; **Catalog** tab → **A2A agent** → **Install**, see
[Admin page](#admin-page)). Installations live in `contents/config/integrations.json`, next to
MCP servers and the other [installed integrations](integrations.md):

```jsonc
{
  "id": "langdock", // letters, digits, _ and - (no "__"); at most 48 characters
  "definition": "com.intrafind/a2a-agent",
  "label": { "en": "Langdock agent", "de": "Langdock-Agent" },
  "description": { "en": "Answers questions about our Langdock workspace" },
  "enabled": true,
  "values": {
    // The Agent Card: usually <agent>/.well-known/agent-card.json
    "cardUrl": "https://agents.example.com/.well-known/agent-card.json",
    "authKind": "apiKey", // service account: "bearer" | "apiKey"
    "timeoutMs": 60000, // whole call: 1000 – 600000
    "streaming": "auto", // "auto" | "never"
    "pollIntervalMs": 1500 // tasks/get polling while a task runs
  },
  "auth": { "mode": "service-account", "credentialRef": "langdock-agent-key" },
  "actions": { "enabled": ["*"], "disabled": [] },
  "allowedGroups": []
}
```

The file reloads automatically on every worker when an installation is saved; no restart is
needed.

| Field | Default | Meaning |
|-------|---------|---------|
| `id` | — | Installation id: letters, digits, `_` and `-` (no `.`, no `__`), at most 48 characters. Tools are named `a2a__<id>__<skill>`; apps bind and groups grant the agent by it, so it must not be the id of another installation or the base id of a tool (see [Ids shared with tools or installed integrations](#ids-shared-with-tools-or-installed-integrations)). |
| `label`, `description` | — | Optional. Shown on the Installed page, in the app editor and in the chat's tool menu. |
| `enabled` | `true` | A disabled agent contributes no tools. |
| `values.cardUrl` | — | Required. Full URL of the Agent Card. HTTPS; plain HTTP only for `localhost` / `127.0.0.1`. |
| `auth` | `{ "mode": "none" }` | The sign-in mode and the credential reference; see [Authentication](#authentication). |
| `actions` | `{ "enabled": ["*"], "disabled": [] }` | Which skills become tools; see [Actions: the card's skills](#actions-the-cards-skills). |
| `allowedGroups` | `[]` (everyone) | Who gets the agent's tools, as for every installation. |
| `values.timeoutMs` | `60000` | Advanced. Budget for one tool call, Agent Card fetch, streaming and polling included (1000 – 600000). |
| `values.streaming` | `"auto"` | Advanced. `auto` streams when the card declares `capabilities.streaming`; `never` always uses `message/send`. |
| `values.pollIntervalMs` | `1500` | Advanced. How often `tasks/get` is polled for a task that is still running. |

### Migration from `a2aAgents.json`

Earlier versions kept remote agents in `contents/config/a2aAgents.json`, with their own admin
page (**Admin → A2A agents**) and the admin routes `/api/admin/a2a/*`. Migration **V194** moves
every agent of that file into an installation under the same id, so tool ids and group grants
stay valid; it maps `auth` to a sign-in mode and keeps the credential references, turns
`allowedSkills` into `actions.enabled`, merges the file's `security` block into
`integrations.json`, rewrites agent references in `app.tools` into bindings (a reference to a
single skill becomes a binding of the whole agent, because the skill ids behind the tool slugs
are only known from the card) and deletes the file. Conversations (`contextId`) and the inbound
side — iHub as an agent — are unchanged.

## Authentication

The wizard's **Sign-in** step chooses the installation's `auth.mode`, as for
[MCP servers](mcp-integration.md#authentication):

| Sign-in mode | Sends |
|--------------|-------|
| **No sign-in** (`none`) | Nothing. |
| **Service account** (`service-account`) | One shared token or key, the way `values.authKind` says: `bearer` — `Authorization: Bearer <token>`; `apiKey` — the key in a request header: `values.headerName` if set, otherwise the header of the card's `apiKey` security scheme (`securitySchemes.<name> = { type: "apiKey", in: "header", name: "X-API-Key" }`), otherwise `X-API-Key`. |
| **OAuth client** (`oauth-client`) | OAuth 2.0 client credentials: iHub fetches a token from `values.oauthTokenUrl` (HTTPS; plain HTTP only for `localhost`) with `values.oauthClientId` and the client secret (optional `values.oauthScope`), caches it until it expires and sends it as a bearer token. The token request times out after 10 seconds. |

The token, key or client secret entered in the wizard goes to the central credential store
(**Admin → Credentials**, `contents/config/credentials.json`), where it is encrypted at rest and
resolved per request; the installation holds only `auth.credentialRef`, so `integrations.json`
never holds secret material, and secrets are never logged. The same credentials are sent for the
Agent Card and for every JSON-RPC call.

There is **no per-user sign-in yet**: every user of an agent shares the one configured credential,
and the definition does not offer the sign-in mode **Per-user OAuth** that MCP installations have.
Per-user OAuth for agents is planned (#2545).

## How skills surface as tools

iHub fetches each enabled agent's Agent Card (cached for 10 minutes, and again after a save or a
**Test connection**). A card fetch gives up after `timeoutMs` or 10 seconds, whichever is shorter.
It checks that the card has a `url`, a `skills` array and a `protocolVersion`, and talks JSON-RPC to
the card's `url` — or, when `preferredTransport` is not JSON-RPC, to the JSON-RPC entry of
`additionalInterfaces`. That endpoint receives the credential and the user's messages, so the same
rule as for `cardUrl` applies: a card naming a plain-HTTP endpoint on another host than `localhost`
is refused (`A2A_CARD_INVALID`).

A slow agent never holds up the chat: tool discovery runs on every chat turn, and it keeps using an
expired card while the new one is fetched in the background, and waits at most 2 seconds for an
agent whose card has not been loaded yet (the agent is left out of that turn; the fetch carries on).
An agent whose card fetch failed is not tried again for 30 seconds.

Each skill the installation has enabled becomes one tool:

- **Id:** `a2a__<agentId>__<skillSlug>`, where the slug is the skill id lower-cased with every run
  of other characters than `a-z0-9` replaced by `_` — the cookbook skill `Ask Langdock Agent` of
  agent `langdock` is `a2a__langdock__ask_langdock_agent`. Ids are at most 64 characters, use only
  `a-z A-Z 0-9 _ -` (what OpenAI and Anthropic accept as a function name) and are unique. When two
  skill ids give the same slug (`Ask Agent`, `ask-agent`), they are numbered in skill-id order over
  all the card's skills (`ask_agent`, `ask_agent_2`), so a skill keeps its tool id whichever skills
  are switched off and however the card orders its skills — the ids **Test connection** shows
  are the ids apps use.
- **Description:** the skill's description, followed by its `examples`.
- **Parameters:** `message` (required, what to ask the agent) and `data` (optional structured
  input, sent to the agent as a data part).

### Actions: the card's skills

The installation's **actions** are the card's skills, as an MCP installation's actions are its
tools. The wizard lists them after **Test connection** (which fetches the card) and when an
installation is edited; switch off the skills the agent should not offer. In the file:

- `actions.enabled` — `["*"]` (every skill), or skill ids exactly as the card names them (what
  V194 writes for a former `allowedSkills` list).
- `actions.disabled` — the skills switched off in the wizard, by skill id.

A skill that `enabled` covers and `disabled` does not name becomes a tool, so a skill the agent
adds to its card later is on by default until you switch it off. The Installed list shows whether
the card could be fetched and the number of skills.

### Using agents in apps

An app offers an agent by binding the installation under `integrations`, keyed by the installation
id — **Admin → Apps → Edit → Installed integrations** writes it, exactly as for an MCP server (see
[Integrations: binding an installed integration](apps.md#integrations-binding-an-installed-integration)):

```jsonc
{ "id": "support-desk", "integrations": { "langdock": {} }, "tools": ["braveSearch"] }
```

`"langdock": {}` offers every skill the installation has enabled; `"langdock": { "actions":
["<skill id>"] }` only the named skills (skill ids as the card names them). The installation's
`allowedGroups` and the binding's actions apply in the chat and in `GET /api/tools?appId=`; an
app whose installation is missing or disabled does not offer the agent. In the chat's tool menu
each agent is one toggle.

Listing an agent in `tools` selects nothing any more: `"langdock"`, `"a2a__langdock"` and
`"a2a__langdock__ask"` are ignored there (V194 rewrote such entries into bindings), and the app
editor's former **Remote A2A agents** picker is gone.

### Ids shared with tools or installed integrations

An agent's id is an installation id, so it cannot collide with another installation — an MCP
server, an iFinder installation or another agent: the Installed page refuses the id (ids are
compared ignoring case). People directories check installed integrations the same way, so a
directory never takes an agent's id either.

Local tools are referenced by bare ids too (`jira` for `jira_searchTickets`), and nothing stops a
tool from being added with the id of an existing agent. Should an agent share the id or base id of
a local tool, the bare id keeps meaning the tool in group grants: the agent is marked with
`_a2a.idConflict`, the server log names the clash, and the agent is granted only by
`a2a__<agentId>` or exact tool ids. Apps are not affected: they bind the installation under
`integrations`, where the id is unambiguous. Group grants that already use `a2a__<agentId>` need
no change when a clash appears later.

### Group permissions

Group grants (`permissions.tools` in `groups.json`) are unchanged: grant `a2a__<agentId>`
(`"a2a__langdock"`) or the bare agent id (`"langdock"` — unless it clashes with a local tool's
base id, then only `a2a__langdock` means the agent) for all its skills, or an exact tool id for
one — just as an installed integration's id (an MCP server's `"drawio"`) grants all its tools and
a base id (`"iFinder"`) a tool's functions. The grants are read wherever group tool grants are
evaluated: the tool list (`GET /api/tools`) and the MCP gateway's permission check. As for every
tool, which tools an app can call is decided by the app's own bindings and `tools` list; the group
grant decides what users see in the tool list. iHub's own MCP gateway and A2A endpoint never
re-export remote agents: a remote agent's credentials stay with iHub.

## Calling an agent

When the model calls an A2A tool, iHub sends one A2A `Message` to the agent:

```jsonc
{
  "message": {
    "kind": "message",
    "role": "user",
    "messageId": "<uuid>",
    "parts": [
      { "kind": "text", "text": "<message>" },
      { "kind": "data", "data": { /* data, when given */ } }
    ],
    "contextId": "<the conversation so far, if any>",
    "taskId": "<only when answering the agent's question, see below>",
    "metadata": { "skillId": "<the card's skill id>" }
  },
  "configuration": { "blocking": true, "acceptedOutputModes": ["text/plain", "application/json"] }
}
```

- **Streaming.** When the card declares `capabilities.streaming` and `streaming` is `auto`, iHub
  uses `message/stream` (Server-Sent Events): artifact chunks are joined (`append`, `lastChunk`),
  status updates appear in the chat as tool progress, and the call ends with the `final` event. A
  stream that breaks off early is finished by polling `tasks/get`. Status and artifact updates are
  matched to the task by their `taskId` and `contextId` (agents such as Google ADK send no `Task`
  event at all); updates of any other task or context are ignored.
- **Without streaming** iHub uses `message/send`. An agent that answers with a `Message` (like the
  Langdock cookbook agent) is done at once. A `Task` that is not finished yet is polled with
  `tasks/get` every `pollIntervalMs`.
- **Result.** The text of the task's artifacts; otherwise the final status message; for a `Message`
  reply its text. Data parts are added as JSON.
- **Questions back.** A task that stops at `input-required` returns the agent's question as the
  tool result, so the model can ask the user and call the agent again. That next call — the
  user's answer — carries the waiting task's `taskId` (and `contextId`), so the agent continues the
  same task. Should the agent no longer know the task (`TaskNotFoundError`), the answer is sent as a
  new task of the same conversation.
- **Signing in.** A task that stops at `auth-required` fails at once with `A2A_AUTH_REQUIRED` and the
  agent's status message: iHub signs in with one shared credential and cannot run the sign-in the
  agent asks for. A task in state `unknown` (or a state iHub does not know) fails with
  `A2A_TASK_FAILED`. Neither is polled until the timeout.
- **Timeouts.** A call that has not finished after `timeoutMs` is cancelled at the agent
  (`tasks/cancel`, best effort) and fails with `A2A_TIMEOUT`.
- **Stop.** When the user stops the chat answer, the running request to the agent is aborted, a
  running task is cancelled the same way (`tasks/cancel`) and the call ends with `A2A_CANCELLED`.
- **Errors** reach the model and the chat's tool activity with a code: `A2A_TASK_FAILED` (the task
  ended `failed`, `rejected` or `canceled`; the agent's status message is the error text),
  `A2A_RPC_ERROR` (a JSON-RPC error from the agent), `A2A_AUTH_FAILED` (HTTP 401/403),
  `A2A_CARD_INVALID` (the Agent Card lacks what iHub needs), `A2A_REDIRECT_REFUSED` (the agent
  answered with a redirect, see [Security](#security)), `A2A_RESPONSE_TOO_LARGE` (see below).
- **Size limits.** An agent's answers are read up to fixed limits: 1 MB for the Agent Card, 4 MB for
  a JSON-RPC response or one stream event, 16 MB for a whole stream and 4 million characters of
  collected artifact text. Past a limit the call fails with `A2A_RESPONSE_TOO_LARGE`. (The model
  only ever sees a bounded preview of a large tool result anyway.)

### Conversations (`contextId`)

The `contextId` of an agent's answer is remembered for the combination of user, chat and agent,
and sent with the next call from the same chat, so the agent can keep the conversation going
("and what about last year?"). The same goes for the `taskId` of a task waiting for the user's
answer (`input-required`), until that task moves on. Neither is ever shared across chats or users.
The conversations are kept on the storage provider (`a2a-client-contexts`, see
[Storage](storage.md)), so a chat continues its conversation with an agent after a restart and on
whichever worker serves the next tool call. A conversation nobody continued for 30 days is dropped.
Without a storage provider the memory is per server process (5,000 conversations).

## Admin page

Agents have no page of their own any more: **Admin → Integrations → Installed**
(`/admin/integrations/installed`) lists each agent among the installed integrations with its
status — card loaded and number of skills, not contacted yet, unreachable, disabled — and offers
**Test**, **Edit**, **Enable**/**Disable** and **Uninstall**, as for every installation. The
**Catalog** tab → **A2A agent** → **Install** opens the wizard: the Agent Card URL, the
**Sign-in** step (see [Authentication](#authentication)), the advanced fields (`timeoutMs`,
`streaming`, `pollIntervalMs`) and the actions. **Test connection** fetches the card of the
unsaved configuration and shows the agent's name, description, version, protocol version,
endpoint, streaming support and every skill with its tool id — switch off the skills the agent
should not offer. Editing a saved agent lists the skills of its card.

The API behind it is the installed-integrations API (see
[MCP → Admin operations](mcp-integration.md#admin-operations), [Integrations → API](integrations.md#api)):
`GET /api/admin/integrations/installed` carries each agent's status,
`POST …/installed` / `PUT …/installed/:id` / `DELETE …/installed/:id` install, update and
uninstall, `POST …/installed/:id/_test` re-fetches a saved agent's card and
`POST /api/admin/integrations/catalog/com.intrafind%2Fa2a-agent/_test` probes an unsaved draft.
The former `/api/admin/a2a/*` routes are gone.

## Security

Every request to an agent — Agent Card, JSON-RPC, streams, the OAuth token endpoint — goes through
the same SSRF guard as outbound MCP (see [MCP security](mcp-integration.md#security)): DNS is
resolved once, private and link-local addresses are refused, and the connection is pinned to the
checked address. To reach an agent on an internal network, add its hostname to
`security.allowedHosts` of `contents/config/integrations.json` (or the platform-wide
`ssrf.allowedHosts`); `security.blockPrivateIps: false` there turns the check off for all agents —
and, since the block is shared, for every other installed integration too.

**Redirects are never followed.** The guard checks the host of the URL iHub requests; a redirect
would send the request — with the agent's credential and the user's message — on to a host that was
never checked (a redirect to an IP address is not even resolved). So an Agent Card, JSON-RPC or
token request answered with a `3xx` fails with `A2A_REDIRECT_REFUSED`; configure the final URL
instead (for example the card URL the redirect points to).

Only the model's `message` and `data` leave iHub. The user object, chat id, app configuration and
attachments of the chat are never sent to an agent.

## Limitations

- **No per-user sign-in** — the definition offers no **Per-user OAuth** mode; see
  [Authentication](#authentication). Follows with #2545.
- **No file parts.** Attachments are not handed to agents, and file parts in an agent's answer are
  ignored.
- **No push notifications** and no `tasks/resubscribe`: long tasks are polled within `timeoutMs`.
- **Text results only.** Output modes other than text and JSON are not requested.
- **Only JSON-RPC.** Agents offering only gRPC or HTTP+JSON transports cannot be connected.
