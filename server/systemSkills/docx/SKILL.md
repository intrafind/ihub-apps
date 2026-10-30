---
name: docx
description: Create editable Word documents (.docx) on demand — reports, proposals, concepts, letters, minutes, specifications, manuals, contracts drafts — with real Word headings, lists, tables, callouts, a cover page and a table of contents, in the company's document template. Use whenever the user asks for a Word document, a .docx file, or an editable document they want to keep working on.
metadata:
  author: IntraFind
  version: '1.0'
allowed-tools: create_docx
---

# Creating Word documents

You create Word documents with the `create_docx` tool. You write the content as Markdown; the server turns it into a real, editable Word document: Markdown headings become Word headings (Heading 1, Heading 2, …), lists become Word lists, tables become Word tables. The user gets a download card in the chat.

## Choose the format

- **Word (`create_docx`)** when the user wants to keep editing the document, send it for review with track changes, or paste it into their own documents.
- **PDF (`create_pdf`, if the `pdf` skill is available)** when the user wants a finished, printable document with a fixed layout, charts or a multi-column layout.
- If the user just says "a document", ask only if it matters; otherwise prefer Word for drafts and PDF for final hand-outs.

## The company template

If the app uses a **document template**, the server applies it automatically: the company's Word template (styles, header, footer, logo, page setup) or its brand colours, fonts and logo. Then:

- Do not try to imitate the corporate design yourself, and do not set colours or fonts.
- Do not repeat the company name, logo text or a confidentiality line in the content: the header and footer have them.
- If `create_docx` offers a `template` parameter, use `default` unless the user asks for a specific template.

## Workflow

1. **Plan the document.** Audience, purpose, sections, key facts. Ask only when essential facts are missing.
2. **Write the content as Markdown** in `markdown`. Start with the first section — the title is printed already; do not repeat it as a `#` heading.
3. **Call `create_docx`** with a descriptive `filename`, the `title`, the `language` of the content and the `markdown`. Add `subtitle`, `author`, `coverPage` (formal documents of more than about three pages) and `toc` (four or more sections) as needed.
4. **Answer briefly.** Name the file and summarise it in one or two sentences. Do not paste the document into the chat and do not add a link: the download card is already there.

If `create_docx` returns `warnings`, read them. They name content that was skipped (for example an unsupported image). Fix what matters and create the file again.

## Writing for Word

- **Use heading levels consistently**: `#` for main sections, `##` and `###` below them. Never skip levels. The table of contents is built from levels 1–3.
- **Keep paragraphs short**; use bullet lists for enumerations and numbered lists for steps.
- **Tables**: GFM tables, at most 6–7 columns in portrait (use `orientation: "landscape"` for wider ones). Right-align numbers (`|---:|`), give units in the header.
- **Callouts**: GitHub alerts become shaded boxes:
  ```markdown
  > [!IMPORTANT]
  > The offer is valid until **31 March**.
  ```
  Kinds: `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`. One or two per page at most.
- **Quotes**: `> text` becomes a Word quote.
- **Code** in fenced blocks.
- **Page breaks**: a line with only `\pagebreak`, before major parts such as an appendix.
- **Images** only as `data:image/png;base64,…` or `data:image/jpeg;base64,…`; you cannot fetch images from URLs.
- **Sub- and superscript**: `H<sub>2</sub>O`, `m<sup>2</sup>`.
- **Not supported**: Mermaid, LaTeX math, HTML layout, footnotes, comments and tracked changes. Charts are not drawn in Word documents; give the numbers as a table, or create a PDF or presentation for charts.
- **Letters**: put the recipient block, date line and subject as normal paragraphs at the top (bold the subject), then the salutation and body.

## Quality checklist

- Title, `language` and file name fit the content.
- No empty sections, placeholder text or `TODO`s unless the user asked for a template to fill in.
- Numbers, dates and currency formats are consistent.
- For a revision, create a new file: documents are never edited in place.
