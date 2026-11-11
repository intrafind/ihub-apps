# Document Templates (Corporate Design)

A **document template** is your company's corporate design for the files iHub creates: PDFs, Word documents, PowerPoint presentations and Excel workbooks. Every document a model creates with the [`pdf`, `docx`, `pptx` and `xlsx` system skills](pdf-generation.md) (the `web-artifacts` skill takes the brand colours and font as CSS variables), and every PDF export of a chat or Markdown, uses it — so all documents look the same, whoever asked for them.

Admins manage templates under **Admin → Customization → Document templates**.

## What a template holds

| Part | Used for | Notes |
|---|---|---|
| **Brand**: primary, accent and text colour | PDF, Word, PowerPoint | Headings, table headers, bullets, chart colours |
| **Brand**: heading and body font, body size | PDF, Word, PowerPoint | `sans`, `serif`, an uploaded font, or a font name installed on your computers |
| **Brand**: company name | PDF, Word, PowerPoint | Author of documents without one; `{company}` in headers and footers |
| **Logo** (PNG or JPEG) | PDF, Word, PowerPoint | Header (left or right) and cover pages; title slide and master of the built-in slide design |
| **Fonts** (`.ttf`/`.otf`, one file per style) | PDF | PDFs embed their fonts. Check that your font licence allows embedding |
| **Page, header and footer** | PDF, Word | Page size, orientation, margins, header and footer text, page numbers |
| **Letterhead** (PDF) | PDF | Printed under every page: first page, and following pages |
| **Word template** (`.dotx`/`.docx`) | Word | Styles, headers, footers, page setup, theme |
| **PowerPoint template** (`.potx`/`.pptx`) | PowerPoint | Slide masters and layouts, theme, logos, backgrounds |

Each part is optional. A template with only colours and a logo already gives every format a consistent look; adding the company's Word and PowerPoint templates makes generated files indistinguishable from hand-made ones.

**Placeholders** in header and footer texts: `{title}`, `{date}`, `{page}`, `{pages}`, `{company}`. An empty header or footer means none.

## Which template a document gets

1. **The app's template** (**Admin → Apps → Edit → Document template**, `documentTemplate` in the app config). The app's documents always use it; the model cannot pick another one, and the export dialog shows it as fixed.
2. Otherwise **the template the model or the user picked**. The tools offer a `template` parameter listing the enabled templates, and the export dialog lists them under **Company templates**.
3. Otherwise **the default template** (one template can be marked as default).
4. Otherwise iHub's built-in design.

Where a template says something, it wins over what the model asks for: colours, fonts, logo, page setup, header and footer, letterhead. When an app pins a template, the tools do not even offer the model the colour, theme and font parameters.

## PDF

- **Base design:** `default`, `professional` or `minimal`, plus the brand colours and fonts.
- **Logo** in the header, left or right, at the configured width (scaled down to fit the top margin), and larger on cover pages.
- **Fonts:** upload the brand fonts and use their family names as heading and body font. Without an upload, a font name such as `Arial` maps to the closest bundled font (DejaVu Sans, Serif, Mono). Characters a brand font lacks are drawn in DejaVu Sans.
- **Letterhead:** a PDF with your stationery (logo, address block, footer lines). Its first page is printed under the first page of the document; the **following pages** letterhead — or, without one, the letterhead's second page, or else its first page again — under the others. A cover page gets no letterhead. The letterhead is drawn *beneath* the text, from its trim box (so a file exported with bleed is not shrunk), and scaled evenly and centred if the sizes differ. Set the margins so the text stays clear of the letterhead's logo and address block. With a letterhead, page size and orientation are the template's — or, when the template sets none, the letterhead's own format.

## Word

**Without a Word template**, iHub builds the document's styles from the brand: fonts, colours, heading sizes, a header with the logo and header text, a footer with footer text and "Page X of Y", and an optional cover page.

**With a Word template** (`.dotx` or `.docx`), the generated content is merged into it:

- The template's **styles** format the content. Styles are matched by Word's built-in names (`heading 1`, `Title`, `List Paragraph`, `Quote`, …), so templates saved by a German, French or any other Word work — their style ids differ, the names do not. Styles the template lacks are added; headings among them use the template's theme fonts and accent colour.
- The template's **headers, footers, page size and margins** stay as they are.
- **Where the content goes:** at a paragraph that holds only `{{content}}`. Without one, after the template's own text — or, when the template body is empty (the usual `.dotx`), as the whole body.
- **Placeholders** `{{title}}`, `{{subtitle}}`, `{{author}}`, `{{date}}` and `{{company}}` are filled in the body, headers and footers — also when Word split them into several runs while you typed them. When the template has `{{title}}`, iHub does not add a title or cover page of its own.
- A table of contents is updated by Word when the document is opened (Word asks for confirmation).
- Templates with macros (`vbaProject.bin`) are refused.

## PowerPoint

For how the template file itself should be built — layouts, placeholders, theme, text slots — and a brief to hand to the people who maintain it, see the [PowerPoint Template Guide](powerpoint-template-guide.md).

Presentations are always built by **filling a template**: your PowerPoint template, or iHub's built-in one made from the brand (a master with an accent bar, the logo, footer and slide number, and title, section, content, two-content, title-only and blank layouts).

- Every slide uses one of the template's **layouts**, and titles and text go into the layout's own **placeholders** — so fonts, sizes, colours, bullets, logos and backgrounds come from the template, and users can switch layouts in PowerPoint as usual.
- **Layouts are chosen** by their type (`title`, `secHead`, `obj`, `twoObj`, `titleOnly`, `blank`), then by their placeholders, then by their name. After uploading, the editor lists the template's layouts and the one chosen for each kind of slide; pick another one where the choice does not fit.
- **Tables, charts and pictures** are placed in the layout's content area. Tables use the template's accent colour; charts are native, editable PowerPoint charts in the theme's accent colours and body font.
- **Sample slides** in the template file are not copied. Neither are custom shows and sections that refer to them.
- **Footer and slide numbers:** set them in the template (**Slide footer**, **Slide numbers**). They appear on every slide but the title slide, where the layout has a footer or slide number placeholder.
- **Text slots:** besides its title and content, a slide can fill **text slots** of its layout: a short label above the title (`kicker`), one sentence under it (`lead`), the presenter on a title slide. A slot is a text placeholder of a layout that the document template names. The model is told which slots the template has, where each one is (above or below the title, bottom left …) and how much text fits, and passes the text in the slide field `slots`: `{ "kicker": "VISION 2027", "lead": "One sentence of context." }`.
  - **Declaring slots:** in the editor (**PowerPoint → Text slots**) or `pptx.slots` of `template.json`, give each slot an id, the **name of its placeholder** in the layouts (PowerPoint's Selection Pane; compared without regard to case, in any language), what to put in it (shown to the model, per language) and what to do in a layout without it. Any text placeholder can be a slot, also on a title or section layout.
  - **Found in your template:** the editor lists small text placeholders with a name of their own that are not slots yet (not the ones named like PowerPoint's defaults, such as "Content Placeholder 3", and not the subtitle of a title or section layout). **Add as slot** takes the placeholder's name, an id made from it and the text the template author typed into the placeholder as the description. Nothing is declared until the admin adds it.
  - **Without declaring:** a body placeholder named `Kicker` or `Eyebrow` is the slot `kicker`, one named `Lead`, `Einleitung` or `Teaser` is `lead`.
  - **Layout choice:** a slide that fills slots uses the layout of its kind that has most of them, then the fewest others; slides without slots keep the layout chosen for their kind. Slots are no content areas. Give the placeholders their own font size, colour and no bullet in the layout, and leave room for them between the title and the content area.
  - **Without a slot in the layout:** the text is left out (`ifMissing: "drop"`, the default, and for `kicker`) or becomes the first paragraph of the slide's text (`"text"`, the default for `lead`; on a title or section slide the subtitle; not on title-only and blank slides). A slot id the template does not have is ignored and reported in the tool's `warnings`.
- **Title slide strip:** a title layout whose footer placeholder holds text (for example the company name) shows that text on every title slide, or the title slide's own `footer`, such as `Strategy 2027 · November 2026`. A placeholder with a white fill hides a static text of the layout underneath it. The footer text set in the template applies to the other slides only.
- **What the model knows:** the description of `create_pptx` lists the slots of the template that applies (the app's, else the default one) with where they are and how much fits, and what each slide type (`layout`) has: title, subtitle, content areas, slots, the footer strip. It is built from the uploaded PowerPoint file, so it follows the template when it changes.
- **KPI cards** (`metrics`) are light neutral cards (the theme's `lt2`) with the theme's dark text colour (`dk2`) and a rule across the top in the first accent colour that is not a grey, so a theme whose accent 1 is grey still gets colourful cards.
- **Speaker notes** use the template's notes master; a template without one gets a plain one.
- Without a PowerPoint template, choose the **slide format** (16:9 or 4:3).
- **The whole design belongs in the template.** A cover photo, edge strips, logos, a footer bar, background pictures and a coloured title slide are shapes and backgrounds of the master and its layouts (`Titelfolie`, `Titel und Inhalt`, …); every deck built on the template gets them, and nothing else has to be set up in iHub.

### Uploaded presentations

A user can upload a `.pptx` made elsewhere and ask for it in the company design. The `restyle_pptx` tool of the `pptx` skill moves the deck onto the template's master and layouts (or, without a PowerPoint template, onto iHub's built-in design made from the brand) and keeps its content:

- **Layout.** Each slide gets the template's layout for its kind (title, section, content, two content, title only, blank), judged from the layout it had.
- **Titles, subtitles, footers and slide numbers** take the template's placeholders, so their positions, fonts and colours are the template's. The template's footer text and slide numbers are added where the slide has none (not on the title slide).
- **Text alone on a slide** takes the template's content placeholder.
- **Everything else** (pictures, charts, tables, text boxes, groups, and text next to them) keeps its arrangement: the shapes are scaled together, by one factor, into the template's content area. Decks of another size (4:3 to 16:9) are fitted the same way. Text shrinks with a shape that shrinks.
- **Kept:** pictures, charts with their data, tables, speaker notes, links, transitions. **Dropped:** slide backgrounds, review comments and the old master, layouts and theme.
- **Colours** the deck took from its old theme (accent colours, text and background colours) follow the template's theme, also inside charts. A colour or font a shape sets itself stays as it is.

It is a move onto a new master, not a redesign: slides with several pictures or tight arrangements can need a look afterwards. The tool reports a slide whose content had to shrink below half its size, and a slide with a shape that cannot be moved (an equation, ink or a 3-D model: it stays where it was). To rewrite a deck instead (new titles, fewer words), use `create_pptx`: the deck is rebuilt from its text, and its pictures are not carried over.

## Excel

Workbooks from the `xlsx` skill take the brand colours and font of the template for header rows, totals and accents; the logo, letterhead and Word/PowerPoint files do not apply. Without a template the model can pass a brand colour, accent colour and font.

## Using a file the user uploaded

A user can also attach a Word, PowerPoint, PDF or Excel file to a chat and ask the model to build on it — as styles for a new document, to fill placeholders, or to fill in a PDF form. This is separate from the company's templates; an app that **pins** a document template keeps it unless the app sets `allowUserTemplateUploads`. See [Chat files → Using a file in the document skills](chat-files.md#using-a-file-in-the-document-skills).

## Fonts in Word and PowerPoint files

Word and PowerPoint files **name** their fonts; the computer that opens them draws them. A brand font must be installed there, otherwise Word and PowerPoint substitute a similar one. `sans`, `serif` and `mono` map to Calibri, Cambria and Consolas.

## Previews

The editor's **Preview** renders sample documents with the saved template: the first page of a sample PDF in the page, and a sample PDF, Word document and presentation to download. Pending changes are saved first.

## Storage and API

Templates live in `contents/document-templates/<id>/`: `template.json` and the files it names (`logo.png`, `letterhead.pdf`, `letterhead-following.pdf`, `word-template.dotx`, `powerpoint-template.potx`, `font-<family>-<style>.ttf`). Files are checked when they are uploaded — images, fonts and PDFs are parsed; Word and PowerPoint files are unpacked with limits on the unpacked size (enforced while unpacking, not taken from what the archive declares), and refused when they contain macros.

| Endpoint | |
|---|---|
| `GET /api/admin/document-templates` | Every template |
| `POST /api/admin/document-templates` | Create one (`id`, `name`, …) |
| `GET/PUT/DELETE /api/admin/document-templates/:id` | Read (with what its Office templates hold), save the settings, delete. A save keeps the stored files: files are only added or removed through the file endpoints |
| `POST/DELETE /api/admin/document-templates/:id/files/:slot` | Upload (multipart `file`) or remove a file. Slots: `logo`, `font` (with `family` and `face`), `letterhead`, `letterheadFollowing`, `wordTemplate`, `powerpointTemplate` |
| `POST /api/admin/document-templates/:id/sample/:format` | A sample `pdf`, `png`, `docx` or `pptx` |
| `GET /api/document-templates` | Enabled templates for the export dialog (signed-in users); with `appId`, also the template that app pins |

Template ids use `a-z`, `0-9` and `-`. `default`, `professional`, `minimal` and `new` are reserved.

### template.json

```json
{
  "id": "acme",
  "name": { "en": "ACME corporate design", "de": "ACME Unternehmensdesign" },
  "enabled": true,
  "default": true,
  "brand": {
    "primaryColor": "#E30613",
    "accentColor": "#374151",
    "textColor": "#1F2937",
    "headingFont": "Frutiger",
    "bodyFont": "Frutiger",
    "fontSize": 10.5,
    "logo": "logo.png",
    "companyName": "ACME GmbH"
  },
  "fonts": [{ "family": "Frutiger", "normal": "font-frutiger-normal.ttf", "bold": "font-frutiger-bold.ttf" }],
  "document": {
    "pageSize": "A4",
    "margins": [56, 90, 56, 70],
    "header": "{title}",
    "footer": "{company} · Confidential",
    "pageNumbers": true,
    "logoPosition": "header-right",
    "logoWidth": 90
  },
  "pdf": { "theme": "professional", "letterhead": "letterhead.pdf" },
  "docx": { "template": "word-template.dotx" },
  "pptx": {
    "template": "powerpoint-template.potx",
    "footer": "{company}",
    "slideNumbers": true,
    "layouts": { "content": "Titel und Inhalt" },
    "slots": {
      "kicker": {
        "placeholder": "Kicker",
        "description": { "en": "Chapter or topic, in capitals", "de": "Kapitel oder Thema" },
        "ifMissing": "drop"
      },
      "presenter": { "placeholder": "Referent", "description": { "en": "Name of the speaker" } }
    }
  }
}
```
