# 01 — Current State (verified 2026-10-08, `main` @ 091acc2)

Everything below was checked in code or reproduced with the installed library versions (mammoth 1.12.3, pdfjs-dist 6.3.289, turndown 7.2.4). Nothing is assumed from documentation alone.

## 1. Data flow

```
File (browser)                           client/src/features/upload/utils/fileProcessing.js
  └─ processDocumentFile(file) ──────────► { content: string, pageImages?: string[] }
       ├─ PDF  → processPdfFile          (pdf.js, items joined by ' ', '\n' per page)       L637
       │         if content < 50 chars → renderPdfPagesToImages (max 5 pages, JPEG)         L1009
       ├─ DOCX → processDocxFile         (mammoth.convertToHtml → div.textContent)          L674
       ├─ XLSX/PPTX/ODF/MSG/TIFF/text    (unchanged in release 1)
       ▼
fileData { content, pageImages, fileName, fileType, displayType }
       ▼
server: shared/promptContext.js renderDocuments()                                           L211
       <content type="document" origin="upload|attachment" name=… format=…>content</content>
       or <content … pages_as_images="N"/> when content is empty
       ▼
server/services/chat/RequestBuilder.js attachDocumentPageImages()   attaches pageImages only when !file.content
server/services/workflow/executors/PromptNodeExecutor.js L946      "[File: name (type)]\n\ncontent", images only when content is empty
```

### Every caller of `processDocumentFile()` (all get the change automatically)

| Entry point | File | Notes |
|---|---|---|
| Chat upload (paperclip, drag & drop) | `client/src/features/upload/components/UnifiedUploader.jsx` ~L312 | Also used by `ChatInput`, `ChatStartForm`, `StartWorkflowModal` (workflow start form) |
| iFinder document attach (`?documentId=…`) | `client/src/features/apps/pages/AppChat.jsx` ~L1215 | Document fetched from iFinder, then same pipeline |
| Cloud picker (Google Drive, OneDrive, Nextcloud) | `client/src/features/upload/utils/cloudFileProcessing.js` ~L104 | |
| Outlook add-in attachments | `client/src/features/office/utilities/buildChatApiMessages.js` ~L202 | Errors are swallowed per attachment (attachment silently skipped) |
| Browser extension, Nextcloud app, Teams | — | No own extraction; they use the client bundle or send no files |

### Paths that do **not** use it

| Path | File | Current behavior |
|---|---|---|
| OpenAI-compatible inference API | `server/services/inference/inputContent.js` `pdfText()` L114, `documentFromInlineFile()` L142 | Own PDF extraction (same `join(' ')`); DOCX rejected with `unsupported_file_type`; `file_has_no_text` when PDF text is empty (L180) |
| OCR tool (text-only / smart mode) | `server/routes/toolsService/processors/ocrProcessor.js` `analyzePdfPages()` L173 | Third copy of the same PDF text join |

Release 1 changes only the browser path (decision A1). The two server paths are release 2 (`2026-10-08 Follow-ups Release 2.md`, WP-E).

## 2. What the model receives today (reproduced)

| Input | Output of the current code |
|---|---|
| DOCX: title, `1. Geltungsbereich` (Heading 1 + Word numbering), body, `1.1 Definitionen`, page break, `2. Laufzeit` | `VertragGeltungsbereichDieser Vertrag gilt für alle Parteien.DefinitionenBegriffe werden…LaufzeitDer Vertrag läuft 12 Monate.` |
| DOCX numbered list `(1) Erstens`, `(2) Zweitens` | `ErstensZweitens` |
| DOCX 2×2 table | `NameWertA1` |
| DOCX footer with page field | missing |
| DOCX run with `<w:br w:type="page"/>` between two words | `Before page breakafter break` (glued even inside one paragraph) |
| DOCX hidden text (`w:vanish`) | **included** (the model sees text the author hid) |
| PDF, 3 pages, page 2 without text | `1. Geltungsbereich  Dieser Vertrag … re- gelt die Zusammenarbeit.  Seite 1 von 3\n\n2. Laufzeit …` — no page markers, page 2 invisible, line breaks become (double) spaces |

The DOCX row was reproduced inside jest with the real code path (see `2026-10-08 Test Plan.md` §1), so it can serve as the first failing test.

## 3. Library behavior that shapes the design

### mammoth 1.12.3

| Behavior | Consequence |
|---|---|
| Maps paragraph styles by **name**, case-insensitive: `heading 1`…`heading 6` → `<h1>`…`<h6>`. German Word (`styleId="berschrift1"`, `name="heading 1"`) works. | Built-in headings are fine. |
| Custom heading styles (corporate templates, e.g. `IF Kapitel`) and `w:outlineLvl` (style or paragraph) are **ignored** → `<p>` plus warning "Unrecognised paragraph style". | Real customer templates lose their hierarchy unless we add style mappings (`p.<styleId> => hN:fresh`, verified working). |
| Numbering: emits `<ol>`/`<ul>` without labels. Consecutive list paragraphs are merged into one `<ol>` even when Word restarts numbering (`startOverride`); numbering formats (`a)`, `(i)`, `§ 1`, `Teil I`) are lost. | Labels must be computed from `numbering.xml`/`styles.xml` **before** mammoth, not derived from `<ol>` positions. |
| `w:ins` content kept, `w:del` dropped, deleted paragraphs merged (accepted view). | Matches decision A3 (visible text). Counters must skip deleted paragraphs. |
| Comments ignored unless style map `comment-reference => sup`. | Matches A3. |
| No header/footer reader. | Headers/footers need an own pass (PR 4). |
| `w:br w:type="page"` and `w:lastRenderedPageBreak` dropped without whitespace; `w:cr` ignored (`endafter cr`); `w:pageBreakBefore` ignored. | Pre-pass must turn page breaks into whitespace/marker and `w:cr` into `w:br`. |
| `w:moveFrom` **and** `w:moveTo` are "unrecognised elements" and dropped with their content. | Text moved with track changes on vanishes completely today. Pre-pass keeps `moveTo` runs, drops `moveFrom`. |
| Hidden text (`w:vanish`) kept. | Pre-pass must drop it (A3: visible text only). |
| Tables keep `colspan`/`rowspan`; **vMerge continuation cells are removed** from the row. | A naive HTML→Markdown table shifts later cells one column left. |
| Images become `<img src="data:image/…;base64,…">`. | Any Markdown conversion that keeps images puts megabytes of base64 into the prompt. |
| Footnotes → `<sup><a href="#footnote-1">[1]</a></sup>` + `<ol>` at the end with `↑` back links. | Needs dedicated rules. |
| Node build (`lib/index.js`) only accepts `{ buffer }`/`{ path }`; the browser build (resolved by Vite through the `browser` field) accepts `{ arrayBuffer }`. | In jest, `import('mammoth')` resolves the Node build and fails with "Could not find file in options" → jest needs a mapping to `mammoth.browser.js`. |

### turndown 7.2.4 (core, as used by `client/src/utils/markdownUtils.js`)

| Behavior | Consequence |
|---|---|
| Escapes Markdown characters: `1\. Absatz`, `Art. 5 \[1\]`, `\*nicht\*`, `a\_b`, `\- Strich` | Pollutes quotes, numbers and every comparison; Translator output would contain backslashes. Must set `escape` to identity. |
| No table rule: cells become separate paragraphs | "Tables as Markdown" needs an own rule. |
| Images → `![](data:…)` | Token explosion (see above). |
| Internal links (`#_Toc…`, footnote anchors) kept as `[text](#anchor)` | Noise; TOC entries duplicate headings. |

### Already in the repo: `server/tools/lib/pageContent.js` `createMarkdownConverter()` (L183)

A tested Turndown setup for web pages: ATX headings, `-` bullets, drops images (keeps alt as `[Image: …]`), reduces in-page links to their text, drops in-page footnote markers, compact list items, **GFM table rule with pipe escaping**. It still escapes Markdown characters and does not expand `colspan`/`rowspan`. Best starting point for the shared document converter (tests: `server/tests/websearch-page-content.test.js`).

### pdf.js 6.3.289

| Behavior | Consequence |
|---|---|
| Line ends arrive as separate empty items with `hasEOL: true` | Join on `hasEOL` gives real lines; today's `join(' ')` yields double spaces. |
| `getPageLabels()` works (e.g. `['i','1','2']`) | Printed page numbers available for front matter. |
| A page without text layer returns `items: []` | Must be flagged, otherwise silently missing. |
| Hyphenated line ends (`re-` / `gelt`) are separate lines | Do **not** dehyphenate automatically (German suspended hyphens: `Bundes-` / `und Landesrecht`). |
| Running headers/footers ("Seite 1 von 3") are ordinary text | Kept; they also give the model the printed page number. |
| `getStructTree()`, `getOutline()` exist (null for untagged PDFs) | Release 2 (heading detection). |
| Package is ESM only (`pdf.mjs`) | Cannot be loaded in jest (CJS) → "Must use import to load ES Module". Test the text assembly as a pure function; real pdf.js only in `node --test`. |

## 4. Constraints from the codebase

- **`shared/` cannot import npm packages.** It has no bare imports today; `turndown`, `mammoth`, `jszip` exist only in `client/node_modules` (and partly `server/node_modules`), not at the root. Shared modules must receive libraries and the XML parser by injection. Precedent for shared code imported by both sides: `shared/promptContext.js` (relative imports, no alias).
- **Feature switch:** features are declared in `server/featureRegistry.js` (`{ id, name, description, category, default }`); `resolveFeatures()` applies the registry default when `contents/config/features.json` has no value, and the admin page lists the registry automatically — a new entry needs no migration. The client gets `features` from `GET /api/configs/platform` (`fetchPlatformConfig()` in `client/src/api/endpoints/config.js`, cached 30 min, already imported by `fileProcessing.js`'s module) and builds `featuresMap` like `PlatformConfigContext.jsx` L97–103.
- **Prompt rendering:** `sourceText()` in `shared/promptContext.js` only HTML-escapes our own structural tag names (`content`, `body`, `title`, `date`, `from`, `to`, …). Markdown passes through unchanged; a literal `<title>` in a document is escaped (existing behavior).
- **Persistence:** the server stores attachment descriptors, not file text (`messageAttachments`), and caps stored strings at 100k chars (`ChatRepository.MAX_MESSAGE_CHARS`). The client keeps `fileData` in `sessionStorage` and already handles `QuotaExceededError` (`useChatMessages.js` ~L440). Slightly longer content does not change this.
- **Apps that depend on structure today:** `parliamentary-questions` ("Preserve the original numbering exactly…") accepts only text/Markdown/PDF; `stellungnahmen-review` workflows cite `§`/sections; `translator` must keep formatting. These are the first places where better structure becomes visible — and where regressions (escaping, markers) would show.
- **Existing test that encodes current behavior:** `tests/unit/client/pptx-file-extraction.test.jsx` asserts slide order by file name. Not touched in release 1; relevant for WP-D.

## 5. Gaps vs. issue #2751 and the follow-up plan

| Issue/plan says | Reality | Resolution (see README) |
|---|---|---|
| Phase 1: "convert mammoth HTML to Markdown" | Turndown core escapes, flattens tables, embeds images | Shared converter based on `createMarkdownConverter()` + no escaping + span-aware tables + footnote rules |
| Phase 2: numbering labels as heading prefix | Cannot be derived from mammoth's `<ol>`; also needed for list paragraphs | OOXML pre-pass injects labels as text and removes `numPr` before mammoth (spike verified) |
| Phase 3: `[Page N]` markers | Markers make "empty" text non-empty → scanned-PDF fallback (`< 50 chars`) never fires; the same trap exists in `RequestBuilder`, `PromptNodeExecutor`, the API's `file_has_no_text` | Length checks use text **without** markers; pages without text get an explicit marker |
| Phase 4: DOCX page hints | Unreliable (missing in Google Docs / generated files, stale after edits) | Dropped (decision A4); only explicit page breaks are marked, unnumbered |
| Not mentioned | Corporate heading styles / `outlineLvl` lost | Style map generated from `styles.xml` |
| Not mentioned | Hidden text is sent to the model today | Removed (decision A3) |
| Not mentioned | No rollback if the new format misbehaves | Admin feature switch, default on (decision A2) |
