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
