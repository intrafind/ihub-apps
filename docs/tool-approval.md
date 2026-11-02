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
other tool is `internal` unless its tool file says otherwise.

## Where it is configured and who wins

Several places can set a mode. **The strictest one wins.** Admin settings are the floor; an app
can only tighten them, never loosen them (a looser app value is ignored and logged).

| # | Layer                    | Where                                                                                         | Set by |
| - | ------------------------ | --------------------------------------------------------------------------------------------- | ------ |
| 1 | Platform default         | `platform.json` → `toolApproval.defaults.internal` / `.external`, else `.default`. **Admin → Security → Tool approval** | Admin |
| 2 | Tool file                | `contents/tools/<id>.json` → `approval` (per function, else the tool's). `requiresApproval: true` counts as `always`. **Admin → Tools → Edit → Approval** | Admin |
| 2 | Installation default     | `integrations.json` → `installed[].approval.default`. **Admin → Integrations → an installation → Overview** | Admin |
| 3 | Installation action      | `installed[].approval.actions[<action name>]`, keyed by the action's own name (an MCP tool's name, never the prefixed tool id) | Admin |
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

There is no persistent "always allow" per user, and the arguments cannot be edited before
approving. Both may come later.

## Where nobody can approve

| Surface                                                                  | Behaviour |
| ------------------------------------------------------------------------ | --------- |
| Inference API (OpenAI-compatible), app-as-tool, MCP gateway, A2A gateway | The call is refused with the tool result `APPROVAL_REQUIRED_NO_USER`; the model carries on. |
| A client that does not draw the card (an integration posting to the chat API without `toolApprovalCapable: true`, or a chat request without an open stream) | Same: `APPROVAL_REQUIRED_NO_USER`. |
| Workflow and agent nodes                                                 | Refused, unless the node names approver groups (`config.toolApproval.approverGroups`). Then the approval is parked for them in **Admin → Agents → Approvals**, and the node continues with the stored call once a member approves (or with `USER_REJECTED`). |
| Scheduled tasks                                                          | Unchanged flow: the run pauses for the task owner, who approves from the run's chat or the task page. **Always allow for this task** still applies. The gate now uses the same resolver, so every mode above applies to scheduled runs too. |

The loop policy `interactions.headlessFallback` decides the no-person case for the shared seam:
`deny` refuses the call, `park` parks it only where something can park it (a node with approver
groups) and refuses otherwise, `fail` ends the run with an error.

Calls nobody's model decided on are not gated: a workflow **tool node** (the author chose the
call), a direct `POST /api/tools/:id` (the user chose it), and admin tools such as building agent
memory from a tool.

## For developers

- Resolver: `server/utils/toolApproval.js` (`resolveToolApproval`, stamped on every tool in
  `getToolsForApp`). Shared vocabulary: `shared/toolApproval.js`.
- Seam: `server/services/loop/seams/approvalSeam.js`, registered first in the chat turn, workflow
  nodes and scheduled runs, before the seams that announce (`tool/started`) or run a call.
- Chat continuation: `server/services/chat/chatToolApproval.js`. The stored chat transcript holds
  only text, so the paused turn's tool calls and results are kept on the chat document
  (`toolApproval.pending`, bounded, never sent to clients) until the approval is answered.
- Chat API: answer an approval by posting the next message with
  `approvalResponse: { interactionId, decision: 'approve' | 'reject', grant?: 'chat' }`, and send
  `toolApprovalCapable: true` with every request from a client that draws the card. A chat
  approval cannot be answered through `POST /api/runs/:runId/interactions/:id/answer` (409
  `ANSWER_IN_CHAT`): only the chat runs the approved call.
- Admin API: `PUT /api/admin/integrations/installed/:id/approval` with
  `{ approval: { default?, actions? } | null }` changes only an installation's approval.
