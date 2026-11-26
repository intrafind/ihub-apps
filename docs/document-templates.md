---
description: "Apply your corporate design to the documents iHub creates."
audience: admin
type: how-to
adminPage: /admin/document-templates
---

# Document Templates

A **document template** is your company's corporate design for the files iHub creates: PDFs, Word documents, PowerPoint presentations and Excel workbooks. Every document a model creates with the [`pdf`, `docx`, `pptx` and `xlsx` system skills](pdf-generation.md) (the `web-artifacts` skill takes the brand colours and font as CSS variables), and every PDF export of a chat or Markdown, uses it — so all documents look the same, whoever asked for them.

Admins manage templates under **Admin → Customization → Document templates**.

## What a template holds

The design of a template lives in **its Word and PowerPoint files**. The template itself holds only what a file cannot:

| Part | Used for | Notes |
|---|---|---|
| **Word template** (`.dotx`/`.docx`) | Word, and the page of PDFs | Styles, headers and footers (logo, letterhead, page numbers), page setup, theme, `{{placeholders}}` |
| **PowerPoint template** (`.potx`/`.pptx`) | PowerPoint | Slide masters and layouts, theme, logos, backgrounds, footers, slide numbers |
| **Company name** | All formats | Author of documents without one, `{{company}}`, the footer of PDFs |
| **Primary, accent and text colour** | PDF, Excel, charts, web pages; Word and PowerPoint where no file sets them | Read from the themes of the files; set one here only to override it |
| **PDF margins** | PDF | Left, top, right, bottom in points; prefilled from the Word template |
| **Fields** | Word | Placeholders of your own, such as `{{classification}}` |

Every part is optional. A template with only a company name and colours already gives every format a consistent look; the Word and PowerPoint templates make generated files indistinguishable from hand-made ones.

**Colours, palette and fonts are resolved, not copied.** Each value is the template's own value if one is set, else the theme of the PowerPoint template, else the theme of the Word template, else a neutral default. (A Word document follows the Word template's theme first, so the content matches the template's styles.) The **palette** (up to six colours, greys last) and the **heading and body font** are always read from the files and cannot be edited; the editor shows each value with its source ("From the PowerPoint template"). The model is told the colours, the palette, the font names and the template's fields. A font is only a name: it must be installed on the computers that open Word and PowerPoint files, and web artifacts use a fallback stack.

**Take colours from this file:** on the editor page, a button next to the colour fields copies the primary, accent and text colour of the Word or PowerPoint template's theme into the fields (unsaved until you save). The primary colour is the first theme accent that is a real colour rather than a grey; the accent colour is the next accent that clearly differs from it; the text colour is the theme's dark text colour.

## Which template a document gets

1. **The app's template** (**Admin → Apps → Edit → Document template**, `documentTemplate` in the app config). The app's documents always use it; the model cannot pick another one, and the export dialog shows it as fixed.
2. Otherwise **the template the model or the user picked**. The tools offer a `template` parameter listing the enabled templates, and the export dialog lists them under **Company templates**.
3. Otherwise **the default template** (one template can be marked as default).
4. Otherwise iHub's built-in design.

Where a template says something, it wins over what the model asks for: its colours, the styles, headers, footers and page setup of its Word template, the layouts of its PowerPoint template. What a template leaves open stays with the model (for example a landscape page for a wide table). When an app pins a template, the tools do not offer the model the colour, theme and font parameters.

## PDF

PDFs are made by iHub's own PDF engine, not from the Word template, because the server has no Office renderer. A PDF therefore carries the brand through its colours, its page and a footer:

- **Colours** of headings, table headers and bullets from the resolved brand; **fonts** are the bundled ones (DejaVu Sans, Serif and Sans Mono). A font name such as `Arial` maps to the closest bundled font.
- **Page:** the size and orientation of the Word template's last section (else A4 portrait), and the **margins**. The margins are the template's own (**Word template → Margins**), else those of the Word template, else 50, 62, 50, 62 points. The editor shows the four values with their source and prefills them from the Word template; **Use the Word template's margins** takes your own values back. The engine keeps at least 36 points at the top and bottom, where the header and footer sit.
- **Footer:** the company name and "Page X of Y".
- **No letterhead, no logo, no uploaded fonts.** A letterhead belongs in the first-page header of the Word template. To get the design of the Word template exactly, create a Word document (`create_docx`).

The chat export's built-in **default, professional and minimal** designs (without a template) are separate from document templates: see [PDF export](pdf-generation.md#server-side-pdf-export).

## Word

**Without a Word template**, iHub builds the document's styles from the brand: fonts, colours, heading sizes, a footer with the company name and "Page X of Y", and an optional cover page.

**With a Word template** (`.dotx` or `.docx`), the generated content is merged into it:

- The template's **styles** format the content. Styles are matched by Word's built-in names (`heading 1`, `Title`, `List Paragraph`, `Quote`, …), so templates saved by a German, French or any other Word work — their style ids differ, the names do not. Styles the template lacks are added; headings among them use the template's theme fonts and accent colour.
- The template's **headers, footers, first-page header, page size and margins** stay as they are. This is where the logo and the letterhead go.
- **Where the content goes:** at a paragraph that holds only `{{content}}`. Without one, after the template's own text — or, when the template body is empty (the usual `.dotx`), as the whole body.
- **A table of contents** goes at a paragraph that holds only `{{toc}}`. Without one, `toc: true` puts it at the start of the content. Word fills it when the user confirms the update-fields prompt on opening; viewers that do not update fields show it empty.
- Templates with macros (`vbaProject.bin`) are refused.

### Placeholders

All placeholders are `{{name}}`, typed as plain text in the body, headers and footers of the Word file (also when Word split them into several runs while you typed). A name is a letter followed by letters, digits or underscores, up to 32 characters, without regard to case.

| Placeholder | Filled with |
|---|---|
| `{{content}}` | The generated content (a paragraph of its own) |
| `{{toc}}` | A table of contents (a paragraph of its own) |
| `{{title}}`, `{{subtitle}}` | The document's title and subtitle. When the template has `{{title}}`, iHub does not add a title or cover page of its own |
| `{{author}}` | The author, else the name of the signed-in user |
| `{{date}}`, `{{year}}` | The date (today unless given) and its year |
| `{{company}}` | The template's company name |
| `{{page}}`, `{{pages}}` | Word's page number and page count (real fields, so Word counts) |
| anything else | A **field** of the template |

### Fields

A field is any `{{name}}` that is not built in: `{{classification}}`, `{{department}}`, `{{version}}`, `{{docId}}`. Uploading a Word template declares the fields it contains, as optional free text, so nothing is ever printed with its braces; a Word template with more than 50 different fields is refused. In **Fields** you give each one a **label**, a **description** (told to the model), a list of **allowed values**, a **default** and whether it is **required**. A declared field that the Word template no longer contains is shown with a warning.

The model is told each template's fields (in the description of `create_docx` and of its `template` parameter) and passes values in the `fields` argument. Author, date, year and company are never asked for. When a **required** field has no value and no default, or a value is not one of the allowed values, `create_docx` creates no file: it reports the missing fields and tells the model to **ask the user and not to invent a value**. `edit_docx` can change one field and keeps the others. Fields exist for Word only; PowerPoint has none.

## PowerPoint

For how the template file itself should be built — layouts, placeholders, theme, text slots — and a brief to hand to the people who maintain it, see the [PowerPoint Template Guide](powerpoint-template-guide.md).

Presentations are always built by **filling a template**: your PowerPoint template, or iHub's built-in one made from the brand colours (a master with an accent bar, the footer and slide number, and title, section, content, two-content, title-only and blank layouts).

- Every slide uses one of the template's **layouts**, and titles and text go into the layout's own **placeholders** — so fonts, sizes, colours, bullets, logos and backgrounds come from the template, and users can switch layouts in PowerPoint as usual.
- **Layouts are chosen automatically** by their type (`title`, `secHead`, `obj`, `twoObj`, `titleOnly`, `blank`), then by their placeholders, then by their name. After uploading, the editor lists the layout found for each kind of slide and the slide format; to change a choice, change the template (name or type of the layout). Slide size and format come from the template.
- **Tables, charts and pictures** are placed in the layout's content area. Tables use the template's accent colour; charts are native, editable PowerPoint charts in the theme's accent colours and body font.
- **Sample slides** in the template file are not copied. Neither are custom shows and sections that refer to them.
- **Footer and slide numbers** come from the layout's own placeholders: a slide number on every slide that has a slide-number placeholder (the model can turn them off), and footer text where the model passes `footer` and the layout has a footer placeholder. Neither is set on the template page.
- **Text slots:** besides its title and content, a slide can fill **text slots** of its layout: a short label above the title (`kicker`) and one sentence under it (`lead`). A slot is a body placeholder of a layout that is **named** `Kicker` or `Eyebrow` (kicker), or `Lead`, `Einleitung` or `Teaser` (lead) — name them in PowerPoint's Selection Pane; the editor lists the slots it found. The model is told which slots the template has, where each one is (above or below the title, bottom left …) and how much text fits, and passes the text in the slide field `slots`: `{ "kicker": "VISION 2027", "lead": "One sentence of context." }`.
  - **Layout choice:** a slide that fills slots uses the layout of its kind that has most of them, then the fewest others; slides without slots keep the layout chosen for their kind. Slots are no content areas. Give the placeholders their own font size, colour and no bullet in the layout, and leave room for them between the title and the content area.
  - **Without a slot in the layout:** a `kicker` is left out; a `lead` becomes the first paragraph of the slide's text (on a title or section slide the subtitle; not on title-only and blank slides). A slot id the template does not have is ignored and reported in the tool's `warnings`.
- **Title slide strip:** a title layout whose footer placeholder holds text (for example the company name) shows that text on every title slide, or the title slide's own `footer`, such as `Strategy 2027 · November 2026`. A placeholder with a white fill hides a static text of the layout underneath it.
- **What the model knows:** the description of `create_pptx` lists the slots of the template that applies (the app's, else the default one) with where they are and how much fits, and what each slide type (`layout`) has: title, subtitle, content areas, slots, the footer strip. It is built from the uploaded PowerPoint file, so it follows the template when it changes.
- **KPI cards** (`metrics`) are light neutral cards (the theme's `lt2`) with the theme's dark text colour (`dk2`) and a rule across the top in the first accent colour that is not a grey, so a theme whose accent 1 is grey still gets colourful cards.
- **Speaker notes** use the template's notes master; a template without one gets a plain one.
- Without a PowerPoint template, the model can choose the **slide format** (16:9 or 4:3).
- **The whole design belongs in the template.** A cover photo, edge strips, logos, a footer bar, background pictures and a coloured title slide are shapes and backgrounds of the master and its layouts (`Titelfolie`, `Titel und Inhalt`, …); every deck built on the template gets them, and nothing else has to be set up in iHub.

### Uploaded presentations

A user can upload a `.pptx` made elsewhere and ask for it in the company design. The `restyle_pptx` tool of the `pptx` skill moves the deck onto the template's master and layouts (or, without a PowerPoint template, onto iHub's built-in design made from the brand) and keeps its content:

- **Layout.** Each slide gets the template's layout for its kind (title, section, content, two content, title only, blank), judged from the layout it had.
- **Titles, subtitles, footers and slide numbers** take the template's placeholders, so their positions, fonts and colours are the template's. Slide numbers are added where the slide has none and the template's layout has a slide-number placeholder (not on the title slide).
- **Text alone on a slide** takes the template's content placeholder.
- **Everything else** (pictures, charts, tables, text boxes, groups, and text next to them) keeps its arrangement: the shapes are scaled together, by one factor, into the template's content area. Decks of another size (4:3 to 16:9) are fitted the same way. Text shrinks with a shape that shrinks.
- **Kept:** pictures, charts with their data, tables, speaker notes, links, transitions. **Dropped:** slide backgrounds, review comments and the old master, layouts and theme.
- **Colours** the deck took from its old theme (accent colours, text and background colours) follow the template's theme, also inside charts. A colour or font a shape sets itself stays as it is.

It is a move onto a new master, not a redesign: slides with several pictures or tight arrangements can need a look afterwards. The tool reports a slide whose content had to shrink below half its size, and a slide with a shape that cannot be moved (an equation, ink or a 3-D model: it stays where it was). To rewrite a deck instead (new titles, fewer words), use `create_pptx`: the deck is rebuilt from its text, and its pictures are not carried over.

## Excel

Workbooks from the `xlsx` skill take the resolved brand colours and the body font of the template for header rows, totals and accents; the Word and PowerPoint files themselves do not apply. Without a template the model can pass a brand colour, accent colour and font.

## Using a file the user uploaded

A user can also attach a Word, PowerPoint, PDF or Excel file to a chat and ask the model to build on it — as styles for a new document, to fill placeholders, or to fill in a PDF form. This is separate from the company's templates; an app that **pins** a document template keeps it unless the app sets `allowUserTemplateUploads`. See [Chat files → Using a file in the document skills](chat-files.md#using-a-file-in-the-document-skills).

## Fonts

A template has no font settings: the heading and body font are those of the theme of its PowerPoint (else Word) file, shown read-only in the editor. Word and PowerPoint files **name** their fonts and the computer that opens them draws them, so a brand font must be installed there, otherwise Word and PowerPoint substitute a similar one. PDFs use the bundled fonts, and Excel files the body font's name.

## Previews

The editor's **Preview** renders sample documents with the saved template: the first page of a sample PDF in the page, and a sample PDF, Word document and presentation to download. Pending changes are saved first.

## Storage and API

Templates live in `contents/document-templates/<id>/`: `template.json` and the two files it names (`word-template.dotx`, `powerpoint-template.potx`). Files are checked when they are uploaded — Word and PowerPoint files are unpacked with limits on the unpacked size (enforced while unpacking, not taken from what the archive declares), and refused when they contain macros.

| Endpoint | |
|---|---|
| `GET /api/admin/document-templates` | Every template |
| `POST /api/admin/document-templates` | Create one (`id`, `name`, …) |
| `GET/PUT/DELETE /api/admin/document-templates/:id` | Read (with what its Office templates hold and `resolved`: the brand and the PDF margins with their sources), save the settings, delete. A save keeps the stored files: files are only added or removed through the file endpoints |
| `POST/DELETE /api/admin/document-templates/:id/files/:slot` | Upload (multipart `file`) or remove a file. Slots: `wordTemplate`, `powerpointTemplate` |
| `POST /api/admin/document-templates/:id/files/:slot/_read-brand` | The colours and fonts of the theme of that file, for "Take colours from this file". Saves nothing |
| `POST /api/admin/document-templates/:id/sample/:format` | A sample `pdf`, `png`, `docx` or `pptx` |
| `GET /api/document-templates` | Enabled templates for the export dialog (signed-in users); with `appId`, also the template that app pins |

Template ids use `a-z`, `0-9` and `-`. `default` and `new` are reserved.

### template.json

```json
{
  "id": "acme",
  "name": { "en": "ACME corporate design", "de": "ACME Unternehmensdesign" },
  "enabled": true,
  "default": true,
  "brand": {
    "companyName": "ACME GmbH",
    "primaryColor": "#E30613",
    "accentColor": "#374151",
    "textColor": "#1F2937"
  },
  "docx": { "template": "word-template.dotx" },
  "pptx": { "template": "powerpoint-template.potx" },
  "pdf": { "margins": [71, 71, 71, 57] },
  "fields": {
    "classification": {
      "label": { "en": "Classification", "de": "Klassifizierung" },
      "description": { "en": "How sensitive the document is" },
      "required": true,
      "options": ["public", "internal", "confidential"],
      "default": "internal"
    }
  }
}
```

The colours are optional overrides (read from the files when unset). The schema is strict: a `template.json` with settings that no longer exist (a logo, fonts, `document`, `pdf.theme`, a letterhead, `pptx.layouts`, `pptx.slots` …) is refused. [Migration V265](configuration-migrations.md) removes them from existing templates on startup.
