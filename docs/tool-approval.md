# Tool Approval

A model can decide on its own to call a tool: search your documents, then ask an external MCP
server with what it found, or comment on a Jira issue. **Tool approval** lets an administrator
decide which of those calls a person has to approve before anything is sent.

The risk is not only writes. A _read_ on an external system can carry internal information out
(search your own sources, then pass what you found to an external tool). So approval depends on
what a call does (**side effect**) and where its data goes (**data flow**).

Approval is **opt-in**: nothing is asked until an administrator sets a mode. An upgrade does not
change how existing tools behave.

## Modes

| Mode     | When a person is asked                                                                     |
| -------- | ------------------------------------------------------------------------------------------ |
| `never`  | Never (the default).                                                                       |
| `writes` | Unless the call only reads. `write`, `destructive` and `unknown` are asked for, and so is a `read` that only a remote server's own annotation claims. |
| `always` | For every call, reads included. Use it for external tools that may leak internal data.    |

## Side effect and data flow

Every tool has a side effect (`read`, `write`, `destructive`, `unknown`) and a data flow
(`internal`, `external`). They come from, in this order:

1. The installation's admin override (`actions.overrides[<action>].sideEffect`).
2. The tool file's own `sideEffect` (per function or for the whole tool).
3. The integration action's declaration (definition, OpenAPI HTTP method).
4. MCP tool annotations (`readOnlyHint`, `destructiveHint`). These are **untrusted**: a remote
   server can say anything about its own tools. They are shown, and `destructiveHint` makes a
   tool stricter, but a claimed `readOnlyHint` never relaxes a gate. Under `writes`, such a tool
   is still asked for until an admin confirms it as a read with an action override.
5. Otherwise `unknown`, which `writes` treats as a write.

Remote MCP servers and A2A agents are `external`; integrations declare their data flow; every
other tool is `internal` unless its tool file says otherwise. An admin can set an action's data
flow on the installation (`actions.overrides[<action>].dataFlow`); it wins over the declared one
and decides which platform default applies.

```json
// integrations.json: this MCP server runs in your network, and its "search" only reads
{
  "id": "wiki",
  "actions": { "overrides": { "search": { "sideEffect": "read", "dataFlow": "internal" } } }
}
```

## Where it is configured and who wins

Several places can set a mode. **The strictest one wins.** Admin settings are the floor; an app
can only tighten them, never loosen them (a looser app value is ignored and logged).

| # | Layer                    | Where                                                                                         | Set by |
| - | ------------------------ | --------------------------------------------------------------------------------------------- | ------ |
| 1 | Platform default         | `platform.json` → `toolApproval.defaults.internal` / `.external`, else `.default`. **Admin → Security → Tool approval** | Admin |
| 2 | Tool file                | `contents/tools/<id>.json` → `approval` (per function, else the tool's). `requiresApproval: true` counts as `always`. Only for a hand-written tool file; the admin-created ones became custom integrations (V211), whose approval is set in the [integration builder](integrations.md#custom-integrations-add-manually) or on the action's detail page | Admin |
| 2 | Installation default     | `integrations.json` → `installed[].approval.default`. **Admin → Integrations → an installation → Overview** | Admin |
| 3 | Installation action      | `installed[].approval.actions[<action name>]`, keyed by the action's own name (an MCP tool's name, never the prefixed tool id). Set in the action's detail panel on the installation page | Admin |
| 3 | New or changed action    | `installed[].approval.newOrChanged` (default `always`) while the action is new or changed since the last review (see below) | Admin |
| 4 | App override             | App → `toolApproval.tools[<tool id or installation id>]`, else `toolApproval.default`. **Admin → Apps → Edit → Tools** | App author |

Because the strictest mode wins, an action can be made stricter than its installation default but
not looser. To have one action that never asks on an installation that otherwise asks on writes,
set the installation default to `never` and the stricter actions to `writes` or `always`.

### Examples

```json
// platform.json: ask before external tools write, nothing else
"toolApproval": { "defaults": { "external": "writes" } }
```

```json
// integrations.json: ask on writes for this Jira installation, always for comments
{ "id": "jira", "approval": { "default": "writes", "actions": { "comment": "always" } } }
```

```json
// contents/tools/crm.json: per function
{
  "id": "crm",
  "approval": "writes",
  "dataFlow": "external",
  "functions": {
    "search": { "sideEffect": "read" },
    "create": { "sideEffect": "write", "approval": "always" }
  }
}
```

```json
// an app that asks for every tool call
"toolApproval": { "default": "always" }
```

## New and changed actions

A vendor can add an action to an integration, or change what an existing one does, after you
configured approval for it. iHub notices and asks for such an action until you have looked at it.

Every action is **fingerprinted** over its name, the side effect its vendor declares (the
definition, the OpenAPI operation, an MCP tool's annotations) and its input schema. The schema is
compared in a canonical form: key order, descriptions, titles and examples do not count (so a
translated description is not a change), the parameters, their types, limits, allowed values and
required fields do.

The installation keeps the fingerprints an admin accepted (`actions.fingerprints`, written by the
server only). An action whose name is not among them is **new**; one whose fingerprint differs is
**changed**. Until an admin reviews it, such an action resolves to at least
`approval.newOrChanged` (default `always`). Like every layer, this only makes it stricter: an
action already set to `always` stays there, and `newOrChanged: "never"` turns the reset off.

- **Opt-in.** Only an installation with an approval setting is tracked. When you set one (or
  install a new integration, which preselects one), the actions as they are then become the
  accepted ones. Nothing is tracked or written for installations without an approval setting.
- **Where you see it.** **Admin → Integrations → an installation → Overview** badges an action
  **New** or **Changed**, says how many are waiting, and offers **Mark reviewed** per action and
  **Mark all reviewed**. Marking accepts the current fingerprints and is recorded in the audit
  log. The **New or changed actions** select next to the installation default sets
  `approval.newOrChanged`.
- **What counts as a change.** A new or removed parameter, a changed type, limit or allowed value,
  or a changed declared side effect. A change of the installation's own settings that changes an
  action's input (such as the maximum number of rows a CKAN search may ask for) counts too.
- **Renamed actions.** An action a definition migration renames is new under its new name.
- **Saving in the builder.** For an OpenAPI, HTTP or script custom integration that already tracks
  actions, saving in the [integration builder](integrations.md#custom-integrations-add-manually)
  accepts the actions the save changed or added as reviewed: the admin just wrote them. An action
  that was already pending and that the save does not touch stays pending, and an MCP tool or A2A
  skill that changed on the remote server is never accepted by a save.
- iHub logs a warning once per action and fingerprint when it first sees one that is new or
  changed. Discovery never writes `integrations.json`; only setting approval for the first time
  and **Mark reviewed** do.

```json
// integrations.json, as the server keeps it
{
  "id": "jira",
  "approval": { "default": "writes", "newOrChanged": "always" },
  "actions": {
    "fingerprints": { "search": "sha256:…", "comment": "sha256:…" },
    "reviewedAt": "2026-11-02T10:00:00.000Z"
  }
}
```

## Installing an integration

The install form preselects an approval default for a new installation, which you can change
before saving:

- **Always ask** for an external integration whose actions carry no trusted side effect: an MCP
  server or A2A agent (their own annotations are never trusted), or a definition with an external
  action whose side effect is `unknown`.
- **Ask unless it only reads** for every other integration.

Choose **Platform default** to install without an approval setting. Installations that exist
before the upgrade keep no approval setting until you set one.

## In the chat

When a call needs approval, the chat shows an approval card instead of running it:

- The tool and its integration, the side effect and the data flow as badges.
- The **exact arguments** the call will run with, as plain text, before anything else.
- Text the assistant wrote before the call, labelled as written by the assistant (it is not a
  verified reason, and it is never treated as an instruction).
- **Approve**, **Approve & allow for this chat** and **Reject**.

On **Approve**, the server runs the stored call itself with the arguments shown on the card. The
model is not asked to issue it again, so the user approves exactly what is sent. The result takes
the place of the waiting call and the assistant continues. **Approve & allow for this chat** also
lets that tool run without asking for the rest of the chat (stored with the chat). On **Reject**,
or when nobody answers within 24 hours, the model gets `USER_REJECTED` or `APPROVAL_EXPIRED` as the
tool result and carries on without the call.

Sending any other message instead of answering supersedes the approval: the call is not run. A
double click or a repeated request cannot run a call twice: the approval is answered exactly once.
The decision is only used once the turn is ready to run; a request refused before that keeps the
approval open, so the same decision can be sent again. An approval that expired in the meantime
continues with `APPROVAL_EXPIRED`.

Admins and approver groups who see an approval in **Admin → Agents → Approvals** (or a run's
interactions) see secret-looking argument values (passwords, tokens, API keys, authorization,
credentials, …) redacted; only the person who asked sees them in full. The call itself always
runs with the full arguments.

There is no persistent "always allow" per user, and the arguments cannot be edited before
approving. Both may come later.

## Where nobody can approve

| Surface                                                                  | Behaviour |
| ------------------------------------------------------------------------ | --------- |
| Inference API (OpenAI-compatible), app-as-tool, MCP gateway, A2A gateway | The call is refused with the tool result `APPROVAL_REQUIRED_NO_USER`; the model carries on. |
| A client that does not draw the card (an integration posting to the chat API without `toolApprovalCapable: true`, or a chat request without an open stream) | Same: `APPROVAL_REQUIRED_NO_USER`. |
| An MCP App view in a host that cannot show the card (an embed, a shared chat, Office) | 403 `APPROVAL_REQUIRED_NO_USER` for a gated tool. |
| Workflow and agent nodes                                                 | Refused, unless the node names approver groups (`config.toolApproval.approverGroups`). Then the approval is parked for them in **Admin → Agents → Approvals**, and the node continues with the stored call once a member approves (or with `USER_REJECTED`). The call runs as the execution's own principal, never as the approver; the approver is recorded as the answer's author. A step that is retried after the approved call ran does not run it again (`APPROVAL_ALREADY_USED`). |
| Scheduled tasks                                                          | Unchanged flow: the run pauses for the task owner, who approves from the run's chat or the task page. **Always allow for this task** still applies. The gate now uses the same resolver, so every mode above applies to scheduled runs too. |

The loop policy `interactions.headlessFallback` decides the no-person case for the shared seam:
`deny` refuses the call, `park` parks it only where something can park it (a node with approver
groups) and refuses otherwise, `fail` ends the run with an error.

Calls nobody's model decided on are not gated: a workflow **tool node** (the author chose the
call) and admin tools such as building agent memory from a tool.

## MCP App views

An MCP App view in the chat can call its own server's tools (`tools/call`). Whether such a call is
gated is resolved as for a model's call in the same app, the app's own overrides included (keyed by
the tool's iHub id, e.g. `<server>__<tool>`). A gated tool waits for the user's approval like a
model's call: the view shows nothing, the chat shows the approval card
below the view (no "allow for this chat" there), and the view's call waits for the decision. One
call of a view waits at a time: a second gated call while the card is shown is refused. On
**Approve** the server runs the stored call with the arguments shown on the card and returns the
result to the view; **Reject** or expiry returns a tool error to the view (`USER_REJECTED`,
`APPROVAL_EXPIRED`). A host that cannot show the card gets `APPROVAL_REQUIRED_NO_USER`.

API: `POST /api/mcp-apps/tools/call` with `chatId` and `toolApprovalCapable: true` answers
`202 { awaitingApproval: true, interaction }` for a gated tool; the host sends the decision with
`POST /api/mcp-apps/tools/call/approval` `{ appId, toolId, interactionId, decision }`, whose answer
is the view's `tools/call` result. Answered exactly once.

## Who a workflow acts as after an answer

A workflow or agent run resumed after a person answered a `human` node, a question or a tool
approval continues as the principal it started with — the user who started it, or the agent's
service account — never as the person who answered: an approver group can hold many people. Who
answered is documented on the answer (`answer.approver`: id, display name only when the run ledger records full
identities (`identityMode: full`), `via` = `approverGroups` | `admin` | `owner`, the approver groups that matched) and
in the execution's answer log. A run started before this release records no principal and cannot
be resumed after an answer (`EXECUTION_PRINCIPAL_UNKNOWN`): start it again.

## For developers

- Resolver: `server/utils/toolApproval.js` (`resolveToolApproval`, stamped on every tool in
  `getToolsForApp`). Shared vocabulary: `shared/toolApproval.js`.
- Seam: `server/services/loop/seams/approvalSeam.js`, registered first in the chat turn, workflow
  nodes and scheduled runs, before the seams that announce (`tool/started`) or run a call.
- Chat continuation: `server/services/chat/chatToolApproval.js`. The stored chat transcript holds
  only text, so the paused turn's tool calls and results are kept on the chat document
  (`toolApproval.pending`, bounded, never sent to clients) until the approval is answered. The
  pause also keeps what the turn had used so far (`pending.basis`: its knowledge sources, the
  connected systems by name and the projects it read), so the answer after the approval names the
  whole turn as its basis (`run/ended.answerBasis`, see
  [Answer Sources](answer-sources.md#what-users-see)).
- Chat API: answer an approval by posting the next message with
  `approvalResponse: { interactionId, decision: 'approve' | 'reject', grant?: 'chat' }`, and send
  `toolApprovalCapable: true` with every request from a client that draws the card. A chat
  approval cannot be answered through `POST /api/runs/:runId/interactions/:id/answer` (409
  `ANSWER_IN_CHAT`): only the chat runs the approved call.
- Admin API: `PUT /api/admin/integrations/installed/:id/approval` with
  `{ approval: { default?, actions?, newOrChanged? } | null }` changes only an installation's
  approval (and takes the fingerprint baseline when there is none yet).
  `POST /api/admin/integrations/installed/:id/actions/review` with `{ actions?: string[] }` marks
  those actions (all when absent) as reviewed. `GET /api/admin/integrations/installed/:id`
  returns `review: "new" | "changed" | null` per action.
- Fingerprints: `server/utils/actionFingerprint.js` (canonical schema, `actionFingerprint`,
  `actionReviewState`); compared where discovery results pass through,
  `server/services/integrations/actionReview.js`. Integration tools carry their fingerprint as
  `_integration.fingerprint`.
- Upgrading: there is no approval configuration to carry over. Tool approval ships in the same
  release as installed integrations, so an MCP server's or integration's approval has been stored
  on its installation from the start, and a tool file keeps its own `approval`.
