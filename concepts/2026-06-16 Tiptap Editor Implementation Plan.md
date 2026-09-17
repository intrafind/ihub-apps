# Tiptap Editor — Detailed Implementation Plan

**Date:** 2026-06-16
**Status:** Plan for review (no code yet)
**Tracking issue:** [#1609](https://github.com/intrafind/ihub-apps/issues/1609)
**Companion to:** [`concepts/2026-06-16 Tiptap Editor Integration.md`](./2026-06-16%20Tiptap%20Editor%20Integration.md) (research + concept, merged in #1608)

> This document turns the merged concept into an actionable, file-level
> implementation plan with per-phase task lists, a Quill→Tiptap API map, the
> exact npm packages, the feature-flag/rollout strategy, acceptance criteria,
> and a test plan. It is written to be split into one tracking issue per phase.

---

## 0. Executive summary

- **Goal:** Replace the Quill-based **Canvas** editor (`client/src/features/canvas/`)
  with a Tiptap (ProseMirror) editor, keep all AI traffic inside iHub, and add
  local DOCX/PDF — without sending any document data to Tiptap Cloud.
- **What is unblocked today (OSS, public npm):** Phases 1–3 and an OSS agentic
  layer. `@tiptap/react@3.x` and `@tiptap/starter-kit@3.x` install from the
  public registry (verified: v3.26.1).
- **What is blocked (external):** Phase 4's **Tiptap Pro** AI Agent / AI Toolkit
  (`@tiptap-pro/*`) return **404 on the public registry** — they need a paid
  subscription + private-registry token. This is the Phase 0 procurement gate
  from the concept doc; it cannot be resolved inside the build environment.
- **Recommended rollout:** New code lives in `client/src/features/editor/`
  behind a per-app feature flag (`app.features.editor === true`), running
  **side by side** with the existing Canvas. Quill is removed only in the final
  cutover (Phase 5), once parity is verified.

### Decision gates (must be answered by a human)

| Gate | Question | Status |
| --- | --- | --- |
| **G0 — Licensing** | Buy a Tiptap subscription incl. AI Agent + AI Toolkit add-on? | **DECIDED: no.** Build the AI layer OSS on the MIT core. |
| **G1 — Routing** | Resolver reuses the app-chat endpoint vs. a dedicated agent route. | Reuse `/api/apps/:appId/chat/:chatId` (default A). |
| **G2 — Agentic design** | How to build the OSS agentic layer (G0=no). | **DECIDED: OSS.** See [OSS Agentic AI Layer doc](./2026-06-16%20Tiptap%20OSS%20Agentic%20AI%20Layer.md) — Option A (4a) then Option C (4b). |
| **G3 — Persistence** | Keep `sessionStorage`-only, or add backend document persistence? | Open follow-up (may be pulled forward for true agentic editing). |

---

## 1. Current state — concrete inventory

All under `client/src/features/canvas/`:

| File | Role | Migration note |
| --- | --- | --- |
| `pages/AppCanvas.jsx` | Page: split chat/editor panes, settings, panel resize, voice commands, content-from-chat redirect. | Fork to `pages/AppEditor.jsx`; swap `CanvasEditor`→`TiptapEditor`, `quillRef`→`editor` instance. |
| `components/CanvasEditor.jsx` | Wraps `react-quill` (Snow theme) + custom clipboard (copy/cut/paste as md/html). | Replace with `TiptapEditor.jsx` (`useEditor` + `EditorContent`). |
| `components/QuillToolbar.jsx` / `.css` | Toolbar: headings, B/I/U/strike, lists, blockquote, code, link, undo/redo, char count, export, voice. | Replace with `EditorToolbar.jsx` driven by Tiptap commands; add BubbleMenu. |
| `components/CanvasVoiceInput.jsx` | Dictation; `quill.insertText()` at cursor; Ctrl/Cmd+M; `useVoiceRecognition` + Azure. | Reimplement as `EditorVoiceInput.jsx` using `editor.chain().focus().insertContent()`. |
| `components/ExportMenu.jsx` | Copy text/markdown/html; print-to-PDF. Uses `useClipboard`, `useFeatureFlags`. | Reuse almost verbatim; feed it editor HTML/JSON. Extend in Phase 2 (DOCX). |
| `components/FloatingToolbox.jsx` | AI quick-actions (continue/summarize/expand/tone/translate/grammar…). | Reuse verbatim — it's editor-agnostic (`onAction(id, description)`). |
| `components/CanvasChatPanel.jsx` | AI chat sidebar; `onInsertAnswer` inserts into editor. | Reuse; rewire `onInsertAnswer` to Tiptap insert. |
| `components/CanvasContentConfirmationModal.jsx` | Replace/append/cancel modal for incoming content. | Reuse verbatim. |
| `hooks/useCanvas.js` | Content state (+`sessionStorage`), selection, `handleEditAction` (prompt builder), `applyEditResult` (Quill insert). | Fork to `useEditorDocument.js`; keep prompt builder; rewrite selection + `applyEditResult` against Tiptap. |
| `hooks/useCanvasContent.js`, `useCanvasEditing.js`, `useCanvasEditResult.js` | Older/auxiliary hooks (some overlap with `useCanvas.js`). | Consolidate; only `applyEditResult` semantics need a Tiptap rewrite. |

**Wiring facts that matter:**

- Canvas is enabled **per app** via `app.features.canvas === true`
  (`SharedAppHeader.jsx:127`, `AppChat.jsx:374`). The new editor will use a
  parallel flag `app.features.editor === true`.
- Route is `/apps/:appId/canvas` → lazy `SafeAppCanvas` (`App.jsx:364`). Canvas
  is a **sub-route of `/apps`**, which is already in `knownRoutes`
  (`runtimeBasePath.js:36`). **No `knownRoutes` change is required** unless we
  introduce a new top-level path (we won't — new route is `/apps/:appId/editor`).
- AI already routes through iHub: `useAppChat` → SSE; `handleEditAction` builds a
  prompt, sets `window.pendingEdit`, calls `handlePromptSubmit`; the completed
  assistant message is applied via `applyEditResult`. **No backend changes needed
  for the OSS AI path.**
- Persistence is `sessionStorage` only (`ai_hub_canvas_content_{appId}`). Same
  model retained; new keys `ai_hub_editor_content_{appId}`.
- Reusable export libs already in `client/package.json`: `docx@^9.5.3`,
  `mammoth@^1.11.0`, `marked`, `turndown`, `dompurify`, `file-saver`,
  plus `client/src/utils/exportFormats.js`, `markdownUtils.js`.

---

## 2. Packages

**Phase 1–3 (public npm, MIT — no licensing):**

```
@tiptap/react @tiptap/pm @tiptap/starter-kit
@tiptap/extension-link @tiptap/extension-placeholder
@tiptap/extension-underline @tiptap/extension-text-align
@tiptap/extension-table @tiptap/extension-table-row
@tiptap/extension-table-cell @tiptap/extension-table-header
@tiptap/extension-character-count
@tiptap/extension-bubble-menu @tiptap/extension-floating-menu
```
(All pinned to the same `3.x` minor; StarterKit already bundles bold/italic/
strike/heading/lists/blockquote/code/history.)

**Phase 4 (Pro — requires G0):**
```
@tiptap-pro/extension-ai-agent          (client)
@tiptap-pro/extension-ai-agent-server   (server, if Path B)
@tiptap-pro/extension-ai-changes        (accept/reject diff UI)
```
> Installed only from Tiptap's private registry with a build-time token; **404
> on public npm**. Vendoring/offline-mirror story must be proven in G0 before
> any of this is added to `package.json`.

**Removed in Phase 5:** `react-quill@^2.0.0`.

---

## 3. Quill → Tiptap API map (the core of the rewrite)

| Concern | Quill (current) | Tiptap (target) |
| --- | --- | --- |
| Mount | `<ReactQuill value onChange .../>` | `const editor = useEditor({extensions, content})` + `<EditorContent editor={editor}/>` |
| Get HTML | `quill.root.innerHTML` | `editor.getHTML()` |
| Get/set JSON | n/a (HTML only) | `editor.getJSON()` / `editor.commands.setContent(json)` |
| Plain text | strip tags via regex | `editor.getText()` |
| Selection | `onChangeSelection` → `{index,length}` | `editor.on('selectionUpdate')` → `editor.state.selection.{from,to}`; text via `editor.state.doc.textBetween(from,to,' ')` |
| Insert at cursor | `quill.insertText(i, txt)` | `editor.chain().focus().insertContent(txt).run()` |
| Insert HTML | `clipboard.dangerouslyPasteHTML` | `editor.chain().focus().insertContent(html).run()` (HTML string parsed by PM) |
| Replace selection | `deleteText` + `updateContents(delta)` | `editor.chain().focus().deleteRange({from,to}).insertContent(content).run()` |
| Char count | `quill.getLength()` | `CharacterCount` extension → `editor.storage.characterCount.characters()` |
| Undo/redo | `history` module | StarterKit history → `editor.commands.undo()/redo()` |
| Toolbar bind | `#quill-toolbar` container | buttons call `editor.chain().focus().toggleBold()...run()`; active state via `editor.isActive('bold')` |
| Clipboard md/html | custom copy/cut/paste handlers | `editorProps.handlePaste/transformPastedHTML` + `turndown` for md copy |

**`applyEditResult` rewrite (key behavioral parity):**
- `action === 'suggest'` → no document mutation (unchanged).
- Markdown detection via existing `isMarkdown()`; convert with `markdownToHtml()`
  then `insertContent(html)`.
- If a range is selected: `deleteRange({from,to})` then `insertContent`.
- Else append at end with spacing; move cursor to end.

---

## 4. Phased plan

### Phase 0 — Licensing & POC spike  *(gate G0/G1; partly external)*
- **In-repo (doable now):** throwaway branch — Tiptap core + StarterKit rendering
  in a sandbox route; wire the **OSS** resolver to an existing app-chat endpoint
  against a local LLM; confirm streamed edits land in the doc. Prove the
  resolver ↔ `ChatRequest` mapping (de-risks Path A).
- **External (cannot do in this env):** obtain subscription quote (AI Agent +
  AI Toolkit add-on); verify private-registry token in CI/Docker/binary/
  **air-gapped** builds; confirm no runtime phone-home; confirm custom-LLM
  resolver is allowed on the purchased tier.
- **Exit:** G0/G1 answered in writing; routing decision recorded.

### Phase 1 — Core editor swap (no AI net-new) — *fully unblocked*
**New:** `client/src/features/editor/`
- `components/TiptapEditor.jsx` — `useEditor` + `EditorContent`, StarterKit +
  link/underline/placeholder/text-align/table/character-count; processing
  overlay; exposes editor via ref/callback for the page.
- `components/EditorToolbar.jsx` (+ css) — command buttons w/ active states; char
  count; export + voice slots. Port BubbleMenu for inline format on selection.
- `components/EditorVoiceInput.jsx` — see Phase 3.
- `hooks/useEditorDocument.js` — fork of `useCanvas.js`: `sessionStorage`
  (`ai_hub_editor_content_{appId}`), selection state, prompt builder
  (`handleEditAction` reused verbatim), Tiptap `applyEditResult`.
- `pages/AppEditor.jsx` — fork of `AppCanvas.jsx`; reuses `CanvasChatPanel`,
  `FloatingToolbox`, `CanvasContentConfirmationModal`, `ExportMenu`,
  `SharedAppHeader`.

**Edits:**
- `client/src/App.jsx` — add lazy route `apps/:appId/editor` → `SafeAppEditor`
  (mirror `SafeAppCanvas`).
- `SharedAppHeader.jsx` — add `mode="editor"`; gate a "Open in editor" button on
  `app.features.editor === true` (parallel to `canvas`).
- Reuse `ExportMenu` for HTML/Markdown/print (feed `editor.getHTML()`).

**Acceptance:** With `features.editor:true`, `/apps/:appId/editor` loads; type/
format/list/table/link/undo-redo work; char count correct; content persists in
session; existing FloatingToolbox + chat-insert AI actions work end-to-end via
iHub chat; **Canvas remains fully functional** for other apps. Lint/format clean;
bundle delta measured.

### Phase 2 — Local DOCX / PDF — *unblocked*
- **Export DOCX:** `editor.getJSON()` → `docx` builder. New
  `client/src/utils/tiptapDocx.js`: map paragraph, heading 1–3, bold/italic/
  underline/strike, bullet/ordered lists, blockquote, codeBlock, link, tables.
  Save via `file-saver`.
- **Import DOCX:** `mammoth.convertToHtml()` → HTML → `editor.commands.setContent(html)`.
- **PDF:** keep browser-print (parity); optionally evaluate server-side render
  later (out of scope).
- **Edits:** extend `ExportMenu.jsx` with "Download .docx" + an import control;
  gate behind existing `export` feature flag.
- **Acceptance:** round-trip a fixture set (headings, nested lists, table, bold/
  italic/links, blockquote, code) DOCX→editor→DOCX with acceptable fidelity;
  fidelity gaps (nested tables, footnotes) documented as known limits.

### Phase 3 — Dictation extension — *unblocked*
- `EditorVoiceInput.jsx`: reuse `useVoiceRecognition` + `azureRecognitionService`;
  on final transcript `editor.chain().focus().insertContent(text + ' ').run()`;
  preserve Ctrl/Cmd+M toggle, interim transcript UX, `VoiceFeedback`. Detect
  focus via the editor's ProseMirror DOM (replace the `.ql-editor` check).
- **Acceptance:** Ctrl/Cmd+M toggles dictation; transcript inserts at cursor;
  manual/automatic modes match Canvas behavior.

### Phase 4 — Agentic AI layer  *(OSS — decided: no Tiptap Pro license)*
**Decision recorded:** we will **not** buy Tiptap Pro. Phase 4 is built entirely
on the MIT core + iHub's own backend. Full design in
[`2026-06-16 Tiptap OSS Agentic AI Layer.md`](./2026-06-16%20Tiptap%20OSS%20Agentic%20AI%20Layer.md).

- **4a (ship first):** single-shot **structured edit ops** via iHub `outputSchema`
  → client maps to ProseMirror transactions → **accept/reject suggestion UI**.
  No server code changes (config only). Upgrades the existing FloatingToolbox/
  chat-insert actions from "insert blob" to "diff + accept/reject".
- **Suggestion layer (shared):** custom ProseMirror insert/delete marks +
  optional `prosemirror-changeset` diffing; review/accept-reject UI (replaces
  Pro's AI Changes).
- **4b (faithful agent):** generalize the `ask_user` clarification pause/resume
  into a **client-executed tool protocol** (new `tool.client.request` event +
  `clientExecuted` tool flag in `ToolExecutor`), so document read/search/replace/
  insert/delete tools run in the browser inside iHub's existing agentic loop
  (`continueWithToolExecution`). Replaces Pro's AI Agent + AI Toolkit.
- **Fallback (Option B):** server-side agent loop over a document mirror, if the
  client-tool protocol proves too costly.
- Gate by group permissions (existing `chatAuthRequired` + app `tools`); record
  usage like normal chat.
- **Acceptance:** agent reads the doc and proposes ranged edits; user accepts/
  rejects per change; all LLM calls visible in iHub usage; **no data leaves iHub**
  and only MIT packages are used (air-gapped-safe).

### Phase 5 — Cutover & cleanup — *after parity sign-off*
- Point `app.features.canvas` apps at the new editor (or migrate the flag);
  remove `react-quill`, `QuillToolbar.*`, and dead Canvas components/hooks.
- If the public route path changes at the top level, update `knownRoutes`
  (`runtimeBasePath.js`) — **not needed** for `/apps/:appId/editor`.
- `npm run lint:fix && npm run format:fix`; `/document-feature` changelog entry;
  update `docs/` (canvas/editor docs).

---

## 5. i18n
New keys under an `editor.*` namespace mirroring existing `canvas.*` keys
(toolbar labels, placeholder, voice tooltips, export labels, processing). Add to
all locale files; the `i18n-checker` agent should pass with no hardcoded strings.

## 6. Testing
- **Unit:** `tiptapDocx.js` mappers; `applyEditResult` (selection vs append vs
  suggest); markdown detection paths.
- **Component:** toolbar command toggles + active states; char count; dictation
  insert.
- **E2E (Playwright):** load `/apps/:appId/editor`; type+format; run a
  FloatingToolbox action against a stub/local model; DOCX export+reimport; verify
  Canvas still works for canvas-flagged apps.
- **Build:** `timeout 10s node server/server.js` smoke; measure client bundle
  delta (Tiptap > Quill — confirm acceptable; both lazy-loaded).

## 7. Risks
- **Pro licensing / air-gapped registry** — biggest unknown (G0).
- **DOCX fidelity** with our own libs vs Tiptap Conversion — fixtures required.
- **Resolver ↔ ChatRequest impedance** — spike in Phase 0 before committing Path A.
- **Bundle size** — Tiptap heavier than Quill; keep route lazy-loaded.
- **No backend persistence** — follow-up (G3).

## 8. Effort (carried from concept, refined)
| Phase | Effort | Blocked? |
| --- | --- | --- |
| 0 POC + licensing | 2–4 d (+ procurement lead time) | partly external |
| 1 Core editor | 3–5 d | no |
| 2 DOCX/PDF local | 4–6 d | no |
| 3 Dictation | 1 d | no |
| 4 AI Agent/Toolkit | 5–10 d | **yes (G0)** |
| 5 Cutover/cleanup | 2–3 d | after parity |

## 9. Suggested issue breakdown (sub-issues of #1609)
1. Phase 0 spike + licensing sign-off (G0/G1).
2. Phase 1 core editor swap behind `features.editor` flag.
3. Phase 2 local DOCX/PDF.
4. Phase 3 dictation extension.
5. Phase 4 agentic AI (Pro **or** OSS, per G0/G2).
6. Phase 5 cutover + remove Quill.
