# Workspace Pane for Artifacts, Files and Sources

**Status:** Proposal (2026-11-10). Not yet implemented.
**Method:** A product manager, a UX designer and a UI designer each wrote a position on their own. They then reviewed each other's positions in one round of discussion. This document records what they agreed on, the disagreements that were settled and how, and what is still open.

---

## 1. Problem

Today every viewer **takes the conversation away** at the moment the user wants to act on the document:

| Viewer | File | Shape today |
|---|---|---|
| Artifact viewer | `client/src/features/chat/components/ArtifactViewer.jsx` | `fixed inset-0 z-[60]` modal with a focus trap. The "Show chat" toggle turns it into a `fixed … w-[60%]` overlay, but the chat does **not** reflow, so the messages and the composer stay half hidden. |
| Files drawer | `client/src/features/chat/components/ArtifactsPanel.jsx` (+ `UploadedFilesTab.jsx`) | `fixed inset-0 z-50` sheet with a `bg-black/40` scrim. It hides the chat completely. |
| Source preview | `client/src/features/documentPreview/components/DocumentPreviewModal.jsx` (+ `PdfPassageViewer.jsx`) | A separate modal for cited sources, with its own toolbar. |

So we have three overlays, three toolbars, three sets of button styles and two z-layers. None of them supports the loop users want: **read the document → copy from it or point at part of it → ask the model to change it → see the new version → keep going.**

Claude.ai solves this with a pane that sits **in** the layout next to the chat. The pane can grow to full screen when needed, and the conversation stays live the whole time.

### Jobs-to-be-done

| Job | Content | Why it matters |
|---|---|---|
| A. "Check and refine what the assistant made for me" | Generated artifacts | The money job: offers, letters, reports, Excel/Word output |
| B. "Check what I gave it, and use it" | Uploaded files (`ChatFileRepository`) | Context and reference |
| C. "Verify the claim against the source" | Cited sources (iFinder, integrations, project items) | The trust job, which sets iHub apart from a generic chatbot |

---

## 2. Decision in one sentence

Replace all three overlays with **one right-hand Workspace pane**. It is part of the chat page's layout, so the chat reflows next to it. It has three states (**closed / docked / full screen**) and a small **list → detail** stack, it hosts artifacts, uploaded files and cited sources, and it uses **one shared header**. The pane keeps the chat within reach in every state.

```
 ┌──────────┬────────────────────────────────┬┬─────────────────────────────────────┐
 │ App      │  messages (max-w-[44rem])      ││ ‹  ▣ Angebot.md  MD ▾  v1·v2·v3     │
 │ sidebar  │  …                              ││    [👁|</>] [Copy|▾] ⤓  Share ⤢ ✕   │
 │ (rail    │  ┌───────────────────────────┐ ││ ─────────────────────────────────── │
 │  when    │  │ ▣ Angebot.md        v3  › │ ││                                     │
 │  pane    │  │   Markdown · updated now  │ ││   document body                     │
 │  open    │  └───────────────────────────┘ ││   (select text → [✦ Ask AI | Copy]) │
 │  <1280)  │  ✎ Angebot.md · v3 ✕            ││                                     │
 │          │  [ composer …               ]  ││                                     │
 └──────────┴────────────────────────────────┴┴─────────────────────────────────────┘
                                             ↑ resizable divider (role=separator)
```

---

## 3. Information architecture

- **One pane, three kinds of content. Not one merged list.** One place on screen, one open/close/expand pattern, one URL state and one accessibility implementation. Each content type keeps its own actions:
  - **Artifact:** versioned, with an AI edit target (Phase 2). Full toolbar.
  - **Uploaded file:** immutable input. Actions: download original or extracted text, delete, and — in Outlook, when the original can be attached — **Attach to email** (today in `UploadedFilesTab.jsx`; it moves to the header's ⋯ menu, and is promoted to a visible header button on the Outlook surface).
  - **Source:** read-only forever. Passage highlights, passage navigation, "Open in source system". We never edit an iFinder document.
- **Pane stack, at most two levels.**
  - The **root** is the Files index, with tabs Generated / Uploaded / Sources. It replaces the Files drawer.
  - The **detail** is a single item.
  - Opening something from the chat (an artifact card, a file card, a source chip) goes straight to its detail. A back chevron `‹ Files` returns to the list.
  - One exception: opening a source while an artifact is shown makes the back chevron read `‹ Angebot.md`.
- **Replace, don't tab.** One item is visible at a time. You switch items with the title dropdown, which lists all the files of the chat and replaces today's prev/next pager. Tabs don't fit in a 400px pane.

---

## 4. Presentation states

| State | Enters via | Layout |
|---|---|---|
| **Closed** | ✕, Esc (focus inside the pane), new chat | Chat at full width |
| **Docked** | Click on a card/chip, the "Files" button, or auto-open of a new artifact (see below) | Flex sibling of the chat; the chat reflows |
| **Full screen** | ⤢, `Ctrl/Cmd+Shift+E` | Pane fills the content area, with a reading column of `max-w-[52rem]` and a floating composer dock (section 6) |

- **Never remount the viewer** between docked and full screen. Only the container changes. Scroll position, Preview/Code mode, the selected version and the composer draft are all kept.
- **URL:** keep `?artifact=<id>`. Add `&view=full` for full screen and `?source=<id>` for sources.
  - Opening the pane pushes **one** history entry. Switching items uses `replace`.
  - Back steps out one level at a time: full screen → docked → closed.
  - `ArtifactViewerHost.jsx` already implements most of this.
- **Sizes:**
  - Default pane width: **50%**, clamped to **420–960px**.
  - Pane minimum **360px**, maximum **70%**. Chat minimum **360px**.
  - The width is remembered per user in `localStorage`; this is a convenience only.
- **Left app sidebar:** below 1280px, it auto-collapses to its icon rail when the pane opens, and is restored when the pane closes.
  - This happens once per tab session.
  - A manual re-expand by the user always wins.
  - The collapse is announced politely: "Sidebar collapsed to make room".
- **Below 1024px, in the Outlook task pane, the browser-extension side panel, mobile and embed mode:** there is **no split, ever**. The pane opens as a full-screen sheet, which is a real `role="dialog"` with a focus trap, as it is today. Its header has a "Back to chat" button. At 400% zoom (WCAG 1.4.10 Reflow) it falls into the same sheet mode.
- **Standalone `/artifact` page:** the full-screen state without a chat.
- **Auto-open on a new artifact:** only when the pane is closed and the viewport is at least 1024px. Focus is never taken from the composer. The open is announced in a live region: "Angebot.md opened in workspace". An app/admin setting can turn it off.

---

## 5. One shared pane header

Today there are three toolbars: the viewer has about 11 icon buttons, the drawer has its own buttons, and PDF.js has a dark toolbar. They become one `PaneHeader` component used by all three content types.

```
[‹] [▣ Angebot.md  MD ▾] [v1·v2🔗·v3]  ···  [👁|</>] [Copy|▾] [⤓] [Share] [⤢] [✕]   [⋯]
```

| Slot | Rule |
|---|---|
| Back `‹` | Always shown in the detail view. It reads `‹ Files` when the item was opened from the list or from the chat (card, chip), and `‹ <previous item>` when it was opened from another item (§3) |
| Title | Type chip, name, and type badge (`MD`, `PDF`, `Source`). The name opens the "switch file" menu |
| Version switcher | Only with 2 or more versions. Up to 4 versions it is a segmented pill; above that, a "v7 of 7 ▾" dropdown with the prompt summary and time per version. 🔗 marks the version a share link points to |
| Preview / Code | Segmented control. Only for markdown, html, svg, csv, json and ipynb |
| Copy split button | Label "Copy". Its dropdown, labelled "More copy and download options", holds the copy formats and the export formats |
| Download | A visible icon button. Below 480px pane width it moves into the Copy dropdown |
| Share | Visible (icon + label) at a pane width of 480px or more; in ⋯ below that. Artifacts only. Sources show "Open in source system" in this place |
| Expand / Close | Always visible |
| ⋯ | Open in new tab, Show in Files, browser full screen, Delete (uploads) |

- Header height is `h-12` when docked and `h-14` in full screen. Buttons are `h-8` (32px, above the WCAG 2.5.8 minimum of 24px) with `ring-indigo-500` focus rings.
- **Sources:** passage navigation ("Passage 2/5 ↑↓") takes the version slot. Zoom moves to a small floating control at the bottom right of the PDF well. The dark PDF.js toolbar goes away.
- The header uses shared button tokens in place of the duplicated `ICON_BUTTON` / `SECONDARY` / `PRIMARY` strings.

---

## 6. Collaboration: "keep chatting while you work on the document"

### 6.1 Selection → chat (MVP)

- When text is selected in the pane, a floating chip appears above the selection: `[✦ Ask AI] [Copy]`. It is `rounded-full`, inverted colours, `h-7`.
  - It is also reachable with `Ctrl/Cmd+Shift+K` and through the context menu.
  - On touch devices, a sticky "Ask about selection" button is shown instead.
  - The chip has `role="toolbar"` and never takes focus by itself.
- **Ask about** puts a **quote block** in the composer and moves focus there. The block is `rounded-md border-l-2 border-indigo-400`, with a two-line excerpt and the source name, and it carries the artifact id, version and excerpt.
- **Edit with AI** does the same with an "edit" prefix. **In the MVP this honestly produces a new file**, and the text in the UI says so. Real in-place revision comes in Phase 2.
- This works for all three content types, sources included. It needs no server changes.
- **Sandboxed HTML/SVG previews:** the pane cannot read a selection inside the `sandbox="allow-scripts"` iframe, and the MVP does **not** weaken the sandbox or inject a selection bridge into model-written markup. For these types the chip works in **Code view** (and on the PDF/markdown/text/code renderers, which render in the pane's own DOM). A postMessage bridge that keeps the sandbox and CSP unchanged can be evaluated later.

### 6.2 Edit target: the active-artifact chip (Phase 2)

- `✎ Angebot.md · v3 ✕`. It is a pill: `rounded-full border-indigo-300 bg-indigo-50 text-xs h-7`. It sits above the composer next to the other context chips.
- With the chip present, the turn is an **edit request against that artifact and version**. Without it, the turn is a normal chat turn.
- **It is not sticky by default.** It is offered as a removable suggestion while an editable artifact is open, and it is only added automatically after the user's first edit request on that artifact. This avoids a turn silently becoming an edit, and avoids a hidden token cost.
- It is marked **stale** when a newer version exists. It is never offered for sources or uploads.
- The pill ("edit target") and the quote block ("this text") look different on purpose. Both can be present at once.

### 6.3 New versions (Phase 2)

- **One artifact, many versions.** "Angebot.md v1 → v2 → v3" is one card in the Generated list and one item in the pane. A new file appears only when the user asks for a new document.
- **The edit streams into the pane** with a 2px indeterminate bar under the header and "Updating…" in place of the type badge.
  - The body shows the previous content at `opacity-60` and re-renders as text arrives.
  - Copy still works and copies the last finished version.
  - If the user is reading an older version, the update runs in the background and a "v4 ready — View" notice appears. Content is never swapped under the reader's cursor.
- **The chat shows a compact update row, not a new full card:**

  ```
  ↻  Updated Angebot.md → v4   +12 −3   Tightened summary, added Q3 table   Open · Compare
  ```

- **Diff:**
  - Off by default.
  - After an update, the changed blocks flash for 2 seconds. There is no flash under `prefers-reduced-motion`.
  - A persistent "Changes since vN" toggle sits in the version bar. Changes are shown inline in the rendered preview: additions in emerald, deletions in red with strike-through and collapsed by default.
  - Every changed block gets a 3px **gutter marker**, so the diff does not rely on colour alone. "Next change" is keyboard-navigable.
  - Code view shows a standard `+`/`-` diff.
  - Binary kinds (docx/pptx/xlsx/pdf) compare by switching versions only.
- **Restore** "make vN current" creates vN+1. History is never rewritten.
- When the user views an older version, an amber bar reads "Viewing v2 · Restore as latest · Go to v4".

### 6.4 Full screen keeps a chat

The product owner's requirement is that "the editor gets a chat interface". In full screen, this is a **floating composer dock**: bottom centre, `max-w-2xl rounded-2xl shadow-xl backdrop-blur`.

- Collapsed, it is one line: "Ask to change this document…" plus the active-artifact chip.
- Expanded, it shows the latest answer as a snippet and its status ("Updated to v4 · view changes"), announced politely, plus an **"Open chat"** link that returns to the **docked** state. On surfaces without a docked state (below 1024px, Outlook, extension, mobile, embed) it closes the sheet back to the chat, and the item stays in the URL and on the active card, so one tap reopens it at the same scroll position, version and view mode.
- The document gets bottom padding equal to the dock's height, so the dock never covers the last lines.
- Esc collapses the dock before it leaves full screen. The dock is reachable with F6.

> PM and UX settled on the dock. In the discussion round the UI designer moved the other way, towards a 320px collapsible chat column on the left (last 3 turns + composer), with the dock as its collapsed state. Both are cheap to build because they reuse the same chat components. See §11, open decision 1.

---

## 7. Files index inside the pane

The two-column drawer goes away; it becomes a list that drills down into the detail view.

```
Files                                        [✕]
[Generated 3] [Uploaded 0] [Sources 5]
☐ Select all                     ⤓ Download all
──────────────────────────────────────────────
☐ [PDF] daniel-manzke-profil.pdf            ⋯
       100 KB · Answer 3 · 10 Nov
```

- Each row is `h-14`. The row for the file currently open gets `bg-indigo-50` and a 2px indigo left bar.
- Clicking a row opens the detail view. The checkbox selects without navigating.
- **Bulk actions:** "Download all (.zip)" is a ghost button. When something is selected, a sticky bottom bar appears: "2 selected · Download .zip · Clear".
- "Answer 3" is a link that scrolls the chat to that message and briefly highlights it.
- Empty state: an icon, "No files yet. Files the assistant creates or you upload appear here.", and Upload on the Uploaded tab.

## 8. In-message artifact card

```
┌───────────────────────────────────────────┐
│ [▣]  Angebot                      v3  ›   │
│      Markdown · 2 pages · updated now     │
└───────────────────────────────────────────┘
```

- The whole card is one button.
- **Active** (open in the pane): `border-indigo-500 ring-1 ring-indigo-500/30 bg-indigo-50/40` with `aria-current="true"`.
- Cards in older messages open the exact version they produced.
- Download is a hover/focus-revealed icon instead of today's text buttons.

## 9. Accessibility (BITV 2.0 / WCAG 2.2 AA)

- Docked and full screen are **not modal**: no focus trap, no `aria-modal`, no scrim.
- **Landmark:** for this release the pane is a `<section role="region" aria-labelledby>` inside `<main>`, labelled "Workspace: {title}". A skip link, "Skip to workspace", is added while the pane is open. Moving the pane out to be a sibling of `<main>` touches `Layout.jsx`, `AdminLayout`, embed mode and the skip link, so it is a separate a11y refactor.
- **Focus:**
  - When the pane opens from a click, focus moves to the pane heading (`tabIndex=-1`).
  - When the model auto-opens it, focus stays where it is and the open is announced.
  - When the pane closes, focus returns to the element that opened it, or to the composer if that element is gone.
- **Keyboard:**
  - F6 / Shift+F6 cycles sidebar → chat log → composer → pane.
  - `Ctrl/Cmd+.` toggles the pane.
  - Esc closes the innermost layer only: menu → selection chip → dock → full screen → pane. It does this only while focus is in the pane. **Esc in the composer never closes the pane.**
- **Divider:** `role="separator" aria-orientation="vertical" aria-valuenow`. Arrow keys resize, Home/End snap to the limits, and double-click resets the width to the default. (Double-click is used only for this; full screen is entered with ⤢ or the shortcut.)
- **One polite live region per pane** announces: "Updating Angebot.md…", "Version 4: 3 sections changed", copied, restored, and width ("Workspace 55 percent"). **Token text is never streamed into a live region.**
- Run the `a11y-audit` skill and update `tests/e2e/accessibility.spec.js` before release.

## 10. Motion and states

- **Open:** the pane width animates from 0 to its target over 220ms ease-out, and the content fades in 80ms later. Close takes 180ms. Expand to full screen takes 250ms. Under `motion-reduce:` there is no animation at all.
- **Loading:** skeleton lines in the reading column. A spinner appears only after 300ms.
- **Error:** an inline card in the body with "Couldn't load preview", Retry and Download original. The header stays usable.
- **Deleted or expired artifact, or a pinned share whose version is gone:** an explicit empty state, never a 404 or an error toast.

---

## 11. Phasing

### Phase 1: MVP, the reflowing pane (client only)

1. A `WorkspacePane` that sits in the layout of `AppChat.jsx`, with the closed/docked/full-screen states, the resizable divider, URL state and sidebar auto-collapse. It replaces the `fixed` containers in `ArtifactViewer.jsx`.
2. The shared `PaneHeader` and button tokens.
3. The Files drawer becomes the pane's index view (`ArtifactsPanel.jsx` content moves into the pane; the drawer is removed).
4. Source previews from `AnswerSources.jsx` open in the pane. `DocumentPreviewModal` stays as it is for project items outside the chat (`ProjectItemDocumentActions.jsx`) and as the narrow-surface fallback.
5. The in-message card redesign with its active state.
6. The selection chip "Ask about" / "Edit with AI" (quote into the composer). Edit honestly produces a new file.
7. Sheet fallback below 1024px and on the Outlook, extension, embed and mobile surfaces.
8. Accessibility per section 9, plus `docs/artifacts.md` / `docs/chat-files.md` updates and a `docs/releases/next/` entry.

### Phase 2: "talk to the document"

1. **Artifact lineage** in `ArtifactRepository`: `lineageId` / `parentId` / `version` on the metadata. Each version is a new immutable blob, and a "latest" alias resolves to the newest. This works for all scopes (chat, workflow, agent), not as a chat-only system.
2. **A revise tool:** either `revise_artifact` or `parentId` on the document skills' create tools. The model reads the referenced artifact with the existing `chat_artifacts_read`.
3. The active-artifact chip, the version switcher, the update row, diff and restore.
4. Share links **pin** the version that was current at share time.
   - The shared view says "Version 3 of 5, shared 10 Nov".
   - The share dialog states that the link is pinned.
   - The owner sees 🔗 on the pinned version and an "Update link to v4" action.
5. **Office previews:** docx/pptx/xlsx rendered server-side to PDF/HTML. These are our customers' real output formats, so this is funded before canvas editing.
6. **Settings:**
   - A `ui.workspacePane` setting (`auto` | `off`), plus an auto-open toggle.
   - A per-app "allow artifact revisions" flag.
   - Both need a migration in `server/migrations/`.

### Phase 3: direct editing (canvas)

The user edits Markdown/text artifacts in the pane, and saving creates a new version. `concepts/ai-assisted-canvas.md` is the reference. This is built **only if** the Phase 2 metrics show that people iterate on documents in iHub rather than only exporting them.

### Explicit non-goals

- WYSIWYG editing of docx/pptx/xlsx. That is Office's job, via the Office add-in round-trip.
- Real-time multi-user co-editing.
- Editing sources or uploaded files.
- A split view on the Outlook, extension or mobile surfaces.
- A second artifact system for agents or workflows.

---

## 12. Open decisions for the product owner

1. **Chat in full screen:** a floating composer dock (PM + UX, the default in this document) or a 320px collapsible chat column (UI's final stance)?
2. **Share link semantics:** does a link pin the version shared (proposed) or follow the latest?
3. **How the model revises:** a dedicated `revise_artifact` tool, or `parentId` on the existing create tools? Partial patches (search/replace) or full regeneration? This matters for long documents and `maxOutputTokens`.
4. **Context cost:** inject only the referenced excerpt plus the id (proposed), or the whole open artifact on every turn?
5. **Version retention:** set a cap on versions per artifact, which also affects the quota.
6. **Phase 2 ordering:** Office previews before or after lineage and revisions?

## 13. Technical notes and risks

- **Security:** the HTML/SVG sandbox (`sandbox="allow-scripts"` plus `HTML_PREVIEW_CSP` in `artifactFiles.js`) stays exactly as it is in the pane. Being inline must never mean being same-origin.
- **Embed hosts:** these may need `?pane=off`.
- **Deep links and shares:** `?artifact=` deep links and `/share/:shareId` single-file shares must keep working.
- **Layout ownership:** the pane needs a layout slot in `AppChat.jsx` (a flex row: chat column + pane). This is the main structural change. `ArtifactViewerHost.jsx` keeps owning open state and URL sync, and `ArtifactViewerContext` keeps `openArtifact` as the single entry point. It gains `openSource` and `openFiles`.

## 14. Success metrics

- More than 70% of artifact, file and source opens stay in the docked pane rather than full screen.
- Messages sent while the pane is open: the core "keep chatting" signal.
- Use of the selection chip per session.
- **Phase 2:**
  - Revisions vs duplicate new files for "change it" requests (target: fewer than 20% duplicates).
  - Revert rate, as a quality signal for model edits.
- Fewer "download → edit → re-upload" loops within one session.
- Source-pane opens per cited answer (the trust job).
- No regressions in task completion on the Outlook and extension surfaces.
