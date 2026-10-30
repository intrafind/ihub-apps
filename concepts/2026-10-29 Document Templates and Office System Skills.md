# Document Templates and the Word and PowerPoint System Skills

Issue: [intrafind/ihub-apps#2635](https://github.com/intrafind/ihub-apps/issues/2635) (continues
[`2026-10-01 Server-side PDF Generation and System Skills`](<2026-10-01%20Server-side%20PDF%20Generation%20and%20System%20Skills.md>))
· PR: [intrafind/ihub-apps#3048](https://github.com/intrafind/ihub-apps/pull/3048). Admin and
developer documentation: [`docs/document-templates.md`](../docs/document-templates.md),
[`docs/pdf-generation.md`](../docs/pdf-generation.md).

## Goal

A company has a corporate design, and every document should follow it — whoever asked for it,
whichever app made it. After the PDF engine (#2639), three things were missing:

1. **Templates**: one place where an admin puts the company's design — colours, fonts, logo,
   letterhead, and the company's own Word and PowerPoint templates — applied to every generated
   document and to exports.
2. **Word** documents on demand (`docx` system skill).
3. **PowerPoint** presentations on demand (`pptx` system skill).

## Decisions

### A template is a folder of files plus settings, managed by admins

`contents/document-templates/<id>/template.json` names the files next to it. Files go into fixed
slots (`logo`, `font`, `letterhead`, `letterheadFollowing`, `wordTemplate`, `powerpointTemplate`)
and are parsed on upload, so a broken file is refused with a message rather than failing every
document later: images by signature and size, fonts with fontkit, PDFs with pdf-lib (encrypted ones
refused), Office files unpacked with entry and size limits and refused with macros.

Folders rather than a JSON config with base64 assets: templates hold megabytes of binary files,
admins recognise the files, and backups and the shared `contents/` of a cluster carry them as they
are.

### Which template applies

App's `documentTemplate` (pinned) → the one the model or user picked → the default template →
the built-in design. A pinned template is the "all documents look the same" switch: the tools then
do not even offer colour, theme or font parameters. Where a template says something, it wins over
the model's arguments.

### Word: generate, then merge into the company's template

The [docx](https://docx.js.org/) library writes the content with Word's own styles (Heading 1,
Title, List Paragraph, Quote, Caption, Hyperlink). With a Word template the generated body is
merged into the template package:

- **Styles are matched by built-in name**, not id. German Word saves `heading 1` as
  `berschrift1`, so matching ids would drop every heading to Normal. Missing styles are copied;
  heading-like copies use the template's theme fonts and accent colour (`majorHAnsi`,
  `themeColor="accent1"`), as Word's built-ins would.
- **Numbering, pictures and links** are merged under new ids; drawing and bookmark ids are moved out
  of the template's range.
- **Placeholders** `{{content}}`, `{{title}}`, `{{subtitle}}`, `{{author}}`, `{{date}}`,
  `{{company}}`, replaced across the runs Word splits text into.
- The template's last section (page size, margins, header and footer references) is kept.

Rejected: the docx library's `patchDocument` — it has no style-name mapping and does not merge
list numbering.

### PowerPoint: always fill a template

pptxgenjs cannot open a template, and a corporate design lives in a `.potx`'s masters and
layouts. So presentations are written as PresentationML **into a template package**: the admin's
PowerPoint template, or iHub's built-in one generated from the brand (a master, six layouts, a
theme with the brand colours and fonts, the logo). One code path for both.

- Slides use the template's **layouts**; titles and text go into the layout's **placeholders** and
  inherit everything (fonts, sizes, colours, bullets). Tables, pictures and charts go into the
  layout's content area.
- **Layout choice** by type (`title`, `secHead`, `obj`, `twoObj`, `titleOnly`, `blank`), then by
  placeholders, then by name; an admin can override per kind. Text goes only into body/content
  placeholders, never into picture or media ones.
- **Sample slides** of the template are removed (with their notes, custom shows and sections);
  parts nothing refers to any more are dropped.
- **Charts**: pptxgenjs renders them on a scratch deck of the same size, at their final position, in
  the theme's accent colours; the chart part, its embedded workbook and its frame are moved onto
  the slide. Native, editable charts without writing chart XML by hand.
- **Fitting**: an estimate of the lines a text needs sets PowerPoint's `normAutofit` font scale, and
  the tool warns when a slide is overloaded.

The slides argument is JSON text, like `create_pdf`'s blocks: its fields are alternatives, which a
strict schema mode would turn into "every field required".

### PDF: brand, fonts, letterhead

- Brand colours and a separate heading font become theme overrides; uploaded fonts are registered
  per render (each render runs in its own worker, so templates never see each other's fonts).
- **Letterhead** is drawn *under* the content: its drawing operations go in front of the page's
  content stream (pdf-lib), so links, outlines and text selection are untouched.
- GitHub alerts (`> [!NOTE]`) became callouts in PDFs too, so Markdown renders alike in all formats.

### One worker service for all formats

`renderService.js` runs PDF, Word and PowerPoint rendering in worker threads with the same time
budget, memory cap and a concurrency limit shared by all formats. Template files travel to the
worker as buffers.

## Not yet

- **Excel** (`xlsx`) system skill.
- **DOCX/PPTX exports** of chats on the server with templates (the export dialog's DOCX and PPTX
  are still built in the browser; #2619 moves them to the server and can use
  `applyTemplateToDocxSpec`/`applyTemplateToPptxSpec`).
- **Slide preview** for the model (needs a renderer for PPTX).
- Embedding brand fonts into Word and PowerPoint files.
- Group restrictions on templates.
