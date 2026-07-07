# Features — 5.5.0

## iHub Support Bot Can Now Answer Questions About the Platform

The bundled **iHub Support Bot** app now references the built-in iHub Documentation source, so it
can look up and cite the full platform documentation on demand instead of only the short FAQ.

- The documentation is exposed as a tool the model calls on demand, so ordinary questions are not
  slowed down by loading the full document.
- Existing installations receive the updated app configuration automatically on upgrade via the
  configuration migration system; no manual action is required.

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
- On error/aborted turns the badge is intentionally not shown, since the assistant bubble is an
  error message rather than a real answer.

## Answer-Source Badge Fixed When a Tool-Enabled App Answers an Upload Directly

Uploading a document or image to an app that has tools enabled, then getting an answer straight
away — the common "summarise this file" case where the model replies without calling a tool — now
shows the correct "Based on uploaded file" badge instead of "Based on AI knowledge". The badge was
attached on later tool-loop turns but not on this first, direct reply, so tool-enabled assistants
kept mislabeling upload-based answers.

- Covers document uploads, image uploads, and email context in tool-enabled apps.
- The detected source is also cleared when a turn instead pauses for a clarification question or
  ends in an error, so it can't carry over to the next message.

## Restrict Which Models an App Can Use

The App Editor now has an "Allowed Models" picker, so admins can limit a specific app to a chosen
set of AI models instead of only being able to set a single preferred one.

- Search and add models to the allow-list, same picker used for group and OAuth-client
  permissions; leave it empty to keep the app open to every available model.
- Users can no longer pick or be switched to a model outside the app's allow-list — chat requests
  fall back to a compatible model automatically.
  
## Group Management: Admin Lockout Prevention

The admin Groups API's protected-group list previously checked for `admin`/`user`, but the
built-in groups are shipped as `admins`/`users`. This meant the real administrator group could be
deleted, or have its administrative access removed via an update, silently locking every admin out
of the platform until `groups.json` was hand-edited.

- Deleting or updating a group is now blocked whenever it would leave the platform with zero
  groups granting administrative access, in addition to the built-in `admins`, `users`,
  `anonymous`, and `authenticated` groups remaining non-deletable.
- The group create/update endpoints now also accept the documented `inherits` field.
