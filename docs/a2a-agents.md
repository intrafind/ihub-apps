# Remote A2A agents as tools

iHub can call agents that speak the [Agent-to-Agent protocol (A2A) 0.3](https://a2a-protocol.org)
— a Langdock agent, an agent built with Google ADK or the `@a2a-js/sdk`, or another iHub — as
tools. Every **skill** a remote agent lists on its Agent Card becomes a tool that apps can use: the
model decides when to delegate, sends the agent a message, and gets the agent's answer back as the
tool result.

This is the client side of A2A. For the opposite direction — other agents calling iHub — see
[Agent-to-Agent (A2A) — iHub as an A2A agent](mcp-integration.md#agent-to-agent-a2a--ihub-as-an-a2a-agent).

## Configuration

Remote agents live in `contents/config/a2aAgents.json`, edited under
**Admin → Integrations → A2A agents** (see [Admin page](#admin-page)). The file is created empty on
first start.

```jsonc
{
  "agents": [
    {
      "id": "langdock", // letters, digits, _ and - (no "__"); at most 48 characters
      "name": { "en": "Langdock agent", "de": "Langdock-Agent" },
      "description": { "en": "Answers questions about our Langdock workspace" },
      "enabled": true,
      // The Agent Card: usually <agent>/.well-known/agent-card.json
      "cardUrl": "https://agents.example.com/.well-known/agent-card.json",
      "auth": { "type": "apiKey", "valueRef": "langdock-agent-key" },
      "allowedSkills": ["*"], // or skill ids exactly as the card names them
      "timeoutMs": 60000, // whole call: 1000 – 600000
      "streaming": "auto", // "auto" | "never"
      "pollIntervalMs": 1500 // tasks/get polling while a task runs
    }
  ],
  "security": {
    "blockPrivateIps": true,
    "allowedHosts": []
  }
}
```

The file reloads automatically on every worker when it is saved from the admin page; no restart is
needed.

| Field | Default | Meaning |
|-------|---------|---------|
| `id` | — | Agent id: letters, digits, `_` and `-` (no `.`, no `__`), at most 48 characters. Tools are named `a2a__<id>__<skill>`; apps and groups reference the agent by it, so it must not be the id of a tool or MCP server (see [Ids shared with tools or MCP servers](#ids-shared-with-tools-or-mcp-servers)). |
| `name`, `description` | — | Shown in the admin UI, the app editor and the chat's tool menu. |
| `enabled` | `true` | A disabled agent contributes no tools. |
| `cardUrl` | — | Full URL of the Agent Card. HTTPS; plain HTTP only for `localhost` / `127.0.0.1`. |
| `auth` | `{ "type": "none" }` | See [Authentication](#authentication). |
| `allowedSkills` | `["*"]` | Which skills become tools. |
| `timeoutMs` | `60000` | Budget for one tool call, Agent Card fetch, streaming and polling included. |
| `streaming` | `"auto"` | `auto` streams when the card declares `capabilities.streaming`; `never` always uses `message/send`. |
| `pollIntervalMs` | `1500` | How often `tasks/get` is polled for a task that is still running. |

## Authentication

| `auth.type` | Sends |
|-------------|-------|
| `none` | Nothing. |
| `apiKey` | The key in a request header: `headerName` if set, otherwise the header of the card's `apiKey` security scheme (`securitySchemes.<name> = { type: "apiKey", in: "header", name: "X-API-Key" }`), otherwise `X-API-Key`. Fields: `valueRef`, optional `headerName`. |
| `bearer` | `Authorization: Bearer <token>`. Field: `tokenRef`. |
| `oauth` | OAuth 2.0 client credentials: iHub fetches a token from `tokenUrl` (HTTPS; plain HTTP only for `localhost`) with `clientId` and the secret behind `clientSecretRef` (optional `scope`), caches it until it expires and sends it as a bearer token. The token request times out after 10 seconds. |

Every `*Ref` field names a profile in the central credential store (**Admin → Credentials**,
`contents/config/credentials.json`), exactly as for [MCP servers](mcp-integration.md#authentication).
The secret is encrypted at rest there and resolved per request; `a2aAgents.json` never holds secret
material, and secrets are never logged. The same credentials are sent for the Agent Card and for
every JSON-RPC call.

There is **no per-user sign-in yet**: every user of an agent shares the one configured credential.
Per-user OAuth (an `oauthUser` auth type) is planned together with per-user OAuth for MCP servers
(#2545).

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

Each skill within `allowedSkills` becomes one tool:

- **Id:** `a2a__<agentId>__<skillSlug>`, where the slug is the skill id lower-cased with every run
  of other characters than `a-z0-9` replaced by `_` — the cookbook skill `Ask Langdock Agent` of
  agent `langdock` is `a2a__langdock__ask_langdock_agent`. Ids are at most 64 characters, use only
  `a-z A-Z 0-9 _ -` (what OpenAI and Anthropic accept as a function name) and are unique. When two
  skill ids give the same slug (`Ask Agent`, `ask-agent`), they are numbered in skill-id order over
  all the card's skills (`ask_agent`, `ask_agent_2`), so a skill keeps its tool id whatever
  `allowedSkills` says and however the card orders its skills — the ids **Test connection** shows
  are the ids apps use.
- **Description:** the skill's description, followed by its `examples`.
- **Parameters:** `message` (required, what to ask the agent) and `data` (optional structured
  input, sent to the agent as a data part).

### Using agents in apps

An app enables an agent like an MCP server: in the app editor's **Remote A2A agents** list, or by
putting the agent id into `tools`:

```jsonc
{ "id": "support-desk", "tools": ["langdock", "braveSearch"] }
```

The agent id selects every tool of that agent (limited by `allowedSkills`), and so does
`a2a__<agentId>` (`a2a__langdock`), a reference that always means the agent; a single tool id such
as `a2a__langdock__ask_langdock_agent` selects just that skill. The literal reference `a2a` does not
select anything — it is not a shortcut for "all agents". In the chat's tool menu each agent is one
toggle.

### Ids shared with tools or MCP servers

Apps and groups reference tools (`jira` for `jira_searchTickets`), MCP servers (`drawio`) and A2A
agents (`langdock`) by the same bare ids. So an agent id must not be the id or base id of a tool, or
the id of an MCP server: `POST /api/admin/a2a/agents` refuses such an id with `409`, and creating an
MCP server with the id of an A2A agent is refused the same way (ids are compared ignoring case).

Should an agent and a tool or MCP server share an id anyway (a hand-edited file, or a tool added
after the agent), the bare id keeps selecting only the tool or MCP server: the agent is never
granted by it. The agent is then enabled as a whole by `a2a__<agentId>`, which the app editor
writes for you, and the server log names the clash. Apps and group grants that already use
`a2a__<agentId>` need no change when a clash appears later.

### Group permissions

Group `tools` grants in `groups.json` read like an app's `tools`: grant the agent id
(`"langdock"`, or `"a2a__langdock"`) for all its skills or a tool id for one — just as an MCP server id grants the
server's tools and a base id (`"iFinder"`) a tool's functions. As for every tool, which tools an app
can call is decided by the app's own `tools` list; the group grant decides what users see in the
tool list (`GET /api/tools`). iHub's own MCP gateway and A2A endpoint never re-export remote agents: a remote agent's
credentials stay with iHub.

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

**Admin → Integrations → A2A agents** lists the agents with their status (card loaded and number
of skills, not contacted yet, unreachable, disabled). The dialog edits every field above; the
credential fields pick a profile from the credential store. **Test connection** fetches the card of
the unsaved configuration and shows the agent's name, description, version, protocol version,
endpoint, streaming support and every skill with its tool id — tick the skills to offer when
**Only the skills I select** is chosen.

The API behind it (all admin-only):

| Endpoint | Purpose |
|----------|---------|
| `GET /api/admin/a2a/agents` | Agents with status |
| `POST /api/admin/a2a/agents` | Create (`409` for an id another agent, a tool or an MCP server uses) |
| `PUT /api/admin/a2a/agents/:id` | Update |
| `DELETE /api/admin/a2a/agents/:id` | Delete |
| `POST /api/admin/a2a/agents/:id/test` | Re-fetch a saved agent's card: `{ status, card, skills }` |
| `POST /api/admin/a2a/test` | Probe an unsaved agent config |
| `GET /api/admin/a2a/status` | Health snapshot |
| `GET /api/admin/a2a/skills` | Skills per agent (the app editor's list; `idConflict: true` for an agent whose id a tool or MCP server shares) |

## Security

Every request to an agent — Agent Card, JSON-RPC, streams, the OAuth token endpoint — goes through
the same SSRF guard as outbound MCP (see [MCP security](mcp-integration.md#security)): DNS is
resolved once, private and link-local addresses are refused, and the connection is pinned to the
checked address. To reach an agent on an internal network, add its hostname to
`security.allowedHosts` (or the platform-wide `ssrf.allowedHosts`); `blockPrivateIps: false` turns
the check off for all agents.

**Redirects are never followed.** The guard checks the host of the URL iHub requests; a redirect
would send the request — with the agent's credential and the user's message — on to a host that was
never checked (a redirect to an IP address is not even resolved). So an Agent Card, JSON-RPC or
token request answered with a `3xx` fails with `A2A_REDIRECT_REFUSED`; configure the final URL
instead (for example the card URL the redirect points to).

Only the model's `message` and `data` leave iHub. The user object, chat id, app configuration and
attachments of the chat are never sent to an agent.

## Limitations

- **No per-user sign-in** — see [Authentication](#authentication); follows with #2545.
- **No file parts.** Attachments are not handed to agents, and file parts in an agent's answer are
  ignored.
- **No push notifications** and no `tasks/resubscribe`: long tasks are polled within `timeoutMs`.
- **Text results only.** Output modes other than text and JSON are not requested.
- **Only JSON-RPC.** Agents offering only gRPC or HTTP+JSON transports cannot be connected.
