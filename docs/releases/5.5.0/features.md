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

## Tools Are Now Managed as Individual Files

Tool configurations now live as individual JSON files under `contents/tools/`, matching how apps,
prompts, and models are already stored, instead of as entries in one shared `config/tools.json`
array. See [Breaking Changes](breaking-changes.md#configtoolsjson-is-removed) for the upgrade path.

- Creating, editing, toggling, or deleting a tool in the admin UI reads and writes its own file,
  making it easy to add or remove a single tool without touching the others.

## Outlook Add-in: Attached Emails and Meeting Invites Are Now Included

Forwarding an email or meeting invite as an attachment now actually sends its content to the
model. Previously these fetched successfully and showed as "attached" in the review banner, but
were silently dropped when the message was sent — the model never saw them and the user had no
indication anything was missing.

- Attached/forwarded emails (`.eml`) are parsed into their subject, sender, recipients, and body
  text.
- Meeting invites (`.ics`) are parsed into a short summary: subject, time, location, and organizer.
- OneDrive/SharePoint attachments (share links, not the file itself) now include the link as a
  reference instead of being dropped without a trace.
- Attachments larger than 20 MB are skipped up front instead of being downloaded into the task
  pane, which could previously stall the pane on a large attachment.
- On Outlook hosts older than Mailbox 1.8 (which can't fetch attachment content at all), the
  banner now shows one explanation instead of repeating the same error on every attachment.

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

## Fixed Cross-Chat Tool-Call Mixups Under Concurrent Load

Streaming tool calls for OpenAI-, Anthropic-, and vLLM/local-backed apps are now tracked per
conversation instead of in one shared bucket. Previously, two users streaming tool calls at the
same time — or a user whose stream was cancelled mid-flight — could have their pending tool-call
data overwritten or merged with another user's, occasionally causing a tool to run with the wrong
or corrupted arguments.

- Each conversation's in-flight tool-call data is now isolated by chat.
- A cancelled or errored stream can no longer leave stale tool-call data behind to be picked up by
  a later, unrelated conversation.

## Stellungnahmen (iFinder) Review Now Covers the Whole Corpus

The iFinder-backed **Stellungnahmen Review** workflow now analyses every matching document instead
of only the first 25 hits per search. Previously, when a search reported many more results than it
returned (e.g. 155 total but only the first 25 retrieved), the remaining documents were never
loaded or reviewed — so the audit report silently missed most of the corpus.

- Each search now pages through all of its hits, bounded only by an overall document ceiling
  (raised from 200 to 500).
- Existing installations are updated automatically on upgrade via the configuration migration
  system; no manual action is required.
- Corpus-search nodes in custom workflows can opt into this behaviour by setting `maxPerTopic: 0`
  (unlimited per query). A positive value keeps the previous top-N-per-query limit.
- Very large corpora may need a higher `maxTotalDocs` and, since each document is fetched and
  analysed individually, a longer `maxExecutionTime`.
  
## Workflows and Other Paths Now Work with OpenAI-Compatible Models

AI apps that run **workflows** with a model on the **OpenAI adapter** — including self-hosted
vLLM, LM Studio, and Jan.ai endpoints, and Mistral/Ministral models served over an
OpenAI-compatible URL — could fail with `Unsupported URL scheme: <model-id>` (for example
`Unsupported URL scheme: ministral`). The model's configured API URL was correct; the request was
being built before the model's endpoint had finished resolving, so the model's id leaked through as
the URL.

- Affected the workflow query-plan/agent steps, the OpenAI-compatible proxy endpoint, the session
  test-chat, OCR, and tool follow-up calls. The standard streaming chat path was not affected.
- No configuration change is required — existing OpenAI-adapter models work as configured.
- When a request URL genuinely cannot be resolved, the error now names the offending URL (with any
  embedded secrets redacted) so misconfiguration is easier to diagnose.

## Chat Exports Are Now Protected Against Spreadsheet Formula Injection

CSV and XLSX chat exports now neutralize cell values that would otherwise be interpreted as
formulas by Excel or LibreOffice. Chat transcripts can contain model output or pasted text a user
doesn't fully control, and a value beginning with `=`, `+`, `-`, or `@` (for example
`=HYPERLINK("http://evil","click")`) previously executed as a formula the moment the exported file
was opened.

- Affected cell values are now prefixed with a single quote before being written, which forces
  spreadsheet applications to render them as plain text.
- Applies to both the CSV and XLSX chat export formats; no configuration change is required.

## Admin Tool Script Paths Are Now Validated Against Traversal

The admin Tools API now validates a tool's `script` filename before reading, writing, or deleting
it on disk. Previously a crafted or hand-edited `script` value (e.g. `../../server/server.js`)
could make the read/update/delete script endpoints touch files outside `server/tools/`.

- Reading, updating, or deleting a tool's script now rejects any path that resolves outside
  `server/tools/`.
- Creating or updating a tool now rejects a `script` value that isn't a bare `<name>.js` filename.

## Marketplace Skill Installs Now Use a Stricter Directory Boundary Check

Installing a multi-file skill package from the marketplace now uses the same separator-aware
boundary check as other content installers, closing a gap where a companion filename could
resolve into a sibling directory that merely shared the skill's directory name as a prefix
(e.g. `foo-evil` next to `foo`).

- No admin action required; existing skill packages install exactly as before.

## Chat No Longer Crashes When a Response Finishes

Chat responses now complete cleanly instead of failing with an "Add-in Error" (`setSearchStatus is
not defined`) the moment the model finished answering. The crash surfaced in the Outlook add-in but
came from the shared chat used across the platform, so any app could be affected.

- Fixes the error thrown at the end of every response, so answers now display and finalize normally.
- Also fixes a related crash for iFinder-backed apps that emit a response message id (used for
  answer feedback), which previously interrupted the reply the same way.
- No configuration or admin action required.
