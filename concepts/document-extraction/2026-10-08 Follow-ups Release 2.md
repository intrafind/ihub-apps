# Document Extraction — Optional Follow-ups

**Date:** 2026-10-08
**Issue:** [#2751 — Document upload: preserve structure when extracting DOCX/PDF text](https://github.com/intrafind/ihub-apps/issues/2751) (Phase 5 "Optional / follow-ups" plus the optional PDF heading detection from Phase 3)
**Status:** Plan for release 2 — WP-F implemented (see `README.md`, "Release 2"); the rest not started

> **Updated 2026-10-08:** decisions D1–D4 below are resolved in [`README.md`](README.md). WP-A (headers/footers) moved into release 1 (PR 4 in `2026-10-08 Implementation Plan.md`); WP-B options must follow decision A3 (comments, deletions, hidden text and speaker notes only as opt-in per app); Phase 4 (DOCX page hints) was dropped (decision A4). Facts in "Verified findings" are extended in `2026-10-08 Current State.md`.

## Context

Issue #2751 Phases 1–4 make the core document path structure-aware: DOCX → Markdown, DOCX chapter/list numbering, PDF page markers and line breaks, best-effort DOCX page hints. Structure is crucial for use cases such as document comparison, contract review and citing chapters/pages, so the remaining format gaps matter too. This plan covers what is left, in a form that can be split into separate PRs.

All extraction still returns **one string per file** (`{ content, pageImages }` from `processDocumentFile()` in `client/src/features/upload/utils/fileProcessing.js`), rendered by `shared/promptContext.js` into a `<content type="document" …>` block. No change to that contract is planned.

## Scope

| ID | Work package | Value for structure-sensitive use | Effort¹ |
|----|--------------|-----------------------------------|---------|
| WP-F | PDF structure: tagged structure tree, outline, page labels, heading heuristic | High | M |
| WP-B | DOCX tracked changes and comments | High for comparison/review | M |
| WP-E | Shared extraction core, DOCX (and more) through the inference API | Medium; also removes triple implementation | L |
| WP-D | PPTX and XLSX parity | Medium | M |
| WP-C | ODT/ODS/ODP structure | Medium (LibreOffice-based organisations) | M |

¹ Rough: S ≤ 1 day, M 2–3 days, L 4–5 days, after Phases 1–3 of the issue are merged.

Non-goals: exact DOCX pagination (needs a layout engine such as server-side LibreOffice — separate decision, see Phase 4 of the issue), a pluggable external extractor (Docling/Tika) behind config, legacy binary `.doc`/`.ppt`, OCR changes.

## Verified findings

Checked against the code in this repo and the library sources (mammoth 1.12.3, pdfjs-dist 6.3.289), not assumed:

| Topic | Finding |
|-------|---------|
| Tracked changes | mammoth (`lib/docx/body-reader.js`) reads `w:ins` content as normal text and ignores `w:del` — the output is an "all changes accepted" view with no markup. A deleted run cannot be recovered through mammoth. |
| Comments | Ignored unless a style mapping `comment-reference => sup` is passed; then appended at the end of the output (mammoth README). |
| Headers/footers | mammoth has no header/footer reader. Verified earlier: a footer with a page-number field does not appear in the output. |
| Text boxes, footnotes | mammoth emits text boxes after their paragraph and footnotes at the end — kept as is. |
| PDF extractors | Three independent implementations join text items the same way: `processPdfFile` (client), `pdfText()` in `server/services/inference/inputContent.js`, `analyzePdfPages()` in `server/routes/toolsService/processors/ocrProcessor.js`. Any PDF improvement must otherwise be made three times. |
| pdf.js APIs | `PDFPageProxy.getStructTree()` (roles already mapped, `null` if untagged), `PDFDocumentProxy.getOutline()`, `getPageLabels()`, `getDestination()`/`getPageIndex()`, and `TextItem.hasEOL`/`height`/`fontName`/`transform` all exist in the installed version. |
| PPTX slide order | `processPptxFile` sorts `ppt/slides/slideN.xml` by the number in the file name and uses it as `[Slide N]`. The real order is `<p:sldIdLst>` in `ppt/presentation.xml` resolved through `ppt/_rels/presentation.xml.rels`; file names reflect creation order, so reordered decks get wrong slide numbers. To be confirmed with a fixture in WP-D. |
| PPTX tables, notes | `a:p` inside `a:tbl` cells come out as separate lines (row/cell structure lost); `ppt/notesSlides/*` are not read. |
| ODT | `processOpenOfficeFile` handles only `text:p`/`text:h` and plain text nodes. `text:line-break`, `text:tab`, `text:s`, heading level (`text:outline-level`), lists, tables and page breaks are not represented. ODS and ODP go through the same function. |
| Server dependencies | `server/package.json` has `jsdom`, `turndown`, `pdfjs-dist`, `pdf-lib`, `@hyzyla/pdfium`; it has **no** `mammoth` or `jszip`. The client has `mammoth`, `jszip`, `turndown`, `xlsx`, `docx`. |
| Shared-code precedent | `shared/promptContext.js` is imported by both server and client through plain relative paths (no alias), so a `shared/` extraction module needs no build changes. |

## Decisions needed before implementation

- **D1 — Build Phases 1–4 DOM-free from the start?** Recommended: yes. Write the extraction logic as pure functions in `shared/documentExtraction/` and inject the environment: `pdfjs` module (browser build with worker vs. `legacy/build/pdf.mjs` on Node) and `parseXml(string) → Document` (browser `DOMParser`; on the server jsdom's `DOMParser`, already a dependency). This avoids a second rewrite for WP-E and keeps the issue's first PR reviewable. Alternative: ship Phases 1–4 in `fileProcessing.js` and move later (cheaper now, a refactor later).
- **D2 — Opt-in or default?** The extracted text changes for every app that uses file upload (structure markers, more tokens). Per project rules no compat shim is added without a maintainer decision. Options: (a) new behavior for everyone; (b) per-app `upload.fileUpload` options for the contentious parts only — tracked changes mode, comments, headers/footers. (b) needs the Zod schema (`server/validators/appConfigSchema.js`), the admin UI and, if defaults must be written into existing files, a migration (`create-migration` skill).
- **D3 — mammoth vs. own OOXML walker for DOCX.** Phases 1–2 keep mammoth. WP-B needs deletions, which mammoth drops, and WP-A needs header/footer parts, which it does not read; together with Phase 2 (numbering from `numbering.xml`/`styles.xml`) that is a growing own OOXML pass beside mammoth. Gate at the start of WP-B: either keep mammoth for the body and add side passes, or replace mammoth with one document-order walker (paragraphs, runs, styles, numbering, tables, `w:ins`/`w:del`, comments, footnotes, hyperlinks, text boxes). Replacing gives one pass and one DOM-free implementation, but we then own what mammoth handles today.
- **D4 — Marker vocabulary.** Define once and document: existing `[Sheet: name]`, `[Slide N]`; new `[Page N]` (Phase 3), `[Header]`/`[Footer]`, and [CriticMarkup](https://criticmarkup.com/) for review marks: `{++added++}`, `{--removed--}`, `{>>author: comment<<}`. Plain-text convention, readable by models without explanation.

## Work packages

### WP-F — PDF structure beyond page markers (optional item from Phase 3)

Goal: heading levels and printed page numbers for PDFs, with a clear order of trust.

1. **Tagged structure tree** — `page.getStructTree()`: roles `H1`–`H6`, `L`/`LI`, `Table`/`TR`/`TD`, `P`. Most reliable, but only present in tagged PDFs. Map to Markdown the same way as DOCX.
2. **Outline (bookmarks)** — `pdf.getOutline()` gives titles, nesting and, via `getDestination` → `getPageIndex`, the target page. Match each entry to a text line on its page and promote that line to a heading of the entry's depth.
3. **Font heuristic (fallback)** — body size = most frequent `height` weighted by characters; lines clearly larger (and/or bold per `fontName`), short, not ending in a sentence period become `#`…`###` by size tier (max 3–4 tiers). Boost lines starting with a chapter pattern (`^\d+(\.\d+)*\.?\s+\p{L}`), which exists as real text in PDFs.
4. **Page labels** — `pdf.getPageLabels()` for printed numbering (roman, `A-1`): marker `[Page 3 — printed: iii]` only when label ≠ index.
5. Line reconstruction from `hasEOL` (Phase 3) and y-delta; document that multi-column pages follow content-stream order, not visual reading order.

Risks: false positives of the heuristic → conservative thresholds, applied only when steps 1–2 yield nothing. Acceptance is measured, not asserted: a small corpus (≈10 PDFs: Word export, LibreOffice export, LaTeX, InDesign, scanned-with-text-layer, multi-column) with golden heading lists; report precision/recall in the PR.

### WP-B — DOCX tracked changes and comments

Current: accepted view, comments dropped (see findings). Goal: a mode switch, default unchanged unless D2 decides otherwise.

- `changes: 'accepted' | 'markup'` — `markup` renders CriticMarkup using `w:ins`/`w:del`/`w:delText` (author/date available, optional).
- `comments: 'ignore' | 'inline'` — read `word/comments.xml`, anchor via `w:commentRangeStart`/`End` and `w:commentReference`; `inline` emits `{>>author: text<<}` after the anchored text.
- Depends on D3 (own pass) and on Phase 2's numbering/document walker.
- Tests: DOCX fixtures generated with the `docx` package (already a client dependency) for insertions, deletions inside a numbered heading, a deleted whole paragraph, comment on a table cell.

### WP-A — DOCX headers and footers

> Moved to release 1 (PR 4); kept here as design notes.

- Resolve parts through `sectPr` → `w:headerReference`/`w:footerReference` (`default`/`first`/`even`) → `word/_rels/document.xml.rels` → `word/headerN.xml`/`footerN.xml`.
- Reuse the Phase 2 paragraph walker; fields (`PAGE`, `NUMPAGES`, `fldSimple` and complex `fldChar`/`instrText`) are dropped, other text kept.
- Emit **once** as a preamble (`[Header] …` / `[Footer] …`), de-duplicated across sections — not per page, which would only add noise and tokens. Skip when nothing but page-number fields is left. Useful content: document title, version, "Draft", classification.
- Depends on D2 if opt-in; otherwise small.

### WP-E — Shared extraction core and the inference API

Problem: `documentFromInlineFile()` in `inputContent.js` accepts only PDF and text; DOCX gets `unsupported_file_type`, and PDF logic is duplicated.

- Create `shared/documentExtraction/` (per D1): `extractDocument({ bytes, mimeType, fileName, options }) → { text, pageCount?, warnings[] }`, one function per format, shared marker/numbering utilities (decimal/roman/letter formats, counter engine used by DOCX and ODT).
- Browser adapter keeps lazy `import()` of pdfjs/mammoth/jszip/xlsx (bundle size, offline worker — see the `?url` worker import in `fileProcessing.js`); server adapter injects the legacy pdfjs build and jsdom's `DOMParser`.
- Add `mammoth` and `jszip` to `server/package.json`; extend `documentFromInlineFile()` with DOCX (then PPTX/XLSX/ODF as WP-C/D land), keeping `MAX_FILE_TEXT_CHARS`/`MAX_PDF_PAGES` limits and the `file_has_no_text` error.
- `analyzePdfPages()` in the OCR processor reuses the shared page-text function for its text-only/smart modes; the VLM path stays untouched.
- **Stays client-side for the UI**: uploads are not sent to the server today (see `docs/file-upload-feature.md`, Security Considerations). The server path serves only API callers.
- Tests: Node-run tests next to the module (precedent `shared/featureFlags.test.js`) plus the existing jest client tests, which must keep passing unchanged.

### WP-D — PPTX and XLSX parity

PPTX:
- Slide order and numbers from `presentation.xml` + rels instead of file names; flag hidden slides (`show="0"`).
- Title placeholder (`p:ph type="title"`/`ctrTitle`) → `#` heading, so slides have a title line.
- `a:tbl` → Markdown table; speaker notes from `ppt/notesSlides` → `[Notes]`.

XLSX (`processXlsxFile`):
- Row/size cap with a truncation notice (`[… N more rows omitted]`) — a spreadsheet's text can be far larger than its file size, and the file limit does not protect the context window.
- Markdown table with header row instead of tab-separated CSV where the first row looks like a header; fill merged ranges (`!merges`); skip or flag hidden sheets.

### WP-C — ODT / ODS / ODP

- Replace the text-node walk in `processOpenOfficeFile` with a structured walker: `text:h` + `text:outline-level` → `#`; `text:list`/`text:list-item` → list; `table:table` rows/cells → table; `text:line-break`/`text:tab`/`text:s` → whitespace; `text:note` → footnote; paragraph-style `fo:break-before="page"` → page marker.
- Heading numbering lives in `text:outline-style` (`styles.xml`) with per-level `style:num-format` and `text:display-levels`; compute labels with the same counter engine as DOCX (WP-E utilities).
- ODS: `[Sheet: name]` tables as in XLSX; ODP: `draw:page` → `[Slide N]`.

## Sequencing

1. D1–D4 are decided (see `README.md`); release 1 builds the shared core this plan relies on.
2. Issue Phases 1–4 (not part of this plan).
3. **WP-F** — highest value for structure, independent of the DOCX decisions.
4. **WP-B** (D3 gate) — builds on the OOXML pre-pass from release 1.
5. **WP-E** — earlier if D1 is "shared core from the start"; at the latest before WP-C/D so they land once.
6. **WP-D**, **WP-C**.

Each work package is a separate PR with its own fixtures and docs, and can be a sub-issue of #2751.

## Findings left over from release 1

Raised in review, deliberately not done in release 1:

- **Numbered paragraphs inside footnotes and endnotes** (`footnotes.xml`, `endnotes.xml`): mammoth reads them from their own parts, so they keep the old, label-less output. Doing it right means resolving the note parts through the document relationships, normalising them in reference order and deciding how Word's per-note counters relate to the body's. No real document with a list inside a footnote has been seen; move it up if one turns up.
- **`startOverride` on a sub-level after its parent restarts:** the implementation restarts at the level's own start (what LibreOffice renders, checked by differential fuzz). Word's behaviour in this corner is unverified — covered by the Word golden corpus (G-01…G-07) before it is relied on.

## Test strategy

- Fixtures are generated in tests where possible (JSZip as in `tests/unit/client/pptx-file-extraction.test.jsx`; the `docx` package for DOCX with numbering, changes, comments; `pdf-lib` for PDFs with outline/labels), so no opaque binaries are committed. Only the WP-F quality corpus needs real files — anonymised and small.
- Each fixture asserts the *string* the model would receive, including the negative cases that are the bug today (no glued words, numbering present, deleted text absent in `accepted` mode).
- Client behavior stays covered by `tests/unit/client` (jest); the shared module gets Node tests. Run `npm run test:unit` and `npm run lint:fix && npm run format:fix` before each PR.

## Documentation and release notes

- `docs/file-upload-feature.md`: add an "Extracted text format" section (markers, CriticMarkup, what is and is not preserved per format) and correct the PPTX/PPT rows (they say "via `xlsx`"; the code uses JSZip + DrawingML, and `.ppt` is rejected).
- Release note per user-visible package in `docs/releases/next/` via the `/document-feature` skill.
- If D2 adds options: `docs/apps.md` and the admin app editor strings (i18n).

## Risks

- **Token growth** — structure costs characters. The existing context-window warning estimates from the content string and therefore picks it up automatically; verify its 80 % threshold still behaves (`concepts/2026-03-09 Document Context Window Warning.md`).
- **Prompt drift** — apps that depend on the flat text format (unlikely, prompts reference tags, not content) — covered by the D2 decision.
- **Heuristic quality (WP-F)** — mitigated by trust order and a measured corpus.
- **Bundle/worker size** — keep every heavy library behind dynamic `import()`; check the Vite build output after WP-E.
