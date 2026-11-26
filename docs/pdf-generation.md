---
description: "Let models create PDF, Word, PowerPoint and Excel files, code and archives on the server."
audience: admin
type: reference
---

# Document and File Generation

iHub generates PDF files, Word documents, PowerPoint presentations and Excel workbooks on the server, without Python, Office or a browser. The engines serve two purposes:

1. **On demand by the model.** The **`pdf`**, **`docx`**, **`pptx`** and **`xlsx` system skills** let the model create a document in a chat — a report, an invoice, a letter, a proposal, a slide deck, a financial model. The **`web-artifacts`** skill builds interactive HTML pages and SVG graphics. The user gets a download card below the answer.
2. **Exports.** Chat export, the Markdown download menus (workflow output) and agent artifacts produce a real `.pdf` file. They used to open the browser's print dialog, which printed blank pages in the Outlook task pane, the browser extension and some browsers.

The office formats follow the company's **[document template](document-templates.md)**: the company's own Word and PowerPoint templates, the brand colours read from them, and the fields of its documents.

## System skills

A **system skill** is a skill that ships with iHub, as part of the server (`server/systemSkills/<name>/`). It works like any other [skill](concepts.md#skills): a `SKILL.md` with instructions, plus reference files the model reads when it needs them.

What makes it different:

- **Read-only.** Admins cannot edit, overwrite or delete a system skill. It is never copied into `contents/`, and it is updated together with iHub. In **Admin → Skills** it carries a **System** badge. The detail page shows what it does and which tools it brings, without edit, toggle or delete actions.
- **Reserved name.**
  - A folder `contents/skills/<name>` with the same name is ignored; the server logs a warning.
  - Importing a skill zip or installing a marketplace skill under that name is refused.
- **Location, not metadata.** A skill is a system skill because of where it lives. An `isSystem` field in the frontmatter of an uploaded skill has no effect.
- **It can bring tools.** A system skill names built-in tools in its `allowed-tools` frontmatter. When an app enables the skill, the model gets those tools as well. A skill an admin installs cannot enable tools this way.

System skills follow the same rules as every skill:

- The **Skills** feature must be on (**Admin → Features**).
- The app must list the skill (**Admin → Apps → Skills**, or `"skills": ["pdf"]` in the app config).
- The user must be allowed to use it (`permissions.skills` in [groups](platform.md)).

Nothing changes for an app that does not list the skill.

The shipped system skills:

| Skill | Tools | Purpose |
|---|---|---|
| `pdf` | `create_pdf`, `preview_pdf` | Create PDF documents on request |
| `docx` | `create_docx`, `edit_docx` | Create editable Word documents on request, and change them in place |
| `pptx` | `create_pptx`, `restyle_pptx`, `edit_pptx` | Create PowerPoint presentations on request, and change them slide by slide; move an uploaded deck into the company design |
| `xlsx` | `create_xlsx`, `edit_xlsx` | Create formatted Excel workbooks with live formulas on request, and change cells, rows and sheets |
| `web-artifacts` | `create_web_artifact`, `edit_web_artifact` | Build interactive HTML pages (calculators, simulators, prototypes) and SVG graphics that run in the chat's workspace pane, and change them in place |
| `dashboard` | `create_dashboard`, `edit_dashboard` | Turn figures from tools or from the user into a dashboard page (headline, KPI tiles, bar and line charts, tables, method and sources) in the chat's workspace pane |
| `files` | `create_file`, `create_zip` | Create source code, JSON, YAML, CSV, Markdown and text files, and ZIP archives, on request |

### Skill access checks

System skills go through the same access check as every other skill (`server/services/skillAccess.js`): `activate_skill`, `read_skill_resource`, `requestedSkills` and `/name` only load a skill that the app (or agent node) lists and the user's groups grant. The tools a system skill brings (`create_pdf`, `preview_pdf`, `create_docx`, `edit_docx`, `create_pptx`, `restyle_pptx`, `edit_pptx`, `create_xlsx`, `edit_xlsx`, `create_web_artifact`, `edit_web_artifact`, `create_file`, `create_zip`) are offered under the same condition.

### Document templates and the tools

The document tools follow the app's [document template](document-templates.md):

- When the app **pins** a template, the tools do not offer the colour, theme and font parameters, and their description tells the model that the corporate design is applied automatically. The model is also told the template's colours, palette, font names and fields (read-only).
- Otherwise, when templates exist, the tools offer a `template` parameter: `default` (the default template, or the built-in design) or one of the enabled templates. The skills tell the model to keep `default` unless the user asks for another one.
- Where a template sets something, it wins over the model's arguments.

## The `pdf` skill

### Enabling it

1. Turn on **Skills** in **Admin → Features**.
2. Add `pdf` to the app's skills (**Admin → Apps → edit app → Skills**).
3. Check that the user's groups may use the skill. The default `users`, `authenticated` and `admins` groups allow all skills.

The model then sees the skill in `<available_skills>`, can load its instructions with `activate_skill`, and can call `create_pdf`.

### What the model can do

`create_pdf` renders a document from **Markdown**, optionally followed by **layout blocks** for layouts Markdown cannot express. It also sets the document up:

- **Content:** headings, paragraphs, bold/italic/strikethrough, links, nested and task lists, GFM tables with column alignment, code blocks, quotes, horizontal rules, `<sub>`/`<sup>`, page breaks (`\pagebreak`), and images as `data:` URIs.
- **Tables stay on the page:** column widths are sized from the text, so a table with many columns or a long URL never runs off the page. When the longest words do not fit at the normal size, the cell padding is tightened, then the font shrinks (down to 6.5 pt), and a word that still does not fit is broken inside its column. Widths given in a layout block are kept.
- **Layout blocks:** columns, callouts (info/success/warning/danger/note), boxes, tables with merged cells and custom widths, SVG charts and diagrams, canvas shapes, QR codes, named styles. The tool takes `blocks`, `styles` and `images` as JSON text, so the schema works with providers that enforce strict tool schemas.
- **Document settings:**
  - title, subtitle, author, language
  - theme (`default`, `professional`, `minimal`) and brand colour (a document template's colours win)
  - font family and size, page size and orientation, margins
  - running header and footer, page numbers
  - cover page, table of contents, watermark

`preview_pdf` renders one page of a PDF the model created to an image and shows it to the model. The model can then check the layout and correct it, which is the "render it and look at it" step of the skill. It is only offered to models that accept images (`supportsImages`).

The skill's instructions and references are in `server/systemSkills/pdf/`:

- `SKILL.md`: workflow and print layout rules.
- `references/layout-blocks.md`: the full block grammar.
- `references/examples.md`: complete report, invoice, letter and one-pager.

- **Forms:** the `form` layout block prints a blank or pre-filled form (`text`, `textarea`, `checkbox` and `signature` fields). To fill the interactive fields of a PDF the user uploaded, the model passes its id as `templateFileId` with `fillFormFields` (field name → value) and optionally `flattenForm` to make the result fixed. Without `fillFormFields`, `templateFileId` prints the new document on that PDF as letterhead. See [Chat files → Using a file in the document skills](chat-files.md#using-a-file-in-the-document-skills).
- **Title block:** `showTitle` turns the title block off for letters, certificates and posters that arrange their own header; `date` sets the cover-page date and the `{date}` placeholder.
- **GitHub alerts** (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) become coloured callouts, as in Word documents.

### What it cannot do (yet)

- **Edit, merge, split or extract from PDFs the user uploaded.** The model can fill in a form's fields or print a new document on an uploaded PDF as letterhead (see above), but not rewrite the pages of an existing PDF. The skill tells the user so and offers to create a new document instead.
- **Colour emoji and CJK text.** The bundled fonts (DejaVu Sans, Serif and Sans Mono) cover Latin, Greek, Cyrillic and a wide range of symbols (arrows, check marks, box drawing).
  - Common colour emoji are replaced by their monochrome counterparts (✅ becomes ✔).
  - Anything the fonts cannot draw is left out, and the tool reports it as a warning.
- **Remote images.** Images must be inline `data:` URIs. The renderer never fetches URLs.

## The `docx` skill

`create_docx` turns **Markdown** into an editable Word document:

- Markdown headings become Word headings (Heading 1–6), so the navigation pane and the table of contents work and the user can restyle the document.
- Bulleted, numbered (each list restarts at 1) and task lists, GFM tables with column alignment and a repeated header row, code blocks, quotes, GitHub alerts as shaded callouts, horizontal rules, page breaks (`\pagebreak`), links, `<sub>`/`<sup>`, and PNG/JPEG images as `data:` URIs.
- Document settings: title, subtitle, author, language, cover page, table of contents (updated by Word when the file is opened), header, footer, page numbers, page size and orientation; without a document template also a primary colour and body font.
- With a document template, the brand's styles and a footer — or the company's Word template, which the content is merged into, with its placeholders and **fields** (see [Document templates](document-templates.md#word)). The model passes the values of a template's fields in `fields`; when a required field has no value, no file is created and the model is told to ask the user.

- `showTitle`, `date` and `accentColor` work as for PDFs; with `templateFileId` the model builds on a Word file the user uploaded (`styles_only`, `fill_placeholders` or `append`, see [Document templates](document-templates.md#word)).

Not supported: footnotes, comments, tracked changes and charts (the skill suggests a table, a PDF or a presentation instead).

Enable it like the `pdf` skill: add `docx` to the app's skills.

## The `pptx` skill

`create_pptx` builds a presentation from a list of slides, passed as JSON text (`slides`):

| Field | Use |
|---|---|
| `layout` | `title`, `section`, `content` (default), `two-column`, `title-only`, `blank` |
| `title`, `subtitle` | Slide title; subtitle on title and section slides |
| `text` | Markdown: bullets, sub-bullets, numbered steps, short paragraphs, bold and italic |
| `table` | `{ "header": […], "rows": [[…]], "align": ["left", "right"] }` |
| `chart` | `{ "type": "column" \| "bar" \| "line" \| "area" \| "pie" \| "doughnut", "categories": […], "series": [{ "name", "values" }], "stacked", "showValues", "numberFormat", "title" }` |
| `image` | `{ "data": "data:image/png;base64,…", "caption" }` |
| `left`, `right` | Two-column slides: each `{ heading, text, table, chart, image }` |
| `metrics` | 1–4 KPI cards, `[{ "value": "+18 %", "label": "Revenue YoY", "note": "…" }]`, placed across the top (also inside `left` / `right`) |
| `notes` | Speaker notes |

- Slides are placed on the template's **layouts and placeholders** — the company's PowerPoint template, or iHub's built-in master made from the brand (see [Document templates](document-templates.md#powerpoint)).
- Text with a table, chart or picture on one slide is placed side by side.
- **Charts are native PowerPoint charts** with their data in an embedded workbook, so users can edit them; they use the theme's accent colours.
- Text that would overflow is shrunk (as PowerPoint's "shrink text on overflow"), and the tool warns the model when a slide is overloaded, a table was cut or an image was skipped.
- Limits: 60 slides, 30 table rows and 12 columns per slide, 12 chart series with 60 categories, 15 MB of images.

There is no slide preview for the model: rendering slides would need Office or LibreOffice on the server.

### `restyle_pptx`: an uploaded deck in the company design

`restyle_pptx` moves a `.pptx` the user uploaded onto the document template's slide master and layouts and hands the result back as a download. The deck is not rebuilt from text: its pictures, charts with their data, tables and speaker notes are carried over, titles and footers take the template's design, other content is scaled into the template's content area, and colours the deck took from its old theme follow the template's. Parameters: `fileId` (the id of the uploaded file) and `filename`; where the model may choose a template, `template`. Details and limits: [Document templates → Uploaded presentations](document-templates.md#uploaded-presentations). Use `create_pptx` to write a new deck or to rewrite a deck's text.

## The `xlsx` skill

`create_xlsx` builds a native Excel workbook from `sheets`, passed as JSON text (1–20 worksheets):

- Each sheet has a `name`, `columns` (a `header`, an optional `align` and a `format`: `currency`, `integer`, `decimal`, `percent`, `date`, `text`, or an Excel number format such as `#,##0.00 €`) and `rows` (numbers, text, ISO dates, or **live formulas** starting with `=`, which Excel recalculates on opening). A row can be `{ "cells": […], "total": true }` for a totals row.
- Row 1 is always the header row. Sheets get a frozen header and an auto-filter (switchable per sheet) and auto-fitted column widths.
- The workbook follows the [document template](document-templates.md): corporate colours and fonts, or the brand parameters `primaryColor`, `accentColor` and `font` when no template applies.
- With `sourceFileId` the model builds on an `.xlsx` the user uploaded: its sheets, styles and defined names are kept, and each sheet in `sheets` replaces the sheet of the same name or is added. See [Chat files](chat-files.md#using-a-file-in-the-document-skills).

Use the `files` skill for a plain `.csv` instead. Enable it like the other skills: add `xlsx` to the app's skills.

## The `web-artifacts` skill

`create_web_artifact` creates a single-file interactive page (`format: "html"`, the default) or a standalone vector graphic (`format: "svg"`) — a calculator, simulator, data explorer, clickable prototype, canvas visualization or diagram, written as HTML or SVG by hand. A dashboard of figures is not made here but with the [`dashboard` skill](#the-dashboard-skill). The user gets a download card, and the file opens in the chat's [workspace pane](artifacts.md#the-workspace-pane) with a **Preview | Code** toggle: HTML runs in a sandboxed frame, SVG renders as a picture. The server still stores and serves both as `text/plain` (see [Artifacts](artifacts.md#kinds)), so a downloaded file is never executed by iHub itself. Enable it by adding `web-artifacts` to the app's skills.

`edit_web_artifact` changes an artifact the chat already has instead of writing it again: the model names the file and sends exact replacements (`edits: [{ oldText, newText }]`). It works on the newest version of that file in the chat (one this turn made, or a stored one), applies every edit or none — each `oldText` must occur exactly once — runs the same checks as a new file, and stores the result as the file's new version under the same name; the earlier version stays. A fix or a small change then costs a few hundred output tokens instead of the whole file, which on a self-hosted model is the difference between seconds and a minute or more. When the model lacks the current text (the file was made in an earlier turn), it reads it with `chat_artifacts_read` first.

## The `dashboard` skill

`dashboard` turns figures into a finished page without the model writing any HTML. The model describes the page as JSON and calls its own tool, `create_dashboard`, with that JSON as `data`; the server checks it and lays it out in a fixed design (`server/systemSkills/dashboard/assets/dashboard.html`). The tool has its own name, description and result, so the run activity reads **Create dashboard** (German: **Dashboard erstellen**), not "web artifact". The file is stored like a web artifact (`text/plain`, shown in the Artifacts panel with a Preview | Code toggle). `edit_dashboard` changes one by exact replacements in its spec (the JSON `chat_artifacts_read` returns for the dashboard) and lays the page out again. The skill's instructions tell the model to build one **as soon as a tool run or an analysis has produced numbers worth looking at**, without being asked, and also when the user asks for a dashboard or charts of their data.

- **What the page holds:** a headline sentence, up to eight KPI tiles, up to 20 blocks (ranked horizontal bars with optional limit lines, line charts of up to eight series, sortable tables with status cells, short texts), a "How these numbers were made" section and a collapsed "Sources and formulas" section that each block can open from its **Source** button. Every chart has a **Table view** with the same numbers, a tooltip on hover and focus, and keyboard access.
- **Numbers come from the data.** The skill tells the model to copy every figure from a tool result or from the user's data. The page works out shares, order, the sum of a folded tail of small bars and table sorting itself, so the model does not add anything up. Bars may be negative (growth, change, margin): they run left of a zero line in their own colour; `share` is refused for negative values.
- **The server holds the rules.** Skill instructions are a tool result and do not reach a later turn, so the tool checks them itself. `create_dashboard` in a turn where the skill was neither active in the chat nor loaded with `activate_skill` is refused with guidance (nothing is created). `asOf` (the date of the data, `YYYY-MM-DD`) and at least one entry in `sources` are required. An `asOf` more than three months before today, or in the future, comes back as a `warnings` entry the model has to answer. A source can carry `ref` (document, table or tool call) and `url`, shown as text under **Sources and formulas**.
- **Looks:** light and dark colours from a validated chart palette, a phone layout, `--brand-primary` for the header rule and the app's `documentTemplate` brand colours and font through the same tokens as other web artifacts. Interface texts are built in for English and German (`lang`); the spec can carry `labels` for another language.
- **Safe by construction:** the spec is checked by one Zod schema (`server/services/documents/webArtifacts/dashboardSpec.js`) and a bad spec comes back as one message that names every field at fault (such as `blocks[1].items[3].value must be a number`), so the model fixes them in one call; at most 1 MB, and nothing in it is read as markup: the page writes every text with `textContent`, and the JSON is escaped so it cannot close its own `<script>`. The page never fetches anything and carries the same sandbox and `text/plain` storage as every web artifact.
- **Enable it** by adding `dashboard` to the app's skills (`"skills": ["dashboard"]`, `skillSettings.enabled: true`). It brings `create_dashboard` and `edit_dashboard` itself, so `web-artifacts` need not be enabled as well. With both, the `web-artifacts` skill and `create_web_artifact` send dashboards of figures to `dashboard`; in an app without it, neither mentions it. A rebuilt dashboard with the same file name replaces the earlier one.

The full field list the model reads is `server/systemSkills/dashboard/references/spec.md`.

## The `files` skill

The `files` skill hands the user files that are not office documents: source code, configuration, data and text. Enable it like the other skills (`"skills": ["files"]`).

`create_file` takes a `name` and the file's `content` (UTF-8 text):

- **The extension decides the type.** JavaScript and TypeScript, Python, Java, Kotlin, C/C++, C#, Go, Rust, Ruby, PHP, Swift, SQL, shell and PowerShell scripts, CSS/SCSS, JSON and JSON Lines, YAML, TOML, XML, INI, CSV/TSV, Markdown, plain text and more. A name without a known extension (`Dockerfile`, `Makefile`) is plain text. The optional `mimeType` counts only when the extension says nothing.
- **Folders are kept.** A name such as `src/components/Button.tsx` keeps its folders in a ZIP archive. `..` segments, drive letters, leading slashes and control characters are removed; a path has at most 10 levels and 200 characters.
- **No active content.** `.html` and `.svg` files are recorded as plain text, and every text file is served as `text/plain` (see [Artifacts](artifacts.md#kinds)).

`create_zip` packs files into one ZIP archive:

| Parameter | Use |
|---|---|
| `filename` | Archive name; `.zip` is added |
| `files` | New files: `[{ "name": "src/index.ts", "content": "…" }]` |
| `include` | Files already created in this chat, by name (`src/index.ts`, or just `index.ts` when only one file has that name) or id |
| `includeAll` | Every file created in this chat: documents and text files, not pictures or other archives. When a name occurs more than once, the newest file is packed |

A new file in `files` replaces an existing file of the same name. A name that is not found is reported back to the model together with the names that exist, so it can correct the call. Duplicate paths get a ` (2)` suffix.

The archive follows the [artifact ZIP limits](artifacts.md#configuration) (`maxZipFiles`, `maxZipBytes`). Because the archive is a generated file, it cannot be larger than 25 MB of content.

## Changing a generated document

A change to a document the chat made is an edit, not the whole document written again. The model sends only what changes, and the server renders the file again from its source:

| Tool | Changes |
| --- | --- |
| `edit_web_artifact` | Exact text replacements in the HTML or SVG (see above) |
| `edit_docx` | Exact text replacements in the Markdown (`edits`), settings such as `title`, `toc`, `coverPage`, `header`, `footer` (`set`) |
| `edit_pptx` | Slide operations (`changes`: `update`, `replace`, `insert`, `delete`, `move`), text replacements in the slide texts (`edits`), deck settings (`set`) |
| `edit_xlsx` | Sheet operations (`changes`: `setCells`, `appendRows`, `insertRows`, `deleteRows`, `replaceSheet`, `addSheet`, `deleteSheet`, `renameSheet`), text replacements in cell texts and formulas (`edits`), workbook settings (`set`) |

Every edit works on the newest version of the file in the chat, applies all its changes or none, keeps the file name, template and date, and stores the result as the file's new version; the earlier version stays in the Files list. An `oldText` must occur exactly once, so a replacement never lands in the wrong place. In Excel, formulas are not adjusted when rows move; the tool says so and the model updates the references in the same call.

**Where the source lives.** `create_docx`, `create_pptx` and `create_xlsx` embed their own arguments (the Markdown, the slides, the sheets, the settings; never the user or the chat) in the file as a Custom XML Data part, `customXml/ihubSource.xml`, related to the main part as Office relates any custom XML. It is a standard Office Open XML part that the applications do not display; it adds the size of its source to the file. Because the source travels with the file, a stored artifact and a file of the current turn are edited the same way. `chat_artifacts_read` returns this source (Markdown, or the slides or sheets as JSON) for a document the chat made, so the model can copy `oldText` from it. A document made before this, one the user uploaded, or one saved by Office without the part has no source: the edit tool says so, and the model creates the document again once.

## Generated files

A file the model created takes the path a generated picture takes. There is no download route of its own:

- **While the answer streams:** `create_pdf` keeps the PDF in server memory and returns only a descriptor, so the model never sees the bytes. As soon as the tool finishes, the file is stored as an [artifact](artifacts.md) of the chat: kind `document` for PDF, Word, PowerPoint and Excel, `code` for a text file (HTML and SVG included), `archive` for a ZIP. The tool's `tool/completed` event carries only the download card — name, type, size, pages or slides — and the card fetches the file from `GET /api/chats/:chatId/artifacts/:artifactId` when it is opened or downloaded. A file the model writes again under the same name replaces the earlier one when the answer is stored.
- **Stored with the answer:** in a stored chat (every chat is), the answer names the file's artifact, so the card works the same after a reload. It is deleted with the chat, and a [share](chat-sharing.md) of the chat includes it.
- **Files that cannot be stored:** in a chat that is not stored, with artifacts turned off (`platform.artifacts.enabled: false`) or over the artifact size cap, the bytes still reach the card with `tool/completed`. The file then lives as long as the page, like a generated picture; after a reload the card says it is no longer available.
- **Limits:**
  - 25 MB per file.
  - Storing follows the artifact settings (`platform.artifacts`: `maxBytes`, default 10 MB, and `maxPerBatch`). A file over the cap is still downloadable while the answer is on screen; its stored card says it was not kept.
- **Preview:** `preview_pdf` reads the PDF from the server's memory. That works for PDFs created in the same chat within the last hour.
- **Files index:** every file of the chat is also listed in the chat's [workspace pane](artifacts.md#the-workspace-pane), with a preview, and can be downloaded alone or together with others as one ZIP.
- **Types:** PDF, Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`), HTML and SVG from `create_web_artifact`, text files from `create_file` and ZIP archives from `create_zip`. The card shows the page or slide count while the answer is on screen. A text file is saved under the last part of its name (`src/index.js` → `index.js`).
- **Many files in one turn:** `maxPerBatch` (default 8) also caps how many generated files one answer stores. For a project, the `files` skill tells the model to use one `create_zip` call instead of one `create_file` call per file.

## Server-side PDF export

`POST /api/exports/pdf` renders a PDF and returns it as the response (`Content-Disposition: attachment`). Nothing is stored.

| `kind` | Body | Used by |
|---|---|---|
| `chat` | `messages` (`role`, `content`, `timestamp`), `settings`, `title`, `appName`, `appId`, `template`, `watermark`, `language`, `timeZone`, `filename` | Chat export dialog, single-message download |
| `markdown` | `markdown`, `title`, `template`, `language`, `filename` | Workflow output download menu, agent artifact downloads |

- **Templates:** the [document templates](document-templates.md) (listed in the dialog as **Company templates**, the default one preselected), and the built-in `default`, `professional` and `minimal` designs. An app that pins a document template always exports with it.
- **Watermark:** a small label at the bottom left, centre or right of every page, with the chosen opacity.
- **Defaults:** [`platform.pdfExport`](platform.md#pdfexport) supplies the export dialog's default template and watermark, and the server's default when a request sends none.
- **Access:**
  - Chat exports follow the **Export** feature (platform) and the app's `features.export`.
  - Markdown exports are plain downloads and were never behind that switch.
- **Limits:**
  - Chat exports: 2,000 messages and 8 million characters.
  - Rate limit: 30 exports per minute per client.

The PDF export is the base the planned signed exports build on (EU AI Act content marking).

## How rendering works

- **Engine:** [pdfmake](https://pdfmake.github.io/) (MIT, pure JavaScript, on top of pdfkit) lays out and renders the document.
  - [pdf-lib](https://pdf-lib.js.org/) re-reads every result as a validity check.
  - pdfium (WASM) renders the page previews.
  - No Python, no Chromium and no system packages are needed, so it works in the Alpine Docker image and in the single-binary build.
- **Print layout:** Markdown written for the screen is tidied for paper.
  - A first heading that only repeats the printed title is left out, so the title is not printed twice. With a cover page or a table of contents the title is not above the body, and the heading stays.
  - Horizontal rules (`---`) at the start or end of the body, doubled rules, and rules next to a heading that draws its own rule are left out.
  - A heading never ends a page. It moves to the next page when fewer than two lines of what follows it would stay with it. Every such move lays the document out again, so a very long document gets fewer of them.
- **Word and PowerPoint:** the [docx](https://docx.js.org/) library writes Word documents; presentations are written as PresentationML into the template package, with [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) creating the chart parts. Every result is unpacked and every XML part parsed again before it is handed out.
- **Isolation:** each document (PDF, Word or PowerPoint) is laid out and rendered in its own **worker thread**:
  - 45-second time budget (90 seconds for exports)
  - 512 MB memory cap
  - at most two documents at once per server process (all formats together), and up to 20 waiting
  - A pathological layout fails with an error; it never blocks the server.
- **Untrusted layouts:** model-authored layout blocks pass an allowlist sanitiser.
  - Every node type and property is checked; unknown ones are dropped with a warning.
  - Images must be PNG/JPEG `data:` URIs whose bytes match their type.
  - SVG loses scripts, foreign objects and external images; the SVG renderer's image loader only accepts `data:` URIs as well. Every link attribute is checked, `href` and `xlink:href` alike: a link keeps only `http(s):`/`mailto:` targets, and other references must stay inside the SVG (`#id`).
  - Links must be `http(s):` or `mailto:`. Fonts are limited to the bundled families. Colours are hex values or CSS colour names; anything else is ignored.
  - Size limits: 50,000 layout elements, 5 MB per image, 15 MB of images per document, 500 pages.
  - The renderer's file and URL access policies deny everything. Fonts are loaded from memory.

## Adding a system skill (developers)

1. Create `server/systemSkills/<name>/SKILL.md` (frontmatter `name`, `description`, `allowed-tools`), plus `references/` as needed.
2. Define the tools as plain data (compare `server/services/documents/pdf/pdfToolDefinitions.js`) and register them in `server/services/systemSkillTools.js`, with a handler that is loaded when the tool runs. A tool that renders in a document template sets `usesDocumentTemplate: true` and lists its `brandParameters`, which are dropped when an app pins a template.
3. Render in the worker: add the format to `server/services/documents/documentWorker.js` and call `renderInWorker(format, { spec, assets })` (`server/services/documents/renderService.js`).
4. A tool that produces a file holds it with `holdGeneratedFile()` (`server/services/documents/generatedFiles.js`) and returns the descriptor in `files`. The chat stores the file as an artifact of the chat when the tool finishes and sends the download card its descriptor; the card fetches the bytes when it is opened. Add the file's media type to `GENERATED_FILE_TYPES`, to `shared/generatedFiles.js` and, if it is new, to the `document` kind in `server/services/artifacts/artifactPolicy.js`.
