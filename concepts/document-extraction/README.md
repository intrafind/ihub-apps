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
| 4 — headers/footers | Done (see below) | `shared/documentExtraction/ooxml/headerFooter.js`, wiring in `docx.js`; tests `tests/unit/client/docx-header-footer-extraction.test.jsx` |
| 5 — prompt guidance | Done | `docs/apps.md` → "Writing prompts that use document structure" (what each format looks like, an example comparison prompt that aligns on section numbers and cites `[Page N]`) |

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
  deviation from the test plan row, which assumed rendering cannot fail). **The text is also kept
  when it sits on a page beyond the five rendered ones** (`lastPageWithText`), otherwise a page 6
  with a few lines would be lost; the images are then not attached (the file has content), as in
  the plain text path before.
- **Server-side extractors are untouched** (`inputContent.js`, `ocrProcessor.js`): release 2 (WP-E).
- `attachDocumentPageImages` in `RequestBuilder.js` is exported for the T-DOWN-02 test; no behaviour change.

### Decisions and findings from PR 4

- **Visible text only (A3):** a first-page header or footer is read only when its section has
  `w:titlePg`, an even-page header or footer only when `word/settings.xml` has
  `w:evenAndOddHeaders`; Word does not show them otherwise (the plan had listed all three types
  unconditionally).
- **Page-number fields** (`PAGE`, `NUMPAGES`, `SECTIONPAGES`, complex and `w:fldSimple`) lose their
  result. A paragraph that held such a field and keeps only pagination words afterwards ("Seite
  von", "Page of", "Pagina di", "第 页") disappears; any other remaining word keeps the line — a
  first version dropped every short remainder and ate "Vertraulich" and "Entwurf" (found by the
  test, not by review). The word list is small and closed on purpose; an unknown language leaves
  "Seite von"-style noise rather than losing content.
- **Text boxes** (letterhead addresses) are read; `mc:AlternateContent` is read once (the `Choice`
  branch), because Word stores the same box a second time in the legacy `Fallback`.
- **Lines, not blocks:** one `[Header] …` / `[Footer] …` line per paragraph, table rows as cells
  joined with ` | `; identical lines appear once across all sections and types. Headers come
  first, then footers, then a blank line and the body.
- **Never costs the body or the other parts:** a malformed or unresolvable header part is skipped
  silently (shared code has no logging) — only its own lines are lost; the other headers and
  footers and the body are extracted as before. The headers are read before the body
  pass changes `sectPr` handling.
- **Applicable test ID:** T-DOCX-25 (plus the cases above). Q-03 and the other open questions are unchanged.

### Checkpoint after PR 5 — text size, legacy vs. structured

Characters of the extracted text for the repository's own documents (`docs/*.md` converted with pandoc to .docx and, through LibreOffice, to PDF), measured with the shipped code. Tokens follow characters only roughly: Markdown syntax (`|`, `---`, `#`) costs more per character than the whitespace it replaces.

| File | Legacy | Structured | Change |
|---|---:|---:|---:|
| apps.docx | 58,722 | 62,861 | +7.0 % |
| architecture.docx | 35,626 | 34,584 | −2.9 % |
| file-upload-feature.docx | 17,174 | 18,738 | +9.1 % |
| models.docx | 46,943 | 49,933 | +6.4 % |
| apps.pdf (43 pages) | 66,477 | 60,420 | −9.1 % |
| architecture.pdf (24 pages) | 37,889 | 33,609 | −11.3 % |
| file-upload-feature.pdf (12 pages) | 19,196 | 17,686 | −7.9 % |
| models.pdf (26 pages) | 52,360 | 48,153 | −8.0 % |

Word: +6…9 % for table-heavy documents (Markdown tables, headings, numbering labels), slightly less where the legacy text carried glued table cells. PDF: −8…11 % — the doubled spaces of the old join are gone, the `[Page N]` markers cost about 10 characters per page. Very small documents grow in percent (a one-paragraph file with a header: 54 → 156 characters), not in absolute size.

## Release 2

Order: WP-F → WP-B → WP-E → WP-D → WP-C, one stacked draft PR each (`2026-10-08 Follow-ups Release 2.md`).

| WP | Status | Where the code is |
|---|---|---|
| F — PDF headings and tables | Done (see below) | `shared/documentExtraction/pdfStructure.js` (sources, tables), `pdfText.js` (orchestration, `readOutline`), `markers.js` (`realTextLength`); tests `tests/unit/client/pdf-structure.test.jsx`, `server/tests/document-extraction-pdf-structure.test.js` (in `test:pdf`) |

| B — Word tracked changes and comments | Done (see below) | `shared/documentExtraction/ooxml/review.js` (markup, comments), step 0b and `neutralizeList` in `ooxml/normalize.js`, `docx.js` (options, comments part), `markers.js` (CriticMarkup, `commentMarker`); app schema `upload.fileUpload.trackedChanges` / `comments` (`server/validators/appConfigSchema.js`), admin editor (`UploadConfigSection.jsx`, `shared/i18n/{en,de}.json`), `extractionOptionsOf` (`client/src/features/upload/utils/extractionOptions.js`) + callers; tests `tests/unit/client/docx-review-extraction.test.jsx`, `upload-config-review-options.test.jsx`, `server/tests/appConfigSchema.fileUpload.test.js` |

| E — shared core for the inference API | Done (see below) | `server/services/documentExtraction.js` (adapter, package guard), `server/services/inference/inputContent.js` (`documentFromInlineFile`), `extractPdfText(pdf, { maxPages, maxChars })` in `shared/documentExtraction/pdfText.js`; dependencies `mammoth`, `jszip` in `server/package.json`; tests `server/tests/document-extraction-api.test.js` (in `test:inference`), helpers `server/tests/helpers/{structuredPdf,docxFile}.js` |

| D — PowerPoint and Excel | Done (see below) | `shared/documentExtraction/pptx.js`, `xlsx.js`, `options.js`, `ooxml/package.js` (relationship helpers, moved out of `docx.js`), `markdown.js` (`escapeTableCell`, `markdownTableLines`); wiring `processPptxFile` / `processXlsxFile` / `legacy*Text` in `fileProcessing.js`; app option `upload.fileUpload.speakerNotes` (schema, admin editor, `extractionOptionsOf`); PowerPoint through the API (`extractPptxDocument`); tests `tests/unit/client/pptx-structured-extraction.test.jsx`, `xlsx-structured-extraction.test.jsx`, `server/tests/document-extraction-api.test.js` |

| C — OpenDocument (.odt, .ods, .odp) | Done (see below) | `shared/documentExtraction/odf.js` (entry, kind from the body), `odf/writer.js` (`createOdfReader`: text → Markdown, `shapeLines`, cell text), `odf/lists.js` (numbering), `odf/styles.js`, `odf/xml.js`, `odf/sheet.js` (ODS), `odf/slides.js` (ODP), `sheets.js` (rendering shared with `xlsx.js`: header detection, limits, notices); wiring `processOpenOfficeFile` / `legacyOpenOfficeText` in `fileProcessing.js`; OpenDocument through the API (`extractOdfDocument`, `OFFICE_DOCUMENTS` in `inputContent.js`); tests `tests/unit/client/odf-text-extraction.test.jsx`, `odf-sheets-slides-extraction.test.jsx`, `server/tests/document-extraction-api.test.js`, helper `server/tests/helpers/odfFile.js` |

### Decisions and findings from WP-F

- **Order of trust, per document:** tags → outline → font size. The first source that yields any heading decides for the whole document, so a document never mixes two kinds of guessing. Tables come from the tags only.
- **The tree annotates the line stream, it does not replace it.** `getTextContent({ includeMarkedContent: true })` carries the marked-content ids (`p158R_mc1`) that `getStructTree()` refers to; every text item gets the table row / cell / heading it belongs to. Running headers and footers are tagged as artifacts and stay as plain lines (Q-04: kept). Building the output from the tree alone would drop them and change the reading order of lines the model sees today.
- **Verified on real pdf.js and LibreOffice exports:** a heading can consist of several chunks (an inline code span plus text, both under one `H3`), a table row's cells sit on one line with a gap item in the second chunk, a cell can wrap over lines, and a row that continues on the next page arrives as a table fragment without header. A cell is therefore assembled from all lines of its `TD` (joined with a space), a row from all its cells; empty cells have no content in the stream and are taken from the tree (`TR` children), so columns do not shift.
- **No header row is invented.** The separator row follows only a first row of `TH` cells; a table continued from the previous page stays pipe rows. Column and row spans are not exposed by pdf.js, rows are padded to the widest row.
- **`H` and unknown roles are ignored; `Title` is `#`.** pdf.js already maps custom roles through the PDF's role map.
- **Outline:** entries are resolved to page indexes (`getDestination` + `getPageIndex`; iterative, 2,000 entries at most) and matched by normalised text (letters and digits only) against the lines of their page, in order; a chapter label in the text (`1.2 Definitionen`) may stand in front of the title, a title may wrap over three lines. An outline is used only if at least half of its entries are found. A line without letters never joins a title (found by measurement: a closing `}` was merged into "} Property Details").
- **Font heuristic:** no bold detection — pdf.js reports only the generic family (`monospace`/`sans-serif`/`serif`), real font names would need `commonObjs` and the operator list. Body size is the most frequent size of non-monospace lines; if that guess makes a fifth of the document "headings" (unmarked code outweighing the text), the next size with at least 15 % is tried. Limits: ≤ 120 characters, no trailing `. ; ,`, at least two letters, not repeated on half of the pages, at most four tiers, candidates at most a fifth of the characters, numbered lines (`2.1 …`) from 1.05×, others from 1.15×.
- **Safety:** the structure code never throws into the upload (tree, outline and heuristic errors keep the lines of release 1), walks the tree iteratively with a 200,000 node cap per page, and bounds the outline matching (2 million line comparisons).
- **Measured, not asserted.** Synthetic corpus: the repository's own `docs/*.md` (apps, models, file-upload-feature, architecture; 12–43 pages) through pandoc → docx → LibreOffice as tagged PDF, PDF with bookmarks, plain PDF, and via HTML. Ground truth: the `#` headings of the Markdown source. Precision = output headings that are source headings (lines that already started with `#` in release 1 text, e.g. code comments, excluded); recall = source headings found; level = share of correct levels among the found.

  | Source | Precision | Recall | Levels |
  |---|---:|---:|---|
  | Tags (4 docs) | 1.00 | 1.00 | exact |
  | Outline (4 docs) | 0.99–1.00 | 0.99–1.00 | relative to the outline depth |
  | Font size, HTML export (headings 14–24 pt, body 12) | 1.00 | 0.53–0.94 | relative |
  | Font size, pandoc styles (headings at body size) | 1.00 | 0.05–0.35 | relative |

  The last row is the honest limit: headings that differ from the body only by weight are not found, and nothing wrong is produced. This corpus is synthetic and generated from one source style; the real corpus (G-08…G-10: Word export, LaTeX, InDesign, multi-column, scan with text layer) is still to be run by a human.
- **No text is lost or reordered:** for the 12 untagged variants the text is identical to release 1 modulo `#` and wrapped heading lines; for the 4 tagged ones the multiset of letters and digits is identical (cell text is regrouped by cell).
- **Cost:** 43-page tagged PDF 0.67 s (release 1: 0.45 s), plain 0.41 s (0.32 s). Text size grows 2–6 % for tagged PDFs (tables, headings), < 1 % otherwise.
- **`realTextLength` ignores the Markdown the structure adds** (heading `#`, table pipes and separator rows), so a scan with a few tagged characters still falls back to page images.
- **Not done:** lists (`L`/`LI` — their labels are real text in a PDF, so they already read as lists), links, figure alt text, reading order from the tree for multi-column pages (the tree order would also drop artifacts; separate decision), `colspan`/`rowspan`.

### Decisions and findings from WP-B

- **D3 gate decided: keep mammoth, add a side pass.** Tracked changes and comments are written into `document.xml` as ordinary text runs before mammoth reads it — the same mechanism as the numbering labels — in `ooxml/review.js`, called from step 0b of `normalizeDocumentXml`. Replacing mammoth would only have moved the work; nothing in this step needs it.
- **What mammoth does with review marks (read in `lib/docx/body-reader.js`, not assumed):** `w:ins` is read as normal content; `w:del` is ignored; a paragraph whose mark is deleted (`w:pPr/w:rPr/w:del`) has its content *merged into the next paragraph*; a row with `w:trPr/w:del` is dropped; `w:commentReference` produces a comment object that the default style map does not render. So the markup mode removes the paragraph and row marks, turns `w:delText` into `w:t`, and unwraps `w:del` / `w:ins` / `w:moveFrom` / `w:moveTo` between marker runs.
- **Both options are per app, opt-in, and additive:** `upload.fileUpload.trackedChanges` (`accepted` | `markup`) and `comments` (`ignore` | `inline`), validated with `prefault` defaults, **no migration** (nothing is written into existing app files; the admin editor drops the key when the default is chosen). This is not a schema break, so the stop-and-ask condition for WP-B did not apply.
- **Vocabulary (D4):** CriticMarkup `{++…++}`, `{--…--}`, comments `{>>Author: text<<}` placed at the comment reference (right after the end of the commented range). No author or date on changes — noise on every change; the comment author is the one name that helps. A comment is one line (whitespace collapsed), `<<}` inside it is defused, and it is cut after 2,000 characters. Replies are separate comments and follow in order.
- **Numbering in markup mode:** paragraphs deleted by a tracked change take no number (as in the accepted view), so the numbers of the other paragraphs stay the ones of the accepted document; a deleted numbered paragraph is shown as plain `{--text--}`, not as a list item (its list properties are neutralised, otherwise mammoth would number it `1.`).
- **Blank changes leave no marks:** a deleted or inserted run that is only whitespace gets no markers, and a deleted space is gone, not shown as a space.
- **Checked against a real writer:** a DOCX written by pandoc (`.insertion` / `.deletion` / `.comment-start` spans) extracts as `Die Laufzeit beträgt {--zwölf--}{++vierundzwanzig++} Monate.`, `{--…--}` for a deleted paragraph, `| Miete | {--3 Monate--}{++6 Monate++} |` in a table and `{>>Clara: …<<}` after the anchored text. Not checked against files saved by Word itself — part of the golden corpus (G-01…G-07).
- **A malformed comments part** cannot be tested through the whole pipeline: mammoth reads the part itself and fails first, and the legacy path fails identically. The read of the comments part is guarded anyway.
- **Not done:** author/date of changes, formatting changes (`w:rPrChange`), comments inside footnotes/headers/footers, resolved state of comment threads, CriticMarkup highlight (`{==text==}`) for the commented range, hidden text (also A3 opt-in material, but not part of WP-B), the server-side (inference API) path — WP-E reuses `extractDocxMarkdown` with the same two options.
- **Where the options come from:** `createUploadConfig` (chat, start forms, workflows, cloud picker, Nextcloud embed, Outlook add-in) and `app.upload.fileUpload` (document opened from a source). The Outlook add-in passes the selected app's block to `buildFileDataFromMailAttachments`, including the token estimate of the panel.

### Decisions and findings from WP-E

- **One extraction, two surfaces.** `documentFromInlineFile` now calls the same `extractDocxMarkdown` and `extractPdfText` as the browser, so a file reads the same through the API as in the chat (PM-13 closed). The server adapter only supplies the Node libraries (`jszip`, `mammoth` behind a shim for its `{ buffer }` interface, `turndown`, jsdom's `DOMParser`/`XMLSerializer`, pdf.js' legacy build) and loads them on first use, so the server boots without them. `server/package.json` gets `mammoth` and `jszip` at the versions the client uses (1.12.3 / 3.10.2: the numbering and review-mark behaviour was verified against that mammoth).
- **API contract: additive, nothing removed.** New: `.docx` is accepted (it was `unsupported_file_type`); the text of a PDF has `[Page N]` markers, lines, and headings/tables where the PDF marks them. Unchanged: request shapes, response shapes, the error codes (`invalid_file`, `file_has_no_text`, `unsupported_file_type`), the limits (500 pages, 500,000 characters). Only the wording of the `unsupported_file_type` message changed (it names Word files). The stop-and-ask condition for WP-E ("API contract changes") therefore did not apply; what the model reads for a PDF does change, by design (A1/A2).
- **The admin switch applies to the API as well.** Off: PDF text as before (words of a page joined by spaces, no markers), and Word files are not accepted — the previous behaviour, not a half-way state. The switch is read per request from the feature configuration.
- **A Word file from an API caller is not a file from the user's own browser.** A docx is a zip: a few kilobytes can unpack to gigabytes, and the shared extraction unpacks and re-packs the whole package. `assertSafePackage` therefore reads the zip directory first (no zip64, no encryption, only stored/deflate; at most 5,000 parts, 30 MB per part, 100 MB in total) and inflates every part once with `maxOutputLength` equal to the declared size, asynchronously (zlib's thread pool, the event loop is not blocked), result discarded. A header that understates the size, a damaged or truncated package and a package with many parts are refused with `invalid_file` before JSZip or mammoth see them. The output limit's memory benefit cannot be asserted by a unit test (the mismatch check rejects the same files); it is there for the allocation, and the tests cover every refusal.
- **No fallback to plain text on the server.** The browser falls back to the old text when the structured step throws, because that text worked before. A Word file never worked through the API, so an unreadable one is an `invalid_file` with the reason, not a silently degraded text.
- **Review marks are not exposed.** API callers have no app, hence no `upload.fileUpload` settings: tracked changes are applied and comments left out (the defaults). Offering them per request would be a new request parameter — a contract change to be decided separately.
- **Not done: the OCR tool.** `analyzePdfPages` in `ocrProcessor.js` joins text items the old way too, but its per-page text feeds a threshold decision (`MIN_TEXT_CHARS`) and a job that mixes VLM output, it is not exported, and a test would need the whole job pipeline. Changing the text there shifts which pages go to the VLM; there is no user-visible reason for it in this step. Left as it is.
- **Cost:** a Word file goes through jsdom, mammoth and Turndown on the server's main thread (about 0.3 s for 100 pages in the browser measurement); the package scan adds one inflate per part. If API volume with large Word files makes this visible, move the extraction to a worker thread — the shared modules are pure and can run there unchanged.

### Decisions and findings from WP-D

- **Slide order is the presentation's, not the file names'.** `ppt/presentation.xml` lists the slides (`p:sldIdLst`); each entry's `r:id` is resolved through `ppt/_rels/presentation.xml.rels` to `slides/slideN.xml`, and the number in `[Slide N]` is the position in that list. The file names only record in which order the slides were *created* (confirmed with a fixture: a slide moved to the front keeps `slide3.xml`). A deck without a slide list, or whose presentation part cannot be read, is read the old way (file name order, numbered by the file name), which is also what the existing `pptx-file-extraction` tests encode and still pass. A listed slide whose part is missing keeps its position in the numbering.
- **Hidden slides are flagged, not dropped** (`[Slide 3 (hidden)]`, number unchanged). Decision A3 says "visible text only" for Word's hidden *text*, which is invisible even to the author; a hidden slide is visible in the editor and often a backup the model should know about. Dropping instead is a one-line change if you prefer the literal reading.
- **Speaker notes are opt-in, as A3 requires:** `upload.fileUpload.speakerNotes: 'include'` adds `[Notes]` after the slide (only the notes body placeholder; not the slide image or number). This is the third per-app option next to WP-B's two, with the same plumbing (`extractionOptionsOf` now returns all three, schema `prefault('ignore')`, a select in the admin editor, en/de strings; no migration, nothing written into existing app files).
- **Title first, structure from placeholders:** `title` / `ctrTitle` placeholders become `# …` and move to the top of the slide; everything else keeps the order of the shape tree. Text in group shapes is read; of an `mc:AlternateContent` only the `Choice` (PowerPoint stores the same shape again as `Fallback`). Slide-number and date placeholders and fields are dropped, footer text stays. A line break inside a paragraph (`a:br`) is a space — before, "line one<br>line two" ran together.
- **Tables:** DrawingML stores one cell per grid column, so a column span is the origin cell plus `hMerge` cells (empty) and a row span the origin plus `vMerge` cells (text repeated). The separator row follows only a table that is marked with a header row (`firstRow="1"`): no header is invented.
- **Spreadsheets:** SheetJS reads the workbook; `sheet_to_json({header: 1, raw: false})` gives the cell text as the sheet shows it. A sheet whose first row names the columns (≥ 2 columns, every cell filled with text that is not a number, percentage, date or time, a data row below; the covered cells of a title merged across the header columns do not count against it) becomes a Markdown table; other sheets stay tab-separated, as before. Vertical merges are filled down (every row stays complete), horizontal ones keep the text in the first column — the rule of the Word and PowerPoint tables.
- **Size limits protect the context window:** 2,000 rows per sheet (only those rows are read, so a million-row sheet costs about as much as a small one) and 300,000 characters per workbook; a sheet cut short ends with `[… N more rows omitted]`, a sheet that no longer fits with `[… N rows omitted]`. A spreadsheet's text can be far larger than its file; the file size limit does not help there. These caps are new behaviour for sheets above them, hence behind the admin switch like the rest.
- **Hidden sheets are flagged** (`[Sheet: name (hidden)]`, `Hidden` 1 and 2 alike).
- **API: PowerPoint yes, Excel no.** `.pptx` is accepted through the inference API (no new dependency: JSZip, the DOM and the shared module), under the same package checks as Word files. `.xlsx` is not: SheetJS would be a new server dependency (the npm release has known unfixed advisories), which the plan reserves for a decision; send CSV instead.
- **Refactor:** the relationship helpers moved from `docx.js` to `ooxml/package.js` for reuse; 106 DOCX tests unchanged and green.
- **Not done:** bullets/levels of slide text (`a:pPr lvl`, bullet characters) as Markdown lists, alt text of pictures, charts and SmartArt, comments of a deck, `.ppt` (rejected as before), cell formatting and formulas of a sheet (the last calculated value is sent, as before), hidden rows and columns.

### Decisions and findings from WP-C

- **One reader per file, three kinds of document.** The kind comes from `office:body` (`office:text`, `office:spreadsheet`, `office:presentation`), not from the file name or the `mimetype` entry (which some producers omit). `createOdfReader` holds what the three share — styles, list numbering, the footnote counter, the text of a paragraph — and hands out `documentMarkdown()`, `shapeLines(box)` (the lines of a slide's text box), `plainText(cell)` and `tableLines(table)`. A file that is none of the three is an error, so the browser falls back to the text of before.
- **Spreadsheets share the rendering with Excel.** The header detection, the table writer, the hidden-sheet flag and the limits moved from `xlsx.js` into `sheets.js` (`renderSheets`); `xlsx.js` and `odf/sheet.js` bring the cells as text. 14 XLSX tests are unchanged and green. An ODS stores the text of every cell next to its value (`text:p`), so a cell shows what the sheet showed when it was saved — the equivalent of `raw: false`; a cell without display text shows its value. Empty rows and columns are stored as repeat counts (`table:number-columns-repeated="16381"` after every row, a million empty rows at the end): nothing is expanded that has no content, leading empty rows and columns are dropped, the row limit counts from the first row with content (as the used range of an Excel sheet does), and the rows beyond the limits are only counted. A cell that is saved more than 1,000 columns wide is cut with a notice (a limit Excel's reader does not have: the repeat counts are cheap to write and expensive to expand).
- **Presentations like PowerPoint.** `draw:page` order is the slide order (there is no separate slide list that could disagree with the file). The `title` placeholder becomes `# …`, other text frames, shapes with text of their own, groups and links are read in file order; slide number and date placeholders are dropped. A slide is hidden when its page style says `presentation:visibility="hidden"` (the style chain is followed; flagged `(hidden)`, not dropped, as for PowerPoint). Notes are opt-in with the same setting as PowerPoint (`speakerNotes`) — frames of the notes page without a placeholder class count, because LibreOffice writes notes typed by a user in a frame with and without `presentation:class="notes"` (seen in a file converted by it); header, footer, date and number placeholders do not. A table is a header table when it says `table:use-first-row-styles="true"` (what Impress writes for "Header row"); otherwise rows only, no header invented.
- **List numbers are computed, and checked against LibreOffice.** Writer stores no labels. `odf/lists.js` counts like Writer: a list restarts, unless it continues another one (`text:continue-list`, an id) or the list right before it (`text:continue-numbering`, only if that list has the same list style — measured: with another style in between, Writer restarts at 1), `text:start-value`, levels shown with their parents (`display-levels`), chapter numbering through `text:outline-style`, numbered headings inside lists. **Every item counts, also the items of a bullet level**: a list that continues a bullet list (or changes style) goes on from the count. Method: random documents (2–5 list styles with random formats, prefixes, suffixes, display levels and start values; up to four levels of nesting; headings in lists; random continuation) converted with `soffice --convert-to txt`, compared label by label with our output. About 24,000 paragraphs in 780 documents over five combinations (default mix, `continue-list` heavy, `continue-numbering` heavy, style overrides, and a mix of everything with headers and start values at high rates): **0 wrong labels**. Before the fixes, the same fuzz found 19–33 wrong labels per 60 documents for continuation and overrides. An override together with a start value could not be compared (LibreOffice failed to convert some of those documents), which is one reason it is declined.
- **Declining is the safe answer.** Where Writer's counting could not be reproduced the item gets no number: a list with a `text:list-header`, a style override (`text:style-override`) on a nested level or with a display of several levels, an override together with a start value (and everything after it in that list), a label that spans levels of different list styles, a gap level without a number (Writer fills it in its own way: `.1.a`), a letter format past `z` with `num-letter-sync="false"`. In the random corpus 7–10 % of the paragraphs are declined when only continuation and start values are mixed in; in the adversarial mix (all constructs at high rates) about half. **Wrong is worse than missing**, as for Word.
- **Tracked changes** need no pass: ODF keeps deleted text inside `text:tracked-changes`, which is not walked, so the text is the accepted view. The opt-in review marks of WP-B are Word-only; for ODT they are not offered (an extension would be a separate step).
- **Numbers on real files.** A spreadsheet written by LibreOffice (xlsx → ods: header tables, a vertical and a horizontal merge, a hidden sheet, a formula cell, a date), and a presentation written by it (flat ODP → odp: title, nested bullets, hidden slide, notes, table) extract as expected; the repeat counts, `covered-table-cell` and the hidden flags in the page and table styles are the structures LibreOffice writes. Not checked against files saved by OpenOffice, Collabora, OnlyOffice or Microsoft Office's ODF export — part of the golden corpus.
- **API: all three accepted, no new dependency.** `.odt`, `.ods` and `.odp` go through `extractOdfDocument` (JSZip, the DOM, the shared module) under the same package checks as Word files (`assertSafePackage`, whose message now says "Office document"). Unlike Excel, spreadsheets need no SheetJS here. Speaker notes are not sent through the API (no app, no setting). `documentFromInlineFile` now looks the Office types up in one table (`OFFICE_DOCUMENTS`: type, name in messages, reader) instead of one branch per type.
- **Cost:** parsing dominates. jsdom needs about 14 s for an 81 MB `content.xml` (300,000 rows, mostly repeat counts); the package limits (30 MB per part) bound this on the server, and the browser's own parser is far faster. The reader itself reads only the rows it needs (60,000 rows: 3.3 s with jsdom, of which parsing is almost all). If API volume with large spreadsheets makes this visible, move the extraction to a worker thread, as noted for Word.
- **A regex that backtracks is a denial of service on the API path.** SonarCloud flagged `/[ \t]*\n[ \t]*/` in the paragraph writer (S8786): on a run of spaces it needs time quadratic in the run (80,000 spaces: 5.4 s), and one `text:s text:c="100"` writes a hundred of them, so a file from an API caller could hold the server's event loop for minutes. The runs of spaces are collapsed first now, then the one space next to a break is removed (same output, linear; test with 100,000 spaces). Every regex literal in the extraction code (80 of them: `shared/documentExtraction`, the server adapter, the browser upload utilities) was timed against 60,000-character runs of spaces, tabs, digits, letters, dots, newlines, braces and pipes: none takes more than 150 ms.
- **Not done:** review marks for ODT (tracked changes as markup, comments), annotations (`office:annotation`) of text and cells, `text:list-header` numbering, sub-levels with overrides, cell formatting, hidden rows and columns, charts, presentation notes in the API, `.fodt` / flat ODF, OpenDocument formulas (the saved value is sent), images in presentations.
