# 02 — Pre-Mortem: "We shipped it, and it didn't work"

Assume release 1 is out and the feedback is bad. Each scenario below names what users saw, why it happened, how likely it is given what we verified, and what prevents it. Every prevention that code can check has a test ID from `2026-10-08 Test Plan.md`; the scope, documentation and release actions in section B are verified in review instead.

Likelihood/impact: **H**igh / **M**edium / **L**ow.

## A. Scenarios that would make the release worse than today

| ID | What users saw | Root cause | L / I | Prevention | Test |
|---|---|---|---|---|---|
| PM-01 | Scanned PDFs are "empty" — the model says it cannot see any content; before, it read the page images | `[Page N]` markers make the text non-empty, so `content.trim().length < 50` no longer triggers `renderPdfPagesToImages`; `RequestBuilder` / `PromptNodeExecutor` only attach images when `content` is empty | **H / H** | Measure text **without** markers (`hasRealText()` helper); return `content: ''` when no page has text | T-PDF-04, T-PDF-06, T-DOWN-02 |
| PM-02 | Uploads of some Word files fail with an error ("could not process file") that worked last week | New numbering/style code throws on unusual DOCX (no `numbering.xml`, Strict OOXML namespace, `mc:AlternateContent`, broken `numId`, cyclic `basedOn`) | **M / H** | Every enrichment step inside one `try`; on failure log `console.warn` and return the **legacy** extraction. Enrichment never makes an upload fail | T-DOCX-14, T-DOCX-15, T-DOCX-27, T-DOCX-28 |
| PM-03 | Answers suddenly contain `1\.`, `\[1\]`, `a\_b`; the Translator returns text full of backslashes; comparison flags every numbered paragraph as changed | Turndown's default escaping | **H** (default behavior) / **H** | `escape = s => s` in the document converter | T-DOCX-23 |
| PM-04 | A request with one Word file with screenshots takes minutes, costs a fortune, or fails with "context length exceeded" | Turndown turns mammoth's `<img src="data:…">` into `![](data:image/png;base64,…)` | **H** (default behavior) / **H** | Image rule: drop or `[Image: alt]`; test asserts no `data:` and output size bound | T-DOCX-17 |
| PM-05 | Chapter numbers are **wrong** (e.g. `2.` where Word shows `3.`), lawyers quote the wrong section | Counter semantics differ from Word: continuation across `w:num` instances of the same `abstractNum`, `startOverride`, skipped levels, `lvlRestart`, deleted (tracked) paragraphs counted | **M / H** — wrong numbers are worse than none | Golden tests against Word-rendered PDFs; when a feature is not supported (e.g. `isLgl`, picture bullets, unknown `numFmt`) **omit the label** instead of guessing; count only paragraphs that remain visible | T-DOCX-03…13, T-DOCX-21, golden corpus G-01…G-05 |
| PM-06 | Tables are garbled: values appear under the wrong column | mammoth removes vMerge continuation cells; a row-by-row Markdown table shifts the rest of the row left | **M / H** | Build a column grid honoring `rowspan`/`colspan` before writing the Markdown table | T-DOCX-16 |
| PM-07 | Words glued together across page breaks ("Before page breakafter break") remain | mammoth drops `w:br type=page` without whitespace (today's bug, not fixed by Markdown alone) | **H / M** | Pre-pass replaces page breaks with a line break + `[Page break]` marker run | T-DOCX-22 |
| PM-08 | Admin turned the switch off, but users still get the new format (or vice versa) for up to 30 minutes / until reload | `fetchPlatformConfig()` caches for 30 min; Office add-in and extension hold their own page state | **H / L** | Document the delay in the feature description and release note; no cache busting needed | T-FLAG-02 (docs check) |
| PM-09 | Switch off → output is *not* identical to the old version (subtle diffs break someone's prompt) | Shared code path partially applied (e.g. soft-hyphen stripping, hidden-text removal still on) | **M / M** | Flag off = call the untouched legacy functions; snapshot tests assert byte-identical legacy output | T-DOCX-26, T-PDF-09 |
| PM-10 | Model mis-cites pages ("see page 5") while the printed page says 3 | Physical index vs. printed labels (roman front matter, cover page) | **M / M** | Marker includes the printed label when it differs: `[Page 5 (printed: 3)]` | T-PDF-01 |
| PM-24 | A sentence the author moved (track changes on) is missing from the answer; a comparison reports it as deleted | mammoth drops `w:moveFrom` and `w:moveTo` with their content (verified; today's bug too) | **M / H** | Pre-pass unwraps `w:moveTo`, removes `w:moveFrom` | T-DOCX-21 |
| PM-11 | Content the author hid appears in answers, or reviewers' deleted text shows up; data-protection complaint | Hidden text (`w:vanish`) is extracted today; future options turned on by accident | **M / H** | Release 1 removes hidden text; deletions stay dropped; comments stay ignored (decision A3) | T-DOCX-20, T-DOCX-21 |

## B. Scenarios where it "works" but nobody benefits

| ID | What happened | Root cause | Prevention |
|---|---|---|---|
| PM-12 | Corporate documents still have no headings | Customer templates use custom styles (`IF Kapitel`, `Gliederung 1`) or `outlineLvl`; mammoth only maps `heading N` | Generate style mappings from `styles.xml` outline levels (incl. `basedOn` inheritance) and handle direct paragraph `outlineLvl` — T-DOCX-05, T-DOCX-06, golden G-02 |
| PM-13 | The external comparison bot of a partner sees no change | It calls the OpenAI-compatible API, which has its own extractor (`inputContent.js`) and rejects DOCX | Decision A1: UI first. State this explicitly in the release note and docs ("API: release 2") so nobody expects it |
| PM-14 | The comparison app still compares flat text | Its prompt never tells the model to align by section numbers/pages | Docs section "Writing prompts that use document structure" with an example comparison prompt (PR 5) |
| PM-15 | DOCX in `parliamentary-questions` still unsupported | App's `supportedFormats` lists only text/Markdown/PDF | Out of scope for the code change; mention in release note as "now possible to enable" — owner decides (open question Q-07) |
| PM-16 | Nobody notices the improvement | No release note / docs | Release note via `/document-feature`, docs updated in the same PR series |

## C. Operational and quality risks

| ID | Risk | Prevention |
|---|---|---|
| PM-17 | UI freezes for several seconds on a 300-page DOCX (XML parsed twice: pre-pass + mammoth) | Measure with a large fixture (T-PERF-01); budget ≤ 2× legacy time; if exceeded, move extraction into a Web Worker (follow-up) |
| PM-18 | Token usage grows and admins complain | Unmeasured so far — measure legacy vs. new character count on the golden corpus and put the number in the release note; the context-window warning already counts the content string (`shared/contextUsage.js`) |
| PM-19 | Tests are green, production differs | jest uses the mammoth **browser** build only through a mapping; Vite resolves it via the `browser` field — keep one real browser check (manual QA M-01) and the `vite build` step in the DoD |
| PM-20 | Two converters drift (web pages vs. documents) | Release 1 copies the needed rules from `pageContent.js` (with a pointer comment) and leaves the web reader untouched; release 2 consolidates into one factory with `server/tests/websearch-page-content.test.js` unchanged |
| PM-21 | `shared/` import of `turndown` breaks the Vite or Node build | `shared/` stays dependency-free; libraries are injected by the client adapter (see `2026-10-08 Current State.md` §4) |
| PM-22 | Zip bomb / huge `document.xml` exhausts browser memory | Unchanged risk (mammoth already unzips everything); the pre-pass must not create extra copies of the whole XML string per paragraph. Upload size limit (5 MB default) remains the guard |
| PM-23 | Literal document text that looks like Markdown (`# 1`, lines with pipe characters, `---`) is misread | Accepted: the model treats it as text; no escaping on purpose (PM-03 is worse). Covered by T-DOCX-30 so the behavior is deliberate |

## D. What would tell us early that it failed

- Golden corpus diff in the PR (before/after output for 12–15 real documents, `2026-10-08 Test Plan.md` §5) reviewed by a human before merge.
- `console.warn('[fileProcessing] structured extraction failed, using legacy', …)` visible in the browser console during manual QA — zero occurrences on the corpus is a merge criterion.
- After release: ask Christoph and the `stellungnahmen-review` owners for a before/after on one real document each.
