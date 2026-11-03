# 01 — Client-Executed Tools

**Phase:** P1 (together with [02](02-chat-approval-gate.md))
**Parent:** [README](README.md)

## Problem

Every tool runs in the server's agent loop today. Office.js runs only in the task pane, so a tool such as "read the draft" or "replace the selection" can only be executed there.

The closest mechanism today is `ask_user`, and it does not fit. It ends the run with `run/paused`, and the answer starts a **new** run (`server/services/chat/chatClarificationLifecycle.js`). That breaks "read draft → rewrite → set subject" into separate turns and loses the model's working state.

## Design

A tool can declare that the **client** executes it. The loop hands the call to the client, waits in the same run for the result, and continues.

```
model ──tool_call──▶ AgentLoop._executeOne
                      └─ preTool seams
                          └─ clientToolSeam  (handles calls with executor:"client")
                              1. interactionService.raise({ kind:'client_tool', … })
                              2. emit interaction/raised + tool/started{execution:'client'}
                              3. await waitForAnswer(id) ⟂ ctx.signal ⟂ timeout
                              4. return { handled:true, message:{ role:'tool', … } }
pane  ◀──SSE── interaction/raised
pane  ── executes Office.js (directly, or through the pop-out bridge)
pane  ──POST /api/runs/:runId/interactions/:id/answer──▶ InteractionService.answer
                                                          └─ resolves the waiter (any worker)
```

### Building blocks (exist today)

| Piece | Where | Use |
|---|---|---|
| `preTool` seam contract | `server/services/loop/seams/index.js`, called from `AgentLoop._executeOne` (`server/services/loop/AgentLoop.js`) | A seam returning `{handled:true, message}` with no `terminate` lets the loop continue in the same run |
| Reference seam | `server/services/loop/seams/questionSeam.js` | Pattern for the new seam, including how it refuses on headless turns (`NO_USER_AVAILABLE`) |
| Seam list for chat | `ChatService.runTurn` (`server/services/chat/ChatService.js`, the `seams` array around `questionSeam(`) | Insert the new seam **before** `questionSeam` |
| One-at-a-time tool calls | `tools: { parallel: false }` in `ChatService.runTurn` | No concurrent Office calls within a turn |
| In-run wait | `InteractionService.waitForAnswer(id, { timeoutMs })` (`server/services/loop/InteractionService.js`) | Rejects on cancel, expiry or run deletion; resolved across workers by `_applyRemote` over `interaction:mutation` |
| Answer endpoint | `POST /api/runs/:runId/interactions/:interactionId/answer` (`server/routes/runs.js`), client `answerInteraction()` (`client/src/api/endpoints/runs.js`) | Reused; no new route |
| Abort | `ctx.signal`; `server/services/chat/abortCause.js` | Stop cancels the wait |

### Declaring a client tool

- Client tools are actions of a built-in **native integration per host**, such as `com.intrafind__outlook` (see [03](03-outlook-tools.md)). The integration lives under `server/defaults/integration-definitions/` and follows the pattern of `com.intrafind__ihub`.
- Each action carries `executor: "client"`, `host`, `mode` (`read` | `compose` | `document`), `sideEffect` and `approval` (`never` | `always`).
- **Schemas, titles and descriptions live on the server only.** The client never sends a schema.
- Add `executor`, `host`, `mode` and `approval` to `CARRIED_FLAGS` in `server/services/integrations/protocols/native/connectors/ihub/index.js`, or to the equivalent in a new host connector. They reach the resolved tool through `toolFromAction()` (`server/services/integrations/integrationTools.js`).
- `server/utils/toolDisplay.js` `toolDisplayOf` already takes `title` and `integration` from `_integration`. A client tool is `activityKind: 'tool'`.

### Offering a client tool

1. With each chat POST the pane sends a declaration of what it can execute right now:
   ```json
   "clientTools": { "host": "outlook", "target": { "itemId": "AAMk…" }, "mode": "compose", "tools": ["getDraftBody", "setDraftSubject"] }
   ```
   - `tools` comes from the host's registry filtered by `isRequirementSetSupported` (`client/src/features/office/utilities/officeCapabilities.js`) and by the current mode.
   - The server validates the object in `chatPostSchema` (`server/validators/index.js`): a known host, at most 100 names, each name matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`.
2. `getToolsForApp` (`server/toolLoader.js`) offers the **intersection** of three sets: the app's granted tools, the admin allowlist (`officeIntegration.hosts.<host>.tools`), and the names the client advertised.
   - A client tool survives `enabledTools` narrowing only while it is advertised. Extend `isInteractiveTool` (`server/utils/toolSelection.js`) or add a sibling check.
3. **Headless turns never get client tools.** These are `server/services/inference/appTurn.js`, `server/services/chat/appToolsGateway.js` and `ChatService.invokeAppInternal`. If a model calls one anyway, the seam returns an error result, mirroring `questionSeam`.

### The round trip

`clientToolSeam.preTool(ctx, info)` handles a call when `toolDef.executor === 'client'`. Ordering inside the seam matters: the `interaction/raised` frame must reach the client before the wait starts, or a fast client could answer an interaction it has not been told about.

1. Refuse the call (return an error result) when the turn is headless or the tool was not advertised.
2. Raise the interaction with the **stored** prompt, in which content-marked arguments are already redacted:
   ```js
   const interaction = await interactionService.raise({
     runId, kind: 'client_tool', origin: 'tool',
     prompt: { tool: name, args: redactClientToolArgs(toolDef, args), target },
     source: { chatId, toolCallId, host },
     policy: { timeoutMs: 60_000 }
   })
   ```
   `raise()` persists the prompt and appends the `interaction/raised` ledger entry, so it must never see raw content.
3. Emit the live `interaction/raised` SSE frame and `tool/started` with `execution: 'client'`. The live frame carries the stored prompt plus `liveArgs`, the full arguments the pane needs to execute. `liveArgs` exists only in that frame and in the waiting seam's memory. It is not written to the ledger, the interaction store or the replay buffer. A pane that reconnects after the frame was sent cannot recover `liveArgs`, so the call ends with `ClientTimeout` and the model may call the tool again.
4. `await` the first of three: `waitForAnswer(id, { timeoutMs })`, `ctx.signal`, or the timeout.
5. Validate the answer: it must be `{ ok: true, result }` or `{ ok: false, error: { name, code, message } }`, and the result size is capped.

   **Error envelope.** Every error, from the pane or the seam, uses the same envelope with all three keys present: `name` (string), `code` (string, number or `null`) and `message` (string). Our own errors use `code: null`. Office.js errors pass their `code` through.
6. Return `{ handled: true, execution: 'client', message: { role: 'tool', tool_call_id, name, content } }`.

The loop then writes `tool/result`, runs `postTool` and continues.

### Executing in the pane

- `useAppChat` (`client/src/features/chat/hooks/useAppChat.js`) already folds `interaction/raised` through `reduceRunEvent` (`shared/run/runReducer.js`). The Office chat adds a handler. It runs only for `kind === 'client_tool'` and only when the current host is the embedded host.
- The handler calls `host.executeClientTool(name, liveArgs)` from `EmbeddedHostContext`, then answers through `answerInteraction(runId, id, { decision: 'respond', data: { ok, result } }, { channel: 'office' })`, or with `{ ok: false, error }` on failure.
- **Pop-out window.** The handler calls `getOfficeRemote().call('runClientTool', { name, args })`. Register a generic `runClientTool` handler next to the existing ones in `client/src/features/office/utilities/officePopout.js`. `client/src/features/office/utilities/officePopoutBridge.js` already chunks large payloads.
- **Target check.** Before every call, and again right before any write, the executor checks that the target is still the one the turn advertised. On a mismatch it answers `{ ok:false, error:{ name:'TargetChanged', code:null, message:'The open item or document changed.' } }` and changes nothing.

  | Host | Advertised `target` | Check before a write |
  |---|---|---|
  | Outlook | `itemId` | `getLiveItemId()` (`outlookMailContext.js`) equals `itemId` |
  | Word, Excel, PowerPoint | `documentId`: `Office.context.document.url`, or a per-pane session id for an unsaved file | Each task-pane instance belongs to one document window, so the document cannot change under it. The check still compares `documentId`, so a stale answer from a closed and reopened pane is refused. |
  | Excel (additionally) | the sheet and address named in the call's arguments | Writes name `sheet` + `address` explicitly and never use "the active selection" implicitly. The executor resolves the range by name, so switching sheets during an approval cannot redirect the write. |
  | PowerPoint (additionally) | the `slideId` named in the call's arguments | Writes name `slideId`; the executor verifies the shape belongs to that slide ([07](07-powerpoint.md)). |

- **No Office API.** A browser tab without Office answers `{ ok:false, error:{ name:'HostUnavailable', code:null, message:'Office is not available.' } }`.

### Protocol changes

| File | Change |
|---|---|
| `shared/runEvents.js` | Add `'client_tool'` to `INTERACTION_KINDS` |
| `server/services/loop/contracts/interaction.js` | Schema for the `client_tool` prompt `{tool, args, target}` (args already redacted) and answer `{ok}` with either `result` or the error envelope |
| `server/services/loop/contracts/sseV2.js` | Add `'client'` to the `tool/started.execution` enum |
| `server/services/loop/contracts/runLogEvents.js` | Same enum |
| `shared/run/runReducer.js`, `shared/run/toolActivity.js` | Show `execution:'client'` rows in the activity list. Today rows that are not `'server'` are hidden. |
| `server/services/chat/chatSeams.js` (`chatToolSeam`) | Derive `execution:'client'` from the tool flag |
| `server/services/chat/chatClarificationLifecycle.js` | `isChatClarification` must return `false` for `kind:'client_tool'`; otherwise its listener ends the run that is waiting |

### Failure modes

Every failure becomes a **tool error result** that the model sees. None of them hangs the run.

| Situation | Result |
|---|---|
| Pane closed, or unpinned and the selection changed | Timeout after 60 s → `error:{ name:'ClientTimeout', code:null, message }`; the interaction is cancelled |
| Item, document, sheet or slide changed since the turn started | `error:{ name:'TargetChanged', code:null, message }`; nothing is written |
| User pressed Stop | The wait rejects with `ctx.signal`; the interaction is cancelled; the run ends `aborted` |
| Office.js rejected the call | `error:{ name, code, message }` from Office.js. The same record goes to the pane's `ihubOfficeErrors()` log. |
| Run's wall clock (`DURABLE_TURN_WALL_CLOCK_MS`) exceeded | Existing deadline handling |
| Answer posted to another worker | Resolved by `_applyRemote`. No special handling. |

### Redaction (what is stored)

The model gets the full result. **What is guaranteed:** tool results are never stored, and arguments marked `x-ihub-content` are never stored at any size. **What is not:** unmarked, structural arguments are stored in full, even when the model took their value from the item.

Arguments are written by the model, but a body or a cell value is often copied straight from the email or document. Size says nothing about that. A tool's schema therefore marks every argument that can carry user content with `"x-ihub-content": true`, for example `body`, `html`, `text`, `subject`, `values`, `formulas`, `notes`, `expectedText`, `filename`. Those arguments are redacted **whatever their size**.

Unmarked arguments are structural and kept for the audit trail: `address`, `sheet`, `slideId`, `shapeId`, `mode` and recipient addresses. A recipient address the model copied from the email is therefore stored, which is deliberate, since the audit must show who was added. A tool author who adds a free-text argument must mark it; a test lists every string argument of every client tool and fails on one that is neither marked nor on the structural allowlist.

| Store | Today | With client tools |
|---|---|---|
| Ledger `tool/call` args | full | content-marked args → `{chars, sha256}` at any size; structural args in full |
| Stored `client_tool` and `approval` interactions, ledger `interaction/raised` | full prompt | the redacted prompt only; full args live only in the SSE frame |
| Ledger `tool/result` preview, spill store | 1 KB preview / spill | `{redacted:true, host, chars}`; never spilled |
| `logInteraction('tool_usage')` (`chatSeams.js`) | `toolOutput: rawResult` | `{redacted:true, host, chars}` |
| Ledger `interaction/answered` | full answer | `{ok, chars, sha256}` |
| Stored chat `activity` (`server/services/chat/runActivity.js` `slim`) | title, status | unchanged (title and status only) |

The seam controls `handled.message`, and `postTool` may rewrite `outcome.rawResult`. Redaction therefore lives in one helper, `redactClientToolOutcome()`, which both use. A sibling, `redactClientToolArgs()`, is applied where `AgentLoop._executeOne` writes the ledger `tool/call` entry for a handled call.

The same marker drives the approval preview ([02](02-chat-approval-gate.md)). The card shows the content to the user live, and the stored `approval` interaction keeps only `{chars, sha256}`.

## Tests

- **Seam unit tests:**
  - advertised vs not advertised
  - headless refusal
  - timeout
  - abort
  - error answer
  - oversized answer
- **Cluster:** raise on one `InteractionService` instance and answer on another. `server/tests/loop/interactionService.test.js` already covers `waitForAnswer`; extend it.
- **Contracts:** `execution:'client'` passes the `sseV2` and `runLogEvents` schemas.
- **Redaction:**
  - no tool output in the ledger, spill store, interaction log or stored chat
  - a **short** `setDraftBody` body copied from the email (under 100 characters) is still stored only as `{chars, sha256}`
  - neither the stored interaction nor the `interaction/raised` ledger entry contains the body; the live SSE frame does
  - every string argument of every client tool is either `x-ihub-content` or on the structural allowlist
  - every error answer carries `name`, `code` and `message`
- **Client:**
  - the interaction handler executes and answers
  - the pop-out routes through `runClientTool`
  - a mismatched Outlook item, document id, Excel sheet or PowerPoint slide is refused with `TargetChanged`, and nothing is written

## Acceptance criteria

- A chat turn that calls two client tools in sequence completes in **one** run with both results in the model context.
- Stop during a pending client tool ends the run within a second.
- Closing the pane yields a `ClientTimeout` tool result, not a stuck run.
- Grepping the run ledger and the interaction log for the test email's body finds nothing, even when the model copied a short sentence of it into a tool argument.
