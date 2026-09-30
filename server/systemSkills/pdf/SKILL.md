---
name: pdf
description: Create PDF documents on demand — reports, summaries, briefs, letters, invoices, handouts, checklists, meeting minutes — with headings, tables, lists, callouts, SVG charts, a cover page, a table of contents, headers/footers and watermarks. Use whenever the user asks for a PDF, a printable or downloadable document, or to save or export content as PDF.
metadata:
  author: IntraFind
  version: '1.0'
allowed-tools: create_pdf preview_pdf
---

# Creating PDF documents

You create PDFs with the `create_pdf` tool. The server lays the document out and the user gets a download card in the chat. You write the content; the tool takes care of fonts, pagination, spacing and styling.

## What is possible

- **Create** a new PDF from Markdown, optionally with layout blocks (columns, callouts, boxes, tables with merged cells, SVG charts, images, QR codes).
- **Check** a page of a PDF you created with `preview_pdf` (only when the tool is offered).
- **Not possible here:** editing, merging, splitting, filling forms in, or extracting content from PDFs the user uploaded. The server does not get the original file. Say so, and offer to create a new document from the content instead.

## Workflow

1. **Plan the document.** Decide on the audience, the sections and the key figures before you write. Ask the user only when essential facts are missing (e.g. the invoice recipient), not about styling.
2. **Write the content as Markdown** in `markdown`. Most documents need nothing else.
3. **Call `create_pdf`** with a descriptive `filename`, a `title` and the content. Add document settings (see below) as needed.
4. **Check it** (only if `preview_pdf` is available and the layout is non-trivial). Look at page 1 and any page with a wide table, a chart or columns. If something is wrong, fix it and call `create_pdf` again. At most two correction rounds.
5. **Answer briefly.** Name the file, give its page count and a one-line summary. Do not paste the document into the chat, and do not add a download link: the card is already there.

If `create_pdf` returns `warnings`, read them. They name content that was skipped (for example an unsupported image) or truncated. Fix what matters and create the file again.

## Document settings

| Setting                       | Use it for                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`, `subtitle`, `author` | Printed at the top (or on the cover) and stored as PDF metadata.                                                                            |
| `language`                    | Always set it to the language of the content (`en`, `de`, …): page labels and metadata.                                                     |
| `theme`                       | `default` (friendly, blue headings), `professional` (serif, restrained, business), `minimal` (black and white).                             |
| `primaryColor`                | The user's brand colour as hex, e.g. `#e30613`. Headings and accents use it.                                                                |
| `coverPage`                   | Formal documents of more than about three pages.                                                                                            |
| `toc`                         | Long documents with four or more sections.                                                                                                  |
| `header` / `footer`           | Running text. Placeholders: `{title}`, `{page}`, `{pages}`, `{date}`. Page numbers are on by default (`pageNumbers: false` turns them off). |
| `pageSize`, `orientation`     | `A4` by default; `LETTER` for US users. Use `landscape` for wide tables.                                                                    |
| `watermark`                   | `"DRAFT"`, `"CONFIDENTIAL"`, … when the user asks for one.                                                                                  |

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
- **Not supported:** Mermaid diagrams, LaTeX math and HTML layout. Draw diagrams as SVG blocks and write formulas in plain text with `<sub>`/`<sup>`.

## Layout blocks: when Markdown is not enough

`blocks` is an optional list that is rendered after the Markdown. Each block has one content key. Typical uses:

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
- **Columns** for side-by-side comparisons, and for the header of invoices and letters (sender left, details right). The gap between columns is automatic (`columnGap` sets it).
- **Charts:** write SVG. Give the root element `width`, `height` and a `viewBox`, use `font-family="sans-serif"` for labels, and keep charts simple (bars, lines, pie segments as paths) with a title and axis labels. SVG must be self-contained: no external images, no scripts.
- **Images** only as `data:image/png;base64,…` or `data:image/jpeg;base64,…`. The tool sizes them to their natural size and never beyond the page. You cannot fetch images from URLs.
- **Tables with merged cells or custom column widths:** see the reference.

To mix, put `markdown` blocks between the other blocks in the order you want. The full grammar (text styles, table spans and layouts, boxes, canvas shapes, named styles and images) is in `references/layout-blocks.md`. Complete examples (report, invoice, letter, one-pager) are in `references/examples.md`. Read them with `read_skill_resource` when you need them.

## Quality checklist

Before you answer:

- The title, the `language` and the file name fit the content.
- There are no empty sections, placeholder text or `TODO`s, unless the user asked for a template.
- Numbers, dates and currency formats are consistent across the whole document.
- Tables fit the page: no more than 6–7 columns in portrait.
- For a revision, you created a new file. PDFs are never edited in place, so each `create_pdf` call makes a new file.
