# Fixes — 5.5.0

## More Room for the Conversation on Phones

On a phone the chat gave the conversation less than half the screen: a 390x664 viewport spent 392px
on chrome and left 272px for messages. Several pieces are now compact below the `sm` breakpoint,
which also covers the Outlook taskpane and the browser-extension side panel.

- The app header uses a smaller icon, back button and title, and less padding.
- The status line above the input no longer squeezes the context-window counter into a narrow
  column, so "~290 / 32,768 context tokens" fits on one line instead of wrapping.
- The disclaimer below the input gets the full row width, and the incognito toggle shows just its
  icon; the toggle keeps its name for screen readers.
- The toolbar row and send button are slightly tighter.

The conversation now gets 339px of the same 664px viewport, up from 272px. Layouts from `sm` up are
unchanged.

## The Footer No Longer Takes a Permanent Strip on Phones

In the sidebar layout the slim footer was pinned to the bottom of the viewport, costing about 57px
of a ~660px phone screen on every content page and clipping the content above it. On small screens
it now sits after the content and scrolls out of the way; on desktop, where it is a single 36px
line, it stays pinned as before.

## Model Descriptions No Longer Leave a Gap in the Model Picker

In the model picker on iOS, rows whose description was long showed one line of text followed by a
tall empty box, so the list looked randomly spaced. The single-line description now uses ordinary
truncation instead of a line clamp, whose height WebKit computes from the full unclamped text when
the element sits inside a flex item. Two-line descriptions from `sm` up are bounded by an explicit
maximum height for the same reason.

## One Unreachable Model Endpoint No Longer Stalls Every Other Chat

When a model endpoint could not be reached — typically a local vLLM behind a VPN that was not
connected — a chat to that model hung for the full 5-minute request timeout, and while it hung,
chats from other users to other, healthy models hung as well. Pages and menus kept loading; only
answers stopped.

The cause was hostname resolution. Node resolves hostnames on a small shared threadpool and lets only
two lookups run at a time. A lookup for an unreachable host blocked one of those slots for the
operating system's resolver timeout, could not be cancelled by stopping the chat, and one chat turn
issued several of them. Every other outbound request in the process then waited in the queue.

- Outbound connections now share one lookup per hostname, give up on a lookup after 5 seconds, and
  remember a failed host for 30 seconds so new requests to it fail immediately. A chat to an
  unreachable model fails within seconds with "endpoint could not be reached", and other chats are
  unaffected.
- A connect timeout is no longer retried, and a failed model auto-discovery is remembered for 60
  seconds, so a dead endpoint is probed once rather than five times per message.
- The server sizes Node's threadpool to 16 threads unless `UV_THREADPOOL_SIZE` is set.
- New environment variables: `DNS_LOOKUP_TIMEOUT_MS` (default `5000`), `DNS_NEGATIVE_CACHE_MS`
  (default `30000`), `UV_THREADPOOL_SIZE` (default `16`). See
  [Server Configuration](../../server-config.md).
- A chat request whose `Accept-Language` header is not a language tag (`*`, sent by some HTTP
  clients) no longer fails with an internal error; the platform's default language is used for date
  formatting in prompts.

## The Footer No Longer Covers Content on Small Screens

The footer sat in a fixed band at the bottom of the viewport and stayed there while the page
scrolled behind it, cutting off the bottom of every page longer than the screen. On a phone, where
the copyright line and the footer links stack into two rows, it took away roughly a seventh of the
screen for the whole visit. The footer now comes after the content: it is off-screen until you
scroll to the end of the page, and pages shorter than the viewport still show it along the bottom
edge.

- Applies to the apps list, the prompts library, the workflows page and all custom pages — every
  view that shows the footer. App and admin views are unchanged.
- Pages now scroll as a document rather than inside the content area, which also makes the header
  stay put while scrolling instead of only appearing to.
  
## Gemini Models Failed With a Bare `400` After Google Moved the `-latest` Aliases

Every shipped Gemini model configuration still carried the Gemini 2.5 thinking settings
(`thinking.budget` / `thinking.thoughts`). Google's Gemini 3 endpoints reject those fields with a
bare `400 INVALID_ARGUMENT` that names no field, so once Google hot-swapped `gemini-flash-latest`
— the default model for a fresh installation — to a Gemini 3 release, chat requests started
failing with an error that gave no clue what was wrong.

All shipped Gemini configurations now use the Gemini 3 `thinking.level` setting, and existing
installations are migrated on upgrade. A thinking level you set yourself is left untouched.

## Anthropic Web Search No Longer Truncates Long Searches or Fails the Answer When Unavailable

Two failure modes of native web search on Claude models are now handled.

- When Anthropic pauses a long search turn (`stop_reason: pause_turn`), the answer used to end
  where the pause happened. The paused turn is now continued automatically on a follow-up request
  (up to three times per call), so the user gets the complete answer.
- When the provider rejects native web search — web search disabled for the organisation in the
  Claude Console, a model or gateway that does not support the tool — the whole chat request used
  to fail. The call is now retried with Brave Search instead, and the model is remembered as unable
  to search natively for 15 minutes so later answers skip the failing request.
- No configuration changes are required.

## The Admin Dashboard No Longer Waits for the GitHub Update Check

On installations without outbound internet access, the admin start page showed nothing but grey
loading placeholders. The dashboard was waiting for the update check against `api.github.com`, which
never answered — where a firewall drops packets instead of refusing them, the request hung until the
operating system's TCP timeout, minutes later. The update check now runs on its own and the page
renders immediately.

- The check aborts after 1 second. Set `VERSION_CHECK_TIMEOUT_MS` (or
  `IHUB_VERSION_CHECK_TIMEOUT_MS`) to change that, for example on slow links or through a strict
  proxy.
- Results and failures are both cached for 5 minutes, so opening the dashboard no longer triggers a
  fresh request to GitHub every time. The admin endpoint answers from that cache and refreshes in
  the background, so it never blocks on the network.
- If the check fails or times out, the dashboard and the **Updates** page render fully — only the
  "new version available" badge is missing. The **Updates** page shows the version cards regardless.
- To stop the server contacting GitHub at all, `NO_VERSION_CHECK=true` still applies and skips the
  request entirely.

## MCP Tools Now Advertise Their Inputs Again

External MCP clients (Claude, IDE agents, and other integrations) could connect to the iHub MCP
gateway and list its apps and workflows, but every tool showed up with no input fields. Any call
then failed with `Missing required argument: 'message'`, because the client had no schema telling it
to send a message in the first place. The gateway now advertises the correct inputs for each tool.

- App tools expose `message` (required) plus any variables the app defines.
- Workflow tools expose `input` (required) plus the workflow's start-node variables.
- Native tools expose their full parameter set, including choices and nested fields.
- No configuration change is needed — reconnect the MCP client and the fields appear.

## Integration Tools Like iFinder Now Work Through the MCP Gateway

Native integration tools (iFinder document search, Entra people search, Jira, and others) run on
behalf of the signed-in user and previously failed over MCP with "iFinder access requires
authenticated user". The gateway now passes the connected caller's identity to every native tool
call, so these tools work end-to-end from an MCP client.

- Each iFinder function — `search`, `getContent`, `getMetadata`, `discover` — is exposed as its own
  MCP tool with the correct arguments.
- A tool only appears if it is reachable through an app the caller can access, `mcpServer.expose.tools`
  is enabled, and the client's token carries the `mcp:tools:read` / `mcp:tools:call` scopes.
- Callers cannot impersonate another user through tool arguments — the gateway always uses the
  authenticated identity.

## Choose a Model When Invoking an App Over MCP

App tools exposed over MCP now accept an optional `modelId` argument, so a client can run an app with
a specific model instead of only the app's preferred one.

- Apps that restrict their models advertise the allowed ids as a fixed choice list.
- Apps configured to hide model selection do not expose the option.
- An unknown or incompatible model falls back to the app's preferred model rather than failing.

## Audit Log Filters Now Actually Filter

Selecting a resource, action, result or source on **Observability → Audit Log** left the table
unchanged and the dropdown snapped straight back to "All". The page changed two URL parameters at
once — the filter and the page number — and the second change silently discarded the first, so the
filter never reached the server. Filters now apply on the first click, and a shared or bookmarked
filter link opens the view it describes.

- Changing the rows-per-page value on the audit log had the same problem and reverted to 50. It now
  sticks.
- The resource list no longer offers `provider`, which nothing ever writes, and no longer omits
  `tool`, `credential`, `integrations`, `uiConfig` and the other types that do occur. The options
  are read from the log itself, so nothing can go missing.
- The actor list covers every actor in the selected date range, not just the ones on the page you
  happen to be looking at.
- `mcp` is gone from the source filter. No code path writes it, so selecting it could only ever
  return an empty table.
- The audit log page is now translated. The German UI previously showed it entirely in English.
- CSV export uses the same filters as the table, including the new ones, so an export always matches
  what is on screen.
  
## Crashes in Error Handlers Fixed

A group of error handlers referenced a variable name that did not exist in that scope, so whenever
the original problem occurred the handler itself threw a `ReferenceError` instead of logging the
cause. The real failure was lost, and in a few places a clean failure turned into a hard crash.

- Proxy authentication now logs and recovers from JWKS fetch and JWT verification failures instead of
  throwing inside the handler.
- Short link redirects, admin config saves, prompt/skill/style loading, marketplace skill installs,
  usage rollups, SharePoint drive listing, and workflow execution recovery all log the actual error
  again.
- Workflow registry recovery re-throws the original error instead of a `ReferenceError`, so unexpected
  filesystem problems surface with their real message.
- An SSE chat connection that fails during setup now reports the error against the right chat id
  rather than crashing the handler a second time.
- The tool-calling entry point (`createConverter`, `ToolCallPatterns.*`) threw on every call because
  the helpers it uses were re-exported but never imported locally. They now work.

Lint now enforces `no-undef`, so this class of bug fails the build rather than shipping.

## Rotated Identity Provider Signing Keys Are Picked Up Without a Restart

Proxy authentication cached each provider's JWKS document forever. When an identity provider rotated
its signing keys, every token signed with a new key failed verification — users were locked out until
the iHub process was restarted. The cache now expires.

- A JWKS document is re-fetched after 10 hours, or immediately when a token arrives with a key id the
  cached document does not contain (at most once every 5 minutes per provider, so unknown key ids
  cannot be used to hammer the provider).
- If a refresh fails, the previously cached keys keep working instead of rejecting every request while
  the provider's JWKS endpoint is briefly unreachable.
- The JWKS request still goes through the platform's configured HTTP proxy and TLS settings.
- No configuration change is needed.

## Crashes Outside a Request Are Logged Instead of Disappearing

An exception or rejected promise raised outside Express's request handling — in a background job, a
timer, or a streaming callback — terminated the process with nothing written to the application log,
leaving no trace of what failed.

- Unhandled promise rejections are logged with their message and stack, and the server keeps running.
- Uncaught exceptions are logged and the process then exits deliberately. With `WORKERS` above 1 the
  affected worker is respawned automatically, as it already was for any other worker exit.
- The standalone binary already behaved this way; the regular server now matches it.

## Streaming Works Behind HTTP/2 Reverse Proxies

Chat responses and long-running tool jobs stopped mid-stream — or never started — for users behind a
reverse proxy that serves iHub over HTTP/2, typically shown in the browser as
`ERR_HTTP2_PROTOCOL_ERROR`. iHub sent a `Connection: keep-alive` header on its event-stream
responses; that header is forbidden in HTTP/2, so a proxy that forwards it instead of removing it
produces a stream strict clients reject outright.

- The header is no longer sent on chat streaming or job progress responses. HTTP/1.1 keeps
  connections alive on its own, so nothing changes for deployments served over HTTP/1.1.
- The same header is no longer sent on outbound calls either — to the iAssistant conversation API and
  when fetching web pages for URL sources and the web content extractor — so those requests survive
  an intermediary that converts them to HTTP/2.
- No configuration change is needed.

## New workflows could not be saved

Creating a workflow from **Admin → Workflows → Create New Workflow** started from an empty
definition, which the workflow schema always rejected: it requires at least a Start and an End step,
plus a non-empty name and description. Saving therefore failed no matter what was entered, and the
visual editor could never be opened for the new workflow.

- New workflows now start from a valid template that already contains a **Start** and an **End**
  step, connected, along with a pre-filled name and description that can be edited afterwards.
- The visual editor's own "new workflow" canvas uses the same template, so both entry points behave
  identically and a new workflow can be saved immediately and then arranged on the canvas.

## One Unreadable Document No Longer Ends a Whole Workflow Run

A loop stopped at the first round that failed. In a pass over a document corpus that meant a
single file in an unsupported format — a zip among the PDFs — ended the run, leaving every
remaining document unread and the report showing "14 identified, 0 processed".

- Loops take a new `onItemError` option: `stop` (the existing behaviour, still the default) or
  `skip`, which records the failure and moves to the next item. All four shipped per-document
  loops now skip, so an unreadable file costs you that file and nothing else.
- A companion `recordFailuresInto` path collects one entry per skipped round — the item, the step
  that failed and its error — so a report can say what was left out instead of quietly
  under-counting. The shipped workflows collect into `_coverage.failed`.
- The visual editor exposes both as **If a round fails** and **Record skipped rounds in**.

## Progress Notes Are Translated

A step's progress note was a plain string, so a workflow written in German announced
"Lade Dokument 1/12" to English readers too. `progress.message` now accepts a localized object
like every other author-written string and is resolved against the language the run was started
in; plain strings keep working for single-language workflows. The shipped German workflows have
English translations for every note, and the editor's **Progress note** field offers the same
**+ i18n** control as other localized fields.

## Workflow Editor: Unreadable Fields in the Start and Human Steps

The Start step's input-variable rows showed a type dropdown and a required checkbox but no
readable name field: the select carried both a fixed width and the shared full-width class, and
the latter won, collapsing the name box to a few pixels. The Human step's option rows had the same
problem with three fields competing for one row. Both now give each text field a row of its own,
which also leaves room for variable names longer than a few characters.

## Tool Calling Over the Inference API Works With Google Models Again

An external application calling the OpenAI-compatible Inference API with a Google model and tools
got the first tool call back fine, then failed the moment it sent the tool result:
`HTTP 400 ... Function call is missing a thought_signature in functionCall parts`. Gemini's thinking
models attach a **thought signature** to a tool call and require it back in the conversation
history; the OpenAI response format has no field for it, so iHub was dropping it on the way out.

- Tool calls returned by the Inference API now carry the signature in
  `extra_content.google.thought_signature`, the same location Google's own OpenAI-compatibility
  layer uses. Callers that echo the assistant message's `tool_calls` back unchanged keep full
  multi-turn tool calling.
  This is the field Gemini-aware OpenAI clients already look for, so agents like Hermes Agent
  work against iHub unchanged.
- Signatures echoed back in that field — or in the flat `thought_signature` variant some clients
  use — are accepted and forwarded to Gemini, on the same tool call they arrived on. Gemini signs
  only the first tool call of a response, so parallel calls after it correctly carry no signature.
- Clients that strip unknown fields no longer break the conversation: iHub substitutes Google's
  documented skip-validation value for the missing signature so the request succeeds, and logs a
  warning. Those turns lose the model's preserved reasoning context, so echoing the real signature
  is still the better path.
- Only affects Google models — no other provider's responses gain the field. Because strict
  providers such as Mistral reject a request that carries it, it is also stripped from outgoing
  requests whenever the target model is not Gemini-family, so replaying a Gemini conversation
  against another model stays safe.
- **Name Gemini models with `gemini` (or `gemma`) in the model id.** OpenAI-compatible clients
  decide whether to replay the signature by matching the model name — it is the only signal they
  have on a generic endpoint — so a Gemini model published under an unrelated id falls back to the
  degraded path.
- In-product chats, workflows and agents were never affected; they already preserved signatures
  internally.

## Admin APIs Reject Tokens That Only Act on a User's Behalf

The admin and content-admin APIs decided access purely from the caller's group membership, so any
token belonging to an administrator reached them — including OAuth service-account tokens and
tokens issued to an external app through the authorization code flow. The rest of the codebase
already treats those principals as never-admin, but the two middlewares never checked.

- `adminAuth` and `contentAdminAuth` now refuse OAuth client credentials, static API keys,
  authorization-code tokens, personal API keys and agent principals outright, whatever groups the
  underlying user holds.
- Browser sessions are unaffected: an administrator signed in to the web UI keeps full access.
- Non-admin APIs are unaffected: a token still reaches chat, models and the MCP gateway with its
  owner's normal permissions.

## Inference API Reports Real Usage and Surfaces Errors In-Band

The OpenAI-compatible inference API (`/api/inference/v1/chat/completions`) used to return zero
token counts and turned a provider failure mid-stream into a normal `finish_reason: "stop"`.

- `usage` now carries the provider's actual prompt and completion counts, and
  `stream_options.include_usage` is honoured for streaming requests.
- A provider error during a stream is sent as an OpenAI-style `error` event followed by exactly
  one `[DONE]`, so clients can tell a failed answer from a complete one.
- A client that disconnects mid-stream now aborts the upstream model call instead of letting it
  run (and bill) to completion.
- Error responses carry `{ error, code, details }` with the provider's status where applicable,
  instead of the untranslated literal `Error: providerError`.

## MCP App Invocations Execute Tools and Receive App Variables

Invoking an app through the MCP gateway (`tools/call`) or as a tool inside another app dropped
the model's tool calls and silently ignored the app's variables. App invocations now run the same
loop as a chat turn: tools execute server-side, passthrough tools' output becomes the answer, and
variables reach the prompt template. A question the model asks (`ask_user`) is refused with a
clear `NO_USER_AVAILABLE` result, since nobody can answer it there.

## Provider Response Parsing Fixes Found by the Adapter Conformance Matrix

A wire-level conformance suite now runs every provider adapter through the same scenarios. It
surfaced two parsing bugs that are fixed: Anthropic non-streaming responses lost their token
usage, and OpenAI Responses-API tool-call argument deltas were merged incorrectly.

## Chat Apps Know Today's Date Again

Chat apps answered questions about "today", "this week", "the latest" or "most recent" using dates
from their training data, and web search apps were the worst affected because recency is the whole
point there. The current date was only ever available as a `{{date}}` / `{{platform_context}}`
placeholder that an app prompt had to reference itself, and no shipped app did.

- The platform context from **Platform → Global Prompt Variables** is now prepended to every chat
  app's system prompt, so the model reads the current date and timezone before its instructions.
- An app that positions `{{platform_context}}` or `{{date}}` itself is left alone — no duplication.
- Workflow steps were already grounded this way; chat now matches them.
- To switch it off, clear `globalPromptVariables.context` in the platform configuration.

## Web Search Answers Are No Longer Shortened on Large-Context Models

Answers from tool-heavy apps — web search above all — became noticeably shorter and shallower,
because older search results and extracted pages were being collapsed to a short preview while
they were still relevant. Chat reused a context-compaction limit of 16,000 tokens that was sized
for workflow steps, regardless of how much room the model actually had.

- The limit now scales with the selected model's context window, so a 128k model keeps roughly
  64,000 tokens of tool output and a 1M model far more.
- Models with a small context window keep the previous 16,000-token behaviour.
- Compaction still protects long conversations from unbounded prompt growth.

## An Unreachable Model No Longer Makes Every Model Look Broken

Selecting a model whose endpoint could not be reached — a local or VPN-only server while the VPN
was down — left the request hanging for the full five-minute request timeout. Each hung chat used
up one of the browser's few connections per site, so after a couple of attempts the whole
interface stopped responding and unrelated models appeared broken too.

- Reaching a provider is now capped separately from generating a response: if no response headers
  arrive within 10 seconds, the call fails with a clear timeout instead of hanging.
- Slow but healthy providers are unaffected — only the connection phase is limited, and a long
  answer still has the full request timeout to stream.

## Multi-Worker Startup No Longer Races Over Its Own Configuration

Starting with more than one worker (the default is four) logged "Configuration migration failed"
errors, because every worker seeded `contents/` and ran the configuration migrations at the same
time and all but one lost the race for the migration lock.

- The main process now performs the initial setup and migrations once, before starting any worker,
  so migrations are always finished before a worker reads the configuration.
- A second race is fixed alongside it: on a first start, workers could read a half-written
  `.encryption-key` and reject it as invalid, leaving a worker running without a persisted key.
  Key files are now published atomically, so a worker either sees no key file or the complete key.

## All Cluster Workers Now Share One JWT Secret

On a first start with more than one worker, every worker generated its own JWT signing secret and
wrote it over the others', so the file kept whichever worker finished last while each worker kept
signing with the secret it had generated. A token issued by one worker then failed verification on
the others, logging users out on a fraction of requests under round-robin routing.

- The first worker to persist a secret wins and the rest adopt it, so the whole cluster signs and
  verifies with the same secret.
- Existing installations already have a persisted secret and are unaffected.

## Stopping the Server No Longer Takes Five Seconds of Serving Traffic

Sending a stop signal to a multi-worker server shut its workers down and then immediately started
replacements, so the cluster kept answering requests for another five seconds until the main
process force-exited — cutting off whatever those new workers had picked up. `docker stop` and
Kubernetes rollouts sat out their full grace period on every restart.

- Workers are no longer replaced once a shutdown has begun, and the main process exits as soon as
  the last one is gone (about a second, instead of five).
- A second stop signal during shutdown is ignored instead of re-killing the workers.

## Web Search Apps No Longer Ask for Tools That Were Removed

App prompts still told the model to call `enhancedWebSearch`, `google_search` or `web_search` by
name. Those tools were consolidated into the app's **Web Search** setting a while ago, so the model
kept requesting a tool that no longer exists, wasting a round of the conversation each time — most
visibly on search-heavy apps whose prompts insisted on using them for every request.

- Prompts that name a removed search tool are rewritten to refer to web search generically.
  Surrounding wording is preserved, so customized prompts keep their text.
- The leftover tool definitions (`enhancedWebSearch`, `webSearch`, `googleSearch`, `tavilySearch`)
  are removed. `braveSearch` and `webContentExtractor` are unaffected.
- Web search itself is unchanged: it still runs natively on providers that support it, falling back
  to Brave Search otherwise.

## Recovering a Run After a Worker Restart Keeps the Run Log Consistent

When the worker that owned a run went away, two surviving workers could each record an event for it
and then one of them resumed the run using a position it had already passed, writing two entries
under the same sequence number in an append-only log.

- A worker taking over a run now re-reads the stored log first, so entry numbering always continues
  after the last recorded event.

## Mermaid Diagrams Stop Re-Rendering on Every UI Change

Diagrams in a chat answer flickered and rebuilt themselves whenever anything on the page changed —
hovering a message, resizing, scrolling, or a new token arriving — and opening one fullscreen showed
it for a moment before the view went blank.

- Diagram containers now get an ID derived from the diagram source, so re-rendering a message
  produces identical markup and the browser leaves the finished diagram in place.
- Rendered diagrams are cached, so a diagram that does have to be re-attached (navigating back to a
  conversation, for instance) reappears instantly instead of being drawn from scratch.
- Diagrams inside a message that is still streaming are left until the answer is complete, rather
  than being drawn and thrown away on every token.
- The fullscreen view scales the diagram to fit the window before showing it. Large diagrams
  previously landed outside the visible area, which looked like an empty viewer.
- Long chat sessions stay responsive: each re-render used to leave behind a keyboard listener and a
  pan/zoom instance that were never released.
- Moving the mouse onto a finished answer, or off it again, no longer redraws its diagrams. The
  rendered answer is now left alone when a message re-renders for an unrelated reason — such as its
  action row fading in on hover — instead of being rebuilt from the markdown each time.

## Web Search Reads Pages Again Instead of Answering From Snippets

A web search app answered from the short descriptions in the search result list
rather than from the pages themselves, so questions about a person or company
were answered out of stale directory entries and the **Extract page content**,
**Max results** and **Content length** settings had no effect no matter what
they were set to.

The tool definition in `contents/tools/` keeps whatever parameters it was
written with — initial setup only copies files that are missing — so an
installation from an earlier release never gained the parameters those settings
are applied to, and every assignment was silently dropped.

- Tool definitions now regain any parameters their shipped counterpart has.
  Your own descriptions, defaults and wording always win; only genuinely absent
  parameters are added.
- Web search extracts page content again (5 results, 3000 characters each by
  default), so answers are built from the pages rather than the result list.

## Thinking Steps No Longer Drift Down While an Answer Streams

The "Show thinking"/"Hide thinking" toggle for models with extended thinking was rendered below
the answer text, so each streamed chunk of the answer pushed it further down the message —
readers watching a long response come in had to keep scrolling to find it. The toggle is now
anchored above the answer and stays in the same place for the whole response.

## Dates in Prompts Are Spelled Out

The current date reached the model as `9/3/2026`, which reads as 3 September in
US format and as 9 March almost everywhere else — a model answering in German
could be six months out while looking entirely confident.

- `{{date}}` now renders the month by name and the weekday, localized:
  "Thursday, September 3, 2026" / "Donnerstag, 3. September 2026".
- A new `{{date_iso}}` variable gives the unambiguous calendar date
  (`2026-09-03`) in the user's timezone for prompts that compare dates.

## Context Token Counter Reflects the Whole Conversation

The `~x / y context tokens` line above the chat input only counted the message
being typed, so a long multiturn conversation still read as a few hundred tokens
right up to the point where the model rejected the request as too large. Everything
already in the chat is re-sent on every turn, but none of it was counted.

- The estimate now covers the app's system prompt, the full chat history including
  the text of attached documents, and the pending message — the whole prompt going
  out with the next turn.
- Turning **Send chat history** off drops the history from the estimate, matching
  what is actually sent.
- The counter appears as soon as a conversation exists, not only while typing, and
  turns amber above 85% of the window and red once the window is exhausted.

Sources and tool definitions are resolved on the server and are still not part of
the estimate, so it remains a lower bound; the provider's own count after each turn
stays authoritative.

## The Model Selector Fits the Screen on Phones

Opening the model list on a phone showed a panel that ran off the right edge of
the screen, so model names and descriptions were cut off mid-word, and the rows
sat at visibly uneven distances from one another.

The list was a fixed 20 rem panel pinned to the left edge of its button, which
sits at the right end of the chat toolbar — on a narrow screen there was no room
left for it. Row heights came out uneven because a description that fitted on one
line made a shorter row than one that wrapped onto two.

- On phones the model list now opens as a full-width sheet from the bottom of the
  screen, with the rest of the page dimmed behind it. Tapping outside the sheet
  closes it.
- Every row is the same height, so the list reads as an even column instead of
  randomly spaced blocks.
- On tablets and desktops the list is unchanged: it still opens as a panel next
  to the model button, with the fuller two-line descriptions.

## Starting a Chat From the Start Page Keeps Your Model on Slow Devices

Typing a message on the start page and pressing Enter opens the chosen app and
sends the message straight away. On a phone — or any device where the app and
the model list took a moment longer to arrive — the message was sent before the
app's settings had been applied, so it went out with no model at all and came
back as **Invalid request** instead of an answer. When it did get through, it
could still use the wrong temperature, because the app's configured value had
not been applied yet either.

- The message now waits for the app's model list before it is sent, so the model
  you picked on the start page (or the app's default) is the one that answers.
- Desktops were never affected: the fixed 100 ms head start the send used to
  rely on was always enough there, and always too short on a phone.

## A Model That Stops Mid-Answer No Longer Hangs the Chat for Five Minutes

If a model endpoint sent part of an answer and then went quiet — without
closing the connection or marking the answer finished — the chat stayed stuck
in its "answering" state: the text that had arrived sat on screen with the stop
button still lit, the typing indicator still running and no answer-source badge,
until the five-minute request deadline finally expired. Self-hosted
OpenAI-compatible servers are the usual culprits.

- Once an answer has started arriving, a gap of more than 60 seconds with no
  further data now ends the turn and reports that the endpoint stopped sending.
  The part of the answer that did arrive stays on screen and the message can be
  sent again.
- The wait *before* the first piece of an answer is unchanged, so a model that
  thinks for a long time before it starts writing is not cut off.

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
