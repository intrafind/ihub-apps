# Fixes — 5.5.2

## Reopening a Durable Chat Mid-Answer Now Picks the Answer Back Up

Three defects, reported together from real use: start a chat with websearch,
close the tab before the first text arrives, come back, and the chat was
marked as having new activity but showed only the question — then, after a
second reload, an empty assistant bubble.

- **Leaving a durable chat no longer cancels its turn.** The page told the
  server to stop whenever the chat surface unmounted for good. `POST …/stop`
  is deliberately unconditional — the Stop button has to reach a turn whose
  browser is gone — so closing the tab aborted the very answer durable chats
  promise to finish, and stored it as an empty message with an `ABORTED`
  error. Only the Stop button cancels a durable turn now. An ephemeral chat
  still stops on leaving, or a generation nobody will read keeps running.
- **Reopening a chat re-attaches to a turn that is still generating.** The
  page replays what the run ledger already holds and then follows the live
  stream, instead of showing the question and waiting for a frame that could
  never arrive on a connection nobody had opened. When the turn ends the
  transcript is re-read from the store.
- **A stopped or failed turn says so.** Reconstructed from storage, both
  rendered as a blank bubble: the "stopped" note is written into the message
  as it happens live, and a failure that produced no text had only its reason,
  which hydration was discarding. Both now render.

## A Chat Reopens With the Settings It Was Using

The websearch toggle, enabled tools, style, output format, temperature,
thinking options and model are recorded on the chat and restored when it is
reopened. They lived only in this browser's per-app storage, so the *app*
remembered a preference and the *chat* remembered nothing: a chat you had
turned websearch on for answered your next question without it.

Only what a chat actually recorded is restored — everything else falls back to
the app's defaults, and the model is re-selected only if the app still allows
it. A turn merges its settings over the earlier ones rather than replacing
them, because a surface only sends the toggles it shows.

## Start Page and Sidebar Settings Take Effect Without a Page Reload

Changes saved under **UI Customization → Start Page** did not reach the running
app: the sidebar kept the app shortcuts it had loaded with, and "/" kept
opening whatever view it opened before. Only a full browser reload picked up
the change. Configuration responses are held in memory for 30 minutes, and the
refresh that follows a save was answered out of that cache instead of from the
server — so a second save appeared to apply the *previous* one.

- Saving now refreshes the sidebar's app list and count, the featured apps, the
  heading and the view "/" redirects to, straight away.
- With app shortcuts set to rank **by recent use**, the sidebar also reorders as
  soon as an app is opened, in this tab and in any other tab that is open.

## Web Search and Tools Are Available From the Start Page

The chat box on the start page hid most of the app's per-chat features. Opening
the **+** menu there showed no web search toggle at all, and the app's tools were
listed with every one switched off and no way to turn any of them on — so a
question that needed a web lookup or a tool had to be re-typed inside the app.

- The **+** menu on the start page now offers the same controls as the app it
  starts: web search, the app's tools (pre-selected exactly as the app
  configures them), the transcription toggle and the image-generation settings.
- Magic Prompt now works from the start page too.
- Whatever is picked there applies to the first message, which is sent
  automatically on arrival in the app — the choice is no longer lost in the jump.
- The toggles open in the state already chosen for that app in the current
  session, so the start page and the app agree.
- Upload options now follow the model selected on the start page, so image or
  audio attachments are offered based on the model that will actually answer.

## Slow Providers Are No Longer Reported as Unreachable

Calls through the OpenAI-compatible inference API failed with `Provider <name> sent no response
headers within 10000 ms — endpoint unreachable` (HTTP 504, `code: TIMEOUT`) even though the
provider was answering normally. It hit longer jobs hardest — summaries, translation passes,
batches of them — while chats in the web UI looked fine.

The ten-second ceiling exists to fail fast on a host that cannot be reached, instead of hanging on
the five-minute request timeout. It only measures reachability if the request streams, and two
things broke that:

- **The provider call was not streamed.** The inference API defaults `stream` to `false`, and that
  flag was passed straight through to the provider. A buffered endpoint — Google's
  `:generateContent`, and every other one — withholds its response headers until the whole answer
  is generated, so the ceiling was timing the generation, not the connection. Every provider call
  now streams, and a client that asked for a single response gets that stream collected into one
  `chat.completion`. The response you receive is unchanged, `usage` included. The web UI streamed
  already, which is why only API jobs were affected.
- **Time spent waiting in line counted.** Each request first waits for a slot in the per-model
  throttle (`requestConcurrency`, 5 by default). A request queued behind five others had not been
  sent yet, but was timed as if the provider had ignored it. The ceiling now starts when the
  request actually goes out.

Both ceilings are also adjustable now, for an endpoint that is reachable but slow to accept a
request:

- `llm.connectTimeoutMs` and `llm.streamIdleTimeoutMs` in `platform.json` (or the environment
  variables `LLM_CONNECT_TIMEOUT_MS` / `LLM_STREAM_IDLE_TIMEOUT_MS`) for the whole installation.
- `connectTimeoutMs` / `streamIdleTimeoutMs` in a single model's config for that model only.
- `0` disables either ceiling and leaves the call to the request timeout.

When the ceiling does fire, the error names the setting to raise, and the server log records the
endpoint that was tried (with URL secrets redacted) next to the model and provider.

## Model, App, and Workflow IDs Are No Longer Case-Sensitive

Calling a model, app, or workflow by id with different casing than it was configured with — for
example through the OpenAI-compatible inference API, an MCP tool call, or a public `GET` endpoint —
failed with a "not found" or "access denied" error even though the resource existed and the caller
had permission to use it.

- Model, app, and workflow lookups now match ids case-insensitively, so `GPT-4o` resolves the same
  model as `gpt-4o`.
- The app/model access check applied to every chat request now compares ids case-insensitively
  too, so a differently-cased id is no longer rejected as access-denied right after being found.
- New app and workflow ids must now be lowercase when created or edited, matching the existing rule
  for model and prompt ids.

## Logging In No Longer Depends on Username Capitalization

A user whose username was created as `Daniel.Manzke` could not log in by typing `daniel.manzke` —
username and email lookups compared strings exactly, so any difference in capitalization was
treated as a different account. Login, admin user creation, and duplicate-username checks now all
match usernames and emails case-insensitively, and the same fix applies to how OIDC, LDAP, NTLM,
and Teams sign-ins are matched against previously persisted accounts.

## Editing an Earlier Message No Longer Requires a Second, Manual Send

Once a conversation had more than one exchange, editing an earlier message updated it but did not
resend it — the edited text was left sitting in the input box, and the only way to actually send it
was to press Send again by hand. Editing a message now reliably resends it and continues the
conversation from that point, no matter how long the conversation already is.

## Configuration Import and Other Admin File Uploads Work Again

Importing a configuration backup failed immediately with "Failed to import configuration: HTTP 400"
and the server log showed only "Starting configuration import" with no further detail. The selected
file was never actually sent: the admin API helper left a JSON content type on the request, so the
browser's HTTP client converted the upload into a short JSON object and discarded the file. The
server correctly reported that no ZIP had arrived.

- Affects every admin file upload, not just backup import: **System → Configuration Backup &
  Import**, the UI **asset upload**, and **skill import** from a `.zip`.
- Exporting a backup was never affected, and no backup created with an earlier version is damaged —
  re-importing a previously exported ZIP now works.
- No configuration change or admin action is required.

## A New Local Account Was Invisible to Every Other Worker

Creating a user through **Admin → Users** (or the local-auth signup path) wrote `users.json`
directly instead of going through the shared save path. In a clustered installation — which is the
default — that left every *other* worker authenticating against a users file it still believed was
current, so the new account could not log in on most requests. Worse, the next save from any of
those workers rewrote the whole file from its stale snapshot, and the new user was dropped
altogether.

- User creation now goes through the same writer as every other change: it writes through the
  configuration store, refreshes the cache entry, and tells the other workers to re-read the file.
- The new account works on every worker immediately, and a later save from another worker no longer
  removes it.

**If you are upgrading from 5.4.x and run more than one worker**, it is worth checking that the
accounts you created are still there. Anyone who was created and then reported "my login does not
work" may have been silently removed by a later save; such an account has to be created again. A
single-worker installation is unaffected.
