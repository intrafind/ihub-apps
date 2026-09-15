# Features — 5.4.14

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
