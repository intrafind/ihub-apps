# 03 — Edge Cases and Expected Behavior

"Expected" is the behavior release 1 must implement. Where a choice was made without the user, it is marked **(default)** and listed in the README as overridable. Test IDs refer to `04-test-plan.md`.

## 1. DOCX — numbering

Word's rule of thumb that the implementation must follow: a paragraph is numbered when it has an effective `w:numPr` (from the paragraph, otherwise from its style chain), the resolved `numId` exists and is not `0`, and the level has a `numFmt` other than `none`.

| Case | Expected | Test |
|---|---|---|
| Numbering defined on the **style** (`Heading 1` → `numPr`) — the common case | Label from the style's `numId`/`ilvl` | T-DOCX-03 |
| Style chain via `basedOn` (Heading 2 based on Heading 1) | Inherit `numPr`, `outlineLvl`; detect cycles (stop after a visited id) | T-DOCX-05 |
| Paragraph `numPr` with only `ilvl`, `numId` from style (or vice versa) | Merge paragraph and style values | T-DOCX-03 |
| `numId="0"` on paragraph | No label, even if the style is numbered | T-DOCX-04 |
| `numId` not present in `numbering.xml` | No label, no error | T-DOCX-15 |
| Two `w:num` sharing one `abstractNum`, no override | Counter **continues** (`a) b) c)`): counters are keyed by `abstractNumId`, not `numId`. Verified with LibreOffice as oracle; the first spike keyed by `numId` and got it wrong | T-DOCX-08 |
| `w:lvlOverride/w:startOverride` | Restart at the override value when that `num` is first used | T-DOCX-07 |
| Higher level increments → lower levels reset (`1.1, 1.2, 2., 2.1`) | Reset deeper counters | T-DOCX-10 |
| Level skipped (ilvl 0 → ilvl 2) | Missing level counts as its `start` value (`1.1.1`, verified with LibreOffice) | T-DOCX-11 |
| `w:lvlRestart` (restart after a specific higher level) | Honor; if not implemented, omit labels for that abstractNum rather than guess | T-DOCX-12 |
| `w:isLgl` (legal numbering, all levels arabic) | Honor if cheap, else omit labels for that level | T-DOCX-12 |
| `numFmt`: `decimal`, `decimalZero`, `lowerLetter`, `upperLetter`, `lowerRoman`, `upperRoman`, `ordinal`, `bullet`, `none` | Format; `bullet` → `-`; `none` → no label | T-DOCX-09 |
| Exotic `numFmt` (`chineseCounting`, `decimalEnclosedCircle`, `cardinalText`, …) | Fall back to decimal **(default)**; never throw | T-DOCX-09 |
| `lvlText` with prefix/suffix (`§ %1`, `Teil %1`, `(%1)`, `%1.%2.%3`, `Artikel %1:`) | Placeholders replaced; literal text kept | T-DOCX-09 |
| `abstractNum` with `w:numStyleLink` / `w:styleLink` (list styles) | Follow the link to the numbering style's `numPr` → real abstractNum | T-DOCX-13 |
| Picture bullets (`w:lvlPicBulletId`) | Treat as bullet `-` | T-DOCX-09 |
| `w:suff` (`tab`/`space`/`nothing`) | Always one space after the label **(default)** | — |
| Numbered paragraph inside a table cell, text box or footnote | Counted in document order (Word does) — tables yes; text boxes/footnotes: count as encountered **(default)** | T-DOCX-16 |
| Numbered paragraph that is tracked as deleted | Not counted, not output | T-DOCX-21 |
| Numbered paragraph that is hidden (`w:vanish` on the paragraph mark) | Not output and **not counted (default)**; confirm Word's print-view numbering with golden G-03 | T-DOCX-20 |
| Number typed manually as text ("1.1 Definitionen") without `numPr` | Unchanged (already text); no double label | T-DOCX-03 |
| Label and manual text both present ("1. 1. Geltung") | Accept (mirrors the document) | — |

## 2. DOCX — headings and styles

| Case | Expected | Test |
|---|---|---|
| Built-in `heading 1–6` (any UI language, any case) | `#`–`######` (mammoth already does this) | T-DOCX-02 |
| Heading 7–9 | `######` capped **(default)** | T-DOCX-02 |
| Custom style with `w:outlineLvl` (directly or via `basedOn`) | Heading of level `outlineLvl + 1` (cap 6) via generated style map | T-DOCX-05 |
| Paragraph with direct `w:outlineLvl` and no heading style | Heading of that level | T-DOCX-06 |
| `outlineLvl val="9"` (body text) | Not a heading | T-DOCX-06 |
| `Title` / `Subtitle` styles | Unchanged (mammoth: plain paragraph) **(default)** — revisit if golden corpus shows need | — |
| Table of contents (TOC field with hyperlinks to `#_Toc…`) | Link syntax removed, text kept (TOC lines remain, incl. their cached page numbers) | T-DOCX-18 |
| Empty heading paragraph | Dropped (Turndown) | — |

## 3. DOCX — content

| Case | Expected | Test |
|---|---|---|
| Paragraph boundaries | Blank line between paragraphs (fixes glued text) | T-DOCX-01 |
| Explicit page break (`w:br w:type="page"`), `w:pageBreakBefore`, section break `nextPage` | `[Page break]` on its own line, unnumbered; words never glued. `pageBreakBefore`/section breaks: marker **(default)** | T-DOCX-22 |
| `w:lastRenderedPageBreak` | Ignored (decision A4) | T-DOCX-22 |
| Line break (`w:br` without type), `w:cr` | Line break. mammoth ignores `w:cr` (verified: `endafter cr`) → pre-pass rewrites `w:cr` to `w:br` | T-DOCX-22 |
| Tab | Space or tab, never glue | T-DOCX-22 |
| Soft hyphen U+00AD | Removed **(default)** — invisible in Word, breaks text matching | T-DOCX-24 |
| Non-breaking space U+00A0, non-breaking hyphen | NBSP kept as-is **(default)**; `w:noBreakHyphen` → `-` (mammoth) | T-DOCX-24 |
| Hidden text `w:vanish` (runs and whole paragraphs) | Removed (decision A3) | T-DOCX-20 |
| Tracked insertion / deletion | Inserted text kept; deleted text and deleted paragraphs removed (accepted view, A3) | T-DOCX-21 |
| Moved text (`w:moveFrom`/`w:moveTo`) | mammoth drops **both** (verified: moved text vanishes completely). Pre-pass unwraps `w:moveTo` (keep runs) and removes `w:moveFrom` → text appears once, at its new position | T-DOCX-21 |
| Comments | Not output (A3) | T-DOCX-21 |
| Footnotes / endnotes | Reference `[^1]` in text, definitions `[^1]: …` at the end **(default)** | T-DOCX-19 |
| Images, charts, SmartArt | `[Image: alt]` if alt text exists, else nothing; never base64 | T-DOCX-17 |
| Equations (OMML) | Dropped by mammoth — note in docs as known limitation | — |
| Text boxes / shapes | Appear after the paragraph that anchors them (mammoth) | T-DOCX-29 |
| Content controls (`w:sdt`), fields (REF, DATE, cross-references) | Cached result text kept (mammoth) | T-DOCX-29 |
| External hyperlink | `[text](url)` | T-DOCX-18 |
| Text that looks like Markdown (`# x`, `| a |`, `---`, `*`) | Output literally, no escaping (deliberate, see PM-23) | T-DOCX-30 |
| Very long document (300+ pages) | Completes; time ≤ 2× legacy | T-PERF-01 |
| Strict OOXML (`http://purl.oclc.org/ooxml/wordprocessingml/main`) | Pre-pass handles both namespaces or skips cleanly → legacy-equivalent text | T-DOCX-28 |
| Missing `styles.xml` / `numbering.xml`; Google Docs, LibreOffice, python-docx exports | No crash; best-effort structure | T-DOCX-14, golden G-04 |
| Password-protected / encrypted DOCX | Same error as today | — |
| `.docm` / `.dotx` renamed to `.docx` | Same as `.docx` | — |

## 4. DOCX — tables

| Case | Expected | Test |
|---|---|---|
| Simple table | GFM table; first row is the header row **(default)** | T-DOCX-16 |
| `gridSpan` (colspan) | Text in the first spanned column, the others empty **(default)** | T-DOCX-16 |
| `vMerge` (rowspan) | Text repeated in each spanned row **(default)** so every row is self-contained; columns never shift | T-DOCX-16 |
| Pipe `|` in a cell | Escaped `\|` (only escape we do) | T-DOCX-16 |
| Multiple paragraphs / list in a cell | Joined with `<br>` **(default)** | T-DOCX-16 |
| Nested table | Inner table flattened into the cell text | T-DOCX-16 |
| Table used for layout (single cell, whole page) | Treated as a table (no heuristic) **(default)** | — |
| Deleted table row (tracked) | Dropped (mammoth) | T-DOCX-21 |

## 5. DOCX — headers and footers (PR 4)

| Case | Expected | Test |
|---|---|---|
| Default / first-page / even-page header and footer | Distinct texts once each, as `[Header] …` / `[Footer] …` before the body | T-DOCX-25 |
| Same header in several sections | Once (de-duplicated) | T-DOCX-25 |
| Only a `PAGE`/`NUMPAGES` field ("Seite 3 von 10") | Field codes dropped; if nothing else remains, no block | T-DOCX-25 |
| Header with a table / logo | Table text kept; image dropped | T-DOCX-25 |

## 6. PDF

| Case | Expected | Test |
|---|---|---|
| Normal text PDF | `[Page N]` before each page, lines from `hasEOL`, no double spaces | T-PDF-01, T-PDF-02 |
| Printed labels differ (`i`, `ii`, `1`…) | `[Page 3 (printed: 1)]`; same label → plain `[Page N]` | T-PDF-01 |
| Page without text layer inside a text PDF | `[Page 2: no extractable text]` **(default wording)** | T-PDF-03 |
| Every page without text (scan) | `content === ''` → page images rendered as today | T-PDF-04 |
| Less than 50 characters of real text overall | Image fallback as today (threshold excludes markers) | T-PDF-06 |
| Hyphen at line end | Kept, line break kept (no dehyphenation) | T-PDF-07 |
| Multi-column layout | pdf.js order (content stream); documented limitation | — |
| Rotated pages, RTL text | pdf.js output as is | — |
| Running header/footer on each page | Kept | — |
| Encrypted / broken PDF | Same error as today | T-PDF-10 |
| 500+ pages | Completes; no per-page quadratic string building | T-PERF-02 |

## 7. Switch and entry points

| Case | Expected | Test |
|---|---|---|
| Feature switch off | Byte-identical legacy output for DOCX and PDF | T-DOCX-26, T-PDF-09 |
| Platform config cannot be loaded (offline, extension before login) | Registry default (on); never throw | T-FLAG-03 |
| Office add-in attachment, cloud picker file, iFinder document, workflow start form | Same output as a direct upload of the same file | T-DOWN-04, manual QA |
| Generic `text/*` upload of a `.docx` | Unchanged: rejected as binary (no extractor without explicit format) | existing `generic-text-upload.test.jsx` |
