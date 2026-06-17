# Tiptap Editor Integration — Research & Implementation Plan

**Date:** 2026-06-16
**Status:** Proposal / Research
**Author:** Daniel Manzke (research compiled with Claude Code)

## 1. Goal

Evaluate replacing iHub's custom-built **Canvas editor** (React Quill) with
[Tiptap](https://tiptap.dev/), and build a first-class **AI document editor app**
that:

- Lets users create/edit documents with rich text.
- Integrates Tiptap's **agentic AI** (AI Agent / AI Toolkit) so the LLM can read,
  edit, patch and rewrite the document — driven by **iHub's own LLM backend**
  (adapters, local LLMs, group permissions, cost tracking), **not** Tiptap Cloud.
- Supports **DOCX (and ideally PDF) import/export**.
- If the migration is sound, **retire the Quill-based Canvas**. The only existing
  feature not covered out-of-the-box is **dictation into the editor**, which we
  re-implement as a small Tiptap extension (low effort — see §7).

## 2. TL;DR Recommendation

**Yes — migrate to Tiptap.** It is the de-facto standard rich-text framework
(ProseMirror-based, React-native, MIT core, highly extensible). It replaces the
home-grown Quill stack with a maintained foundation and unlocks a genuinely
agentic editing experience.

Key architectural decisions:

| Concern | Decision |
| --- | --- |
| **Core editor** | Tiptap core + StarterKit — **MIT, free, self-hosted**. Replaces React Quill. |
| **AI / agentic editing** | Tiptap **AI Agent + AI Toolkit** with a **custom backend resolver** that routes every LLM call through **iHub's existing chat/adapter pipeline**. Keeps data on-prem; reuses local-LLM support, permissions, cost tracking. (Paid Tiptap subscription — see §6.) |
| **DOCX / PDF** | **Do NOT use Tiptap Cloud Conversion** (it uploads documents to Tiptap's servers — unacceptable for our enterprise / on-prem / air-gapped deployments). Instead keep our **existing local libs** (`docx`, `mammoth` — already in `client/package.json`) and convert Tiptap JSON ↔ DOCX ourselves. |
| **Dictation** | Re-implement as a Tiptap extension that inserts the transcript at the cursor, reusing the existing `useVoiceRecognition` hook + Azure service. |

**The single biggest caveat:** Tiptap's AI Agent / AI Toolkit / Conversion are
**paid Pro extensions** shipped via a **private npm registry** and require an
active subscription (token at build time). The MIT core is free. We must budget
for this and confirm the on-prem/air-gapped build story (registry token + any
runtime license check). See §6 and §10.

## 3. Current state (what we're replacing)

Located in `client/src/features/canvas/`:

- **`CanvasEditor.jsx`** — wraps **React Quill** (`react-quill@^2.0.0`), Snow theme.
- **`QuillToolbar.jsx` / `.css`** — custom toolbar (headings, bold/italic/underline,
  lists, blockquote, code, link, undo/redo, char count).
- **`CanvasVoiceInput.jsx`** — dictation; inserts text at cursor via Quill's
  `insertText()`. Uses `client/src/features/voice/hooks/useVoiceRecognition.js`
  (Web Speech API) + `client/src/utils/azureRecognitionService.js` (Azure Speech).
  Toggle via **Ctrl/Cmd+M**.
- **`ExportMenu.jsx`** — copy as text/markdown/HTML; "Print as PDF" (browser print).
- **`CanvasChatPanel.jsx`, `FloatingToolbox.jsx`, `CanvasContentConfirmationModal.jsx`**
  — AI chat sidebar + AI edit actions (replace/append flow).
- **Hooks** — `useCanvas`, `useCanvasContent`, `useCanvasEditing`, `useCanvasEditResult`.
- **Persistence** — `sessionStorage` only (`ai_hub_canvas_content_{appId}`); **no
  backend persistence** (lost on tab close).
- **Route** — `/apps/:appId/canvas` (`AppCanvas.jsx`), split chat/editor panes.

Existing export libs already in the repo (reusable, no Tiptap Cloud needed):
`docx@^9.5.3`, `mammoth@^1.11.0` (DOCX in/out), `pptxgenjs`, `write-excel-file`,
`marked`, `turndown`, `dompurify`, `file-saver`.

## 4. Tiptap capabilities (research findings)

### 4.1 Editor core — MIT / free
The Tiptap editor and most extensions are MIT-licensed, self-hostable, framework-
agnostic with first-class React bindings (`@tiptap/react`, `@tiptap/starter-kit`).
In June 2025 Tiptap open-sourced 10 formerly-Pro extensions under MIT. Only
**Comments, Snapshots/Versioning, AI, and Conversion** remain Pro.
Sources: [Open source → platform](https://tiptap.dev/open-source-to-platform),
[Pro extensions open-sourced (HN)](https://news.ycombinator.com/item?id=44202103).

### 4.2 AI Agent (agentic editor)
The **AI Agent** extension adds a Cursor-like agent that not only replies with text
but **calls tools to read and edit the document** (insert, replace, patch ranges).
Crucially, it supports a **custom backend / custom LLM** via a **`resolver`**:
you provide a function that ships chat messages to *your* backend and returns the
response, giving "complete control over the AI model, tools, and conversation flow."
Unsupported providers can be added by implementing the **`AiAgentAdapter`** interface.
A reference Next.js repo (`ueberdosis/ai-agent-custom-llm-demos`) shows custom
backends for **OpenAI (Chat + Responses), Anthropic Claude, and the Vercel AI SDK**,
using `@tiptap-pro/extension-ai-agent` (client) + `@tiptap-pro/extension-ai-agent-server`
(server) + `@tiptap-pro/extension-ai-changes` (review/diff UI).
Sources:
[AI Agent overview](https://tiptap.dev/docs/content-ai/capabilities/agent/overview),
[Integrate your LLM](https://tiptap.dev/docs/content-ai/capabilities/agent/custom-llms),
[Configure options](https://tiptap.dev/docs/content-ai/capabilities/agent/configure/options),
[Custom-LLM demos repo](https://github.com/ueberdosis/ai-agent-custom-llm-demos),
[Release: Introducing the AI Agent](https://tiptap.dev/blog/release-notes/introducing-the-tiptap-ai-agent).

### 4.3 AI Toolkit
The **AI Toolkit** gives agents structured **read / write / patch** operations over
the document, schema-aware chunked reads, streamed edits, and a tool layer that is
**framework-agnostic** (LangChain, Vercel AI SDK, Anthropic SDK, OpenAI, or "any AI
model that can output text"). Includes track-changes UI, audit logging, and read/write
boundary enforcement. **Paid add-on**, but runs against **your own backend/LLM** —
you only pay your own provider/token costs.
Source: [AI Toolkit](https://tiptap.dev/product/ai-toolkit).

> **Why this matters for iHub:** the resolver/custom-LLM path means we can keep the
> entire LLM round-trip inside iHub — through our `adapters/` (OpenAI, Anthropic,
> Google, Mistral, Bedrock, **local/vLLM/LM Studio/Jan**), with group permissions,
> tool gating and token accounting intact. No document content or prompts go to
> Tiptap Cloud.

### 4.4 DOCX / PDF conversion
Tiptap **Conversion** (`@tiptap-pro/extension-import-docx`, `extension-export-docx`,
`extension-export-pdf`, ODT/EPUB/Markdown) translates DOCX ↔ Tiptap JSON with good
fidelity (nested lists, tables, mixed fonts, custom-node mapping). **However it runs
as a Tiptap Cloud service by default** — the conversion happens on Tiptap servers,
and self-hosting/on-prem conversion is only available on the **Enterprise** tier.
Sources:
[DOCX import/export](https://tiptap.dev/docs/conversion/import-export/docx),
[Improved DOCX](https://tiptap.dev/blog/release-notes/improved-docx-import-export-in-tiptap),
[Legacy conversion](https://tiptap.dev/docs/conversion/legacy/overview).

> **Decision:** For privacy/on-prem reasons we will **not** adopt Tiptap Cloud
> Conversion. We already bundle `mammoth` (DOCX → HTML/JSON import) and `docx`
> (build DOCX export). We convert Tiptap JSON ↔ DOCX locally (client or server),
> exactly as the current Canvas export pipeline already does from HTML. This keeps
> documents on our infrastructure and avoids the per-conversion cloud cost.

### 4.5 Pricing (June 2026)
- **Editor core + most extensions:** MIT / free.
- **Start** ~$49/mo (annual) · **Team** ~$149/mo · **Business** ~$999/mo · **Enterprise** custom (adds **on-premises** option, custom auth/storage/AI).
- **Content AI / AI Agent:** bundled into subscription tiers; **AI Toolkit** is a
  custom-priced add-on. **Conversion** included in plans but cloud-run unless Enterprise on-prem.
Sources: [Pricing](https://tiptap.dev/pricing), [New pricing model](https://tiptap.dev/blog/release-notes/tiptaps-new-pricing-model-is-live).

## 5. Proposed architecture

```
┌────────────────────────────── Client (React) ──────────────────────────────┐
│  New feature: client/src/features/editor/                                    │
│   ┌────────────────────┐   ┌───────────────────────────────────────────┐    │
│   │ TiptapEditor.jsx    │   │ Tiptap AI Agent extension                 │    │
│   │  @tiptap/react      │◄──┤  resolver: POST iHub chat endpoint (SSE)  │    │
│   │  StarterKit (MIT)   │   │  AI Toolkit: read/write/patch doc tools   │    │
│   │  + Dictation ext    │   └───────────────────┬───────────────────────┘    │
│   │  + Toolbar/BubbleMenu                       │                            │
│   └─────────┬───────────┘                       │                            │
│             │ JSON/HTML                          │ chat messages + doc ops    │
│   DOCX/PDF ◄┘ (docx, mammoth — local)            │                            │
└─────────────────────────────────────────────────┼────────────────────────────┘
                                                   ▼
┌──────────────────────────── iHub Server (Express) ───────────────────────────┐
│  Editor-agent endpoint (new or special app)                                   │
│   → chatService.prepareChatRequest / processStreamingChat                     │
│   → adapters/ (openai, anthropic, google, mistral, bedrock, local/vLLM)       │
│   → group permissions, tool gating, cost/usage tracking, SSE stream out       │
└───────────────────────────────────────────────────────────────────────────────┘
```

**LLM routing options (pick during POC):**

- **A. Reuse the existing app-chat endpoint.** Define a dedicated "Document Editor"
  app (`contents/apps/`) and have the resolver POST to
  `/api/apps/{editorAppId}/chat/{chatId}` (SSE GET + POST as today). The resolver
  translates Tiptap agent messages ↔ our `ChatRequest` shape. **Lowest backend
  effort; inherits permissions, tools, accounting for free.**
- **B. New dedicated agent route.** Add `server/routes/editor/agentRoutes.js` using
  `@tiptap-pro/extension-ai-agent-server` to format the agent loop, dispatching to
  `chatService`/adapters. More control over the agent tool-loop, more code.

Recommended: **start with A** for the POC, evaluate B only if the agent tool-loop
needs server-side orchestration our app pipeline can't express.

**Auth:** reuse current model — JWT cookie / `Authorization: Bearer` and the
fetch+`AbortController` SSE pattern in `client/src/shared/hooks/useEventSource.js`.

## 6. Licensing & procurement (must resolve before building AI phase)

1. **Subscription tier** that includes Content AI / AI Agent and the **AI Toolkit**
   add-on (custom-priced) — get a quote.
2. **Private npm registry token** required to install `@tiptap-pro/*` — confirm it
   works in our **CI / Docker / binary build** and **air-gapped** builds (vendoring).
3. **Runtime license check** — confirm whether Pro AI extensions phone home or only
   need a build-time token (critical for on-prem/air-gapped customers).
4. Confirm the **custom-LLM resolver** path is fully supported on the purchased tier
   (i.e., we are *not* forced through Tiptap Cloud AI).
5. **Conversion stays local** (our libs), so no Enterprise on-prem conversion needed.

> If AI Toolkit licensing is a blocker, **Path B-OSS** (build agentic editing on the
> MIT core ourselves — custom Tiptap commands + our chat API + a diff/accept UI)
> remains viable at zero Tiptap cost, at the price of reimplementing the read/write/
> patch + track-changes layer the Toolkit provides. Keep this as the fallback.

## 7. Dictation (the one "missing" feature)

Low effort. Reuse `features/voice/hooks/useVoiceRecognition.js` + `azureRecognitionService.js`.
A Tiptap dictation control calls `editor.chain().focus().insertContent(text).run()`
(or `insertContentAt(selection, text)`) on each final transcript, preserving the
Ctrl/Cmd+M toggle and interim-result UX. No data leaves the existing pipeline.

## 8. Implementation phases

**Phase 0 — POC & licensing (1 spike)**
- Stand up Tiptap core + AI Agent in a throwaway branch; wire the resolver to a test
  iHub app-chat endpoint; confirm streamed agentic edits work end-to-end against a
  local LLM. Resolve all §6 licensing questions. Decide routing A vs B.

**Phase 1 — Core editor swap (no AI)**
- Add `@tiptap/react`, `@tiptap/starter-kit` (+ link, table, placeholder, etc.).
- New `client/src/features/editor/` with `TiptapEditor.jsx` + toolbar/bubble menu
  replacing `CanvasEditor`/`QuillToolbar`.
- Keep sessionStorage persistence; reuse `ExportMenu` (HTML/Markdown/print).
- Feature-flag behind the existing Canvas route so both can run side by side.

**Phase 2 — DOCX/PDF (local)**
- Tiptap JSON → `docx` for export; `mammoth` → HTML → Tiptap for import.
- Map headings, lists, tables, blockquote, code, inline marks (parity with current
  `markdownExports.js`). PDF via current browser-print, or a server-side renderer.

**Phase 3 — Dictation extension** (see §7).

**Phase 4 — AI Agent / Toolkit integration**
- Add `@tiptap-pro/extension-ai-agent` (+ `-ai-changes`) client-side; resolver → iHub.
- Map agent tool calls to document read/write/patch; surface accept/reject (changes UI).
- Gate by group permissions; record token usage like normal chat.
- Port the FloatingToolbox quick-actions (summarize/rewrite/translate) onto the agent.

**Phase 5 — Cutover & cleanup**
- Migrate the Canvas app/route to the new editor; remove `react-quill`, `QuillToolbar`,
  old Canvas components/hooks once parity is verified.
- Update `client/src/utils/runtimeBasePath.js` `knownRoutes` if the route path changes.
- `npm run lint:fix && npm run format:fix`; `/document-feature` changelog entry; docs.

## 9. Effort estimate (rough)

| Phase | Effort |
| --- | --- |
| 0 POC + licensing | 2–4 days (+ procurement lead time) |
| 1 Core editor | 3–5 days |
| 2 DOCX/PDF local | 4–6 days (fidelity-dependent) |
| 3 Dictation | 1 day |
| 4 AI Agent + Toolkit | 5–10 days |
| 5 Cutover/cleanup | 2–3 days |

## 10. Risks & open questions

- **Pro licensing / private registry in air-gapped builds** — biggest unknown
  (build token + possible runtime check). Resolve in Phase 0.
- **AI Toolkit cost** — custom-priced add-on; may push toward Path B-OSS fallback.
- **DOCX fidelity** with our own libs vs Tiptap Conversion — acceptable, but complex
  documents (nested tables, footnotes) need realistic test fixtures.
- **Resolver ↔ ChatRequest impedance** — Tiptap's agent message/tool format must map
  cleanly onto our SSE app-chat contract; spike it before committing to Path A.
- **No backend persistence today** — out of scope here, but a real document editor
  likely wants server-side storage; flag as a follow-up.
- **Bundle size / Babel-in-browser** — Tiptap is heavier than Quill; verify build.

## 11. Sources

- [Tiptap AI Agent overview](https://tiptap.dev/docs/content-ai/capabilities/agent/overview)
- [Integrate your LLM (custom backend)](https://tiptap.dev/docs/content-ai/capabilities/agent/custom-llms)
- [AI Agent configure options](https://tiptap.dev/docs/content-ai/capabilities/agent/configure/options)
- [Custom-LLM demos repo](https://github.com/ueberdosis/ai-agent-custom-llm-demos)
- [Introducing the Tiptap AI Agent](https://tiptap.dev/blog/release-notes/introducing-the-tiptap-ai-agent)
- [AI Toolkit](https://tiptap.dev/product/ai-toolkit)
- [DOCX import/export](https://tiptap.dev/docs/conversion/import-export/docx)
- [Improved DOCX import/export](https://tiptap.dev/blog/release-notes/improved-docx-import-export-in-tiptap)
- [Legacy conversion](https://tiptap.dev/docs/conversion/legacy/overview)
- [Pricing](https://tiptap.dev/pricing) · [New pricing model](https://tiptap.dev/blog/release-notes/tiptaps-new-pricing-model-is-live)
- [Open source → platform](https://tiptap.dev/open-source-to-platform) · [Pro extensions open-sourced (HN)](https://news.ycombinator.com/item?id=44202103)
