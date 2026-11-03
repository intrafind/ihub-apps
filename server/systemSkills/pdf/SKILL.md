---
name: pdf
description: Create PDF documents on demand — reports, summaries, briefs, letters, invoices, forms, handouts, checklists, posters, certificates, meeting minutes — with headings, tables, lists, callouts, printable/pre-filled form fields, SVG charts, a cover page, a table of contents, headers/footers and watermarks. Use whenever the user asks to create, generate, export or save a PDF or printable document. Do NOT activate just to read, summarize or answer questions about an uploaded PDF (its extracted text and form fields are already in the conversation context).
metadata:
  author: IntraFind
  version: '1.3'
allowed-tools: create_pdf preview_pdf
---

# Creating PDF documents

You create PDFs with the `create_pdf` tool. The server lays the document out and the user gets a download card in the chat. You write the content; the tool takes care of fonts, pagination, spacing and styling.

## Choose the format

- **PDF (`create_pdf`)** when the document is meant to be read, printed or sent as it is: reports, briefs, letters, invoices, handouts, certificates, visual posters, one-pagers.
- **Word (`create_docx`, `docx` skill)** when the user wants to keep editing the document, collaborate with Track Changes, or paste it into their own templates.
- **PowerPoint (`create_pptx`, `pptx` skill)** when the user wants a slide deck or presentation.
- **Excel (`create_xlsx`, `xlsx` skill)** when the user wants a spreadsheet, workbook, financial model or multi-sheet data table with live formulas.
- **Interactive web apps or standalone SVGs (`create_web_artifact`, `web-artifacts` skill)** when the user wants an interactive HTML dashboard, calculator, simulator, HTML5 `<canvas>` animation, or standalone `.svg`.
- **Code, diagrams, notebooks, CSV or archives (`create_file` / `create_zip`, `files` skill)** when the user wants source code, a `.ipynb` notebook, `.drawio`/`.excalidraw` diagram file, `.ics` calendar invite, or a ZIP archive.

## What is possible (and how uploaded PDFs & forms work)

- **Create** a new PDF from Markdown, optionally with layout blocks (columns, callouts, boxes, printable/pre-filled `{ form }` blocks, tables with merged cells, SVG charts, vector canvas shapes, images, QR codes).
- **Check** a page of a PDF you created with `preview_pdf` (when the tool is offered).
- **Reading uploaded PDFs & forms:** When the user uploads a PDF in chat, the platform has **already extracted its text, tables, and AcroForm widget fields (`[Form fields]`) into `<content type="document">` in your prompt context** (or attached rendered page images for scanned PDFs). Answer questions, summarize, or extract form values directly from that context — never claim you cannot read an uploaded PDF.
- **Filling or recreating uploaded PDF forms:** Because `create_pdf` always builds a fresh document, you cannot mutate an uploaded PDF binary in place. When the user uploads a PDF form and asks you to fill it out or produce a clean printable version, read the `[Form fields]` and surrounding labels from `<content type="document">` and call `create_pdf` using `{ "form": { "title": "…", "columns": 2, "fields": […] } }` blocks to generate the completed PDF form.

## Workflow

1. **Plan the document.** Decide on the audience, the sections and the key figures before you write. Ask the user only when essential facts are missing (e.g. the invoice recipient), not about styling.
2. **Choose `markdown` vs. `blocks`:**
   - For prose documents (reports, memos, guides, policies), write the entire body in `markdown` (using `> [!NOTE]` / `[!WARNING]` alerts for callouts).
   - When mixing prose with layout blocks (SVG charts, multi-column KPI cards, invoices, letters) in a specific reading order, **put `{ "markdown": "…" }` items inside `blocks` in reading order** and leave top-level `markdown` empty. (Top-level `markdown` always renders in full _before_ `blocks`, so putting all sections in `markdown` and a chart in `blocks` pushes the chart to the very end of the document.)
3. **Call `create_pdf`** with a descriptive `filename`, a `title` and the content. Add document settings (see below) as needed.
4. **Visually inspect with `preview_pdf`** (when `preview_pdf` is available and the layout is non-trivial: charts, multi-column boxes, wide tables, invoices, posters):
   - Remember that when `coverPage: true` and `toc: true`, page 1 is the cover and page 2 is the table of contents — preview **page 3** (or whichever page holds your charts, columns, or wide tables) in addition to page 1.
   - Check the rendered image for: clipped or overlapping SVG text labels, narrow table columns wrapping single words across 3+ lines, awkward page splits, or an unwanted duplicate title at the top of a letter (`showTitle: false` fixes this).
   - If you spot a layout defect, fix the spec and call `create_pdf` again (at most two correction rounds).
5. **Answer briefly.** Name the file, give its page count and a one-line summary. Do not paste the document into the chat, and do not add a download link: the card is already there.

If `create_pdf` returns `warnings`, read them. They name content that was skipped (for example an unsupported image) or truncated. Fix what matters and create the file again.

## The company template

If the app uses a **document template**, the server applies it automatically: the company's colours, fonts, logo, header, footer, page setup and letterhead. Then:

- Do not set `theme`, `primaryColor`, `accentColor` or `font`, and do not imitate the corporate design with layout blocks.
- Do not repeat the company name, logo text or a confidentiality line in the content: the header and footer have them.
- If `create_pdf` offers a `template` parameter, use `default` unless the user asks for a specific template.

## Document settings

| Setting                               | Use it for                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`, `subtitle`, `author`, `date` | Printed at the top (or on the cover) and stored as PDF metadata (`date` also fills `{date}` in headers/footers).                            |
| `showTitle`                           | Set to `false` for letters, certificates, invoices or visual posters that arrange their own header in `blocks` (default `true`).            |
| `language`                            | Always set it to the language of the content (`en`, `de`, …): page labels and metadata.                                                     |
| `theme`                               | `default` (friendly, blue headings), `professional` (serif, restrained, business), `minimal` (black and white).                             |
| `primaryColor`, `accentColor`         | Brand colour (`primaryColor`) for headings/table headers and secondary (`accentColor`) for callout borders, as hex (`#0f766e`).             |
| `coverPage`                           | Formal documents of more than about three pages.                                                                                            |
| `toc`                                 | Long documents with four or more sections.                                                                                                  |
| `header` / `footer`                   | Running text. Placeholders: `{title}`, `{page}`, `{pages}`, `{date}`. Page numbers are on by default (`pageNumbers: false` turns them off). |
| `pageSize`, `orientation`, `margins`  | `A4` by default; `LETTER` for US users. Use `landscape` for wide tables. Set `margins` (`[left, top, right, bottom]`) for posters/flyers.   |
| `watermark`                           | `"DRAFT"`, `"CONFIDENTIAL"`, … when the user asks for one.                                                                                  |

## Writing good Markdown for print

- **Structure with headings.** Use one `#` heading per major section and `##`/`###` below it. Do not repeat the document title as the first heading: the title is printed already.
- **Keep paragraphs short**, and use lists for anything enumerable.
- **Tables:** at most 6–7 columns in portrait. Switch to `orientation: "landscape"` or split the table otherwise. Right-align numeric columns (`|---:|`), keep cells short and give units in the header (`Revenue (k€)`).
- **Page breaks:** a line containing only `\pagebreak`, and only before major parts (appendix, a new chapter). Headings are never left alone at the bottom of a page, so do not add breaks just to avoid that.
- **Spacing is automatic.** Do not add blank lines, `&nbsp;` or empty headings to make space.
- **Sub- and superscript:** `H<sub>2</sub>O`, `m<sup>2</sup>`. Never use Unicode sub/superscript characters (₂, ²).
- **Symbols:** ✓ ✗ → ← • ★ ⚠ ☐ ☑ € and similar are available. Colour emoji are not: they are replaced where possible and otherwise left out, so do not rely on them.
- **Links** become clickable when they start with `http(s)://` or `mailto:`.
- **Code** goes in fenced blocks. Long lines wrap.
- **Callouts** without layout blocks: GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` on the first line of a quote) become coloured boxes, as in Word documents.
- **Not supported:** Mermaid diagrams, LaTeX math and HTML layout. Draw diagrams as SVG blocks and write formulas in plain text with `<sub>`/`<sup>`.

## Layout blocks: when Markdown is not enough

`blocks` is an optional list that is rendered after the Markdown. Pass it as JSON text, like `styles` and `images`. Each block has one content key. Typical uses:

```json
[
  {
    "callout": {
      "tone": "warning",
      "title": "Action required",
      "markdown": "Renew the licence by **31 March**."
    }
  },
  {
    "columns": [
      { "width": "*", "markdown": "### Strengths\n- Market share\n- Brand" },
      { "width": "*", "markdown": "### Risks\n- Supply chain\n- Currency" }
    ],
    "columnGap": 20
  },
  {
    "svg": "<svg width=\"480\" height=\"200\" viewBox=\"0 0 480 200\" xmlns=\"http://www.w3.org/2000/svg\">…</svg>"
  },
  { "qr": "https://example.com/feedback", "fit": 90 }
]
```

- **Callouts** (`info`, `success`, `warning`, `danger`, `note`) for key takeaways, risks and next steps. Use one or two per page at most.
- **Columns** for side-by-side comparisons, KPI stat cards, and for the header of invoices and letters (sender left, details right). The gap between columns is automatic (`columnGap` sets it).
- **SVG Charts & Visual Graphics (`svg-to-pdfkit` rules):**
  - Always set explicit numeric `width`, `height`, and a matching `viewBox="0 0 W H"` on the root `<svg>` element (keep `width` ≤ the usable content width, i.e. the page width minus the left and right margins: `495` on A4 portrait with the default margins, `539` with `margins: [28, 28, 28, 28]`; `480` is a safe default).
  - Always set explicit `fill="#111827"` (or another hex colour) and `font-family="sans-serif"` on `<text>` elements — never rely on `currentColor`, CSS variables, or external stylesheets.
  - Leave at least `16px` of padding inside the `viewBox` around edge labels so text is never clipped.
  - Never use `<foreignObject>`, `<script>`, or external `<image>` URLs (all are stripped for security).
- **Printable & Pre-Filled Forms (`{ "form": … }` block):**
  - Use `{ "form": { "title": "Applicant Details", "columns": 2, "fields": [ { "label": "Full Name", "value": "Jane Doe", "required": true }, { "label": "Department", "placeholder": "e.g. Engineering" }, { "label": "Request Type", "type": "checkbox", "options": [{ "label": "New Access", "checked": true }, { "label": "Hardware" }] }, { "label": "Justification", "type": "textarea", "rows": 3, "span": 2 }, { "label": "Applicant Signature", "type": "signature" }, { "label": "Date", "value": "2026-11-02" } ] } }` to create clean, aligned blank or pre-filled forms.
- **Visual Posters, Certificates & One-Pagers (`canvas-design` workflow):**
  - When the user asks for a poster, flyer, certificate, or visual infographic PDF, read `references/canvas-design.md` with `read_skill_resource` and follow its design-philosophy workflow (`showTitle: false`, `pageNumbers: false`, tight `margins`, bold SVG hero geometry, and restrained typography).
- **Images** only as `data:image/png;base64,…` or `data:image/jpeg;base64,…`. The tool sizes them to their natural size and never beyond the page. You cannot fetch images from URLs.
- **Tables with merged cells or custom column widths:** see the reference.

To mix prose and visuals in reading order, put `{"markdown": "…"}` blocks between the other blocks in `blocks`. The full grammar (text styles, table spans and layouts, forms, boxes, canvas shapes, named styles and images) is in `references/layout-blocks.md`. Poster and visual composition patterns are in `references/canvas-design.md`. Complete examples (report, invoice, letter, one-pager, visual poster) are in `references/examples.md`. Read them with `read_skill_resource` when you need them.

## Quality checklist

Before you answer:

- The title, the `language` and the file name fit the content.
- There are no empty sections, placeholder text or `TODO`s, unless the user asked for a template.
- Numbers, dates and currency formats are consistent across the whole document.
- Tables fit the page: no more than 6–7 columns in portrait.
- For a revision, you created a new file. PDFs are never edited in place, so each `create_pdf` call makes a new file.
