# Artifact Creation Progress: Product Brief

Issue: [intrafind/ihub-apps#3534](https://github.com/intrafind/ihub-apps/issues/3534) "Chat: show tool
call progress while the model streams tool arguments (spinner-only for 1+ min on
`create_web_artifact`)". Request that started this brief: "improve our artifact creation".

| | |
|---|---|
| Document | 01 Product brief (what to build, in what order) |
| Author role | Product management |
| Date | 2026-11-09 |
| Status | Draft for product-owner review. No code has been written or changed. |
| Next documents | 02 Technical design (architect), 03 Test plan (QA / author of the tests). Add them next to this file as `02-technical-design.md`, `03-test-plan.md`. |

How to read this: sections 1 to 3 are the decisions and the reasoning. Sections 4 to 9 are the
requirements. Section 10 onward is for whoever builds it (risks, order of work, checklist). If you
only have five minutes, read the Decisions box and section 5.

## Decisions at a glance

1. **The problem is trust, not speed.** Nothing was hung; the UI gave no sign of life for about two
   minutes and the user pressed Stop. We fix that first.
2. **Smallest slice that fixes it:** a provider-independent "the model is still working" line with a
   running clock, so the screen is never a bare spinner. It needs no adapter change, so it works for
   every model. On top of it goes the richer "Creating web artifact... 12 KB, 0:41" row for providers
   that tell us early.
3. **Live artifact preview (HTML/SVG appearing in the Artifacts panel while it is generated) is a
   non-goal for release 1.** It is a gated fast follow, starting with the safest part (streaming the
   code into the Code tab, no execution). Reasons in section 3.
4. **Which tools:** a generic server-side rule, no hard-coded list. System-skill tools (the file and
   document creators) are announced immediately; every other visible tool is announced once its
   arguments have been streaming for 1.5 seconds. Section 6.
5. **Gemini and Mistral get the fallback, not the rich row**, because as implemented today their
   adapters only see a tool call once it is complete. Section 7.
6. **Success metric:** user Stop presses during a silent model call or tool-argument streaming,
   measured per phase. We ship the measurement first so we have a baseline. Section 11.
7. **Wire format:** additive. New `tool/progress` phases, no change to `tool/started`. Recommended
   shape in section 8, the architect confirms.

---

## 1. Executive summary

When a model writes a large tool call, the chat shows only a spinner. For the tools whose arguments
are the deliverable (`create_web_artifact`, `create_docx`, `create_pptx`, `create_xlsx`,
`create_pdf`, `create_file`, `create_zip`) that wait is the whole job: 60 to 120 seconds on a local
model. The server only announces a tool (`tool/started`) after the arguments are complete, so the
user sees nothing until the work is almost done.

Release 1 makes the wait legible: the user sees that something is happening, what it is, and that it
is progressing, on every provider (richer on those that can tell us early). It also lays the
measurement groundwork so we can prove the premature-stop rate went down.

Beyond progress feedback, the user's wording "improve artifact creation" points at two bigger
opportunities that we deliberately do not start now: a live preview while generating (section 3) and
making the retry loop cheaper (section 5, item P15). Both need the measurement and the evidence that
release 1 produces.

## 2. Problem framing

### Who suffers, how badly

| Who | Situation | Impact |
|---|---|---|
| End user on a self-hosted model (vLLM, LM Studio, Jan.ai) | Generation runs at 100 to 200 tokens per second, an artifact is 8k to 15k tokens | One or two minutes of apparent freeze per artifact. Highest severity, and this is IntraFind's own deployment (issue evidence: k3s01, Qwen3.6-35B). |
| End user on a hosted model | Faster, but a long deck or dashboard still takes 20 to 60 seconds | Same confusion, shorter. |
| Admin / support | "The chat is stuck" tickets that are not bugs | Support cost, loss of confidence in local models. |
| Screen-reader user | A silent spinner is invisible | Worst case: no feedback at all (see accessibility requirements). |

How bad: the failure is not an error, it is a wrong conclusion. The user cancels a healthy run, loses
the time already spent (and possibly the unfinished second artifact), and retries, which costs the
same wait again. A cancelled run also looks like a product defect.

A likely contributor to the length: in the evidence, the second 66-second call is "most likely a
second tool call (e.g. re-creating the artifact)". The `web-artifacts` skill instructs the model to
call `create_web_artifact` again when the first result carries warnings (see
`server/systemSkills/web-artifacts/SKILL.md`, "If `create_web_artifact` returns `warnings` ...").
Every such retry regenerates the whole file. **This is a hypothesis to verify** from the run ledger of
chat `chat-83b0fdd3-f4f5-49cf-9171-f2e36f583b4c` (see section 10, spike S0).

### Success metric

- Primary: the share of user Stop presses that happen while the model is silent (no visible output)
  or streaming tool arguments, as a fraction of turns that used a deliverable tool. Target: halve it
  within 30 days of rollout on instances that run local models. Details in section 11.
- Secondary: the first visible tool signal appears within 1.2 seconds (95th percentile, server-side)
  of the provider first sending the tool name, on providers that send it early.
- Guardrail: zero new orphan rows (a "preparing" row that never ends) and no growth in stored chat
  size.

### Smallest slice that fixes the trust problem

A line that says the model is working and shows a running clock after 3 seconds without visible
output. It is independent of the provider, of the tool and of the adapter code, and it fixes "I
cannot tell hung from working" for 100 percent of models. It is slice A in section 10. It does not
say what is being made; the rich row (slice B) adds that.

## 3. Scope decision: is a live artifact experience in scope?

Verdict: **non-goal for release 1; a gated fast follow (release 2) in three steps; live HTML preview
stays a non-goal until the steps before it have shipped and been reviewed.**

What "live artifact" means here: while the model generates `create_web_artifact`, the Artifacts panel
shows the file growing, and eventually the rendered page, before the tool call has finished.

| Consideration | Finding | Consequence |
|---|---|---|
| Value | High for demos and perceived speed. For a 60-second generation, watching the file appear is a much better wait than a counter. | Worth doing, but after the wait is legible. |
| The payload is not the HTML | The arguments are a JSON object streamed as text; `content` is a JSON-escaped string inside it (`\"`, `\n`, `<`). To show it we must decode a partial JSON string field incrementally. Field order is not guaranteed, so the `format` (html or svg) may not be known yet. | New incremental decoder with its own tests. Not a trivial addition to the progress work. |
| Security invariants | `webArtifactTools.js` states the invariant: html and svg are stored as `text/plain`, rendered only in `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc>` (HTML) or through DOMPurify (SVG). The server also inspects the file (`inspectWebArtifact`) and injects the brand tokens (`--brand-primary` etc.) before it is shown. | A live preview would show markup that has not been inspected or branded, and would run half-written scripts repeatedly inside the iframe (loops, side effects, CPU). The sandbox limits the damage but this is a security review item, not a refactor. |
| What may be shown is not what is stored | The final file can still fail (tool error, validation warning, user presses Stop). A download card only exists once the tool completes. | The panel must clearly mark "draft, not saved" or users will think a file exists that does not. |
| Adapter differences | Needs argument fragments. OpenAI-compatible, Anthropic and Bedrock can give them; Gemini and Mistral cannot (section 7). | Live preview would work on some models only. Inconsistent. |
| Volume and privacy | Streaming the content sends the same 40 to 60 KB twice (fragments, then the final file) and exposes argument text to the client earlier than today (it is sent only in `tool/started` today). Release 1 deliberately carries no argument content. | Needs its own size limits and a decision on shared/read-only chat viewers. |

Recommended ladder (each step is shippable on its own and each carries more risk than the one before):

| Step | What | Risk | Entry condition |
|---|---|---|---|
| R2a | Stream the raw text of `content` into the **Code** tab of the Artifacts panel while generating. Text only, shown by the existing code viewer (highlight.js plus DOMPurify). Nothing executes. | Low | R1 shipped and metric moving; argument fragments reach the loop for OpenAI-compatible and Anthropic; incremental string decoder tested. |
| R2b | Live **SVG** preview (sanitised with DOMPurify, no scripts exist in SVG after sanitising). | Low to medium | R2a stable; flicker acceptable. |
| R3 (revisit) | Live **HTML** preview with scripts stripped until the call completes, then the real sandboxed render. | Medium to high | Security review sign-off; product decision that "draft" labelling is acceptable. |

## 4. What the code does today (grounding)

These facts were read from the repository on 2026-11-09. They drive every decision above and below.

1. **The announcement is late by construction.** `chatToolSeam.preTool` in
   `server/services/chat/chatSeams.js` emits `tool/started` (with `title`, `integration`,
   `activityKind`, `activityScope` from `server/utils/toolDisplay.js`). The loop calls `preTool` in
   `server/services/loop/AgentLoop.js` only after `stream.result()` and after the arguments were parsed
   (`repairToolArguments`).
2. **The loop already sees every chunk.** In `AgentLoop.js` the `for await (const chunk of stream)`
   loop calls every seam's `onChunk(ctx, chunk)` and the channel's `onChunk`. A chunk is the generic
   shape from `normalizeChunk` in `server/services/loop/LLMClient.js` (`content[]`, `thinking[]`,
   `tool_calls[]`, `finishReason`, unknown fields pass through). So the place to observe a streaming
   tool call exists; `chatToolSeam` just has no `onChunk` yet.
3. **Most converters hide the early signal.** They keep a half-built call in private state and only
   put a finished call into `tool_calls`:
   - `OpenAIConverter.js` and `VLLMConverter.js`: `state.pendingToolCalls` is filled from
     `delta.tool_calls` (name and id on the first delta, arguments as fragments); the call is emitted
     at `finish_reason` or `[DONE]`.
   - `AnthropicConverter.js`: `content_block_start` (`tool_use`, with name and id) sets
     `state.pendingToolCall`; `input_json_delta` fragments accumulate; the call is emitted at
     `content_block_stop`.
   - `bedrock.js` (event stream): `toolUseBlocks` map filled at `contentBlockStart`, emitted at
     `contentBlockStop`.
   - `OpenAIResponsesConverter.js` is the exception: it already emits the name
     (`response.output_item.added`) and each `function_call_arguments.delta` as partial `tool_calls`
     deltas, and `mergeToolCallDeltas` (`server/services/loop/toolCallMerge.js`) already merges them.
   - `GoogleConverter.js`: a `functionCall` part becomes a finished call as soon as it has a name; a
     part without a name is ignored (logged). No incremental arguments are used.
   - `MistralConverter.js`: tool calls are pushed straight from each chunk without accumulation,
     which only works if Mistral sends whole calls. Inference, to verify.
4. **There is an existing free-form progress frame.** `tool/progress` (`phase`, `message`, `data`,
   `callId`, `toolId`) is already in `shared/runEvents.js`, the Zod contract
   (`server/services/loop/contracts/sseV2.js`, `phase` is a free string, `data` is `any`) and
   `docs/sse-v2.md`. Adding phases needs no contract change.
5. **Stored activity is allow-listed.** `server/services/chat/runActivity.js` keeps only the
   `tool/progress` phases in `RECORDED_PROGRESS_PHASES` (`search.status`, `skill.activation`,
   `grounding`). A new phase is not stored unless added, which is what we want. `tool/started` is
   stored, which is a reason not to overload it.
6. **The client reducer appends every `tool/progress` frame** to `run.progress`
   (`shared/run/runReducer.js`). A once-per-second frame would grow that list for the whole wait, so
   the new phases must update one entry instead.
7. **The client builds rows from `run.tools`.** `shared/run/toolActivity.js` turns `tool/started` and
   `tool/completed` into rows; `ToolActivity.jsx` draws them ("Running {{name}}"). It hides
   `activate_skill` and `ask_user` and non-server executions. Strings live in
   `shared/i18n/en.json` and `de.json` under `toolActivity.*`.
8. **The approval gate runs before the announcement.** `approvalSeam.preTool` returns `handled` for
   a call that needs approval, so `chat-tools` never emits `tool/started` for it. An early row for such
   a call would be left dangling unless something closes it.
9. **System-skill tools carry a marker.** `systemSkillToolsFor` in `server/services/systemSkillTools.js`
   sets `isSystemSkillTool: true` on the eight tools (`create_pdf`, `preview_pdf`, `create_docx`,
   `create_pptx`, `create_xlsx`, `create_web_artifact`, `create_file`, `create_zip`). Loop-internal
   tools (skills, tool search) are `isInternalTool`. Clarification tools are `interactive`. Caller-run
   tools are `passthrough`.
10. **Stopping already has a cause.** `server/services/chat/abortCause.js` records why a turn was
    aborted (`user_stop` among others) on the ledger `run/end`. The OpenTelemetry counter
    `ihub.stream.outcome` (`completed`, `aborted`, `error`) is recorded per call in
    `server/services/chat/chatTelemetry.js`. Metric labels must come from the allow-list in
    `server/telemetry/metrics.js`.
11. **Thinking is already streamed.** `chatChannel.onChunk` emits `step/delta` with `kind: 'thinking'`
    whenever a chunk has `thinking`, and the reducer collects it into `run.thinking`. The client knows
    reasoning is happening even when it does not show it, so "Thinking..." needs no new server field.

## 5. Prioritisation (MoSCoW) and release plan

Release names: R0 is a small preparatory change, R1 is the feature, R2 is the gated fast follow.

| ID | Item | Class | Release | Why |
|---|---|---|---|---|
| P1 | Announce a tool call as soon as its name is known in the stream (issue item 1) | Must | R1 | The core of the issue. |
| P2 | Throttled progress while arguments stream: size and elapsed time, at most about 1 per second (issue item 2) | Must | R1 | Without growth the row looks frozen too. |
| P3 | No orphan rows: every announced call ends in a defined state (ran, stopped, refused, handed to approval) | Must | R1 | A permanent spinner is worse than today. Added by PM. |
| P4 | Provider-independent liveness: "the model is still working" with a running clock after 3 s without visible output | Must | R1 (slice A, first) | The only thing that works for Gemini, Mistral and a vLLM parser that buffers. Added by PM. |
| P5 | Measurement: record the phase in which a turn was aborted, and ship it before the feature to get a baseline | Must | R0 | Without it we cannot show the metric moved. Added by PM. |
| P6 | Label a repeated call of the same deliverable tool in one turn: "again (2)" (issue item 3). The separate second row itself is Must and comes free from the distinct call id. | Should | R1 | Cheap, explains the second wait. |
| P7 | "Thinking..." instead of a bare spinner when reasoning streams but is not shown (issue item 4) | Should | R1 | Cheap once the liveness line exists. Lowest evidence: the issue's own evidence points at tool arguments, not reasoning. |
| P8 | Show the file name being created ("Creating roi-calculator.html...") | Should | R1 if the spike shows a small partial-JSON peek is enough, otherwise R2 | Strong trust cue. Depends on the model writing `filename` before `content`, which the tool schema order encourages but cannot guarantee. |
| P9 | Diagnostics: log and span attributes for argument stream duration and size | Should | R1 | Lets ops explain "why was that slow" without a debugger. |
| P10 | Early signal for Bedrock (same pattern as Anthropic) | Should | R1, or the first follow-up if it makes slice B too large | Same work, separate code. |
| P11 | "This is taking long" hint after about 90 s, with a way to stop | Could | R2 | Nice, risks nagging; decide after we see real timings. |
| P12 | Stream `content` into the Code tab (R2a, section 3) | Could | R2, gated | |
| P13 | Live SVG preview (R2b) | Could | R2 or later | |
| P14 | Live HTML preview (R3) | Won't (now) | Revisit after R2 | Security review needed. |
| P15 | Make retries cheap: a patch-style update tool, or server-side auto-fix of mechanical warnings (missing `viewBox`, unguarded `localStorage`) instead of a full regeneration | Should consider | Decide after S0 | If the second long call in the evidence was a warning retry, this removes a 60-second wait outright and is worth more than any counter. Needs its own brief. |
| P16 | Early signal for Gemini and Mistral | Won't | Until the providers stream arguments and the adapters use it | They get the P4 fallback. |
| P17 | Workflow and agent run pages | Won't | Later | Same signals could feed them; release 1 is the chat surface only. |
| P18 | Admin setting to switch the feature off | Won't | | Fewer knobs; additive and cheap. Revisit if a customer finds it noisy. |

Release 1 therefore contains P1, P2, P3, P4, P6, P7, P9, P10 and, conditionally, P8, on top of the R0
baseline P5.

## 6. Which tools get the treatment

Recommendation: **a server-side rule with two criteria and one exclusion list that is derived from
existing server flags, not a hard-coded tool-id list.** The client never decides (repo rule "Run
Activity: the Server Decides, the Client Renders").

A tool call is announced as "preparing" when all of these hold:

1. **It resolves to a known, visible, server-run tool.** The tool name matches a tool definition the
   loop offered. A name that matches nothing (a hallucinated name; the synthetic `json` tool the
   Anthropic adapter uses for structured output) is never announced. Tools flagged `interactive`
   (`ask_user`), `isInternalTool` (skills, tool search) and `passthrough` (caller-run) are never
   announced. This mirrors what the chat already hides.
2. **And at least one of:**
   - (a) **It is a system-skill tool** (`isSystemSkillTool === true`). Its arguments are the
     deliverable, so it is announced the moment the name is known. This covers the eight document and
     file creators with no list to maintain: a new system-skill tool gets the behaviour automatically.
   - (b) **Its arguments are still streaming 1.5 seconds after the name was first seen.** This covers
     any other tool with a large argument (an MCP tool that creates a page with a long body, an
     integration action) without naming it. A tool that finishes its arguments in under 1.5 s (search,
     page read) shows nothing extra and behaves exactly as today. This is why there is no flicker for
     the common fast case.

Why not "every tool": it adds a frame and a state change to every small call for no benefit, and
multiplies the surface for the orphan-row problem (section 10, risk R3). Why not "only
`create_web_artifact`": the issue names five tools, and the same wait exists for each.

The server also sends `occurrence` (how many times this same tool has been called in this turn), but
only for calls matching criterion 2(a) or 2(b), so that cheap repeated searches never read "again (4)".

## 7. Provider expectations and graceful fallback

"Early signal" below means: the provider sends the tool name before the arguments are finished, and
(for progress) sends argument fragments while the model generates. "Graceful fallback" always means
the P4 liveness line, never a regression to a bare spinner and never an error.

| Adapter (file) | What it streams | Early name | Argument progress | Converter today | Release 1 expectation | If it cannot |
|---|---|---|---|---|---|---|
| OpenAI chat completions (`openai.js`, `OpenAIConverter.js`) | `delta.tool_calls[i]` with id and name first, then argument fragments | Yes | Yes | Buffers in `pendingToolCalls`, emits at finish | Full row (P1, P2) | n/a |
| vLLM (`vllm.js`, `VLLMConverter.js`) | Same wire format | Yes, if the server's tool-call parser streams incrementally | Same | Same buffering | Full row, after spike S0 confirms it for the Qwen parser in use | The parser may buffer until the whole call is parsed. Then the provider sends nothing during generation and only P4 can help. This is the single biggest risk to the issue's own scenario. |
| OpenAI Responses (`openai-responses.js`, `OpenAIResponsesConverter.js`) | `output_item.added` (name), `function_call_arguments.delta` | Yes | Yes | Already emits partial `tool_calls` deltas | Full row, needs only the loop-side consumer | n/a |
| Anthropic (`anthropic.js`, `AnthropicConverter.js`) | `content_block_start` tool_use (name, id), `input_json_delta` | Yes | Yes, but Anthropic may send fragments in bursts | Buffers in `pendingToolCall`, emits at `content_block_stop` | Full row. Sizes may jump in steps; the elapsed clock keeps the row alive between bursts. | Clock only (P4 behaviour) |
| Bedrock (`bedrock.js`) | `contentBlockStart` toolUse (name, id), `contentBlockDelta` input fragments | Yes | Yes | Buffers in `toolUseBlocks` | Full row (P10, Should) | P4 |
| Google Gemini (`google.js`, `GoogleConverter.js`) | A `functionCall` part, complete, in one chunk | No (as implemented) | No | Emits a finished call when the part arrives; partial parts without a name are ignored | **Fallback only (P4)** | P4. Google's optional partial-argument streaming is not used today; out of scope (P16). |
| Mistral (`mistral.js`, `MistralConverter.js`) | `delta.tool_calls` carrying whole calls (inferred) | No | No | Pushes straight through | **Fallback only (P4)** | P4 |
| iAssistant conversation | No tool calling | n/a | n/a | | n/a | n/a |

Expectation to put in the acceptance test: for a provider without an early signal the visible
behaviour after this release is **strictly better than today** (P4 appears after 3 s) and **never
different in outcome** (the tool still runs, the file is still created, the final frames are
identical to today).

## 8. Requirements

### 8.1 User stories

Each story traces to the success metric in section 2.

- **US-1 Know what is happening.** As a chat user waiting for a generated document, I want to see
  that the model is creating it (and what kind of thing), so that I do not stop a run that is working.
- **US-2 Know it is still alive on any model.** As a chat user on a model whose provider gives no
  early signal, I want a visible "still working" indication with a running clock, so that a silent
  minute does not look like a freeze.
- **US-3 Understand a second wait.** As a chat user, I want a second generation of the same kind to
  appear as its own entry marked as a repeat, so that a second long wait is explained.
- **US-4 Know the model is thinking.** As a chat user whose model reasons without showing it, I want
  "Thinking..." instead of a bare spinner.
- **US-5 Diagnose slowness.** As an administrator, I want the argument stream duration and size of
  slow calls in the logs and traces, so that I can tell a slow model from a stuck system.
- **US-6 Accessible waiting.** As a screen-reader user, I want to be told once that a long creation
  started and once that it finished, without a constant stream of updates.
- **US-7 My language.** As a German-speaking user, I want every new string in German, with local
  number formatting.

### 8.2 Acceptance criteria (Given / When / Then)

Numbers (1.5 s, 3 s, 1 Hz) are the proposed defaults; they are named constants, not requirements to
hard-code in several places.

**AC-1 Early announcement (US-1, OpenAI-compatible and Anthropic)**
- Given an app with the `web-artifacts` skill and a model whose stream sends a tool call named
  `create_web_artifact`
- When the first fragment carrying the name arrives
- Then within 1 second of that fragment being read by the server, one frame announces the call, and
  the chat shows a row titled from the tool definition (localised, from `toolDisplayOf`) with a
  spinner, before any argument is complete
- And no frame of this feature contains any part of the argument text.

**AC-2 Progress (US-1)**
- Given a call whose arguments stream for 60 seconds
- When progress is projected
- Then the server emits at most one progress frame per second per call and at least one every 2
  seconds while fragments flow; each frame carries absolute values (characters received so far,
  elapsed milliseconds), never deltas; `argChars` never decreases
- And the row shows the size in KB (locale formatted) and the elapsed time (m:ss), and both change
  while the call streams
- And a final frame is sent when the arguments complete, so the last number shown is the real total.

**AC-3 Hand-over to the running tool (US-1)**
- Given a visible "preparing" row
- When the call is executed and `tool/started` arrives for the same call id
- Then the same row becomes the normal running row and then the completed row; there is never a
  duplicate row for one call; the download card and Artifacts panel behave exactly as today.

**AC-4 Repeated call (US-3)**
- Given one turn in which the model calls `create_web_artifact` twice
- When the second call is announced
- Then the chat shows two separate rows; the second is labelled as a repeat with its number ("again
  (2)" in English, the German equivalent in German); the first row is unlabelled; a tool that does not
  match criterion 2(a) or 2(b) of section 6 is never labelled, however often it is called.

**AC-5 No orphan rows (P3)**
- Given a "preparing" row
- When any of these happens: the user presses Stop; the provider fails mid-arguments; the loop
  refuses the call (tool disabled, circuit breaker); the call is handed to the approval card;
  the arguments arrive malformed
- Then within 1 second of that event the row leaves the preparing state: it is replaced by the
  approval card, or shows as stopped/failed, or disappears if the call was dropped
- And after `run/ended` no row anywhere is in the preparing state.

**AC-6 Liveness fallback (US-2, P4)**
- Given any provider, and a model call that has produced no visible output (answer text, reasoning,
  image) for 3 seconds
- When the silence continues
- Then the chat shows a localised line such as "The model is still working... 0:12" with a clock that
  is correct to within 2 seconds, also after the browser reconnected to the stream
- And the line disappears as soon as visible output or a tool row appears
- And for a provider with no early signal (Gemini, Mistral, a buffering vLLM parser) this is the only
  new element, the final frames are identical to today's, and no error is raised.

**AC-7 Thinking (US-4, P7)**
- Given a model that streams reasoning, reasoning not displayed to the user, and no answer text yet
- When reasoning fragments arrive
- Then the indicator reads "Thinking..." (localised); when answer text starts it is replaced by the
  answer.

**AC-8 Fast tools unchanged (section 6)**
- Given a tool whose arguments finish in under 1.5 seconds and that is not a system-skill tool
- When it is called
- Then no preparing row or extra frame is produced; the frames and the row are identical to today.

**AC-9 Hidden and internal tools**
- Given calls to `ask_user`, `activate_skill`, tool search, a caller-run (passthrough) tool, a
  hallucinated tool name, or the synthetic `json` structured-output call
- Then none produces a preparing row or a progress frame.

**AC-10 No regression in neighbours**
- Given the approval flow, deferred tool search and MCP tools (including an MCP App tool)
- Then their existing tests pass unchanged; an MCP App tool still mounts its view on `tool/started`
  only (never from the early frame); an MCP tool with a slow argument stream is announced under
  criterion 2(b).

**AC-11 Nothing extra is stored**
- Given a persisted chat
- When the turn finishes and the chat is reopened
- Then the stored activity is the same as before this feature, the stored chat is not larger, and a
  turn rebuilt from the run ledger after a process crash shows no preparing artefacts.

**AC-12 Adapter-level detection (tests the issue asks for)**
- Given recorded stream fixtures for OpenAI chat completions, vLLM, Anthropic and Bedrock
- When fed through their converters
- Then a progress signal is produced at the chunk that carries the name, argument counts are
  monotonic, and the finished `tool_calls` are byte-identical to what the converter returns today
- And for OpenAI Responses the same signal is derived from the existing partial deltas
- And for Google and Mistral no progress signal is produced and the output is unchanged.

**AC-13 Language (US-7)**
- Then every new user-visible string exists in `shared/i18n/en.json` and `de.json`, nothing is
  hard-coded, sizes and times are locale formatted (German decimal comma), and the German row is
  grammatically correct without relying on English ordinals.

**AC-14 Accessibility (US-6)**
- Then the row's start and its end are announced once through a polite live region; the changing size
  and clock are not announced on each tick; the spinner stops animating under
  `prefers-reduced-motion`; meaning is not carried by colour alone; the existing axe baseline in
  `tests/e2e/accessibility.spec.js` still passes with the preparing row on screen.

**AC-15 Volume**
- Given a call that streams for 120 seconds
- Then the feature adds at most 130 frames and 40 KB in total for that call, and none of it contains
  argument text.

**AC-16 Measurement (P5)**
- Given telemetry enabled
- When a user presses Stop while a call is streaming tool arguments
- Then `ihub.stream.outcome` is recorded with `stream.outcome=aborted` and `stream.phase=tool_args`,
  and the ledger `run/end` cause carries the same phase.

**AC-17 Replay of the reported incident (end-to-end)**
- Given a mock model stream that sends `create_web_artifact` arguments for 63 seconds, then a second
  call for 66 seconds
- Then the user sees the first row within about 1 second with growing progress, then a second row
  labelled as a repeat, and the screen is never a bare spinner for more than 3 seconds.

### 8.3 Behavioural contract, recommended (architect confirms in document 02)

Recommendation: use `tool/progress`, not `tool/started` with a `phase`.

Reasons: it is additive (an older client appends an unknown phase to `run.progress` and ignores it);
it needs no Zod contract change; the stored-activity allow-list keeps it out of stored chats by
default; `tool/started` carries `args`, `execution` and the MCP App view announcement, and
consumers treat it as "the tool is running".

| Frame | Phase | Carries |
|---|---|---|
| Preparing | `args` | `step`, `callId`, `toolId`, and in `data`: `name`, display fields from `toolDisplayOf` (`title`, `integration`, `activityKind`), `argChars`, `elapsedMs`, `occurrence` (only for announced calls that qualify) |
| End of arguments | `args.ended` | `callId`, `data.outcome`: `ready` (a `tool/started`, an approval or a refusal follows) or `dropped` |
| Liveness | `model.waiting` | `step`, `data.elapsedMs` since the last visible output |

Rules that follow from the acceptance criteria:
- The `callId` of a preparing frame must equal the `callId` the later `tool/started` uses
  (`callIdOf(info)` in `chatSeams.js`: the provider's call id, else the index). If the id is not known
  yet when the name arrives, wait for it or key by index and reconcile; do not announce under an id
  that will change.
- Values are absolute, so a dropped or replayed frame is harmless.
- Frames are live-only: not stored in activity and not appended to the ledger one by one (a single
  summary on completion is fine, see P9).
- The client reducer updates one entry per call instead of appending every tick.
- Display decisions (`title`, `activityKind`, whether to announce, `occurrence`) are made on the
  server. The client only renders what it is told, plus a stopwatch.

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| SSE volume | At most 1 progress frame per second per announced call; each under about 300 bytes; no argument content; at most 2 calls shown preparing at once (parallel tool calls beyond that are folded into the first two, the rest show on `tool/started` as today). Final frame always sent, leading and trailing edge. |
| Server cost | O(1) work per chunk: counters only. No JSON parsing of partial arguments per chunk, no extra copy of the argument string beyond what the converter already holds. No measurable CPU change at 200 tokens per second. |
| Backward compatibility | Additive only. Old clients keep working; `tool/started`, `tool/completed`, the stored activity shape and the `/v1` inference API do not change. No compatibility shim is needed. If the architect finds a breaking change is unavoidable, stop and ask the product owner (repo rule). |
| Reliability | Never raises an error to the user because of this feature. If the signal is missing or malformed, behave as today (plus P4). |
| Replay and reconnect | A browser that reconnects mid-call shows the current state on the next frame; the clock is correct after reconnect. |
| Accessibility | See AC-14. |
| i18n | en and de at minimum, in `shared/i18n/en.json` and `de.json` under `toolActivity.*`. Suggested keys: a row with size and time, `again` with a count, `waiting`, `thinking`. |
| Security and privacy | Release 1 sends no argument text. Frames carry only the tool title, sizes and times. No new outbound connection (so no SSL whitelist work), no new endpoint (so no `api-design` work). |
| Configuration | No new admin setting, so no config migration (`server/migrations/`). |
| Licensing | New `.js`/`.jsx` files carry the two-line SPDX header (repo rule). |

## 10. Dependencies, risks, order of work

### Spike S0 (half a day, before any design is frozen)

Two facts decide how much of release 1 works for the issue's own scenario:

1. **Does the vLLM server in the evidence stream tool-call name and arguments during generation, or
   buffer them?** Capture the raw SSE from `local-vllm` (Qwen3.6-35B-A3B-FP8 on k3s01) for a
   `create_web_artifact` request. Record: time of the first delta with the name, whether the id is on
   that delta, and whether argument fragments arrive over the 63 seconds or in one burst at the end.
   The result goes into section 7.
2. **What were the three model calls in chat `chat-83b0fdd3-f4f5-49cf-9171-f2e36f583b4c`?** Read the
   run ledger events `tool/call` and `tool/result`. Did the first `create_web_artifact` return
   `warnings`? Was the 66-second call a second `create_web_artifact`? The reporter has the access.
   The result decides whether P15 (cheaper retries) becomes the next brief.

### Risks

| ID | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | The vLLM tool-call parser buffers until the call is complete, so there is no early signal for the very model in the issue. | Medium / high | S0 first. P4 covers it regardless; the acceptance for the issue's replay (AC-17) is then met through P4 and the product owner is told plainly that "Creating web artifact..." is not possible on that parser. |
| R2 | The call id is not on the first fragment on some OpenAI-compatible servers; the converters currently drop a call without an id. | Medium / medium | Key by index until the id is known; test with a fixture that has the id late. |
| R3 | A row announced for a call that never runs (stop, refusal, approval, malformed arguments) stays forever. | High if unhandled / high | P3 and AC-5 are Must. The server closes every announced call at the end of the model step. |
| R4 | The reducer appends every progress frame to `run.progress`; one frame per second for two minutes is noise and re-renders. | High / low | Dedicated reducer case that updates one entry per call. |
| R5 | Parallel tool calls: several calls arrive at once with indexes 0, 1, 2. | Medium / low | Cap shown rows at 2 (section 9); test two parallel `create_*` calls. |
| R6 | Anthropic argument fragments arrive in bursts, so sizes look jumpy. | High / low | Elapsed clock keeps ticking from the server tick, not from fragments. |
| R7 | `tool/started` is stored; the new frames must not be, or chats grow. | Low / medium | Keep the phase out of `RECORDED_PROGRESS_PHASES`; add an assertion test (AC-11). |
| R8 | The success metric needs telemetry, which is off by default. | Medium / medium | Also record the phase on the ledger `run/end` cause, which exists without OpenTelemetry. Confirm telemetry is on where success will be judged. |
| R9 | Scope creep towards live preview. | High / medium | Section 3 verdict; R2 entry conditions. |

Dependencies: none on other teams or services. Documentation and the release note are part of the
work (section 12).

### Order of work (each slice is a separate pull request; slices B and C ship in one release)

| Slice | Content | Items | Rough size |
|---|---|---|---|
| S0 | The spike above | | 0.5 day |
| R0 | Record `stream.phase` on `ihub.stream.outcome` (values: `waiting`, `reasoning`, `answer`, `tool_args`, `tool_run`) and on the ledger abort cause. Add the label to the allow-list. Ships first, so a baseline accumulates. | P5 | Small |
| A | Liveness line. Server: time since last visible output, emit `model.waiting`. Client: reducer, one line component with the stopwatch, en and de strings, accessibility. | P4, P7 | Small to medium |
| B | Early signal. Converters (OpenAI, vLLM, Anthropic, Bedrock) additionally expose a progress signal and leave the finished `tool_calls` untouched; Responses derived from its deltas. `chatToolSeam.onChunk`: the rule of section 6, throttle, `args` and `args.ended` frames, step-end cleanup. Reducer and `toolActivity` row with the preparing state. | P1, P2, P3, P10, P9 | Medium |
| C | Polish: `occurrence` label, file name if cheap, docs and release note. | P6, P8 | Small |

A suggested minimal way to carry the signal (non-binding): add one optional field on the generic chunk
(for example `toolCallProgress: [{ index, id, name, argChars }]`) set by the converters, passed through
`normalizeChunk` (unknown fields already pass through) and ignored by `ResultAccumulator`. This keeps the
`tool_calls` contract untouched and avoids a refactor that would need Google and Mistral re-tested.

## 11. Telemetry and success measurement

What exists (`docs/telemetry.md`, `server/telemetry/metrics.js`, `server/services/chat/chatTelemetry.js`,
`server/services/chat/abortCause.js`):

- Counter `ihub.stream.outcome` with `stream.outcome` = `completed`, `aborted`, `error`, recorded once
  per model call. Telemetry is disabled by default.
- Metric labels are an allow-list, and the file says high-cardinality attributes belong on spans.
- Every abort has a cause; `user_stop` is the Stop button. It is on the ledger `run/end`.

What to add (release R0 and R1):

| Signal | Where | Notes |
|---|---|---|
| `stream.phase` label on `ihub.stream.outcome` | metric, add `stream.phase` to `ALLOWED_METRIC_LABELS` | Five values only: `waiting`, `reasoning`, `answer`, `tool_args`, `tool_run`. Low cardinality, so it is safe as a label. |
| Phase on the abort cause | ledger `run/end` | Works with telemetry off. This is the data source for the offline baseline on instances without OpenTelemetry. |
| `ihub.tool.args_chars`, `ihub.tool.args_stream_ms` | attributes on the model-call span | High cardinality (tool id, size), so span only. |
| One log line per slow call | server log next to the existing `Chat tool call` line in `chatSeams.js` | Tool id, argument characters, stream milliseconds. |

How we judge success:
1. After R0 has run for about two weeks: baseline = (`aborted` with `user_stop` and phase `waiting` or
   `tool_args`) divided by (turns that used a deliverable tool), per instance with local models.
2. After R1: same ratio, 30 days. Target: halved. If the baseline is too small to read (fewer than
   about 20 events a month on an instance), judge by the replay test AC-17 and by support-ticket
   count instead; do not pretend to a statistic.
3. Secondary: p95 of the time from the provider's first name fragment to our first frame (a span
   attribute, server-side), target at most 1.2 seconds.

## 12. Implementation guide for whoever continues

### Repo rules that apply (from `CLAUDE.md`)

- **Run Activity: the server decides, the client renders.** Whether a call is announced, its title,
  its kind and its `occurrence` come from the server (`server/utils/toolDisplay.js` and the seam).
  Neither the client nor `shared/run/` may infer anything from a tool id. If a new distinction is
  needed, add a server-sent field.
- **Changes are additive.** Ask the product owner before adding any compatibility shim.
- **i18n:** every new string in en and de.
- **License header** on new source files. Run `npm run lint:fix && npm run format:fix` before
  committing.
- **Release changelog:** a visible change needs an entry in `docs/releases/next/`. Use the
  `/document-feature` skill, which decides whether an entry is needed. Never write into a numbered
  release folder.
- **Docs:** update `docs/sse-v2.md` (the `tool/progress` phases table and the chat-turn example),
  `docs/telemetry.md` (new label and span attributes), and `docs/pdf-generation.md` if the user
  experience of "Creating a document" is described there. No new doc file is expected, so
  `docs/SUMMARY.md` is untouched.
- No new route, no new outbound connection, no new endpoint: the "new routes", "SSL whitelist" and
  "REST API design" rules are not triggered. If that changes, re-read them.

### Where to look

| Topic | File |
|---|---|
| Where `tool/started` is emitted; where to add `onChunk` | `server/services/chat/chatSeams.js` (`chatToolSeam`) |
| How chunks are consumed; where `preTool` runs; step end | `server/services/loop/AgentLoop.js` |
| The generic chunk and `normalizeChunk`; the accumulator | `server/services/loop/LLMClient.js`, `server/services/loop/toolCallMerge.js` |
| Converters | `server/adapters/toolCalling/{OpenAI,VLLM,Anthropic,Google,Mistral,OpenAIResponses,Bedrock}Converter.js`, `server/adapters/bedrock.js` |
| Display decisions | `server/utils/toolDisplay.js` |
| System-skill marker | `server/services/systemSkillTools.js` |
| Event vocabulary and contract | `shared/runEvents.js`, `server/services/loop/contracts/sseV2.js`, `docs/sse-v2.md` |
| Client state and rows | `shared/run/runReducer.js`, `shared/run/toolActivity.js`, `client/src/features/chat/components/ToolActivity.jsx`, `client/src/features/chat/components/ChatMessage.jsx` |
| What is stored | `server/services/chat/runActivity.js` (`RECORDED_PROGRESS_PHASES`) |
| Abort cause and telemetry | `server/services/chat/abortCause.js`, `server/services/chat/chatTelemetry.js`, `server/telemetry/metrics.js` |
| The tool and its rules | `server/services/documents/webArtifacts/webArtifactToolDefinitions.js`, `webArtifactTools.js`, `server/systemSkills/web-artifacts/SKILL.md` |

### Tests to write (names are suggestions; extend the existing files where they exist)

- Converter tests next to the existing ones: `server/tests/openaiAdapter.test.js`,
  `anthropicAdapter.test.js`, `bedrockConverter.test.js`, `openaiResponsesToolCalling.test.js`,
  `googleAdapter.test.js`, `mistralAdapter.test.js`. Use recorded stream fixtures (AC-12). Include the
  "id arrives late" fixture (risk R2).
- Loop and projection: `server/tests/loop/chatTurn.test.js` (frame order, throttle with a fake clock,
  AC-1, AC-2, AC-5, AC-8, AC-9, AC-15). One test per orphan case in AC-5.
- Client: `tests/unit/client/run-reducer.test.jsx` (one entry per call, hand-over by call id, AC-3),
  `tests/unit/client/tool-activity.test.jsx` (row text, repeat label, AC-4, AC-13).
- Stored activity: extend `tests/unit/client/stored-run-activity.test.jsx` and
  `server/tests/chat-persistence-activity.test.js` (AC-11).
- Accessibility: the axe baseline in `tests/e2e/accessibility.spec.js` with a preparing row on screen
  (use the `a11y-audit` skill).
- End to end: a mock slow stream for AC-17 using the chat flow in `tests/e2e/chat.spec.js`.
- Also check, as an engineering question rather than a product one: does pressing Stop mid-turn keep a
  file that an earlier call in the same turn already created? (In the evidence the first artifact had
  already been created when the user stopped.)

### Definition of done for release 1

All acceptance criteria above pass; the spike results are written into section 7; the baseline from R0
has run for at least two weeks before slices B and C ship (if the release date does not allow it, ship
anyway but say so, and measure from the first week); docs and release note updated; no new lint
findings; the unchanged suites for approval, tool search and MCP pass.

## 13. Out of scope

Live preview of partial HTML or SVG; streaming argument text to the client; workflow, agent and
scheduled-task run pages; an admin setting; tokens as the unit of progress (they are an estimate that
differs per model, KB and seconds are exact and mean something to every user); changing the tool schemas
(except keeping `filename` and `title` before `content` in `create_web_artifact`, which is already the
case and should be protected by a test comment because P8 depends on it); Gemini and Mistral early
signals; changing how the model is prompted to retry (P15 is a separate brief).

## 14. Open questions only the product owner can answer

1. **Live artifact appetite.** Do you accept the verdict in section 3 (not in release 1; start with
   the Code tab as R2a), or is a live preview a hard requirement that justifies a security review now?
2. **Provider promise.** Is "full row on OpenAI-compatible, Anthropic, Bedrock and OpenAI Responses,
   liveness line only on Gemini and Mistral" acceptable for customers, or does a Gemini or Mistral
   customer need the rich row in release 1? (Doing it means new adapter work that Google and Mistral
   have not enabled by default.)
3. **Priority of cheaper retries (P15).** If spike S0 shows the second 66-second call was a warning
   retry, do you want that brief before or after release 1? My recommendation: write it in parallel and
   decide after the R0 baseline.
4. **Success target.** Do you accept "halve the Stop-during-silent-wait rate within 30 days" and the
   fallback to qualitative judgement when the volume is too small? The issue reporter owns the
   instances where this can be measured (k3s01).

Smaller choices made by product management that the owner can overrule without blocking work:
size in KB plus clock instead of tokens (section 13); repeat label as "again (2)" rather than an English
ordinal, because German ordinals differ (AC-13); no admin switch (P18).

## 15. Decision log

| Date | Decision | By | Reason |
|---|---|---|---|
| 2026-11-09 | Ship the provider-independent liveness line first | PM | Works for every model, no adapter risk, fixes the trust problem on its own. |
| 2026-11-09 | Use `tool/progress` phases, not a phase on `tool/started` | PM, architect to confirm | Additive, not stored, no contract change, `tool/started` keeps its meaning. |
| 2026-11-09 | Rule by `isSystemSkillTool` plus a 1.5 s argument-stream threshold, no id list | PM | Generic, server-side, covers MCP and integration tools automatically. |
| 2026-11-09 | Live preview is a non-goal for R1, gated ladder for R2 | PM | Security invariants, decoder complexity, adapter inconsistency (section 3). |
| 2026-11-09 | Size and time, not tokens | PM | Exact, universal, model-independent. |
| 2026-11-09 | Measure first (R0) | PM | A metric without a baseline cannot show improvement. |
