# Features — 5.5.0

## Agent Profile Editor No Longer Corrupts Shared State on Save

Fixed a bug in the Agent Profile admin editor where saving could corrupt data shared across the
page.

- Creating a new agent no longer strips fields (like planner/synthesizer system prompts) from the
  blank template used for subsequent "New Agent" sessions.
- If a save fails, the editor no longer mistakenly reports the form as "no unsaved changes,"
  preventing accidental loss of edits when navigating away.

## Native Web Search for Anthropic Claude Models (and a Cleaner Native Search Architecture)

Apps and agent workflows with web search enabled now use Claude's own built-in web search when the
selected model is an Anthropic model, instead of falling back to Brave Search — matching the
existing native-search behavior already available for Gemini and GPT models.

- When `websearch.useNativeSearch` is on (the default) and the app's model is an Anthropic Claude
  model, Claude searches the web itself and returns answers with citations in the same response.
- Search results and citations are surfaced through the same "Grounding" answer-source badge used
  for Google Search grounding, including in agent workflow synthesizer citations.
- Anthropic bills native web search separately per search, in addition to standard token costs.
- No configuration changes are required for existing apps that already have `websearch.enabled: true`.
- Agent workflow nodes that request `webSearch` now also get native search on whichever provider
  the node's model uses (previously this only worked reliably on Gemini). The bundled research
  workflows are migrated automatically to the provider-agnostic `webSearch` marker.
- Under the hood, native web search (Google, OpenAI, Anthropic) is no longer represented as a tool
  — `googleSearch` and `webSearch` are removed as tool files, and existing installations are
  migrated automatically. Only Brave Search remains a real, script-backed tool; native search is
  now resolved directly from the app/workflow configuration and passed straight to the model
  provider.

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

## Workflow Search and Quote-Validation Steps Now Use the Configured Model

The query-planning ("seed plan") and quote-validation steps in workflows now honor the same model
selection as every other step. Previously these steps silently ran on the platform's global default
model, ignoring both the model chosen in the chat/app and the workflow's own default — so a workflow
pinned to one model could still run parts of a run on a different one.

- Affects the corpus-search planning step (used by the Stellungnahmen / law-consultation review
  workflows) and the quote-validation step.
- Model precedence is now consistent across workflow steps: a per-step model wins, then the model
  selected in the chat/app, then the workflow's default model, then the global default.
- To pin a workflow step to a specific model regardless of the chat selection, set that step's model
  in the workflow editor; this now takes effect for the planning and quote-validation steps too.
- No configuration or admin action required; existing workflows pick up the corrected behavior
  automatically.
  
## App Editor No Longer Corrupts Numeric Fields When Cleared, and Supports HTML Output Format

Clearing a numeric field (Temperature, upload file-size limits, textarea rows) in the app editor
form previously left an invalid value in the saved configuration, which could cause the save to be
rejected by the server without a clear reason. The Output Format dropdown was also missing the
`html` option, so apps configured for HTML output silently displayed and re-saved as Markdown.

- Clearing a numeric field now omits it from the saved config instead of storing an invalid value.
- The Output Format dropdown now includes `HTML`, matching what the server already accepts.

## Usage Statistics No Longer Lose Events During Cleanup

The hourly usage-data retention cleanup could silently drop token-usage events that were flushed
to disk at the same moment cleanup ran, causing usage/billing numbers in the admin dashboard to
undercount without any error being logged.

- Cleanup and the periodic flush of pending usage events are now serialized so an in-flight flush
  can never be overwritten by a concurrent cleanup pass.
- Flush and cleanup failures are now actually logged instead of throwing an unrelated internal
  error that masked the real cause.
- No configuration or admin action required.

## Realtime Voice Input via Self-Hosted vLLM (Voxtral)

Apps can now use a new speech-to-text backend that streams microphone audio to the iHub
server, which proxies it to a self-hosted vLLM realtime endpoint (for example Voxtral) and
streams the transcription back live. Unlike the browser and Azure backends, the model URL
and any API key stay on the server and never reach the browser.

- Configure the endpoint under **Admin → Voice Input** (or `platform.json` → `speech.realtime`):
  `enabled`, `url`, `model`, optional `apiKey`; disabled by default.
- Enable it per app by setting the app's Speech Recognition Service to **vLLM Realtime**
  (`settings.speechRecognition.service: "vllm-realtime"`) — no per-app host needed.
- Supports both manual (push-to-talk) and automatic (stops when you pause) microphone modes,
  and works in browsers without the Web Speech API (including Firefox). Requires HTTPS or
  localhost for microphone access.
- **Resource guards** protect the GPU-backed upstream: the vLLM socket opens only once the
  browser sends its first audio frame (an abandoned connection never pins a session), idle and
  no-audio connections are closed automatically, and per-user / global concurrent-connection
  caps bound how many sessions can run at once. Tune them under `speech.realtime`:
  `maxConnections` (default 50), `maxConnectionsPerUser` (default 3), `maxFrameBytes`
  (default 256 KB).

## Admin Page for Voice Input (Speech-to-Text)

A new **Admin → Voice Input** page centralizes speech-to-text backend configuration, so
admins no longer need to edit `platform.json` by hand.

- **vLLM Realtime**: toggle, WebSocket URL, model, and an optional API key (stored encrypted
  at rest).
- **Azure Speech**: toggle, default host/endpoint, region, and the subscription key. The key is
  stored **encrypted at rest** on the server and exchanged for a short-lived authorization token
  per session (`/api/voice/azure/token`), so it never reaches the browser. Apps that select
  Azure without their own host fall back to the platform default host.
- The app editor's **Speech Recognition Service** dropdown now also lists Azure alongside the
  browser default, vLLM Realtime, and custom options.

> **Breaking change:** The Azure subscription key is no longer read from the
> `VITE_AZURE_SUBSCRIPTION_ID` build-time client env var (which baked the key into the browser
> bundle). Move the key into **Admin → Voice Input** (`platform.json` → `speech.azure.subscriptionKey`).
> Existing deployments that relied on the env var must set the key server-side for Azure to keep
> working.

## Tool-Enabled Chats No Longer Show a Duplicated Error or Hang When a Follow-Up Call Fails

When an app with tools enabled hit a provider error (for example a rate limit) on a follow-up
call after a tool ran, the error text could appear twice in the assistant bubble, and the chat
stream sometimes never closed cleanly. Both are fixed: the error is now reported once, and the
stream always ends with a proper terminal event.

- No admin action required.

## Auto-Send Links Now Survive Login and No Longer Leave a Stale Message Behind

Answer links built with the documented `?prefill={message}&send=true` pattern are now reliable in
two previously broken cases:

- **Already logged in:** once the message auto-sends, both `prefill` and `send` are now removed
  from the URL. Previously only `send` was removed, so a later reload of the same link
  re-populated the chat input with the already-sent message and left it looking unsent.
- **Logged out with SSO auto-redirect enabled:** the `prefill`/`send` parameters now survive the
  OIDC/NTLM login round trip instead of being dropped, so the message still auto-sends after
  signing in.

Applies to shared support/FAQ links, ticket-reply templates, and any other one-click "answer link"
workflow built on the auto-send feature. No configuration or admin action required.

## Outlook Add-in: Manifest Download Restored

Downloading the Outlook add-in manifest works again. The manifest endpoint had started returning a
server error, which blocked installing or sideloading the add-in.

- The generated manifest now uses the correct localized add-in name, task-pane button label, and
  description, with English defaults and German (`de-DE`) overrides.
- No admin action is required — the fix takes effect automatically on upgrade.

## Group Assignment Is Now a Searchable Picker

Assigning groups on the user editor and adding external group mappings on the group editor now use
a searchable picker instead of a plain comma-separated text field, so it is easier to pick the
right group and harder to introduce typos.

- Start typing to search your defined groups by name or id and add them with a click or the Enter
  key; selected groups appear as removable chips.
- You can still type a name that is not a defined group and press Enter to add it — needed for
  external identity-provider group names used in mappings.
- On the user editor, entries that do not match a defined group are highlighted so you can spot a
  mistyped group at a glance.
- No admin action is required — the change is purely in the admin UI.

## Content Admins Can Now Use the Admin Area

Members of the **Content Admins** group (the `contentAdmin` permission, without full admin access)
can now open and use the admin area to manage Apps, Prompts, and Sources. Previously they had no
way in: the **Admin Panel** link was missing from the user menu, and opening `/admin` directly
trapped the page in an endless reload loop.

- The **Admin Panel** link now appears in the user menu for content admins, not just full admins.
- Opening `/admin` no longer reloads endlessly. A per-request permission denial (403) on an
  admin-only endpoint is now handled where it happens instead of hard-redirecting the whole page.
- Content admins get a focused admin experience: the sidebar and the overview dashboard show only
  Apps, Prompts, and Sources — the platform-only sections and stats they cannot access are hidden.
- No admin action is required — the fix takes effect automatically on upgrade.

## Displayed Version Number Fixed

The version shown in the admin UI and documentation footer is corrected back to a real release
number. A release-automation run had previously committed a stray branch name as the app version,
which also broke downstream update checks.

- The release-sync script now rejects any non-semver input, so this cannot recur.
- No admin action is required — the fix takes effect automatically on upgrade.

## Tool-Enabled Apps Now Show Up in Usage and Telemetry Dashboards

Chats with an app that has **tools** enabled now record token usage, OpenTelemetry `gen_ai.*`
spans, and stream-outcome metrics for every LLM call, the same as ordinary chats. Previously the
tool-calling path recorded none of this, so any app with tools configured was invisible in usage
tracking, cost accounting, and telemetry dashboards — and the gap grew with every tool-loop
iteration, since each iteration is its own billable LLM call.

- Each LLM round-trip in a tool-calling conversation — including every iteration of a multi-step
  tool loop — is now counted individually, matching how the standard chat path is measured.
- No configuration or admin action required; historical usage prior to this fix is not backfilled.

## Transcribe Audio, Video, and Recordings with Voxtral (Chat Answer)

Apps can now transcribe a whole audio clip with a self-hosted **Voxtral** transcription model and
render the transcript as an assistant chat answer. Three sources are supported: uploading an audio
file, uploading a video (its audio track is extracted in the browser), and recording audio directly
in the chat. This complements the existing live **dictation** (which drops text into the input
field) and the multimodal audio-upload path (which sends audio to a chat LLM).

- Transcription is a new **first-class model type** (`modelType: "transcription"`). A default
  `voxtral-mini-realtime` model ships disabled; enable it and point its `ws://` URL at your vLLM
  realtime endpoint. Existing installations are seeded automatically on upgrade (migration V073),
  carrying over any configured realtime dictation settings.
- Configure it per app under **Admin → Apps → Transcription**: pick the transcription model, choose
  which inputs are offered (audio upload, video upload, record), decide whether it is on by default,
  toggle streaming, and set a max duration. A new **Video Upload** section was also added to the app
  upload configuration.
- Users get a **Transcription toggle** in the chat actions menu (like Web Search) that makes it
  clear audio/video is handled by a separate transcription model; a long transcription can be
  **stopped** with the same Stop button used to cancel a chat.
- Audio and video upload size limits are now configurable up to 2 GB (previously 100 MB for audio /
  500 MB for video), so longer recordings and meeting videos can be transcribed.
- The vLLM endpoint URL and API key stay server-side — the public models API strips them, so they
  never reach the browser. Transcription models are subject to the same group permissions as chat
  models and are hidden from the chat model selector.
- Errors (unreachable endpoint, unsupported/undecodable format, file too long, connection limits)
  are surfaced clearly in the chat.

**Enterprise hardening & operations** (applies to dictation and transcription — the shared
`/api/voice/realtime` endpoint):

- **Keepalive**: the server pings each voice connection every 25 s, detecting dead clients
  (crashed tab, suspended laptop) and preventing reverse proxies from killing quiet sessions while
  the GPU processes a long tail.
- **Backpressure**: when the iHub→vLLM hop is slower than the browser upload, the browser socket is
  paused via TCP flow control, so server memory stays flat instead of buffering the whole file.
- **Session cap**: a new `speech.realtime.maxSessionSeconds` (default 3600) bounds how long one
  connection can pin a GPU-backed upstream session; anonymous users are now capped per client IP
  rather than as one shared bucket.
- **Privacy/diagnostics**: upstream connection errors shown to users no longer include the internal
  vLLM host address (server logs keep the full detail); error frames now carry stable
  machine-readable codes. A `*` CORS wildcard is no longer honored for the cookie-authenticated
  voice WebSocket.
- **Interrupted transcripts are never presented as complete**: if the connection drops mid-file,
  the partial transcript is kept and annotated as interrupted (same pattern as user cancellation).
- New documentation: [Realtime Voice & Transcription](../../voice-transcription.md) covers vLLM
  deployment, model/app/permission configuration, nginx/reverse-proxy WebSocket setup, scaling
  (per-worker caps), the security model, and troubleshooting.

**Before using:** add or enable a transcription model under **Admin → Models** (model type
"Transcription"), set its realtime URL, then enable transcription on the desired app.

## Microsoft Teams Sign-In No Longer White-Screens

Opening iHub Apps inside Microsoft Teams (with Teams SSO enabled) previously crashed immediately
with a blank screen, before any authentication attempt could even start.

- Fixed a rendering bug in the Teams tab and Teams sign-in popup that threw an error on first load.
- The Teams sign-in popup no longer depends on a client-side build variable that was never set; it
  now fetches the Azure AD client/tenant ID from the server at sign-in time.
- No admin action is required for existing `teamsAuth` configuration — the fix takes effect
  automatically on upgrade.

## No More Silent Empty Answers from Gemini (Web Search Off)

Chatting with a Gemini model while web search is turned off (for example the **Web Chat** app) could
occasionally return a blank answer — most often when resending a message that worked before. This
is now both prevented and, if it still happens, reported clearly instead of showing an empty bubble.

- When an app supports web search but it is turned off for the turn, iHub now tells the model that
  web search is unavailable so it answers from its own knowledge instead of trying to call a search
  tool that isn't there. That phantom tool call was what made Gemini return an empty response
  (`MALFORMED_FUNCTION_CALL`).
- If a model still returns an incomplete response with no answer, the user now sees a clear message
  ("The AI model returned an incomplete response… please try sending your message again") rather
  than a silent blank reply.
- No admin action is required — the fix takes effect automatically on upgrade.
