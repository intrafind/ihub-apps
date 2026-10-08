# Structure-Preserving Document Extraction

**Issue:** [intrafind/ihub-apps#2751](https://github.com/intrafind/ihub-apps/issues/2751)
**Status:** Ready for implementation (release 1) — 2026-10-08
**Owner of decisions:** Daniel Manzke

Uploaded Word and PDF files reach the model as flat text today: chapter numbers, headings, list labels, table cells and page boundaries are lost, Word paragraphs are glued together. For document comparison, contract review and citing sections, that structure is essential. This folder is the complete handoff for an implementation agent.

## Reading order

| File | Purpose |
|---|---|
| [`2026-10-08 Current State.md`](2026-10-08%20Current%20State.md) | Verified facts: data flow, every entry point, library behavior (mammoth, Turndown, pdf.js), constraints, gaps in the original issue |
| [`2026-10-08 Pre-Mortem.md`](2026-10-08%20Pre-Mortem.md) | "Shipped but it didn't work" — 24 failure scenarios with prevention and test IDs |
| [`2026-10-08 Edge Cases.md`](2026-10-08%20Edge%20Cases.md) | Expected behavior per edge case (numbering, styles, tables, PDF, switch) |
| [`2026-10-08 Test Plan.md`](2026-10-08%20Test%20Plan.md) | Test infrastructure findings, fixture helper (validated), test matrix, golden corpus, manual QA |
| [`2026-10-08 Implementation Plan.md`](2026-10-08%20Implementation%20Plan.md) | **Agent brief:** guardrails, module design, PR 1–5 with files, tests and done criteria, validated spike code |
| [`2026-10-08 Follow-ups Release 2.md`](2026-10-08%20Follow-ups%20Release%202.md) | Release 2: inference API, PDF headings, PPTX/XLSX/ODF, per-app options |

## Decisions

Answered by the owner on 2026-10-08:

| ID | Question | Decision |
|---|---|---|
| A1 | Which path first? | **Browser upload** (chat, workflows, cloud picker, iFinder, Outlook add-in). Inference API is release 2 |
| A2 | Rollout | **On by default**, admin feature switch `structuredDocumentExtraction` (Admin → Features) restores today's output |
| A3 | New content sent to the model | **Visible text only.** Headers/footers yes. Comments, tracked deletions, hidden text, speaker notes: not sent (later only as per-app opt-in). Hidden text, which is sent today, is removed |
| A4 | DOCX page numbers | **None.** Word does not store pages; explicit page breaks are marked `[Page break]`, unnumbered |

Technical defaults set during analysis (override in review if needed):

| ID | Topic | Default | Why |
|---|---|---|---|
| D1 | Where the logic lives | New pure modules in `shared/documentExtraction/` with injected libraries; client adapter in `fileProcessing.js` | Release 2 (API) becomes wiring; `shared/` cannot import npm packages |
| D3 | mammoth vs. own parser | **Keep mammoth**, add an OOXML pre-pass that injects numbering labels as text and fixes what mammoth drops | Validated in a spike; output matched LibreOffice on the test fixtures |
| D4 | Markers | `[Page N]`, `[Page N (printed: L)]`, `[Page N: no extractable text]`, `[Page break]`, `[Header] …`, `[Footer] …`, `[Image: alt]`, footnotes `[^n]` / `[^n]: …` — English, fixed | Consistent with existing `[Sheet: …]`, `[Slide N]`; models read them in any document language |
| — | Markdown escaping | Off | Escaping puts backslashes into every quote and number (PM-03) |
| — | Merged table cells | Row spans repeated per row, column spans in the first column | Every row stays self-contained, columns never shift |

## What changed compared to issue #2751

The issue was written before the verification. The implementation plan supersedes it where they differ:

1. **Phase 1:** plain Turndown is not enough — it escapes Markdown characters, has no table rule and turns images into base64 data URLs. A document-specific converter is required.
2. **Phase 2:** numbering cannot be derived from mammoth's `<ol>` (restarts merged, formats lost). Labels are computed from `numbering.xml`/`styles.xml` and injected before mammoth. Counters are keyed by `abstractNum` (the first spike keyed by list and was wrong — caught with LibreOffice as oracle).
3. **Phase 3:** page markers must not count as text, otherwise the scanned-PDF image fallback silently stops working (PM-01).
4. **Phase 4:** dropped (A4).
5. **New:** custom heading styles / `outlineLvl`; hidden text removal; tracked moves (mammoth loses moved text entirely today); `w:cr` and page breaks gluing words; the feature switch.

## Questions still open (not blocking release 1)

| ID | Question | Default until answered |
|---|---|---|
| Q-01 | Who provides the golden corpus (`2026-10-08 Test Plan.md` §5), and may anonymised files be committed to the public repo? | Daniel provides; files stay local, outputs go into the PR description |
| Q-02 | Should hidden numbered paragraphs consume a number? Needs a check in Word (print view) | Not counted |
| Q-03 | Many `[Page break]` markers when the Heading 1 style has "page break before" — acceptable? | Yes, emit them |
| Q-04 | Strip running headers/footers from PDF page text? | Keep |
| Q-05 | Enable DOCX in the `parliamentary-questions` app once numbering ships? | Owner of the app decides; mentioned in the release note |
| Q-06 | Update issue #2751 with the corrected plan, or close it in favor of per-PR issues? | Leave the issue; link this folder |
| Q-07 | Target release version | Next minor after PR 3 is merged |

## Release 1 at a glance

| PR | Content | Main risk it closes |
|---|---|---|
| 1 | Feature switch, test infra, DOCX → Markdown (headings, outline styles, tables, footnotes, links, page breaks, hidden text, moves, no escaping, no images) | PM-02, 03, 04, 06, 07, 09, 11, 12, 24 |
| 2 | Word numbering labels | PM-05 |
| 3 | PDF page markers, labels, line breaks, scanned fallback | PM-01, 10 |
| 4 | DOCX headers/footers | — |
| 5 | Prompt guidance in `docs/apps.md` | PM-14 |

## Implementation status

| PR | Status | Where the code is |
|---|---|---|
| 1 — switch, test infra, DOCX → Markdown | Done (see below) | `shared/documentExtraction/{markers,markdown,docx}.js`, `shared/documentExtraction/ooxml/{xml,styles,normalize}.js`; wiring in `client/src/features/upload/utils/fileProcessing.js` (`processDocxFile`, `legacyDocxText`, `isStructuredExtractionEnabled`); switch in `server/featureRegistry.js`; tests `tests/unit/client/docx-*.test.jsx`, `document-extraction-flag.test.jsx`, `office-docx-attachment-extraction.test.jsx`, `server/tests/document-extraction-feature.test.js`; fixtures `tests/utils/officeFixtures.js` |
| 2 — numbering labels | Done (see below) | `shared/documentExtraction/ooxml/numbering.js` (counters), numbering step 3d in `ooxml/normalize.js`, wiring in `docx.js`; tests `tests/unit/client/docx-numbering-extraction.test.jsx` |
| 3 — PDF pages | Done (see below) | `shared/documentExtraction/pdfText.js` (+ `markers.js`); wiring in `fileProcessing.js` (`extractPdfContent`, `legacyPdfText`); tests `tests/unit/client/pdf-structured-text.test.jsx`, `server/tests/document-extraction-pdf.test.js` (in `test:pdf`) |
| 4 — headers/footers | Not started | |
| 5 — prompt guidance | Not started | |

### Decisions and findings from PR 1

- **Section breaks:** a `sectPr` describes the section it ends, but its `w:type` says how *that*
  section starts. The plan said "after paragraphs carrying a `sectPr` of type nextPage"; that
  would mark the wrong boundary. The type of section k decides whether a marker follows the
  paragraph that ends section k−1. No marker before the first content of the document.
- **Markers inside a paragraph** are single line breaks (`before\n[Page break]\nafter`), not
  blank lines; `pageBreakBefore` and section breaks are paragraphs of their own.
- **`w:noBreakHyphen`:** mammoth emits U+2011, normalized to `-`. **Tabs** fold to one space.
- **Turndown is quadratic** on one call for a long document (see "T-PERF-01 method" in the test
  plan). The converter works through top-level blocks in chunks of 100 and joins them; this was
  found by measuring in Chromium, jsdom hid it.
- **Performance vs. the 2× stop rule:** median 2.2× legacy at 5,000 paragraphs (0.3 s for about
  100 pages, linear up to 1.4 s at 20,000 paragraphs). Raised for a decision before PR 2.
- **Malformed XML parts** cannot test the fallback: mammoth rejects them as well, so the legacy
  path fails exactly like before. The fallback is tested by making the structured step reject.
- **Not applicable in PR 1:** numbering labels (PR 2); `T-DOCX-03, 04, 07–13, 15` and the numbering
  parts of 20/21.

### Decisions and findings from PR 2

Validated with a differential fuzz against LibreOffice (`soffice --convert-to txt` as oracle; 3 × 120–200 generated documents with direct and style-based numbering, about 8,400 labels, 0 mismatches). The fuzz script is a dev tool and is not committed; the expected labels in the tests are hard-coded.

- **Counters are keyed by `abstractNum`**, shared by all `w:num` that point to it. A `w:startOverride` applies **per level, the first time that `w:num` uses that level** (not when the instance is first used at another level) — the first fuzz run had 193 mismatches before this was found.
- **Level shown by a skipped level** is its start value; a deeper level starts over after any shallower paragraph; `isLgl` turns roman/letters/ordinals into decimals but keeps `decimalZero` zero-padded; letters repeat (`z`, `aa`, `bb`).
- **`w:lvlRestart` is not implemented:** the level and every level whose `lvlText` refers to it get **no label** (PM-05: wrong numbering is worse than none). Counting still runs so other levels stay correct.
- **Numbering comes from the paragraph or its style** (`numPr` in the style chain, `numStyleLink`/`styleLink`, level linked by `w:lvl/w:pStyle`). `numId 0` switches numbering off.
- **mammoth must not see the numbering again:** a numbered paragraph gets its label as text and its `numPr` is neutralised. Clearing it is not enough — mammoth also finds list membership through the style link — so the paragraph gets explicit `ilvl=0` and `numId=0`.
- **Bullets** stay mammoth lists only when every level above them is a bullet too; under a numbered level they become a `- ` paragraph (otherwise mammoth writes `- - text`).
- **Empty numbered paragraph:** counted (Word shows its number), no label written. **Deleted or moved-away paragraph marks and hidden paragraphs take no number** — Q-02 (hidden numbered paragraphs in Word's print view) is still to be confirmed in Word by a human.
- **Applicable test IDs now covered:** T-DOCX-03, 04, 07–13, 15, and the numbering parts of 20, 21 and 28.

### Decisions and findings from PR 3

- **Lines:** pdf.js puts the spaces of a line into its items and marks the line end with `hasEOL`
  (usually on an empty item). The items of a line are concatenated **without** a separator —
  joining with a space (as before) doubles every space; runs of one word (kerning, font change)
  arrive as separate items and must stay glued. Whitespace runs collapse to one space, empty lines
  are dropped, line-end hyphens stay (no dehyphenation). Checked on real pdf.js output
  (LibreOffice and pdf-lib PDFs).
- **Marker label from the file is untrusted:** brackets, parentheses and line breaks are removed
  and the label is cut at 40 characters, so a crafted label cannot produce a second marker.
- **Scan detection** uses `realTextLength` (markers excluded) for structured text and the old
  `trim().length < 50` for the plain text, so switching off the feature keeps the old decision
  byte for byte. A PDF without a single character of text assembles to `''` (no row of
  "no extractable text" markers).
- **Short text below the threshold (T-PDF-06):** the pages are rendered and the content is set to
  `''`, because `RequestBuilder` only attaches page images for a file without content. Before,
  such a PDF (a scan with a page number in its text layer, or a one-line PDF) reached the model as
  its few characters only. **If rendering fails or yields no image, the text is kept** (a
  deviation from the test plan row, which assumed rendering cannot fail).
- **Server-side extractors are untouched** (`inputContent.js`, `ocrProcessor.js`): release 2 (WP-E).
- `attachDocumentPageImages` in `RequestBuilder.js` is exported for the T-DOWN-02 test; no behaviour change.
