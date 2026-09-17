# Fixes — 5.4.23

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

## Dates in Prompts Are Spelled Out

The current date reached the model as `9/3/2026`, which reads as 3 September in
US format and as 9 March almost everywhere else — a model answering in German
could be six months out while looking entirely confident.

- `{{date}}` now renders the month by name and the weekday, localized:
  "Thursday, September 3, 2026" / "Donnerstag, 3. September 2026".
- A new `{{date_iso}}` variable gives the unambiguous calendar date
  (`2026-09-03`) in the user's timezone for prompts that compare dates.
