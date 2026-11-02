# Tool approval (#2945): implementation notes

**Date:** 2026-11-02
**Status:** Implemented (draft PR)
**Issue:** [intrafind/ihub-apps#2945](https://github.com/intrafind/ihub-apps/issues/2945) · follow-up [#2916](https://github.com/intrafind/ihub-apps/issues/2916)
**User docs:** [docs/tool-approval.md](../../docs/tool-approval.md)

These notes are for whoever continues this work (most likely #2916). They say where things are,
why they are shaped the way they are, and what is deliberately left out.

## The decisions this builds on (2026-10-22)

1. Opt-in: nothing is asked until an admin sets a mode.
2. Grants per call and per chat. No persistent per-user "always allow".
3. No editing of arguments before approving.
4. Admin config is the floor; an app can only tighten.
5. No human attached: deny, unless a workflow node names approver groups (then park).

## Where the pieces are

| Piece | File | Notes |
| --- | --- | --- |
| Vocabulary | `shared/toolApproval.js` | Modes, side effects, data flows, error codes, `needsApproval()`. Used by server and client. |
| Resolver | `server/utils/toolApproval.js` | `resolveToolApproval(toolDef, app, platform, { installation })`; `stampToolApproval` is called at the end of `getToolsForApp` (`server/toolLoader.js`). |
| Per-function flags | `server/configCache.js` → `expandToolFunctions` / `approvalFieldsOf` | Without this a function's `approval` was dropped. |
| MCP annotations | `server/services/mcp/McpServerConnection.js` (`_mcp.annotations`) | Read by the resolver as `sideEffectSource: 'annotation'` (untrusted). |
| Seam | `server/services/loop/seams/approvalSeam.js` | One seam for chat, workflow nodes and scheduled runs. Must be the first seam. |
| Loop resume | `server/services/loop/AgentLoop.js` (`request.resume`) | Runs the approved call through `_executeOne` before the first model call. |
| Chat | `server/services/chat/chatSeams.js` (`chatApprovalOptions`), `chatToolApproval.js`, `ChatService.runTurn` (`approvalGate`, `toolApproval`, `canApproveTools`) | |
| Chat route | `server/routes/chat/sessionRoutes.js` (`settleChatApprovals`), `server/validators/index.js` (`toolApprovalCapable`) | |
| Workflows | `PromptNodeExecutor._approvalSeamOptions`, `questionPause.js` (`buildToolApprovalCheckpoint`, `resumeApprovalPlan`), `checkpointResume.js` (`resumeToolApproval`) | Node config `toolApproval.approverGroups` (workflow schema). |
| Scheduled runs | `server/services/scheduler/tasks/runSeams.js` | `scheduledRunSeams` returns `{ approvalGate, seams }`; the gate is the shared seam. |
| MCP gateway | `server/services/mcp/McpServerService.js` (`gatewayCallNeedsApproval`) | Refuses gated tools. |
| Config | `integrationsConfigSchema.js` (`approval`), `appConfigSchema.js` (`toolApproval`), `platformConfigSchema.js` (`toolApproval`), `routes/admin/configs.js` (merge + validation) | No migration: every field is optional and absent means `never`. |
| Admin API | `PUT /api/admin/integrations/installed/:id/approval` | Changes only `approval`. |
| Definition migrations | `migrationPlanner.js` | `renameAction` / `removeAction` carry `approval.actions` along. |
| Client | `ApprovalCard.jsx`, `runToMessage.js` (`buildToolApproval`), `useAppChat.js` (`submitToolApproval`, `toolApprovals` option), `AppChat.jsx`, admin: `ToolApprovalFields.jsx`, `ToolApprovalConfig.jsx` (Security), `AdminInstallationPage.jsx` + `installationApproval.js`, `ToolFormEditor.jsx`, `ToolsConfigSection.jsx` | |

## Spike: how the paused chat turn continues

The plan's slice 0 asked how persisted chat history swaps the `awaiting_approval` tool message for
the real result. The answer: **it does not have to, because the stored transcript never holds
tool messages.** `historyForPrompt` (sessionRoutes) builds the prompt from stored `role` +
`content` only; tool calls and tool results live only in the loop's in-memory messages and in the
run ledger (previews). A paused turn stores no assistant message at all (`pausedWithoutAnswer` in
`chatMaterializer.js`).

So the paused turn's tool part (its assistant tool-call messages, sibling results and the
placeholder) is kept on the **chat document** as `toolApproval.pending.transcript` — bounded
(16 KB per message, 192 KB total, pictures dropped) and stripped from every chat response
(`publicChatView`). The continuation turn builds its prompt as usual, drops the decision message
("Approved: …") and appends that transcript (`continuationMessages`). The loop then runs the
approved call (`resume`) and replaces the placeholder in place. On the next turn the stored
history is text again, exactly as before.

## Why things are the way they are

- **The server runs the stored call** (pre-mortem #1). The arguments come from the interaction's
  `displayData.args` — what the person saw — not from the model's message. The seam lets exactly
  that call id with exactly those arguments through (`sameArgs`).
- **Exactly once** (pre-mortem #8). `InteractionService.answer` is the compare-and-set. A second
  answer gets `NOT_PENDING` / `ANSWER_IN_PROGRESS` and the route answers 409
  `APPROVAL_ALREADY_ANSWERED` without running a turn.
- **Annotations never relax a gate** (pre-mortem #3). Only `sideEffectSource: 'annotation'` is
  untrusted. An admin confirms a read with `actions.overrides[action].sideEffect`.
- **Strictest wins everywhere**, including action vs. installation default. This keeps the rule
  one sentence long; the action select therefore only offers "as the integration", "ask unless it
  only reads" and "always".
- **Clients opt in to the card** with `toolApprovalCapable: true`. Office, canvas, compare and other
  surfaces that do not pass the handler are headless for approvals (pre-mortem #10).
- **The generic answer endpoint refuses chat approvals** (409 `ANSWER_IN_CHAT`): answered there,
  nothing would run the call.
- **`runTool` callers are listed in a test** (`server/tests/loop/approvalSeam.test.js`, pre-mortem
  #4). A new direct caller fails it until it is listed with its reason.

## Left for later

- **#2916:** fingerprints and `approval.newOrChanged`, the "changed" badge, the install wizard
  preselecting a mode, per-action controls on the Actions tab / action detail (#2974). The
  `approval: { default, actions }` shape on installations is the one #2916 describes; it only adds
  fields.
- Taint-based gating (ask only when the chat holds internal source data).
- Editing arguments before approving (needs schema re-validation).
- A persistent per-user "always allow".
- Restoring a pending approval card after a page reload (the chat document already carries
  `toolApproval.pending.interactionId`; the client does not read it yet — the same is true for
  clarifications today).
- An axe scan of the card in `tests/e2e/accessibility.spec.js` needs a scripted chat stream; the
  card's labels and focus are covered by `tests/unit/client/tool-approval-card.test.jsx`.
