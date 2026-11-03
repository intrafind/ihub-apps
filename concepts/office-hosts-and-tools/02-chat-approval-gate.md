# 02 — Chat Approval Gate

**Phase:** P1 (together with [01](01-client-executed-tools.md))
**Parent:** [README](README.md)
**Related issues:** #2945 (configure which tools need approval), #2916 (approval policy per integration action)

## Problem

Some tools act on what the user is about to send:
- set a draft body
- add recipients
- attach a file
- replace text in a document
- overwrite cells

The content those tools read (an incoming email, a document) is attacker-controllable. A malicious email can tell the model to add a Bcc recipient and paste the thread into the draft. The user must confirm such calls before they run.

Chat has **no per-call approval** today. The only gate is for scheduled runs:
- `scheduledRunSeams` in `server/services/scheduler/tasks/runSeams.js`
- it pauses the run, and `taskService.js` resumes it as a continuation

The only approval UI is the workflow `HumanCheckpoint` (`ChatCheckpoint` in `client/src/features/chat/components/ChatMessage.jsx`).

## Design

### Server: `toolApprovalSeam`

- **Placement.** A `preTool` seam in `ChatService.runTurn`, placed **before** `clientToolSeam`, so approval happens before the call reaches the client.
- **Decision.**
  1. `resolveToolApproval(toolDef, ctx)` returns `'never' | 'always'`.
  2. In this phase it reads the action's `approval` flag, the existing `requiresApproval` tool flag, and the admin list `officeIntegration.hosts.<host>.tools.requireApproval`.
  3. #2916 later replaces the function body with the integrations policy (`approval: never | writes | always`). Its signature stays the same.
- **On `'always'`:**
  1. `interactionService.raise({ kind:'approval', origin:'policy', prompt:{ tool, title, args, preview }, source:{ chatId, toolCallId } })`.
  2. Emit `interaction/raised`.
  3. `await waitForAnswer` (no fixed timeout beyond the run's wall clock), raced against `ctx.signal`.
- **Answers:**
  - `approve` → the seam returns nothing, so the call continues to the next seam or executor.
  - `edit` → the call continues with `answer.data.args`, re-validated against the tool schema.
  - `reject` → `{handled:true, message:{role:'tool', content:'{"declined":true,"reason":"user declined"}'}}`. The model sees the refusal and can explain itself or try differently.
- **Headless.** Never approve automatically. Return an error result, exactly as `ask_user` does.
- **Preview.** `preview` is built per tool by an optional `previewApproval(args)` on the tool definition. Examples: the recipients to add, the subject, the first 2,000 characters of a new body, `n` cells at `A1:D20`. Without one, the args summary is shown.
- **Cleanup.** `isChatClarification` must exclude `origin:'policy'` approvals, as in [01](01-client-executed-tools.md).

### Client: approval card

- `ToolApprovalCard`, a new component under `client/src/features/chat/components/`, is rendered by `ChatMessage` for a pending `approval` interaction of the current run.
- It shows the tool title, the integration label, the preview and the buttons **Allow**, **Allow and edit** (when the tool allows it) and **Decline**.
- It answers through `answerInteraction()` (`client/src/api/endpoints/runs.js`). No new route.
- It is keyboard operable and announced (`role="alertdialog"`, focus moves to the card). See the a11y-audit skill.
- It works in the web chat, the Office pane, the Office pop-out and the browser extension. All four render `ChatMessage`.
- All strings go through i18n (`shared/i18n/en.json`, `de.json`).

### Office pane fix (existing bug)

`client/src/features/office/components/OfficeChatPanel.jsx` renders `ChatMessageList` without `onClarificationSubmit`. Only `client/src/features/apps/pages/AppChat.jsx` wires it. As a result, an `ask_user` card renders in the pane but its answer is dropped.

Wire `onClarificationSubmit` (via `submitClarificationResponse` from `useAppChat`) and the approval answer in `OfficeChatPanel`. Add a test.

## Tests

- **Seam tests:**
  - never vs always
  - approve, edit (re-validated) and reject
  - headless refusal
  - Stop while waiting
  - answer on another worker
- **Client:**
  - the card renders from `interaction/raised`
  - each button posts the right decision
  - focus handling
- **Pane:** an `ask_user` answer in `OfficeChatPanel` reaches the server.
- **Accessibility:** the axe baseline in `tests/e2e/accessibility.spec.js` covers the card.

## Acceptance criteria

- A tool marked `approval:'always'` never executes before the user allows it, in any chat surface.
- Decline yields a tool result the model can react to, and the run continues.
- An `ask_user` question can be answered in the Outlook pane.
