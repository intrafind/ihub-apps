# 05 — Implementation Plan (agent handoff, release 1)

Read first: `README.md` (decisions), `2026-10-08 Current State.md` (facts), `2026-10-08 Pre-Mortem.md`, `2026-10-08 Edge Cases.md`, `2026-10-08 Test Plan.md`. This document says **what to build, in which order, and when you are done**.

## 0. Mission

Make the text that the browser extracts from uploaded **DOCX** and **PDF** files keep its structure — headings with Word's chapter numbers, lists with their labels, tables, footnotes, PDF pages — so models can cite sections and pages. Ship it on by default behind an admin feature switch that restores today's output exactly.

### In scope (release 1)

- Browser extraction in `client/src/features/upload/utils/fileProcessing.js` — reaches chat upload, workflow start form, cloud picker, iFinder attach and the Outlook add-in automatically.
- DOCX: paragraphs, headings (built-in, custom styles with `outlineLvl`, direct `outlineLvl`), numbering labels, tables with merged cells, footnotes, links, page breaks (unnumbered), headers/footers, removal of hidden text, correct handling of tracked moves; no Markdown escaping; no images as base64.
- PDF: `[Page N]` markers with printed labels, real line breaks, flagged pages without text, correct scanned-PDF fallback.
- Feature switch `structuredDocumentExtraction` (default on).
- Docs and release note.

### Out of scope (release 2, see `2026-10-08 Follow-ups Release 2.md`)

Inference API (`server/services/inference/inputContent.js`), OCR tool, PDF heading detection, PPTX/XLSX/ODF, per-app options for comments / tracked changes / hidden text / speaker notes, DOCX page numbers (decision A4: never estimated).

## 1. Guardrails (non-negotiable)

1. **Never make an upload fail that works today.** All structured work runs inside one `try`; on any error `console.warn('[fileProcessing] structured extraction failed, using legacy', error)` and return the legacy result.
2. **Switch off = byte-identical legacy output.** Keep the current `processDocxFile`/`processPdfFile` bodies as `legacyDocxText`/`legacyPdfText` and call them unchanged.
3. **`shared/` stays dependency-free.** No bare imports in `shared/documentExtraction/**`; JSZip, mammoth, Turndown, `DOMParser`, `XMLSerializer` and pdf.js are passed in by the client adapter (see `2026-10-08 Current State.md` §4).
4. **No new npm dependencies.** Everything needed exists (`jszip`, `mammoth`, `turndown` in `client/`; `pdf-lib`, `pdfjs-dist` in `server/` for node tests). If you believe one is needed, stop and ask.
5. **Do not touch** `server/tools/lib/pageContent.js` (web page reader), `server/services/inference/**`, `ocrProcessor.js`, `shared/promptContext.js` tag names. Copy the Turndown rules you need from `pageContent.js` with a comment pointing to it; consolidation is a release 2 cleanup.
6. **Wrong is worse than missing.** When numbering semantics are unsupported or ambiguous, output no label for that paragraph.
7. Project rules from `CLAUDE.md`: `npm run lint:fix && npm run format:fix` before each commit; release note via the `/document-feature` skill into `docs/releases/next/`; update existing docs instead of creating new ones; no compatibility shims beyond the agreed feature switch.

### Stop and ask a human when

- legacy snapshot tests (T-DOCX-26 / T-PDF-09) cannot be made identical;
- the golden corpus shows a numbering difference you cannot explain from `2026-10-08 Edge Cases.md`;
- structured DOCX extraction is more than 2× slower than legacy on T-PERF-01;
- any existing test outside the files you changed starts failing.

## 2. Target design

### Module layout

```
shared/documentExtraction/
  markers.js            PAGE_BREAK_MARKER, pageMarker(n, label), NO_TEXT_PAGE(n),
                        HEADER/FOOTER prefixes, realTextLength(text), MIN_REAL_TEXT_CHARS = 50
  ooxml/xml.js          namespace helpers (transitional + Strict OOXML), child/val accessors
  ooxml/styles.js       readStyles(stylesDoc) → { get(styleId, prop) } resolving basedOn (cycle-safe):
                        numId, ilvl, outlineLvl, pageBreakBefore, vanish, name
  ooxml/numbering.js    createNumbering(numberingDoc, styles) → { labelFor(numId, ilvl) → string|null }
                        counters keyed by abstractNumId; startOverride on first use of a w:num;
                        numStyleLink/styleLink; formatters; null when unsupported
  ooxml/normalize.js    normalizeDocumentXml(doc, { styles, numbering }) — mutates the DOM, see pipeline
                        → { syntheticStyles: string[] } (XML of synthetic heading styles to add)
  ooxml/headerFooter.js PR 4: readHeaderFooterText(zip parts, rels, parseXml) → { header[], footer[] }
  markdown.js           createDocumentMarkdownConverter(TurndownService) + normalizeMarkdown()
  pdfText.js            assemblePdfText(pages, { pageLabels }) → { text, realTextLength }
  docx.js               extractDocxMarkdown({ arrayBuffer, JSZip, mammoth, TurndownService,
                        DOMParser, XMLSerializer }) → string   (orchestrates the pipeline)
```

Client adapter (only file that imports libraries): `client/src/features/upload/utils/fileProcessing.js`.

### DOCX pipeline (`extractDocxMarkdown`)

1. `JSZip.loadAsync(arrayBuffer)`; parse `word/document.xml`, `word/styles.xml`, `word/numbering.xml` with `new DOMParser().parseFromString(xml, 'application/xml')`. Missing parts → `null` (tolerated). A `parsererror` document → throw (falls back to legacy).
2. Build `styles` and `numbering` models.
3. `normalizeDocumentXml` walks `w:p` in document order (`Array.from(getElementsByTagNameNS(W, 'p'))` — includes table cells, text boxes, content controls) and:
   - removes runs with effective `w:vanish`; removes a paragraph whose paragraph mark and all runs are hidden (not counted for numbering);
   - unwraps `w:moveTo` (keep children), removes `w:moveFrom`;
   - skips numbering for paragraphs tracked as deleted (`w:pPr/w:rPr/w:del`) — mammoth drops them;
   - replaces `w:cr` with `w:br`; replaces `w:br[@w:type="page"]` with `w:br` + run `[Page break]` + `w:br`; inserts a `[Page break]` paragraph before paragraphs with effective `w:pageBreakBefore` and after paragraphs carrying a `w:sectPr` of type `nextPage`/`oddPage`/`evenPage` (default type is `nextPage`); ignores `w:lastRenderedPageBreak`;
   - removes `w:softHyphen` elements and U+00AD in `w:t`;
   - computes the numbering label (`numbering.labelFor`), inserts it as a leading run `"<label> "`, then neutralizes numbering (remove paragraph `numPr`, or add `numPr/numId=0` when it came from the style) so mammoth renders a plain paragraph/heading;
   - for paragraphs with effective `outlineLvl` 0–5 whose style name is not `heading N`: set `w:pStyle` to a synthetic style `IHubOutline{N}` and return its definition `<w:style w:type="paragraph" w:styleId="IHubOutline1"><w:name w:val="heading 1"/></w:style>` so mammoth's default style map makes it `<hN>` (one mechanism for custom styles and direct `outlineLvl`; avoids style-map syntax issues with unusual style IDs). The spike used `styleMap: ['p.IFKapitel => h1:fresh']`, which also works for simple IDs.
4. Append synthetic styles to `styles.xml`, serialize changed parts with `XMLSerializer`, `zip.generateAsync({ type: 'arraybuffer' })`.
5. `mammoth.convertToHtml({ arrayBuffer }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) })` — avoids base64 work; alt text survives as `alt`.
6. `createDocumentMarkdownConverter(TurndownService).turndown(html)`:
   - `headingStyle: 'atx'`, `bulletListMarker: '-'`, `escape: s => s` (instance property);
   - `img` → `[Image: alt]` or `''`;
   - links: `href` starting with `#` → text only; others `[text](href)`;
   - footnote references (`sup > a[href^="#footnote-"]`, `#endnote-`) → `[^n]`; the footnote/endnote list items (`li[id^="footnote-"]`) → `[^n]: text` without the `↑` back link;
   - tables: build a grid honoring `colspan`/`rowspan` (rowspan text repeated, colspan text in the first column), first row as header, cell content on one line (`<br>` between paragraphs), `|` → `\|`, nested tables flattened;
   - compact list items (copy from `pageContent.js` `listItem` rule).
7. `normalizeMarkdown` (copy from `pageContent.js`), strip remaining U+00AD, trim.
8. PR 4: prepend `[Header] …` / `[Footer] …` lines (deduplicated, fields removed) followed by a blank line.

### PDF pipeline

`processPdfFile(file, { structured })` keeps the pdf.js loading loop and collects `{ items }` per page plus `pageLabels = await pdf.getPageLabels().catch(() => null)`; `assemblePdfText(pages, { pageLabels })`:

- per page: join items, inserting `\n` after `hasEOL` items, collapsing runs of spaces, no dehyphenation;
- header line `[Page N]` or `[Page N (printed: L)]` when `L` exists and `L !== String(N)`;
- empty page → `[Page N: no extractable text]`;
- returns `{ text, realTextLength }` where `realTextLength` counts characters outside markers.

`processDocumentFile` uses `realTextLength < MIN_REAL_TEXT_CHARS` (instead of `content.trim().length < 50`) to trigger `renderPdfPagesToImages`; when rendering succeeds, return `content: ''` so `RequestBuilder`/`PromptNodeExecutor` attach the images (PM-01). If rendering fails, keep the text.

### Feature switch

- `server/featureRegistry.js`, new entry (category `content`, `default: true`):
  - name: en "Structured document extraction", de "Strukturierte Dokumentextraktion"
  - description en: "Keep headings, chapter numbers, lists, tables and PDF page numbers when uploaded Word and PDF files are turned into text for the model. Turn off to return to plain text extraction; users get the change after reloading the page (at the latest after 30 minutes)." — de accordingly.
- No migration: `resolveFeatures()` applies the registry default; the admin page lists registry entries automatically. Verify on `Admin → Features`.
- Client: `isStructuredExtractionEnabled()` in `fileProcessing.js` — `await fetchPlatformConfig()` (cached), build the `featuresMap` like `PlatformConfigContext.jsx` L97–103, `new FeatureFlags({ featuresMap }).isEnabled('structuredDocumentExtraction', true)`; any error → `true`. Call it inside `processDocumentFile` (never at module init — the browser extension sets its API base URL later, see the comment in `fileProcessing.js` L143).

## 3. Pull requests

Each PR is independently releasable; the feature switch protects all of them.

### PR 1 — Switch, test infrastructure, DOCX structure without numbering (≈ 2–3 days)

Files: `server/featureRegistry.js`; `tests/config/jest.config.js` (`'^mammoth$'` mapping); `tests/utils/officeFixtures.js` (from `2026-10-08 Test Plan.md` §2); `shared/documentExtraction/{markers,markdown,docx}.js`, `ooxml/{xml,styles,normalize}.js` (without labels); `client/src/features/upload/utils/fileProcessing.js`; `tests/unit/client/docx-structured-extraction.test.jsx`; `tests/unit/client/document-extraction-flag.test.jsx`; docs (`docs/file-upload-feature.md` DOCX row + new "Extracted text format" section + switch; fix PPTX/PPT rows), release note.

Tests: T-DOCX-01, 02, 05, 06, 14, 16–24, 26–30; T-FLAG-01…03; T-DOWN-01, T-DOWN-03.

Done when: tests green; `npm run test:unit`; `cd client && npm run build` succeeds (proves `shared/` imports resolve in Vite); the server stays up for 10 s (`timeout 10s node server/server.js; test $? -eq 124`); manual M-01, M-06, M-08 on two real DOCX files.

### PR 2 — Numbering labels (≈ 2–3 days)

Files: `shared/documentExtraction/ooxml/numbering.js`, wiring in `normalize.js`, tests.
Start from Appendix A (validated against LibreOffice), then add: `numStyleLink`/`styleLink`, `lvlRestart`/`isLgl` (or label suppression), hidden/deleted paragraphs not counted, exotic `numFmt` fallback, Strict namespace.

Tests: T-DOCX-03, 04, 07–13, 15, numbering parts of 20/21; golden G-01…G-03 reviewed by a human (attach before/after in the PR).

### PR 3 — PDF pages (≈ 1–2 days)

Files: `shared/documentExtraction/pdfText.js`, `fileProcessing.js`, `tests/unit/client/pdf-structured-text.test.jsx`, `server/tests/document-extraction-pdf.test.js` (+ add to `test:pdf` in `package.json`), docs (PDF row), release note update.

Tests: T-PDF-01…07, 09, 10; node integration; T-DOWN-02; T-PERF-02; golden G-08…G-10; manual M-07.

### PR 4 — DOCX headers and footers (≈ 1 day)

Files: `shared/documentExtraction/ooxml/headerFooter.js`, `docx.js`, tests, docs.
Resolve `w:headerReference`/`w:footerReference` from every `w:sectPr` via `word/_rels/document.xml.rels`; text per paragraph (tables: cells joined with ` | `); drop field results of `PAGE`, `NUMPAGES`, `SECTIONPAGES` (`w:fldSimple`, and complex fields between `w:fldChar` `separate` and `end`); deduplicate; skip empty.

Tests: T-DOCX-25.

### PR 5 — Prompt guidance (≈ 0.5 day)

`docs/apps.md` ("What `{{content}}` contains"): documents arrive as Markdown with `#` headings, Word numbering, `[Page N]` markers; example instruction for comparing two documents section by section and citing `[Page N]`. Addresses PM-14.

## 4. Commands

```bash
npm run install:all                         # once
npx jest --config tests/config/jest.config.js tests/unit/client/docx-structured-extraction.test.jsx
npm run test:unit
npm run test:pdf                            # PR 3
cd client && npm run build                  # shared/ resolution in Vite
npm run lint:fix && npm run format:fix
timeout 10s node server/server.js; test $? -eq 124 && echo "Server stayed up"   # 124 = killed by timeout; any other code is a startup failure
soffice --headless --convert-to "txt:Text (encoded):UTF8" --outdir /tmp/out file.docx   # numbering oracle (dev only)
```

## Appendix A — Validated numbering spike (reference, not production code)

Node script (jsdom for `DOMParser`), run against two fixtures; output matched LibreOffice exactly: style-linked numbering with German style IDs, `numId=0`, restarts via `startOverride`, continuation across `w:num` instances sharing an `abstractNum`, skipped levels, `Teil %1` with upper roman. Not handled: hidden/deleted paragraphs, `numStyleLink`, `lvlRestart`, `isLgl`, Strict namespace — see PR 2.

```js
const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const kids = (el, name) => Array.from(el?.childNodes || []).filter(n => n.namespaceURI === NS && n.localName === name);
const kid = (el, name) => kids(el, name)[0];
const val = el => el?.getAttributeNS(NS, 'val') ?? el?.getAttribute('w:val');

function toRoman(n) { const m = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']]; let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; }
function toLetter(n) { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }
function fmt(n, f) {
  switch (f) {
    case 'decimal': return String(n);
    case 'decimalZero': return String(n).padStart(2, '0');
    case 'lowerLetter': return toLetter(n);
    case 'upperLetter': return toLetter(n).toUpperCase();
    case 'lowerRoman': return toRoman(n);
    case 'upperRoman': return toRoman(n).toUpperCase();
    case 'bullet': return null;
    case 'none': return '';
    default: return String(n);
  }
}

// doc, stylesDoc, numDoc: parsed XML Documents of document.xml, styles.xml, numbering.xml
const styles = new Map();
for (const s of stylesDoc ? stylesDoc.getElementsByTagNameNS(NS, 'style') : []) {
  const ppr = kid(s, 'pPr'); const numPr = kid(ppr, 'numPr');
  styles.set(s.getAttributeNS(NS, 'styleId') || s.getAttribute('w:styleId'), {
    basedOn: val(kid(s, 'basedOn')), name: val(kid(s, 'name')),
    numId: val(kid(numPr, 'numId')), ilvl: val(kid(numPr, 'ilvl')), outlineLvl: val(kid(ppr, 'outlineLvl'))
  });
}
const styleProp = (id, prop, seen = new Set()) => {
  const s = styles.get(id); if (!s || seen.has(id)) return undefined; seen.add(id);
  return s[prop] ?? styleProp(s.basedOn, prop, seen);
};

const abstracts = new Map(), nums = new Map();
for (const a of numDoc ? numDoc.getElementsByTagNameNS(NS, 'abstractNum') : []) {
  const levels = {};
  for (const l of kids(a, 'lvl')) {
    levels[l.getAttributeNS(NS, 'ilvl') ?? l.getAttribute('w:ilvl')] = {
      start: +(val(kid(l, 'start')) ?? 1), numFmt: val(kid(l, 'numFmt')) ?? 'decimal', lvlText: val(kid(l, 'lvlText')) ?? ''
    };
  }
  abstracts.set(a.getAttributeNS(NS, 'abstractNumId') ?? a.getAttribute('w:abstractNumId'), levels);
}
for (const n of numDoc ? numDoc.getElementsByTagNameNS(NS, 'num') : []) {
  const overrides = {};
  for (const o of kids(n, 'lvlOverride')) {
    const so = val(kid(o, 'startOverride'));
    if (so != null) overrides[o.getAttributeNS(NS, 'ilvl') ?? o.getAttribute('w:ilvl')] = +so;
  }
  nums.set(n.getAttributeNS(NS, 'numId') ?? n.getAttribute('w:numId'), { abstractId: val(kid(n, 'abstractNumId')), overrides });
}

const counters = new Map(); // key: abstractNumId — w:num instances of one abstractNum share counters
const seenNums = new Set();
for (const para of Array.from(doc.getElementsByTagNameNS(NS, 'p'))) {
  const ppr = kid(para, 'pPr'); const styleId = val(kid(ppr, 'pStyle'));
  const numPr = kid(ppr, 'numPr');
  const numId = val(kid(numPr, 'numId')) ?? styleProp(styleId, 'numId');
  const ilvl = +(val(kid(numPr, 'ilvl')) ?? styleProp(styleId, 'ilvl') ?? 0);
  if (!numId || numId === '0' || !nums.has(numId)) continue;
  const num = nums.get(numId), levels = abstracts.get(num.abstractId) || {};
  const c = counters.get(num.abstractId) || [];
  if (!seenNums.has(numId)) { // first use of this w:num: apply its startOverrides
    seenNums.add(numId);
    for (const [lv, start] of Object.entries(num.overrides)) { c[+lv] = start - 1; c.length = +lv + 1; }
  }
  for (let i = 0; i < ilvl; i++) if (c[i] == null) c[i] = levels[i]?.start ?? 1; // skipped level shows its start
  c[ilvl] = (c[ilvl] ?? (levels[ilvl]?.start ?? 1) - 1) + 1;
  c.length = ilvl + 1; // deeper levels restart
  counters.set(num.abstractId, c);
  const lvl = levels[ilvl] || { numFmt: 'decimal', lvlText: `%${ilvl + 1}.` };
  const label = lvl.numFmt === 'bullet'
    ? '-'
    : lvl.lvlText.replace(/%(\d)/g, (_, d) => fmt(c[+d - 1] ?? 1, levels[+d - 1]?.numFmt ?? 'decimal'));
  if (!label) continue;
  // inject the label as a leading run, then neutralize numbering for mammoth
  const r = doc.createElementNS(NS, 'w:r'), t = doc.createElementNS(NS, 'w:t');
  t.setAttribute('xml:space', 'preserve'); t.textContent = `${label} `; r.appendChild(t);
  para.insertBefore(r, Array.from(para.childNodes).find(n => n.localName !== 'pPr') || null);
  if (numPr) ppr.removeChild(numPr);
  else {
    const np = doc.createElementNS(NS, 'w:numPr'), ni = doc.createElementNS(NS, 'w:numId');
    ni.setAttributeNS(NS, 'w:val', '0'); np.appendChild(ni); ppr.appendChild(np);
  }
}
// then: XMLSerializer → zip → mammoth.convertToHtml → Turndown (escape disabled)
```

Spike output for the fixture in `2026-10-08 Test Plan.md` style (German heading styles, `IF Kapitel`, lists):

```
Teil I Teil-Überschrift
# 1. Geltungsbereich
## 1.1 Definitionen
## 1.2 Pflichten
# 2. Laufzeit
# Unnummeriert
# Firmenvorlage Kapitel
a) erster Punkt
b) zweiter Punkt
a) neu gestartet
# 3. Kündigung
```

## Appendix B — PDF fixtures with pdf-lib (node test)

```js
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const p1 = doc.addPage([595, 842]);
p1.drawText('Dieser Vertrag gilt fuer alle Parteien und re-', { x: 50, y: 750, size: 11, font });
p1.drawText('gelt die Zusammenarbeit.', { x: 50, y: 736, size: 11, font });
doc.addPage([595, 842]); // page without text
// Page labels: roman for the first page, then decimal from 1
doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({
  Nums: [0, doc.context.obj({ S: PDFName.of('r') }), 1, doc.context.obj({ S: PDFName.of('D'), St: 1 })]
}));
const pdf = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
await pdf.getPageLabels();            // → ['i', '1']
(await (await pdf.getPage(1)).getTextContent()).items;
// → [{str:'', hasEOL:true}, {str:'Dieser … re-', hasEOL:true}, {str:'gelt die Zusammenarbeit.', hasEOL:false}] (abridged)
```
