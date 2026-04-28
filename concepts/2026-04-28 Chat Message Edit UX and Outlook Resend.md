# Chat Message Edit UX & Outlook Resend

**Date:** 2026-04-28
**Issues:** [#1343 (Outlook editing)](https://github.com/intrafind/ihub-apps/issues/1343), [#1344 (Improve editing UX)](https://github.com/intrafind/ihub-apps/issues/1344)
**Status:** Proposed / Implementing

## Problem

Two related shortcomings around editing previously sent user messages in the chat interface:

1. **Outlook taskpane has no edit/resend.** A user who realises their prompt was off has to type the whole prompt from scratch in a small input. The web UI has had inline edit-and-resend for a while; the Outlook integration explicitly disables it (`editable={false}`).
2. **Web edit UX is cramped.** When the user clicks the pencil on a sent message, the bubble turns into a small `textarea` with `rows={Math.max(3, lines)}`, no autosize, no keyboard shortcuts and no hint that "Save" actually re-runs the prompt. For long prompts (the common case) this is awkward.

## Goals

- Editing a sent message in the **web UI** should feel like editing a draft in a real editor: the textarea grows with content, the bubble width is preserved, and saving makes it obvious the prompt is being re-run.
- Editing should also work in the **Outlook taskpane**, with the same component and the same UX, tuned for the narrow panel width.
- No backend changes; no new endpoints. Edit remains a local-only conversation rewrite (truncate → resend).

## Best practices reviewed

| Product       | Pencil affordance | Editor                                                      | Submit                                  | Cancel | Branching                                  |
| ------------- | ----------------- | ----------------------------------------------------------- | --------------------------------------- | ------ | ------------------------------------------ |
| ChatGPT       | Hover icon        | Inline autosize textarea, full bubble width                 | "Send" button + ⌘/Ctrl+Enter            | Esc    | Yes (versions, ⟨ 2/3 ⟩)                    |
| Claude.ai     | Hover icon        | Inline autosize textarea                                    | "Save & Submit"                         | Esc    | Truncates                                  |
| Gemini        | Pencil            | Inline editor                                               | "Update"                                | Esc    | Truncates                                  |
| Copilot Chat  | Pencil            | Inline editor                                               | "Send"                                  | Esc    | Truncates                                  |

**Common ground we'll adopt:**

- Autosizing textarea with a generous min-height and a soft max-height that scrolls.
- Editor occupies the full width of the message bubble (visual continuity, no jumping).
- Two buttons: **Cancel** and **Send** (relabelled from "Save" — what really happens is a re-run).
- Keyboard: `Esc` cancels, `⌘/Ctrl + Enter` submits. `Enter` alone inserts a newline (matches the main composer).
- "Send" is disabled when content is empty or unchanged (no-op) — a click on a no-op just exits edit mode.
- Hint footer with the keyboard shortcuts.
- Auto-focus the textarea on enter, place cursor at end.
- Consistent styling with the main `ChatInput` (rounded border, focus ring).

**Branching is out of scope.** iHub Apps already truncates the conversation on resend; introducing version navigation would touch persistence and the backend message store. We can revisit later.

## Design

### 1. Web UI — replace the inline edit textarea (Issue #1344)

Touched file: `client/src/features/chat/components/ChatMessage.jsx`

The current editor (lines 446-470) is replaced with an autosize editor that:

- Calls `requestAnimationFrame` to recalculate its `height` from `scrollHeight` whenever the text changes. Min height ≈ 4 lines (~96px), max ≈ 60vh capped at 480px. Above the cap it scrolls.
- Spans `w-full` of the bubble container (which is already `max-w-[80%]` of the message list).
- Auto-focuses on enter; cursor moves to the end of the existing text (typical edit affordance).
- Handles `Esc` (cancel) and `⌘/Ctrl + Enter` (submit) through `onKeyDown`.
- Renders a footer line that shows the shortcuts (and stays out of the way on mobile / narrow panes by hiding when the bubble is < 320 px or `compact` mode is active).
- Disables **Send** when the textarea is empty or identical to the original content. An empty/unchanged save just closes the editor — no resend, no truncation.
- Dispatches the existing `onEdit` + `onResend` flow unchanged. The 250 ms `setTimeout` workaround is preserved because `handleResendMessage` reads from `input` state.

Visual pass:

- Textarea: `rounded-lg border border-slate-300 focus:ring-2 focus:ring-indigo-500 px-3 py-2 bg-white text-slate-900` matching `ClarificationInput.jsx`.
- Buttons: keep the existing layout but bump the padding slightly (`px-3 py-1.5`) and add an icon on **Send** (`paper-airplane`).
- Cancel: outlined gray. Send: solid indigo.

### 2. Outlook taskpane — enable edit/resend (Issue #1343)

Touched files:

- `client/src/features/office/components/OfficeChatPanel.jsx` — wire up the handlers, remove `editable={false}`.
- The new `handleResend` calls `adapter.resendMessage(messageId, editedContent)` (already part of `useAppChat`) to truncate the conversation, then dispatches `submitMessage(content)` directly. Email context and uploads are picked up automatically, the same as a fresh send.
- `editMessage` from the adapter is wired to `onEdit`. No extra logic needed — it's the same local-state mutation as the web app.

Why we don't reuse `AppChat.handleResendMessage`'s pattern of dispatching a synthetic form `submit`: the Outlook panel orchestrates its own send flow through `submitMessage(text)` and doesn't need to round-trip through the DOM. A direct call is simpler and avoids the form lookup.

Compact tuning:

- The new editor in `ChatMessage` already adapts via the `compact` prop that `OfficeChatPanel` passes through (`compact={true}`). Compact mode hides the keyboard-shortcut footer (no room) and tightens button padding.
- Selectable text width is fine — the Outlook taskpane is `max-w-lg` (32 rem) so even a 60vh-tall editor stays usable.

### 3. Non-goals / future work

- **Branching / versions.** Out of scope. Would require persisting message variants and a navigator UI.
- **Server-side message rewrite.** Out of scope. The current truncate-and-resend model has no endpoint and we don't plan to add one in this change.
- **Multi-message edit.** Editing assistant messages is intentionally not added (would change conversation semantics).
- **Auto-save drafts of in-progress edits.** Worth considering later if users complain about losing work when they accidentally close the panel.

## Risks

- **Auto-resize loops.** Mitigated by setting `height = 'auto'` before reading `scrollHeight` and clamping at the max — the same pattern `ChatInput.jsx` already uses.
- **Pre-existing `setTimeout(..., 250)` race.** Left in place; refactoring it into a deterministic flow would touch `AppChat.handleResendMessage` and the form submit dispatch, which is broader than the issue calls for.
- **Outlook compose-mode quirks.** `useOutlookMailContextReader` already swallows errors when no item is selected, so editing/resending in compose mode behaves like a regular send.
- **i18n.** Three new keys (`chatMessage.editHint`, `chatMessage.send`, `chatMessage.editEmptyOrUnchanged`) added with English fallbacks. Translation team can fill the rest in a follow-up.

## Validation plan

- Manual smoke in web UI: edit a long markdown prompt, confirm the editor grows, ⌘+Enter resends, Esc cancels.
- Manual smoke in Outlook taskpane: send a prompt with the email body attached, edit it, confirm the email body still gets attached on resend.
- `npm run lint:fix` and `npm run format:fix`.
- Server start sanity check.
