# Features — 5.5.0

## Outlook Add-in: Reliable Email and Attachment Sync

The Outlook task pane now follows the selected email reliably. Previously, switching emails could
leave the previous email's attachments in the context strip — shown as failed ("not part of this
mail") — while the new email's attachments never appeared, and using "Add email(s)" could freeze
the pane on the old email entirely. Both required closing and reopening the add-in.

- Switching emails always loads the new email's subject, body, and attachments; a read that
  overlaps a quick switch is retried against the newly selected email instead of showing stale data.
- "Add email(s)" no longer freezes the pane: the pinned email is captured without disturbing the
  live Outlook selection, so the context strip keeps updating as you move between emails.
- Attachment reads are far less chatty with the Outlook host, improving task-pane responsiveness
  on emails with large attachments.

## Ephemeral Chat Is Now a First-Class Toggle

Ephemeral (never-stored) chat moves out of the settings dialog and becomes a ghost-icon toggle
directly below the chat input, next to the send button — working like a browser's incognito mode.

- While active, the chat input is highlighted in violet and a notice states that messages are not
  saved and disappear when leaving or reloading — so users always know the conversation is private.
- Behavior is unchanged: ephemeral chats are never written to browser storage and no iAssistant
  conversation ID is persisted.
- The app-level configuration is the same: `ephemeral: true` presets the toggle, and
  `settings.ephemeral.enabled: false` hides it.
## PowerPoint Files Are Now Read Properly (and Binary Files Rejected)

Uploaded or email-attached PowerPoint decks are now converted to real slide text before being sent
to the model. Previously `.pptx` files had no text extractor, so the raw file container was sent as
unreadable characters — a single deck could silently flood the model's entire context window and
fail the request with a context-size error.

- `.pptx` content arrives at the model as clean, slide-numbered text.
- Legacy binary `.ppt` files (and other unreadable binary formats) are rejected with an
  "unsupported format" message instead of being sent as garbage.

## Outlook Add-in: Token Estimate Now Counts Attachments

The context-usage indicator under the chat input now includes the extracted text of email
attachments (from the open email and all pinned emails). Previously only the typed message and
email bodies were counted, so the indicator could show a few thousand tokens while the actual
request was far above the model's context window.

## Answer-Source Badge Fixed for Apps with Tools

Answers based on email content or uploaded files now show the correct "Based on email content" /
"Based on uploaded file" badge in apps that have tools enabled. Previously these apps always
reported "Based on AI knowledge" because the source tracking was lost in the tool-execution path.

## Answer-Source Badge No Longer Drops to "AI Knowledge" on Non-Standard Completions

The "Based on uploaded file / email content" badge is now emitted on every way a chat turn can
finish, not just the clean streaming completion. Previously the badge was attached only when the
model stream ended with an explicit completion signal, so answers that finished another way — a
dropped/closed connection, a streaming ("passthrough") tool, or a run that hit the tool-iteration
limit — silently fell back to "Based on AI knowledge" even though a file or email was in context.

- Applies to both the standard chat path and apps with tools enabled.
- Source attribution is also cleared reliably at the end of each turn, so a later message in the
  same conversation can no longer inherit a stale badge.

## Uploaded Documents Are Used by Prompt-Template Apps (e.g. Summarizer)

Apps whose prompt contains a `{{content}}` placeholder (Summarizer, NDA analyzer, and similar) now
correctly summarize/analyze an uploaded document. Previously the placeholder was filled only with
the text typed into the message box — so when a user uploaded a file without typing anything, the
model was told to work on empty content while the document sat disconnected above the instruction,
producing generic "there is nothing to summarize" style answers.

- Uploaded document text is now folded into `{{content}}` (before any typed text), so the
  instruction references the actual document.
- Works with a single document, multiple documents, and mixed uploads (text documents are placed in
  the prompt while image-based pages are still attached as images).
- The document is never duplicated in the request, and the "Based on uploaded file" badge continues
  to appear.
