# Document Templates (Corporate Design)

A **document template** is your company's corporate design for the files iHub creates: PDFs, Word documents and PowerPoint presentations. Every document a model creates with the [`pdf`, `docx` and `pptx` system skills](pdf-generation.md), and every PDF export of a chat or Markdown, uses it — so all documents look the same, whoever asked for them.

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

Presentations are always built by **filling a template**: your PowerPoint template, or iHub's built-in one made from the brand (a master with an accent bar, the logo, footer and slide number, and title, section, content, two-content, title-only and blank layouts).

- Every slide uses one of the template's **layouts**, and titles and text go into the layout's own **placeholders** — so fonts, sizes, colours, bullets, logos and backgrounds come from the template, and users can switch layouts in PowerPoint as usual.
- **Layouts are chosen** by their type (`title`, `secHead`, `obj`, `twoObj`, `titleOnly`, `blank`), then by their placeholders, then by their name. After uploading, the editor lists the template's layouts and the one chosen for each kind of slide; pick another one where the choice does not fit.
- **Tables, charts and pictures** are placed in the layout's content area. Tables use the template's accent colour; charts are native, editable PowerPoint charts in the theme's accent colours and body font.
- **Sample slides** in the template file are not copied. Neither are custom shows and sections that refer to them.
- **Footer and slide numbers:** set them in the template (**Slide footer**, **Slide numbers**). They appear on every slide but the title slide, where the layout has a footer or slide number placeholder.
- **Speaker notes** use the template's notes master; a template without one gets a plain one.
- Without a PowerPoint template, choose the **slide format** (16:9 or 4:3).

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
    "layouts": { "content": "Titel und Inhalt" }
  }
}
```
