# Features — 5.5.0

## OAuth Login for MCP Clients No Longer Fails With "Authorization code is invalid or expired"

Fixed a bug that made the OAuth 2.0 authorization code flow fail on any multi-worker deployment
(the default is 4 workers). After approving the consent screen, clients such as Claude Code
reported `Authorization code is invalid or expired` and never obtained a token.

- Authorization codes were held in a single worker's memory. Since connections are distributed
  across workers round-robin, the token request almost always arrived at a different worker than
  the one that issued the code, which then could not find it. Codes are now resolved across
  workers, so the exchange succeeds regardless of which worker handles each request.
- Codes remain strictly single-use: a code is consumed on exactly one worker, so replay attempts
  are still rejected cluster-wide with `invalid_grant`.
- The consent screen no longer depends on server-side session state either. Previously the CSRF
  token and the PKCE `code_challenge` were stored in a per-worker session, so approving consent
  could fail with `CSRF token missing`, or could issue a code with no PKCE binding that the token
  endpoint later rejected.
- Consent parameters (`redirect_uri`, `scope`, `code_challenge`, `nonce`) are now cryptographically
  signed and verified on submission, so they can no longer be altered between the consent screen
  and the decision.
- No configuration changes are required. Deployments that set `STICKY_SESSIONS=true` to work around
  this no longer need it for OAuth.

## Admin Config Backup Restore No Longer Risks Wiping the Configuration

Fixed a data-loss risk in **Admin → Backup → Import**: if the safety backup of the current
configuration failed partway through (for example due to a full disk), the import used to proceed
anyway and delete the live configuration directory before copying in the new one.

- The import now stages the imported configuration next to the live one and swaps it in with an
  atomic rename, so there is no window where a request could see a half-restored configuration.
- If the safety backup can't be created, or the final swap fails, the import aborts and the
  original configuration (apps, models, users, groups, encryption key) is left untouched or rolled
  back automatically — nothing is deleted unless the new configuration is safely in place.
- No admin action is required — the fix takes effect automatically on upgrade.

## Brute-Force Rate Limiting Now Actually Applies to Login and Inference Endpoints

Fixed a bug where the rate limiters intended to protect authentication and inference endpoints
were mounted on paths that never matched any real request, so they never fired.

- `POST /api/auth/local/login` (and the LDAP/NTLM login endpoints) are now correctly limited to
  50 requests per 15 minutes per IP, restoring brute-force login protection.
- The OpenAI-compatible inference proxy (`/api/inference/...`) is now correctly rate-limited,
  protecting upstream LLM quota and cost from runaway clients.
- No configuration changes are required; existing `rateLimit.authApi` / `rateLimit.inferenceApi`
  overrides in `platform.json` now take effect as intended.
  
## Cancelling a Workflow No Longer Crashes the Server

Fixed a crash where stopping or cancelling a running workflow at the moment the chat connection
dropped could take down the entire server for all users.

- Previously, if the browser's connection closed while a workflow was being cancelled, the stop
  handler tried to close an already-removed connection and threw an unhandled error, exiting the
  server process.
- The stop endpoint now safely handles a connection that has already disconnected, so cancelling a
  workflow always completes cleanly.

## Authentication Admin Now Uses Searchable Group Pickers

The default-group fields in Authentication settings are now searchable group selectors instead of
free-text inputs, so admins pick from real, defined groups and can no longer introduce typos that
silently grant no permissions.

- Applies to all default-group fields: the authenticated-users group, anonymous-access groups, and
  the default groups for each OIDC, LDAP, and NTLM provider.
- Each field shows the defined groups with their names and descriptions and filters as you type.
- Any group value that no longer matches a defined group is still shown but visibly flagged, so
  existing configurations remain visible and can be corrected rather than being dropped.

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

## Agent Workflows No Longer Crash on Their First Prompt Step

Fixed a regression introduced with the native web search rework above that caused agent workflows
to fail as soon as they reached a prompt step, with the error `Agent execution failed:
nativeWebSearch is not defined`.

- Every workflow with a prompt/agent node was affected, whether or not the node used web search;
  the failure surfaced on the first such step (for example, the Stellungnahmen review workflows
  failed at their `refine-decision` step).
- Workflows now run their prompt steps normally again, and the native web search directive is
  correctly applied on steps that request it.
- No configuration changes are required.

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

## Gemini Apps No Longer Corrupt Parallel Tool Calls

Fixed a bug where Gemini (Google) models calling more than one tool in the same turn could
silently lose one of the calls. When two tool calls arrived in separate streaming chunks, the
second one collided with the first instead of being tracked separately, corrupting its arguments
into invalid JSON and dropping the call entirely — with no error shown to the user.

- Apps and agent workflows on Gemini models that trigger multiple tools per turn (a common pattern
  for tool-using agents) now execute every tool call correctly.

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

## Admin Details Popups Are Now Keyboard-Accessible and Consistent

The App, Model, Prompt, and Short Link details popups in the admin area now share one dialog
component, fixing an inconsistency where only the Prompt popup closed on **Escape**.

- All four popups now close on **Escape** and trap keyboard focus while open (Tab/Shift+Tab cycle
  within the dialog instead of escaping to the page behind it), and are marked `aria-modal` for
  screen readers.
- Clicking the dimmed backdrop now also closes the popup, matching other dialogs in the admin area.
- No admin action is required — the fix takes effect automatically on upgrade.

## Admin Save/Load Errors Now Show the Real Reason

Admin pages (Apps, Prompts, Models, Tools, Workflows, Skills, Users, Groups, Agents, Providers,
and more) now display the server's actual error message — a validation problem, a duplicate ID, a
conflict reason — instead of a generic "Request failed with status code 409".

- A shared helper extracts the server-provided error detail everywhere an admin API call fails,
  across roughly 60 call sites.
- Saving an app or prompt that fails validation no longer replaces the entire edit form with a
  full-page error, discarding the in-progress edit — the error now shows as a banner above the
  still-visible form. The same fix applies to the User and Group editors.
- No admin action is required.

## Chat Messages Are Now Sanitized Before Rendering as HTML

User messages that carry an image, file, or audio attachment (or that merely contain text
resembling an `<img>` tag or a `data:image` value) are now sanitized before being rendered as
HTML. Previously this render path skipped the sanitization applied everywhere else in the app, so
a pasted message body could execute arbitrary script in the app's origin.

- No admin action is required — the fix takes effect automatically on upgrade.
- Legitimate attachments (pasted images, uploaded files, audio) continue to render exactly as
  before.
  
## Audit Log Now Covers Tools, Marketplace, and UI Configuration Changes

The admin audit log (Admin → Audit Log) now records explicit, before/after-aware entries for three
route groups that previously relied only on the coarse URL-derived fallback: **Tools**,
**Marketplace**, and **UI configuration**.

- Tools: create, update, delete, enable/disable toggle, and script content edits.
- Marketplace: registry create/update/delete/refresh, and item install/update/uninstall/detach.
- UI configuration: asset upload/delete, configuration save, and configuration backup.
- No admin action required — existing audit log filtering, retention, and CSV export apply to
  these new entries automatically.

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

## Dynamic JSX Pages No Longer Depend on a Public CDN

Custom React pages (`contents/pages/*.jsx`) and app-embedded React components now compile using the
JSX compiler already bundled with iHub, instead of fetching it from `unpkg.com`/`cdn.jsdelivr.net`
at runtime. This removes a supply-chain dependency on those CDNs being reachable and trustworthy,
and fixes JSX pages failing to render on air-gapped or self-hosted deployments that block outbound
calls to public CDNs.

- No admin action is required — the compiler now loads from iHub's own bundle on first use.

## Disabling a Teams SSO User Now Actually Blocks Them

Disabling a Microsoft Teams user's account previously had no effect: Teams SSO logins (both the
silent tab/app sign-in and the token-exchange endpoint) never checked or recorded the account's
active status, unlike every other external login method (OIDC, LDAP, NTLM, proxy).

- Teams users are now persisted to `users.json` and validated on every sign-in the same way as
  OIDC/LDAP/NTLM/proxy users, so an admin who disables a Teams user's account blocks them from
  signing in again (`403 Forbidden`).
- No admin action is required — existing Teams users are picked up automatically on their next
  sign-in.
  
## Cancelling an Agent Run Now Actually Stops It

Cancelling a workflow/agent run, or hitting its per-node timeout, previously only stopped things
*between* steps — an agent step already in progress kept calling the model and running tools in
the background until it finished on its own, even though the run showed as cancelled.

- Cancelling a run (or a timeout firing) now interrupts an in-flight agent step immediately: the
  in-progress model request is aborted, and the agent stops before starting another model call or
  another queued tool call in the same turn.
- This stops wasted LLM spend and background tool activity on runs operators already considered
  stopped.
- Also fixed a related bug where a tool-enabled agent step could fail outright with an internal
  error when native web search was configured, instead of running normally.
- No admin action is required — the fix takes effect automatically on upgrade.

## Web Content Extraction Is Now Protected Against Redirect-Based SSRF

The **webContentExtractor** tool (used directly by apps and internally by Brave Search's page
extraction) validated only the initial URL before fetching. A page that redirected to an internal
address — for example a cloud metadata endpoint — could bypass that check entirely and have the
server fetch it on the tool's behalf.

- Every redirect hop is now re-validated against the same private/internal-address guard as the
  initial request, and the connection is pinned to the validated address to close a DNS-rebinding
  window between the check and the fetch.
- Redirect chains are capped at 5 hops to prevent an unbounded chain.
- No admin action is required — the fix takes effect automatically on upgrade.

## Production Docker Compose Now Boots on a Fresh Clone

`docker/docker-compose.prod.yml` previously couldn't start on a clean checkout, and broke
configuration migrations and admin-UI saves once it did.

- Configuration was bind-mounted from a host `../contents/` folder that doesn't exist until the
  app generates it on first boot, so a fresh clone started with an empty, broken config.
- `contents/config` was mounted read-only, so config migrations and any admin-UI save (platform
  settings, apps, models, etc.) failed once the container did start.
- Replaced the multi-volume, read-only setup with a single writable volume covering the whole
  `contents/` tree, matching how the app already manages its own data — no separate init
  container needed.
- No admin action is required for new deployments. Existing deployments upgrading their compose
  file should back up their current volumes first (see `docker/DOCKER.md`'s updated backup/migration
  steps) since the old per-directory volumes (`ihub-config`, `ihub-data`, `ihub-uploads`, etc.) are
  replaced by a single `ihub-contents` volume.
  
## Customizable Error & Empty-State Messages

Admins can now reword the text shown on error and empty-state screens per language, directly from
the admin panel — no code change or redeploy required. This is useful for branded deployments that
need tenant-specific wording, a support contact, or a different tone.

- Covers the generic error screen, the 404 / 500 / 403 / 401 pages, and the "no apps available"
  state on the apps list.
- Edit under **Admin → UI Customization → Error Pages**. Each screen has its own title and message
  fields, with the standard multi-language editor (add languages, auto-translate).
- Every field is optional — leave one empty to keep the built-in default text. Existing
  installations get the current wording seeded automatically so there's nothing to fill in unless
  you want to change it.
- No admin action is required on upgrade; a migration adds the editable defaults for you.

## Authentication Debug Logging — Fixed and Consolidated

Enabling authentication debug logging now actually works, and all of its controls live in one
place. Admins can trace OIDC redirects, token exchange, group mapping, and NTLM handshakes to
diagnose sign-in problems.

- Configure it under **Admin → Platform → Logging → Authentication Debug Logging**. The
  Authentication page now points here instead of offering a second, disconnected copy.
- Turning it on is sufficient on its own — traces are written at the `info` level, so they appear
  at the default log level without also lowering the global log level, and the change applies
  immediately (no server restart).
- The **Include raw authentication data** option (off by default) is clearly marked as a security
  risk; leave it off unless you are actively debugging, and turn it off again afterward.
- The obsolete "Console logging" toggle was removed (the logger already manages console output).
- No admin action is required on upgrade: a migration moves any previously saved setting to its new
  location so your configuration is preserved.

## Fixed App Crash Caused by Browser Auto-Translation

Fixed a crash where the entire app would fail to load with a generic "Something went wrong" error
on browsers configured to automatically translate pages (for example, Chrome or Edge on a German,
French, or other non-English system).

- The symptom was an unexpected-error screen showing `NotFoundError: Failed to execute
  'insertBefore' on 'Node'`, often in the browser's own translated wording rather than iHub's.
- It was most visible right after a fresh installation, because a new install starts in English
  and a non-English browser would offer to auto-translate it.
- iHub Apps already ships its own language switcher, so browser translation was both redundant and
  the source of the crash. The application now instructs browsers not to auto-translate its pages;
  users should continue to switch languages using the in-app language selector.
- No admin action is required on upgrade.

## Connect Claude and Other MCP Clients Without Manual OAuth Setup

The MCP gateway can now be activated end-to-end from **Admin → MCP gateway**, and MCP clients such
as Claude (claude.ai custom connectors, Claude Desktop), Cursor, and VS Code can connect through
standard OAuth discovery — including automatic client registration.

- The MCP gateway page now includes an **Authentication** section: one toggle enables the OAuth
  authorization server (previously this had to be edited in `platform.json` by hand, which left
  the gateway unusable), and a second toggle enables **Dynamic client registration (RFC 7591)** so
  MCP clients create their OAuth client automatically at `/api/oauth/register` — no manual client
  setup needed. A warning appears if the gateway is on but OAuth is off.
- New standard discovery endpoints: `/.well-known/oauth-authorization-server` (RFC 8414) and
  `/.well-known/oauth-protected-resource` (RFC 9728). Unauthenticated requests to `/mcp` now
  return the `resource_metadata` challenge that MCP clients use to bootstrap authentication.
- Auto-registered clients are never trusted: users always sign in and consent to the requested
  `mcp:*` scopes, and the clients can be reviewed, restricted, or removed under
  **Admin → OAuth clients**. Registration is rate-limited and capped
  (`oauth.dcr.maxClients`, default 100), and only the authorization-code flow can be registered.
- The consent screen now explains `mcp:*` scopes in plain language, and clients that omit the
  `scope` parameter receive their registered scopes instead of a token the gateway would reject.
- Fixed the MCP gateway settings not saving at all: the platform config endpoint reported success
  while discarding the gateway section, so every toggle on the page reverted on reload.
- To connect Claude: enable the three toggles, then add `https://your-ihub/mcp` under
  **Settings → Connectors → Add custom connector** in Claude.

**Note:** after enabling the OAuth authorization server for the first time, restart the server
once so the OAuth session middleware is mounted.

## MCP clients can connect reliably after sign-in

Fixed the MCP gateway rejecting every request that followed a successful OAuth login, which left
clients such as the Claude Code CLI stuck at "could not connect" even though the browser consent
step had completed.

- Requests the gateway cannot match to a live session now get the status the MCP spec prescribes,
  so clients recover on their own: an unknown or expired `Mcp-Session-Id` returns
  `404 Session not found` (the client simply opens a new session), and `GET /mcp` outside a session
  returns `405`. Previously all of these returned `400 Bad Request: Server not initialized`, which
  MCP clients treat as a fatal protocol error.
- The session is registered the moment the handshake is accepted, closing a window in which a
  client already held its session id but the gateway did not yet recognise it.
- New **Stateless mode** toggle under **Admin → MCP gateway → Transports** for installations that
  run several load-balanced replicas. Each request is then served independently, so no session
  affinity is required. Trade-off: no server-initiated SSE stream (the gateway does not use one).
- Every request the gateway turns away is now logged under the `McpGateway` component with the
  reason, and abandoned sessions are released after an hour instead of being held for the lifetime
  of the process.
- Only the user who opened a session can terminate it via `DELETE /mcp`.
- Authorization-code tokens no longer log a misleading `JWT verification failed — jwt audience
  invalid` warning on every MCP request; those tokens are audience-scoped to their OAuth client by
  design and were always being accepted.

## Health Probes and the Login Screen No Longer Lock Themselves Out With 429s

The brute-force limiter that protects login was applied to the whole `/api/auth` namespace,
including read-only endpoints nothing can avoid calling. Polling `/api/auth/status` — the call the
web app makes on every page load, and a natural choice for a container health probe — exhausted the
window (30 requests per 15 minutes in the shipped configuration) on its own, after which every
caller including the probe received
`429 Too Many Requests` until the window reset. The platform looked completely wedged.

- The strict limiter now covers only endpoints that actually verify credentials
  (`/api/auth/local/login`, the LDAP/NTLM logins, and the Teams token exchange). Brute-force
  protection is unchanged for those.
- Read-only endpoints — `/api/auth/status`, `/api/auth/user`, the provider-discovery endpoints, the
  OIDC sign-in and callback redirects, and `/api/auth/logout` — are covered by the generous public
  API limiter instead. A single exhausted window can no longer block SSO sign-ins or logouts for
  everyone.
- Health probes are best pointed at `/api/health`, which has never been rate limited.

## New `trustProxy` Setting for Deployments Behind More Than One Proxy

`platform.json` now takes a `trustProxy` value: the number of proxy hops in front of iHub (it also
accepts `true`/`false` or a list of trusted addresses and subnets). It decides what iHub sees as the
client address, which is both the rate-limit key and the address recorded in the audit log.

- The default is `1`, matching the previous hard-coded behaviour — nothing changes on upgrade.
- Raise it if iHub sits behind more than one hop, e.g. an ingress plus an internal load balancer.
  With a value that is too low, every caller behind the inner proxy is seen as the *same* client, so
  they all share one rate-limit counter and one busy client can exhaust the auth or OAuth window for
  the whole deployment. Audit entries also record the proxy rather than the user's address.

```json
{
  "trustProxy": 2
}
```

## MCP Gateway `405` Responses Are Now Diagnosable

A `GET /mcp` rejected with `405` was returned without a log line, so the three very different causes
were indistinguishable from the server side. Each rejection is now logged under the `McpGateway`
component with the request's method, user, user agent, and whether an `Mcp-Session-Id` header
arrived.

- Most `405`s are harmless: a Streamable HTTP client probing for the optional server-initiated SSE
  stream. Tools still list and run — nothing to fix.
- A `405` a client cannot recover from means it is configured for the legacy SSE transport but
  pointed at `/mcp`; the error message now names `/mcp/sse` explicitly.
- A `405` with no session header *after* a successful handshake means a reverse proxy is stripping
  the `Mcp-Session-Id` header — allow it (and `MCP-Protocol-Version`) through.

## Clustering Now Warns When Sticky Routing Collapses Onto One Worker

With `WORKERS` greater than 1, the primary process hands each connection to a worker chosen from the
TCP peer address. Behind a reverse proxy that address is identical for every request, so all traffic
lands on a single worker while the others stay idle — and a saturated worker looks like a dead
server, health probes included.

- The primary now logs this once at startup instead of leaving it to be discovered under load.
- To actually use several workers, either expose iHub directly, or run `WORKERS=1` with multiple
  replicas behind proxy-level session stickiness.

## Clustered Deployments Now Use Every Worker Behind a Proxy

Worker processes no longer need each client pinned to one of them. Chat streaming state that lands
on a different worker than the one holding the browser's connection is relayed internally, so
connections are distributed evenly instead of hashed by network address.

- Previously, routing hashed the client's TCP address. Behind a reverse proxy or Kubernetes ingress
  every request carries the proxy's address, so a single worker served all traffic while the rest
  sat idle — a `WORKERS=4` deployment had the capacity of one process, and the saturated worker
  looked like a dead server because health probes queued behind real requests.
- No configuration change is needed to get the fix. Deployments already setting `WORKERS` see all
  workers used from the first restart.
- Chat streaming, stop/cancel, workflow cancellation and workflow progress replay all work
  regardless of which worker a given request reaches.
- Set `STICKY_SESSIONS=true` to restore the old address-hashing behaviour if some part of your
  deployment depends on connection affinity. It is not needed for chat.

Note two per-worker limits that now spread differently, since one user's requests can reach several
workers: rate-limit counters and realtime-voice connection caps are counted per worker, so the
effective ceiling is up to `WORKERS ×` the configured value. Size them accordingly or enforce limits
at your ingress.

Running more than one **replica** still requires cookie-based session affinity at the ingress — the
relay works between workers in a pod, not between pods. See
[Scaling with Multiple Workers](../../scaling.md) for Kubernetes examples.

## Configuration Changes Now Reach Every Worker Immediately

With `WORKERS` greater than 1, an admin save only reached the worker that handled the request. Every
other worker kept serving the previous configuration until its cache expired, so a saved change
looked applied on one page load and reverted on the next — and a deleted app stayed visible on the
workers that had not handled the delete.

- Saving, creating, deleting or toggling anything in the Admin UI now takes effect on all workers at
  once: apps, models, prompts, tools, workflows, agents, sources, providers, groups, users, pages,
  skills, MCP servers and platform settings.
- Runtime settings that were previously applied only in the worker serving the request now follow
  too — log level and logging config, telemetry, usage-tracking mode, iFinder/iAssistant connection
  settings and outbound MCP server connections.
- Backup import and the admin **Clear cache** / **Refresh cache** actions reload every worker.
- No configuration change is needed. `GET /api/admin/cache/stats` gains a `sync` block with the
  per-worker announce/receive counters if you want to confirm changes are propagating.

## OIDC and OAuth Logins No Longer Fail Intermittently on a Fresh Install

On the very first start of a multi-worker installation, each worker could generate its own JWT
signing key and its own secret-encryption key, because they all raced to create the key files before
any of them existed. A user who logged in was then authenticated on some workers and rejected with
"Authentication required" on others, seemingly at random, and secrets encrypted by one worker could
not be decrypted by another.

- The first worker to create each key file now wins and the others adopt it, so a cold start ends
  with one signing key and one encryption key for the whole cluster.
- Only fresh installations were affected. Existing installations already have the key files on disk
  and were reading them correctly.
- **If you hit this**, `contents/.jwt-private-key.pem`, `contents/.jwt-public-key.pem` and
  `contents/.encryption-key` may hold a key that only one worker was using. Existing sessions will
  need a re-login after upgrading. Any secret that was saved in the Admin UI while the keys were
  mismatched should be re-entered, since it may have been encrypted with a key that is no longer on
  disk. Setting `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` and `TOKEN_ENCRYPTION_KEY` explicitly avoids the
  situation entirely and is recommended for multi-replica deployments.
  
## Cited Passages Can Now Be Located and Highlighted Inside the Source Document

When an app uses iFinder as its search backend, the passages listed under a chat answer's
**Documents** section can now be opened directly in the document they came from. The document opens
in an in-app PDF preview with every cited passage highlighted, scrolled to the first one.

- Each passage in an expanded document gets a magnifier button that opens the preview at that
  passage. The overflow menu's **Preview (PDF)** entry opens the same viewer with all of the
  document's cited passages highlighted.
- The preview replaces the previous behaviour of opening the converted PDF in a new browser tab,
  which could not highlight anything. It adds highlight-to-highlight navigation (also `Enter` /
  `Shift+Enter`), a page count, zoom, download, and a per-passage filter when a document is cited
  more than once.
- Passage text and the generated preview PDF do not match character-for-character — the PDF's text
  layer differs in whitespace, ligatures, hyphenation and page furniture such as headers and
  footers. Matching therefore compares only letters and digits, so passages are still found across
  those differences, in any script (including Cyrillic and CJK), and across page breaks.
- A passage that a header or footer interrupts at a page break is highlighted sentence by sentence
  rather than not at all. If a passage genuinely cannot be located, the preview still opens and
  reports "Passage not found" instead of failing.
- Documents without a downloadable version are unaffected: the passage button and preview entry
  only appear where iFinder exposes document access.

## Connection Diagnostics for iFinder and iAssistant

The **Test iFinder** and **Test iAssistant** buttons under Admin → iFinder Integration now run a
step-by-step diagnostic instead of returning a single pass/fail message. Each step reports what it
observed and, when it fails, what to check — so connecting iHub to iFinder no longer requires
reading server logs and guessing.

- Checks the whole path: the configured URL (including a warning when the hostname is not fully
  qualified), DNS resolution, the TCP/TLS handshake with certificate subject, issuer, expiry and
  trust result, JWT generation, local signature verification, JWKS reachability, and a real API
  request against iFinder's search endpoint or iAssistant's profile list.
- Shows the decoded JWT — header, payload, and the subject that was actually derived for the user —
  so it can be compared against the trust configuration on the iFinder side. A 401 now also surfaces
  the `WWW-Authenticate` header and names the usual causes: issuer mismatch, a `kid` missing from
  the JWKS, a subject in the wrong format, or clock skew.
- Flags the issuer and JWKS URL that **iFinder itself must call back to**. A `localhost` or
  single-label hostname there is reported as a failure, because iFinder can never fetch the signing
  keys from it — the most common reason iFinder answers 500 during token validation.
- Detects an iAssistant profile ID that does not exist and lists the profiles the tested user can
  actually see.
- Diagnostics options allow testing as a specific user (email, username, domain) to verify how the
  JWT subject is built, optionally returning the signed JWT together with a ready-to-run `curl`
  command, and running an iAssistant conversation round-trip to verify write access. Without the
  token option the `curl` command references `$TOKEN` and is safe to share.
- The search term and profile are fixed rather than configurable per run, so no value from the
  request can influence which URL iHub contacts. The diagnostics always exercise the configured
  search profile, which is what an admin wants to verify anyway.
- A previous behaviour is fixed: an iAssistant network failure used to be reported as "configuration
  is valid" and counted as a success. Unreachable now reads as unreachable.

## Apps Can Now Call Other Apps as Tools (Concierge Pattern)

A chat app can delegate to other apps: list app IDs in the new `apps` field and the model
sees each one as a callable tool (`app__<id>`). The called app answers with its own system
prompt, model, tools, and sources — entirely server-side, with no REST round-trip — and the
calling app weaves the answer into its response. This enables a concierge bot that routes
requests to specialist bots.

- Configure via the new **Apps as Tools** section in the admin app editor, or the `apps`
  array in the app JSON.
- Requires the **App-as-Tool** platform feature (Admin → Features; previously agent-only,
  off by default).
- Users can only reach apps their groups permit — the same permission check as opening the
  app directly; apps a user may not access are never offered to the model.
- Delegation is limited to one level: a called app cannot call further apps, so loops
  cannot form.

## iFinder Sources Select Documents Instead of Carrying Connection Settings

iFinder knowledge sources no longer ask for a base URL and API key — the connection comes from
the central iFinder integration (Admin → Providers → iFinder). A source now only defines which
documents it loads, and the admin form can verify the selection against the live iFinder before
saving.

- Pin a source to one document by ID, or give it a search query that loads the top N matching
  documents (configurable, 1–100) as source content — each document arrives clearly delimited
  with its title and link.
- A **Connect** button next to the document ID loads the document's metadata (title, author,
  media type, size, modification date, link) so admins can confirm it is the right document.
- A **Test Query** button shows how many documents match and which ones would be loaded.
- The search profile is optional and falls back to the platform-wide default profile.
- Documents are always fetched with the identity of the current user, so a source never exposes
  content the user could not open in iFinder directly.
- Sources exposed as tools may leave both fields empty; the assistant supplies a query or
  document ID when it calls the tool.

## Audit Log Filtering by Checkbox, With Entry Counts

**Observability → Audit Log** now filters with checkbox lists instead of single-value dropdowns, so
"everything except logins" is one click rather than impossible. Actor, resource, action, result and
source each open a list of the values that actually occur in the selected date range, each showing
how many entries are behind it.

- **Select all** and **Select none** are single clicks; lists longer than ten values get a
  type-ahead box. Full keyboard and screen-reader support.
- Counts are what make a noisy log tractable: seeing `login — 794` tells you exactly what to untick.
- Option lists are read from the log, not from a fixed list, so resource types added by a later
  release appear on their own.
- Counts and options are computed over the date range only, so unticking a value never makes its
  checkbox vanish.
- A new **search box** matches the summary, resource ID, IP, request ID and actor name of any entry
  in the date range.
- **Quick filters:** Today / Today & yesterday / Last 7 days / Last 30 days, **Hide sign-ins**,
  **Failures only**, and **Clear all filters**.
- The default range is now **today and yesterday** instead of 7 days. The date filter works in whole
  calendar days (UTC) with no time-of-day cutoff, so the default covers two days rather than a
  rolling 24 hours — that way the table is not near-empty just after midnight. Widen it with the
  date inputs or a chip.
- Action, result and source are translated in the table itself, not only in the filter lists.
- Filter state stays in the URL, so a filtered view is still bookmarkable and shareable. Each field
  takes an include parameter and an `<field>Exclude` parameter, with `*` meaning "every value" —
  `?actionExclude=login,logout` is "everything but sign-ins". Existing single-value links such as
  `?resource=app` keep working.
- Audit log queries now scan each daily file once instead of loading the whole date range into
  memory and sorting it, so a wide range costs materially less.

## Subpath Deployments No Longer Bypass Authentication or Rate Limits

Closed a security gap where requests carrying an `X-Forwarded-Prefix` header (used for reverse
proxy subpath deployments, e.g. `/ihub/`) could, in some configurations, reach protected API
endpoints without going through authentication or rate limiting.

- The base-path rewrite now runs before authentication and rate limiting instead of after, so every
  downstream check consistently sees the final, rewritten request path.
- The `X-Forwarded-Prefix` header is now only honored when the request arrives through a hop that
  the server's `trust proxy` setting actually trusts, instead of being accepted unconditionally from
  any direct client.
- No admin action is required — the fix takes effect automatically on upgrade. Deployments that
  rely on a specific reverse proxy for subpath routing should confirm their `trust proxy`
  configuration reflects their actual proxy topology.
