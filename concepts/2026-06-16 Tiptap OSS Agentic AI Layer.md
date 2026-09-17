# Tiptap Editor — OSS Agentic AI Layer (no Tiptap Pro license)

**Date:** 2026-06-16
**Status:** Design for review (no code yet)
**Tracking issue:** [#1609](https://github.com/intrafind/ihub-apps/issues/1609)
**Part of the Tiptap feature set:**
- [`2026-06-16 Tiptap Editor Integration.md`](./2026-06-16%20Tiptap%20Editor%20Integration.md) — research/concept (merged #1608)
- [`2026-06-16 Tiptap Editor Implementation Plan.md`](./2026-06-16%20Tiptap%20Editor%20Implementation%20Plan.md) — phased file-level plan
- **this doc** — Phase 4 detailed design, OSS path (replaces Tiptap Pro AI Agent / AI Toolkit)

---

## 1. Decision recorded

**We will NOT buy the Tiptap Pro subscription.** Therefore the agentic AI layer
(AI Agent + AI Toolkit equivalent) must be **built on the Tiptap MIT core + iHub's
own LLM backend**. `@tiptap-pro/*` packages (404 on public npm, private-registry
token, possible runtime phone-home, air-gapped risk) are **out**.

This resolves the concept doc's gates: **G0 = no license**, **G2 = OSS path**.

## 2. What Tiptap Pro gives us — and what we must rebuild

| Pro capability | What it does | Our OSS replacement |
| --- | --- | --- |
| **AI Agent** (`extension-ai-agent`) | Cursor-like loop: LLM reads doc, calls tools to edit, iterates; pluggable `resolver` to your backend. | iHub's existing **server-side agentic loop** (`ToolExecutor.continueWithToolExecution`, max-iteration loop) + a new **client-side tool-execution protocol** so document tools run in the browser. |
| **AI Toolkit** | Structured read/write/patch tools, schema-aware chunked reads, streamed edits, read/write boundary, audit log. | A set of **document tools** (read/search/replace/insert/delete) we define ourselves; reads chunked by ProseMirror nodes; audit via existing `actionTracker` tool events + `usageTracker`. |
| **AI Changes** (`extension-ai-changes`) | Track-changes UI: proposed edits as diffs, accept/reject per change. | A **ProseMirror suggestions layer** we build with Decorations + insertion/deletion marks (optionally `prosemirror-changeset` for diffing) and an accept/reject UI. |

Everything else (permissions, cost/usage tracking, local/vLLM/LM Studio support,
provider adapters) is **already** in iHub and is reused unchanged.

## 3. The core constraint

From the pipeline audit (`server/services/chat/*`, `server/actionTracker.js`,
`server/sse.js`, `client/src/shared/hooks/useEventSource.js`):

- iHub tools **always execute server-side** (`ToolExecutor.executeToolCall` →
  `runTool`). The client never sees raw tool calls.
- SSE is **one-way** (server→client).
- The **only** pause/resume round-trip to the client is the `ask_user`
  **clarification** tool: `executeClarificationTool()` emits a
  `clarification` SSE event (`actionTracker.trackClarification`), the loop
  pauses, the client collects input and posts it back, and the loop resumes.

**The document lives in the browser.** So document-editing tools cannot run on
the server's normal tool path — they must either (a) be applied client-side, or
(b) run server-side against a server-held *copy* of the document. Three options
follow.

## 4. Three architectures (with recommendation)

### Option A — Single-shot structured edits *(recommended Phase 4a — ship first)*
The LLM returns, in **one response**, a structured list of edit operations
(via iHub **`outputSchema`**). The client maps each op to a ProseMirror
transaction and renders them as **proposed suggestions** (accept/reject). No new
server protocol.

- **Op schema (example):**
  ```json
  {
    "operations": [
      { "type": "replace", "anchor": "<unique quoted text>", "with": "<new text>", "reason": "..." },
      { "type": "insertAfter", "anchor": "<quoted text>", "content": "..." },
      { "type": "delete", "anchor": "<quoted text>" },
      { "type": "appendToEnd", "content": "..." }
    ]
  }
  ```
- **Anchoring:** match `anchor` against `editor.getText()` / node text; if unique,
  map to `{from,to}`; if ambiguous/missing, surface as a skipped op (no silent
  failure). (Avoids trusting absolute offsets the model can't see reliably.)
- **Reuses:** chat endpoint, structured output (`RequestBuilder.js:298` →
  adapter `response_format`/schema), permissions, usage tracking. Zero backend
  changes beyond a "Document Editor" app config.
- **Covers:** the FloatingToolbox quick-actions (rewrite/expand/translate/grammar
  on selection), "summarize the doc", "continue writing" — i.e. the existing
  Canvas AI surface, upgraded from "insert blob" to **diff + accept/reject**.
- **Limits:** not truly multi-step; the model edits from a single snapshot and
  cannot "look again" after a change. Good for 80% of editing actions.

### Option B — Server-side agent loop over a document mirror
Client sends the document (Tiptap JSON or Markdown) at request start; the
server's agentic loop runs document tools (`replace`, `insert`, `search`)
against an **in-memory server copy**, streaming a patch set back; client applies
the final patch as suggestions.

- **Reuses:** the full existing `processChatWithTools` / `continueWithToolExecution`
  loop **as-is** — document tools are just normal server-side tools operating on
  the in-memory doc string.
- **Cost:** server needs a faithful document model. Markdown interchange is
  simple but lossy (tables/marks); ProseMirror-JSON interchange needs the **same
  schema on the server** (`prosemirror-model`) — heavier, and risks client/server
  schema drift + double-application bugs.
- **Verdict:** viable, lowest *protocol* effort, but introduces a server-side doc
  model we'd otherwise not need. Keep as fallback if Option C's protocol work is
  deemed too large.

### Option C — Client-executed tools via a generalized pause/resume *(recommended Phase 4b — the faithful agent)*
Generalize the `ask_user` clarification mechanism into a **generic client-tool
protocol**, so the LLM's document tools execute **in the browser** against the
live Tiptap doc — exactly mirroring Tiptap Pro's resolver model, but on iHub's
own loop.

**Protocol (new, built on existing primitives):**
1. Document tools are registered as **`clientExecuted: true`** tools (new flag in
   the tool definition; analogous to `passthrough`/`ask_user` special-casing in
   `ToolExecutor`).
2. When the LLM calls one, the server emits a new SSE event
   `tool.client.request` `{ callId, toolName, args }` (mirrors
   `trackClarification`) and **pauses the loop** (same mechanism as
   `hasClarificationRequest`).
3. The client executes the tool against Tiptap (read/search/replace/insert),
   producing a result (e.g. `{ ok: true, matched: 1, newSelectionText: "..." }`),
   and **POSTs it back** as a tool result for `callId` (mirrors the clarification
   answer round-trip).
4. The server resumes `continueWithToolExecution`, feeding the tool result to the
   LLM, and the loop continues until the model stops (max-iteration cap already
   exists, line ~1214).
5. Edits land as **suggestions** (the §5 layer); user accepts/rejects at the end
   (or per-step).

- **Tools (AI-Toolkit equivalent):** `read_document(range?)` (chunked by nodes),
  `get_selection`, `search(query)`, `replace_range({from,to}|anchor, content)`,
  `insert({at|anchor}, content)`, `delete(range|anchor)`,
  `set_heading/format(...)`. Read tools are free; write tools produce suggestions.
- **Read/write boundary:** enforce per-tool (e.g. read-only mode disables write
  tools); gate the whole tool set by group permissions (existing
  `chatAuthRequired` + app `tools` gating).
- **Pros:** true multi-step agent; document stays only in the browser; no
  server-side doc model; reuses iHub's loop, permissions, adapters, usage.
- **Cons:** new (small) bidirectional protocol + client tool runtime. This is the
  one genuinely new piece of infrastructure — but it's a **generalization of code
  that already exists** (`ask_user`), and it's broadly useful beyond the editor.

### Recommendation
**Ship Option A first (4a)** for immediate value and low risk, then **build
Option C (4b)** for the real agent. Treat Option B as the fallback if the
client-tool protocol proves too costly. A/C share the suggestion UI (§5) and the
"Document Editor" app config, so 4a is not throwaway.

## 5. Suggestion / accept-reject layer (MIT, shared by A and C)

This replaces Pro's **AI Changes** extension.

- **Representation:** custom ProseMirror **marks** `suggestion_insert` /
  `suggestion_delete` (and a node-level attr for block changes), rendered with
  distinct styling; or a Decoration set for non-persisted preview. Each change
  carries a `changeId` + metadata (tool/call origin, reason).
- **Diffing:** for "replace selection" we know the range directly; for free-form
  rewrites use **`prosemirror-changeset`** (MIT) to compute a minimal diff between
  the pre-edit and post-edit doc, then map to insert/delete marks.
- **UI:** a review panel / inline controls: **Accept** (strip insert marks to
  plain content, remove deleted ranges), **Reject** (inverse), Accept-all /
  Reject-all. Mirrors the current `CanvasContentConfirmationModal` UX but at the
  granularity of individual changes.
- **Audit:** emit existing `tool.call.start/end` events for each applied op;
  record usage via `usageTracker` exactly like normal chat.

## 6. Routing & server changes

- **App config:** add a `contents/apps/document-editor.json` (or per-app
  `features.editor`) whose `tools` list is the document tool set, and (for 4a) an
  `outputSchema` for the op list. Reuses `/api/apps/:appId/chat/:chatId`.
- **4a:** **no server code changes** beyond config — pure structured output.
- **4b:** localized server changes in `server/services/chat/ToolExecutor.js`:
  - add `clientExecuted` tool handling alongside `ask_user`/`passthrough`;
  - new event `tool.client.request` in `shared/unifiedEventSchema.js` +
    `actionTracker` emitter + `server/sse.js` passthrough;
  - a resume path that injects the client-returned tool result into
    `continueWithToolExecution` (model the `ask_user` answer round-trip).
- **Client:** a `useEditorAgent` hook that (4a) sends the doc + request and
  applies the returned ops as suggestions; (4b) additionally registers a
  client-tool runtime that handles `tool.client.request` events, executes against
  the Tiptap editor, and POSTs results back.

## 7. Security / privacy / on-prem

- All LLM traffic stays on iHub adapters (incl. local/vLLM/LM Studio) — **no data
  to Tiptap Cloud, no Pro runtime check, air-gapped-safe** (only MIT packages from
  public npm, mirrorable).
- Document content travels only client→iHub (4a/C never send the doc to a third
  party). Option B keeps a transient server copy for the loop's duration.
- Tool gating + group permissions reuse the existing chat authorization path
  (`chatAuthRequired`, app `tools`/permissions).

## 8. Risks specific to the OSS path

- **Anchor reliability (4a):** models must quote existing text exactly; mitigate
  with fuzzy/normalized matching + explicit "could not locate" reporting.
- **Client-tool protocol correctness (4b):** pause/resume + callId bookkeeping;
  reuse the `ask_user` precedent and cap iterations. Handle disconnect mid-loop.
- **Suggestion layer complexity:** track-changes is non-trivial; start with
  replace-range granularity, add changeset diffing incrementally.
- **Multiple concurrent suggestions / collaboration:** out of scope (no backend
  doc persistence yet — see G3 follow-up).

## 9. Effort (OSS Phase 4, replaces the Pro estimate)

| Item | Effort |
| --- | --- |
| 4a — structured ops + suggestion apply + accept/reject UI | 4–6 d |
| 5 — suggestion/changeset layer (shared, MIT) | 3–5 d |
| 4b — client-tool protocol (server pause/resume + client runtime) | 5–8 d |
| 4b — document tool set (read/search/replace/insert/delete) | 3–4 d |
| Doc-editor app config + permissions + usage wiring | 1–2 d |

(Comparable to the Pro estimate, with **$0 licensing** and no air-gapped registry
risk; the extra build cost buys full control and on-prem safety.)

## 10. Open questions for sign-off

1. **Phase 4a scope first, then 4b?** (recommended) or jump straight to the full
   client-tool agent (4b)?
2. **Suggestion granularity** for v1: replace-range only, or full changeset
   diffing from the start?
3. **Dedicated "Document Editor" app** vs. enabling the editor agent on any app
   with `features.editor`?
4. **Backend document persistence** (G3) — still a follow-up, or pull forward
   because real agentic editing benefits from server-held doc state (also unlocks
   Option B and collaboration)?
