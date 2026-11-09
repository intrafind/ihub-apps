# 04 — Reconciled decisions and release-1 contract

Status: decided 2026-11-09 by the implementing agent after reading the three briefs
(`01-product-brief.md`, `02-ux-brief.md`, `03-ui-spec.md`). Where the briefs disagree, this document
wins. It is also the contract the server and client slices are built against. Issue:
[#3534](https://github.com/intrafind/ihub-apps/issues/3534).

Anyone continuing this work: read this file first, then the brief that owns the topic.

## 1. Decisions where the briefs disagree

| Topic | Product | UX | UI | **Decision** | Why |
|---|---|---|---|---|---|
| Wording of the idle line | "Waiting for the model… 0:12" (after review) | "Still working… 0:12" | "The model is still working… 0:12" | **"Waiting for the model…"**, de "Wartet auf das Modell…" | A clock cannot tell a healthy buffered call from a hung provider (review finding on the product brief). The stall caption stays hedged. |
| Repeat label | "again (2)" | "Fixing… / Attempt n" with a server `reason`, else a neutral "No. n" chip | (revised) same as UX | **Neutral chip "No. 2" / de "Nr. 2"** on the 2nd and later announced call of the same tool in the turn | UX and the revised UI spec converged on it: the client cannot verify that a repeat is a retry, and the chip meets the issue's "label it as such" without asserting a reason. It needs only `occurrence` (a fact the server knows). "Fixing… / Attempt n" needs `reason`/`issueCount` (a warning-retry fact); that is follow-up scope together with product brief P15. The first draft of this document chose "again (2)"; it is reversed here. |
| Where size and clock render | headline and row | row and headline | (first draft: one place only) revised: headline suffix and active row, one shared clock | **Both, ticking in sync** (UX section 5, revised UI spec) | Simpler (no branch on the open or closed state) and a collapsed list still shows progress. Both copies are `aria-hidden`. Revisit if reviewers find the duplicate noisy. |
| Unit | KB from `argBytes` | KB | KB from `argBytes` | **KB from `argBytes`** | Review finding: the counter and the unit must match. |
| File name while arguments stream (P8) | R2 behind a security review | wants a one-line exception to AC-1/AC-15 | not specified | **Not in release 1** | Argument text on the wire is forbidden by AC-1. Revisit in R2 with a security review. |
| Noun in "Creating {{what}}…" | not specified | server-sent `outputKind` | tool title, optional `activityKind: 'create'` | **Server sends `outputKind`** (`webArtifact`, `document`, `presentation`, `workbook`, `pdf`, `file`, `archive`) from `utils/toolDisplay.js`; the client maps it to a noun | CLAUDE.md "Run Activity": the server decides what a call is; the client never infers it from a tool id. |
| A painted row whose call is dropped | disappears | turns `failed` "Not created…" | disappears, no animation | **Turns `failed`** with `toolActivity.dropped` | A row that vanishes after "Creating…" was announced leaves a screen-reader user waiting. |
| `args.ended` outcomes | `ready`, `dropped` | + `approval`, `truncated`, `invalid` | n/a | **`ready`, `dropped`, `truncated`, `invalid`, `aborted`** | The row must say why it ended. `approval` is derived on the client from the existing `interaction/raised` frame. |
| Stall caption | P11 Could, 90 s | Should, 20 s without growth | out of scope | **Should, client-only, 20 s** (`STALL_AFTER_MS`) with the hedged UX string | It addresses "hung or working?" directly and needs no server field. Drop first if time is short. |
| Client grace before painting | not specified | 500 ms | none | **500 ms** (`PREPARING_GRACE_MS`) | Avoids flicker for tiny `create_file` calls the server announces at once. |
| Live announcements | polite region, start and end once | `RunAnnouncer` outside `role="log"` | existing log | **UX `RunAnnouncer`**, numbers `aria-hidden`, list `aria-live="off"` | Most precise; the a11y rules of the repo apply (see `docs/accessibility.md`). |
| Stop button (`Stop generating`, focus return) | not specified | Should | not specified | **Could**, only after the above is green | Independent of the progress feature. |
| Card replacement, draft note, viewer notices, drawer refresh | not specified | follow-up | Artifacts panel unchanged in R1 | **Follow-up** | Product AC-3: the panel and cards behave exactly as today. |

## 2. Release 1: in and out

**In** (this PR):

- **A. Waiting line.** After 3 s without visible output (answer text, reasoning, image, a tool row),
  `tool/progress` phase `model.waiting` with `elapsedMs`; the client shows "Waiting for the model… 0:12",
  or "Thinking… 0:07" while reasoning streams. Works on every provider.
- **B. Early signal.** Converters expose a progress signal while a tool call's arguments stream; the
  server announces the call (phase `args`), throttles progress, and closes every announced call
  (phase `args.ended`) on normal end, error and abort. Row `preparing` with `12 KB · 0:41`.
- **C. Repeat chip** "No. 2", and the three-dot loader standing down while a line or row is shown.
- **D. Accessibility:** `RunAnnouncer`, reduced-motion static icon, `aria-live="off"` on the list.
- en and de strings, docs (`docs/sse-v2.md`, `docs/accessibility.md`), release note, tests.

**Out** (separate work): live artifact preview; file name while streaming; "Fixing… / Attempt n" and
`reason`; Gemini and Mistral early signal (they get A only); workflow and agent run pages; an admin
setting; card replacement and viewer notices; version labels; the `R0` stop-phase telemetry (a small,
independent PR, see section 7); patch-style retries (product brief P15).

## 3. Wire contract (additive, `tool/progress`)

`tool/started` is unchanged. `tool/progress` already exists in `server/services/loop/contracts/sseV2.js`
(`phase`, `message`, `data` are free-form), so **no Zod contract change is needed**; document the phases
in `docs/sse-v2.md`.

| Phase | Frame fields | `data` |
|---|---|---|
| `args` | `step`, `callId`, `toolId` | `name`, `title?`, `integration?`, `activityKind?`, `outputKind?`, `argBytes` (UTF-8 bytes of the raw argument JSON received so far, escapes counted as sent, never decreases), `elapsedMs` since the first fragment, `occurrence?` (only when 2 or more) |
| `args.ended` | `step`, `callId`, `toolId` | `outcome`: `ready` (the finished call exists; a `tool/started` or an interaction follows), `dropped` (the loop will not run it), `truncated` (output limit hit), `invalid` (arguments unparsable), `aborted` (Stop or provider error); `argBytes`, `elapsedMs` |
| `model.waiting` | `step` | `elapsedMs` since the last visible output |

Rules:

1. **The call id is stable.** The `callId` of the first `args` frame equals the `callId` of the later
   `tool/started` and `tool/completed`. If the provider sends the id late, key by index until it is
   known and emit nothing until then (risk R2 in the product brief).
2. **No argument text on the wire.** No frame of this feature carries any part of the arguments.
3. **Which calls are announced** (server-side, no tool id list in the feature code): the call must
   resolve to a known, visible, server-executed tool (not `activate_skill`, `ask_user`, passthrough,
   clarification or caller-executed tools, never an unknown or hallucinated name). It is announced
   **immediately** when the tool definition declares an `outputKind` (the seven document, file,
   archive and web-artifact creators), and **after 1.5 s** of still-streaming arguments for any other
   such tool (MCP tools, and system-skill tools that make nothing such as `preview_pdf`, so a fast
   search never flickers). Changed after implementation: the first draft said `isSystemSkillTool`,
   which also matched `preview_pdf`.
4. **Throttle.** At most one `args` frame per second per call, at least one every 2 s while fragments
   flow, absolute values only, a final `args.ended` frame always. At most 130 frames and 40 KB per call
   over 120 s (AC-15).
5. **Closing.** Every announced call gets exactly one `args.ended`: `ready`/`invalid`/`truncated`/
   `dropped` when the model stream ends (the final tool-call list is known there), `aborted` on the
   error or abort exit. After `run/ended` no call is left unclosed.
6. **`occurrence`** counts announced calls of the same `toolId` in this run (the first has none, the
   second has 2).
7. **Not stored.** The stored-activity allow-list keeps these phases out of stored chats; add a test.

### Where it hooks into the loop

- Converters set an optional chunk field `toolCallProgress: [{ index, id?, name?, argBytes }]` (absolute
  per pending call, set only when something changed) and leave `tool_calls` untouched.
  `normalizeChunk` already passes unknown fields through; `ResultAccumulator` ignores it.
- `AgentLoop.js` consumes chunks at `for await (const chunk of stream)` (the `onChunk` seam hook already
  runs for every chunk). Add **one new seam hook `streamEnd(ctx, { outcome, result? })`** called from a
  `finally` around that consumption loop, so it runs on normal end (outcome `completed`, `result`
  present), on a provider error (`error`) and on Stop (`aborted`). Today the loop returns from its
  `catch` without calling `stepEnd`, so `stepEnd` alone cannot close rows (see the review thread on the
  product brief). Update the seam list in the `AgentLoop` JSDoc.
- `chatToolSeam` (in `server/services/chat/chatSeams.js`) implements `onChunk` (announce + throttle) and
  `streamEnd` (close). `info`/tool-definition resolution for rule 3 uses the loop's existing tool lookup;
  if it is not reachable from `onChunk`, expose it on `ctx`.
- `server/utils/toolDisplay.js` gets `outputKindOf(toolDef)`; `toolDisplayOf` returns it.
- The waiting line (`model.waiting`) is driven by a timer seam that is armed at request start, reset by
  any visible output, and cleared at `streamEnd`; it emits at 3 s and then once per second (clock
  correct to 2 s, also after a reconnect: the client derives the clock from `elapsedMs`, not from when
  the frame arrived).

### Provider status (what each converter can do today)

| Converter | Early signal in release 1 |
|---|---|
| `OpenAIConverter`, `VLLMConverter` (OpenAI-compatible, vLLM) | Yes: set `toolCallProgress` while `pendingToolCalls` accumulates. A parser that buffers upstream gives nothing; A (waiting line) still works. |
| `AnthropicConverter` | Yes: `content_block_start` tool_use gives name and id, `input_json_delta` gives size. |
| `OpenAIResponsesConverter` | Yes: derive from its existing name and argument deltas. |
| Bedrock | Should (same pattern as Anthropic); skip if it makes the slice too large. |
| Google, Mistral | No (tool calls arrive whole): waiting line only. |

## 4. Client model

- `shared/run/runReducer.js`: handle `args`, `args.ended`, `model.waiting` in dedicated state
  (`run.argStreams[callId]`, `run.waiting`), **not** by appending to `run.progress` and **not** through
  the `tool/started` replace-and-append path (the row must keep its position). Reset per run.
- `shared/run/toolActivity.js`: `buildToolActivity` merges `run.argStreams` with `run.tools` by call id,
  in order of first appearance. States: `preparing` → `running` (`tool/started`) → `completed` /
  `failed`; plus `stopped` and `awaiting`. A `preparing` row of a finished run is `stopped` (the same
  rule that coerces a running row today). Keeps hiding `activate_skill`, `ask_user` and non-server
  execution. A `ready` row that never gets a `tool/started` while an interaction is pending is
  `awaiting` ("Waiting for approval"); a `dropped`/`invalid`/`truncated` row is `failed` with the
  matching string.
- Components (new files named in the revised UI spec): `ActivityProgress.jsx` (`BusyIcon`,
  `ArgumentProgress`, `useNow`, `RowChip`, `ActivityHint`, `formatSize`, `formatClock`) and
  `RunAnnouncer.jsx` + `deriveAnnouncements.js`. There is no separate `ModelWorkingLine`: the idle
  states ("Waiting for the model…", "Thinking…") live in the `ToolActivity` headline slot, in a
  headline-only mode when there are no rows. `ToolActivity.jsx` and `ChatMessage.jsx` change as the
  UX/UI briefs describe. The active state uses the UI spec's accent (indigo-600 light, indigo-400 dark;
  its contrast table forbids indigo-600 on dark); if reviewers object, fall back to gray with a medium
  weight. Tailwind utilities only;
  no new CSS or theme token in release 1 (UI spec decision 8). Logical properties (`ms-`, `ps-`,
  `border-s`) for RTL.
- Constants live in one module (UX 17.3): `PREPARING_GRACE_MS=500`, `IDLE_LABEL_AFTER_MS=3000`,
  `STALL_AFTER_MS=20000`, `PROGRESS_RENDER_MS=1000`, `ANNOUNCE_*`.
- Strings under `toolActivity.*` in `shared/i18n/en.json` and `de.json` (the UX 12.1 table) with these
  release-1 changes: `waitingForModel` = "Waiting for the model…" / "Wartet auf das Modell…" replaces
  `working`; `occurrence` stays "No. {{count}}" / "Nr. {{count}}"; `fixing`,
  `retrying`, `attempt`, `problemsFound*`, `fixingWhy*`, `retryingWhy`, `revisions*`, `longWait`,
  `stoppedKeptPrevious`, `draft*` are not used in release 1 and must not be added yet.

## 5. Tests required (both slices)

Server: each converter's early signal (name seen with the id late, argument growth, no `tool_calls`
change, a buffering fixture gives nothing); the rule for which calls are announced (system-skill tool
immediate, other tool after 1.5 s, unknown/hidden/passthrough never); throttle and the frame budget;
exactly one `args.ended` per announced call for each outcome, including a provider error and an abort
mid-arguments (the loop returns from `catch` without `stepEnd`); `occurrence`; the allow-list keeps the
phases out of stored chats; the waiting timer (3 s, resets on output, cleared at stream end).

Client: reducer (one entry per call, stable position, reset per run); `buildToolActivity` (each state,
kind and `outputKind`, repeat chip, `preparing` coerced to `stopped` at run end, hidden tools);
`deriveAnnouncements` (once only, throttled, reset per run, no numbers); reduced-motion icon;
`known-routes-sync` is untouched. Extend `tests/unit/client/tool-activity.test.jsx` and
`run-reducer.test.jsx`; add an e2e with the stub model in `tests/config/e2e-llm-stub.mjs` and the
`preparing` row in `tests/e2e/accessibility.spec.js` (ratchet rules in the `a11y-audit` skill).

## 6. Acceptance (from the product brief, as adjusted)

AC-1 to AC-15 apply with the changes above (`argBytes`, the "No. n" repeat chip, no file name, dropped rows turn
`failed`). AC-16 (stop-phase telemetry) is the separate R0 PR. AC-17 holds for a stream that exposes the
call; AC-17b for a buffering stream (the waiting line only, final frames equal today's).

## 7. Open items for the product owner

1. **vLLM parser.** Does the Qwen tool-call parser on `local-vllm` stream the name and arguments, or
   buffer them (spike S0)? If it buffers, the reported chat gets the waiting line but not
   "Creating web artifact…", and the issue's acceptance criterion cannot be met by an adapter-level
   change for that model. The implementation gives a clean fallback either way.
2. **The 66 s second call.** Probably a full regeneration after `create_web_artifact` returned
   `warnings`. Showing it as a numbered repeat explains the wait but does not remove it; a patch-style update
   tool or server-side repair of mechanical warnings (missing `viewBox`, unguarded `localStorage`) would.
   Separate brief (P15). Worth deciding soon.
3. **R0 telemetry** (stop phase on `ihub.stream.outcome`): separate small PR, or part of this one?
4. **Stop button wording and focus return** (UX F10): in this PR or later?
