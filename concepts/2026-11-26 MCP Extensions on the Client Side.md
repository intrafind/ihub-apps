# MCP Extensions on the Client Side

Status: proposed. Follows the move to MCP SDK v2 and protocol revision 2026-07-28, which gave the
inbound gateway Skills, Tasks and approval through elicitation (see
[MCP Integration](../docs/mcp-integration.md#protocol-revisions)).

## Where we stand

iHub talks MCP in two directions. The **gateway** (`/mcp`, iHub as server) now serves:

| Capability                        | Gateway (iHub as server)                     | Outbound (iHub as client)          |
| --------------------------------- | -------------------------------------------- | ---------------------------------- |
| Protocol 2026-07-28               | yes, stateless, next to the 2025 revisions   | yes, over Streamable HTTP          |
| Skills (`io.modelcontextprotocol/skills`) | yes: `skills/list`, `skill://` files | no                                 |
| Tasks (`io.modelcontextprotocol/tasks`)   | yes: apps and workflows              | no                                 |
| Elicitation                       | yes: approval of gated tools                 | yes: form and URL mode, in the chat |
| File Uploads (experimental)       | no                                           | no                                 |

Outbound, iHub declares none of the extensions, so every server answers it as it answers any
client without them: synchronously, without asking the user mid-call, without skills. Nothing is
broken; iHub just does not use what servers like Supabase, GitHub or Atlassian now offer. This
document plans the three client-side pieces and says what blocks File Uploads.

## 1. Elicitation from external servers

**Status: implemented, form and URL mode** (see
[MCP Integration → Questions from the server](../docs/mcp-integration.md#questions-from-the-server-elicitation)).
As built, the question is a `question` interaction on a child run of the chat
run (the chat-launched workflow pattern), shown by its own form card and
answered on the runs endpoint; a per-call AsyncLocalStorage scope finds the
chat on the shared connection. Admins switch it off per installation
(`elicitation: { enabled }`).

URL mode answers `accept` when the person comes back and clicks **Done**, not
when the page opens: 2026-07-28 drops `elicitationId` and the completion
notice, so a server that got `accept` at once would only ask again. A 2025
server's `notifications/elicitation/complete` ends the question early, and a
`-32042` refusal is answered by asking for each page and calling again.

Still open: the question's child run is announced on the live chat stream
only, not written to the run ledger, so a page reload during a question does
not bring the card back (the question is cancelled after 10 minutes, or when
the turn is stopped). Questions are offered over Streamable HTTP only; on
`stdio` and legacy SSE a question arrives outside the call and could not be
put to the right chat.

The original plan follows.

**What it gives:** a server can ask the chat user mid-call: confirm a paid action (Supabase), type
a repository name before deleting it (GitHub), fill in a missing parameter.

**Why it is not there yet:** the chat's human touchpoints (`InteractionService`, the approval
seam, `ask_user`) pause the *turn* and resume it later. An elicitation is the other way round: the
tool call stays open while the user answers. On 2026-07-28 the SDK client fulfils `input_required`
by calling our `elicitation/create` handler and retrying the call; on 2025 the server sends the
request over the session. Either way the handler has to wait for the user inside the tool call.

**Plan:**

- Declare `elicitation: { form: {}, url: {} }` on the outbound `Client` per installation, behind
  an installation setting (default off until the UI exists).
- Run every outbound `callTool` inside an `AsyncLocalStorage` scope that names the run, chat and
  user (`toolCallScope.js` already runs one per tool call). The elicitation handler reads it; a
  service-account connection is shared by many users, so the scope is the only reliable way to
  find whose question it is.
- Raise a `question` interaction (`InteractionService.raise`, `inputType: 'form'`, the
  `requestedSchema` as `inputSchema`) and `waitForAnswer` with the elicitation timeout. The chat
  renders the card while the turn is still streaming: a new `interaction/raised` frame inside a
  running tool call, which the client must learn to show. URL mode opens the link and offers
  **Done**.
- Decline when no person can answer (inference API, workflows, scheduled runs), as the gateway
  refuses when its client cannot ask.

**Open:** how long a turn may wait; whether an answer survives a worker restart (the interaction
does, the open HTTP request to the server does not).

## 2. Tasks from external servers

**What it gives:** a long server job (a research run, a build) no longer hits the per-call
timeout; the chat can show its status.

**Why it is not there yet:** the v2 client (`@modelcontextprotocol/client` 2.4.0) rejects a
`resultType: "task"` answer (`UNSUPPORTED_RESULT_TYPE`) and has no `extensions` option to accept
it. `@modelcontextprotocol/ext-tasks` (0.2.x) can drive tasks over an SDK client, but against a
2026-07-28 server it needs a raw request dispatcher and request framing we would have to build on
our own fetch.

**Plan:** wait for client extension support in the SDK (the docs already describe
`ClientExtension.acceptResultType`), then: declare the extension, poll `tasks/get` at the server's
`pollIntervalMs` inside the tool call with an overall limit per installation, send `tasks/cancel`
when the run is aborted, and report `statusMessage` as tool progress.

## 3. Skills from external servers

**What it gives:** a connected server ships its own playbooks (how to use its tools well), loaded
only when the model needs them.

**Plan:**

- List skills with `SkillsClient` when the server declares the extension; show them on the
  installation page with their origin (server and URI) and file manifest.
- An admin approves a skill per installation. The approval binds to the manifest: a changed digest
  revokes it and the skill is offered for approval again (the spec requires this).
- Approved skills appear to the model like iHub's own skills (`activate_skill`), named
  `<installation>:<skill>`, never replacing a skill of the same name. Reading verifies every file
  against the manifest; `allowed-tools` in an MCP skill's frontmatter grants nothing.
- Cache verified files per installation outside the skill folders, so filesystem discovery never
  picks them up.

**Open:** per-user servers (`oauthUser`) may list different skills per user.

## 4. File Uploads

The File Uploads extension is an experimental draft (`experimental-ext-file-uploads`), not a
proposed SEP; its wire format will change. The gateway already accepts files inline (`files` on
`app__*` and `workflow__*`, base64). Revisit when the extension is proposed: the gateway would mark
the `files` argument in the input schema and accept out-of-band uploads; the client would upload
chat files to servers instead of passing base64 through the model.

## Order

1. Elicitation — done (form and URL mode).
2. Skills (server-side only, no SDK gap).
3. Tasks (blocked on SDK client extensions).
4. File Uploads (blocked on the spec).
