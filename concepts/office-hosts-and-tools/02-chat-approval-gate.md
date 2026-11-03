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

- **Placement.** A `preTool` seam in `ChatService.runTurn`. It runs before the tool executor (for client tools, `clientToolExecutor` in [01](01-client-executed-tools.md)), so approval happens before the call reaches the client.
- **Decision.**
  1. `resolveToolApproval(toolDef, ctx)` returns `'never' | 'always'`. For a tool marked `approval: 'untracked'` it returns `never` only when `ctx.clientTools.state.trackChanges === 'tracked'`; a missing or invalid state yields `always` (fail closed).
  2. In this phase it reads the action's `approval` flag, the existing `requiresApproval` tool flag, and the admin list `officeIntegration.hosts.<host>.tools.requireApproval`.
  3. #2916 later replaces the function body with the integrations policy (`approval: never | writes | always`). Its signature stays the same.
- **On `'always'`:**
  1. `interactionService.raise({ kind:'approval', origin:'policy', prompt:{ tool, title, args, preview }, source:{ chatId, toolCallId } })`.
  2. Emit `interaction/raised`.
  3. `await waitForAnswer` (no fixed timeout beyond the run's wall clock), raced against `ctx.signal`.
- **Answers:**
  - `approve` → the seam returns nothing, so the call continues to the next seam and then the executor, and takes the loop's normal completion path.
  - `edit` → the call continues with `answer.data.args`, re-validated against the tool schema. Schema validation is not the only check. Every policy check that ran on the original arguments, such as the Outlook recipient-domain allowlist ([03](03-outlook-tools.md)), runs again on the edited ones. To make that structural, those checks live in `clientToolExecutor` ([01](01-client-executed-tools.md)), which runs **after** this seam and therefore always sees the final arguments.
  - `reject` → `{handled:true, message:{role:'tool', content:'{"declined":true,"reason":"user declined"}'}}`. The model sees the refusal and can explain itself or try differently. A declined call is the one case that uses the `handled` early return, and that is safe: nothing executed and no content was read, so there is nothing for `postTool` to redact. The seam emits `tool/completed` with `status: 'declined'` itself, so the activity row does not hang.
- **Headless.** Never approve automatically. Return an error result, exactly as `ask_user` does.
- **Preview.** `preview` is built per tool by an optional `previewApproval(args)` on the tool definition. Examples: the recipients to add, the subject, the first 2,000 characters of a new body, `n` cells at `A1:D20`. Without one, the args summary is shown.
  - The preview travels to the card in the live `interaction/raised` frame only.
  - The stored interaction and its ledger entries keep arguments marked `x-ihub-content` as `{chars, sha256}` ([01](01-client-executed-tools.md#redaction-what-is-stored)).
- **Cleanup.** `isChatClarification` must exclude `origin:'policy'` approvals, as in [01](01-client-executed-tools.md).

### Client: approval card

- `ToolApprovalCard`, a new component under `client/src/features/chat/components/`, is rendered by `ChatMessage` for a pending `approval` interaction of the current run.
- It shows the tool title, the integration label, the preview and the buttons **Allow**, **Allow and edit** (when the tool allows it) and **Decline**.
- It answers through `answerInteraction()` (`client/src/api/endpoints/runs.js`). No new route.
- **Accessibility: an inline, non-modal card, not a dialog.** The card sits in the message list like the existing `ClarificationCard`. While it waits the user must still be able to scroll the chat, read the email in the context strip and press **Stop**. A modal `alertdialog` would have to trap focus and block exactly that, so the card does not use that role.
  - `role="region"` with `aria-labelledby` pointing at the card title. An `aria-live="assertive"` announcement says "Approval needed: <tool title>" when it is raised.
  - When it is raised, focus moves to the card's heading, but only if focus is in the chat composer or on the page body. Focus is never pulled out of a field the user is typing in elsewhere.
  - After an answer, focus returns to the element that had it before the card took it, or to the composer if that element is gone. The card then collapses to a one-line status ("Allowed", "Declined").
  - All buttons are reachable with Tab, **Esc** does not decline (no accidental declines), and the buttons have visible focus rings. See the a11y-audit skill.
- It works in the web chat, the Office pane, the Office pop-out and the browser extension. All four render `ChatMessage`.
- All strings go through i18n (`shared/i18n/en.json`, `de.json`).

### Office pane fix (existing bug)

`client/src/features/office/components/OfficeChatPanel.jsx` renders `ChatMessageList` without `onClarificationSubmit`. Only `client/src/features/apps/pages/AppChat.jsx` wires it. As a result, an `ask_user` card renders in the pane but its answer is dropped.

Wire `onClarificationSubmit` (via `submitClarificationResponse` from `useAppChat`) and the approval answer in `OfficeChatPanel`. Add a test.

## Tests

- **Seam tests:**
  - never vs always
  - approve, edit (re-validated) and reject
  - edit that introduces a value a policy check forbids (a recipient outside the allowlist) is refused before execution
  - headless refusal
  - Stop while waiting
  - answer on another worker
- **Client:**
  - the card renders from `interaction/raised`
  - each button posts the right decision
  - focus handling: focus moves to the card only from the composer or body, returns to the previous element (or the composer) after an answer, and is never trapped. Tab reaches the chat and **Stop** while the card is open.
  - the live-region announcement fires once per raised approval
- **Pane:** an `ask_user` answer in `OfficeChatPanel` reaches the server.
- **Accessibility:** the axe baseline in `tests/e2e/accessibility.spec.js` covers the card.

## Acceptance criteria

- A tool marked `approval:'always'` never executes before the user allows it, in any chat surface.
- Decline yields a tool result the model can react to, and the run continues.
- An `ask_user` question can be answered in the Outlook pane.
