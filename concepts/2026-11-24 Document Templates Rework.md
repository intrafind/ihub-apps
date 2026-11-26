# Document Templates Rework: Office Files, Derived Brand, Custom Fields

Continues [`2026-10-29 Document Templates and Office System Skills`](<2026-10-29%20Document%20Templates%20and%20Office%20System%20Skills.md>).
Admin documentation today: [`docs/document-templates.md`](../docs/document-templates.md),
[`docs/powerpoint-template-guide.md`](../docs/powerpoint-template-guide.md).

Status: draft, decided in conversation. Step 1 of the plan is implemented (brand resolution from the
themes, `fields` and `pdf.margins` in the schema). The rest is not.

Related issues: [#3605](https://github.com/intrafind/ihub-apps/issues/3605) (create a template
automatically from uploaded brand documents, see "Relation to #3605") and
[#3745](https://github.com/intrafind/ihub-apps/issues/3745) (admin UI rework for customization,
which lists the empty-colour-looks-black defect as CU-B20).

## Why

A document template today has two places that describe the same design: the settings of the admin
page (colours, fonts, logo, header, footer, margins, base design, letterhead) and the company's own
Word and PowerPoint files. Where both say something, the file wins for its own format, so the
settings only matter for PDF, Excel and templates without a file. That leads to these problems:

- Admins cannot tell which setting does what. "Base design" (`default`, `professional`, `minimal`)
  is the clearest example.
- The same placeholder idea exists twice with different syntax and lists: `{title}`, `{date}`,
  `{page}`, `{pages}`, `{company}` in the header and footer settings, and `{{title}}`, `{{subtitle}}`,
  `{{author}}`, `{{date}}`, `{{company}}`, `{{content}}` in Word files.
- The model is told the placeholder names only in general, not which ones a template has. A
  placeholder without a value becomes an empty string, and nobody asks the user for it.
- The letterhead PDF (first page and following pages) did not work in a real test: the whole
  document was put on the first-page paper. The cause is not found yet.
- Page numbers, the table of contents, the year and a confidentiality level cannot be put where the
  template wants them.

## Goal

The company's design lives in **its Office files**. The template page holds only what a file cannot:
a name, the company name, the brand colours (read from the files by default), the PDF margins
(prefilled from the Word template), and the **fields** the company's documents need. The model is told what a template needs and asks the user for what is
missing.

## What stays, goes and comes

| Part | Decision |
| --- | --- |
| Name, description, enabled, default | Stay |
| Word template (`.docx`, `.dotx`), PowerPoint template (`.pptx`, `.potx`) | Stay. Each is optional |
| Company name | Stays (`{{company}}`) |
| Primary, accent and text colour | Stay as overrides. By default read from the files |
| Heading and body font | **Derived** from the file's theme, read-only, no editing |
| Colour palette (up to six) | **New**, derived, read-only |
| Custom fields | **New** |
| Logo | Goes. A logo belongs in the Word and PowerPoint template |
| PDF margins | **Stay**, as the only PDF layout setting (`pdf.margins`). Prefilled from the Word template, see "PDF margins" |
| Font files, font size, Word and PowerPoint margins, header, footer, page size, orientation, page numbers, logo position | Go. They come from the files |
| Base design (`pdf.theme`) | Goes |
| Letterhead PDF, letterhead for following pages | Go. A letterhead is the Word template's first-page header |
| PowerPoint layout overrides (`pptx.layouts`), extra text slots (`pptx.slots`), footer text, slide numbers, aspect ratio | Go. Everything is detected from the template's placeholders and size |

This is a **clean break** (decided): no reading of the old keys at runtime and no compatibility layer.
A migration cleans existing templates up (see Migration).

## Decisions

### A template is the files plus a small `template.json`

```json
{
  "id": "corporate",
  "name": { "en": "Corporate", "de": "Konzern" },
  "description": { "en": "Company design for all documents" },
  "enabled": true,
  "default": true,
  "brand": {
    "companyName": "Example AG",
    "primaryColor": "#e30613",
    "accentColor": "#374151",
    "textColor": "#1f2937"
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

A template needs no Office file. Without one, documents use the neutral built-in design in the
template's colours. Brand colours are optional too (see next section).

### Brand: resolved, not copied

The colours and fonts a document, workbook, dashboard or web artifact uses are **resolved** when
they are needed, in this order:

1. The template's own value (`brand.primaryColor`, `accentColor`, `textColor`).
2. The theme of the PowerPoint template.
3. The theme of the Word template.
4. The neutral built-in default.

The PowerPoint theme comes first because its accent colours are ordered for charts. A theme only
provides primary, accent and palette colours when it has at least one colourful accent; a theme
whose accents are all grey is skipped for them, so the Word theme is tried next, and the neutral
default is used only when neither has one. The text colour (`dk1`) is always available from a
theme. Theme colours
are read from the theme part of the package (`dk1`, `dk2`, `lt1`, `lt2`, `accent1` to `accent6`);
system colours such as `windowText` use their stored hex value (`lastClr`).

- **Primary** is the first accent that is not a grey. The Office engine already has this rule for
  KPI cards and chart colours; the same helper is reused. A theme whose accent 1 is grey therefore
  still gives a colourful primary.
- **Accent** is the next accent that clearly differs from the primary.
- **Text** is `dk1`.
- **Palette** is accents 1 to 6, with greys moved to the end. It is never typed in; it follows the
  file.
- **Fonts** are the theme's heading and body font names. They are read-only.

The admin page has a button "Take colours from this file". It reads the theme of the chosen
PowerPoint or Word file itself, ignoring the template's own overrides, and copies that file's primary,
accent and text colour into the three fields. It offers this when a PowerPoint or Word file is
uploaded. It never overwrites a value without being asked. Because resolution falls back to the files, a template
with just an upload already has a brand, so the button is a convenience, not a step the admin has
to do.

### PDF margins

PDFs are not built from the Word file, so the Word template's margins do not reach them by
themselves. A PDF therefore keeps one layout setting: `pdf.margins`, four values `[left, top, right,
bottom]` in points, as today. It is resolved like the brand colours:

1. The template's own `pdf.margins`.
2. The margins of the Word template's last section (`pgMar`), the same values the Word merge
   already reads.
3. The built-in default `[50, 62, 50, 62]`.

The admin page shows the four values with their source and prefills them when a Word template is
uploaded, without overwriting values the admin has set. There is no setting for page size or
orientation: a PDF takes them from the Word template's last section, else A4 portrait.

Values keep today's limits (18 to 200 points); the engine raises the top and bottom margin to at
least 36 points because the page footer sits in it. Margins matter again whenever something is drawn
behind the text, which is what broke the letterhead: a logo taller than the margin ended up under
the text. With no letterhead and no logo in the PDF, nothing sits behind the text.

### Placeholders: one syntax, one list

All placeholders are `{{name}}`, typed as plain text in the Word file, in the body, headers and
footers. A name is a letter followed by letters, digits or underscores, up to 32 characters, matched
without regard to case. Placeholders split by Word into several runs are still found, as today.

| Placeholder | Filled with |
| --- | --- |
| `{{content}}` | The generated content (a paragraph that holds only this) |
| `{{toc}}` | A table of contents (a paragraph that holds only this) |
| `{{title}}`, `{{subtitle}}` | The tool's `title` and `subtitle` |
| `{{author}}` | The tool's `author`, else the name of the signed-in user |
| `{{date}}` | The tool's `date`, else today |
| `{{year}}` | The year of `date` |
| `{{company}}` | The template's company name |
| `{{page}}`, `{{pages}}` | Word page number fields (`PAGE`, `NUMPAGES`) |
| anything else | A custom field of the template |

`{{page}}` and `{{pages}}` are written as real fields, so Word counts the pages. Replacing a
placeholder with a field means ending the text run at the placeholder and inserting a field there.

The old single-brace form `{title}` in the header and footer settings goes away with the settings.

### Table of contents

`{{toc}}` marks where the table of contents goes, for example after a cover page. When the template
has it, the contents appear there. When it does not, `toc: true` puts the contents at the start of
the generated content, as today. The field is formatted with the template's "TOC 1 to 3" and "TOC
Heading" styles, matched by name like all other styles.

The Word contents field has no stored entries. Word fills it when the user confirms the "update
fields" prompt on opening. Viewers that do not update fields show it empty. The `docx` skill says
so, so the model does not promise a filled contents page.

### Custom fields

A custom field is any `{{name}}` that is not a built-in. Examples: `{{classification}}`,
`{{department}}`, `{{version}}`, `{{docId}}`.

Detection and declaration:

- Uploading or saving a Word file finds every placeholder in it. A name not yet declared is added to
  `fields` as optional free text, so nothing is ever printed with its braces.
- The admin page lists the fields and lets the admin set a label, a description, "required", a list
  of allowed values and a default. A declared field that the file no longer has is shown with a
  warning.
- Names must not equal a built-in. At most 50 fields per template. A Word file with more distinct
  placeholders is refused on upload, with a message that lists the names, so no placeholder is
  silently left undeclared. The migration declares up to 50 and writes the remaining names to the
  migration log; those stay in the file as plain text.

How the model sees them:

- The tool description of `create_docx` names the fields of the default or pinned template: name,
  label, whether it is required, allowed values. It has a generic `fields` object argument for the
  values.
- Every enabled template's fields are listed in the `template` argument's description, not only the
  default's, so the model learns the fields of a chosen template before it creates the file, also
  when all of them are optional. The missing-fields error below is a second line of defence, not the
  way fields are discovered.
- Values derived without asking: author (signed-in user), date, year and company. The model never
  has to ask for them.

When a required field has no value and no default, `create_docx` does not create the file. It
returns an error that lists the missing fields with label, description and allowed values, and tells
the model to **ask the user and not to invent a value**. A value outside the allowed list is
refused the same way. The skill text says the same. Optional fields without a value stay empty.

`edit_docx` stores the fields with the other arguments, so an edit rebuilds the document with the
same values.

This applies to Word. PowerPoint has no custom fields in this rework (see below).

### Where each format gets its design

| Format | Source |
| --- | --- |
| Word | The Word template. Styles, headers, footers, first-page header, page setup and theme come from it. Without a Word template the neutral built-in design in the resolved brand |
| PowerPoint | The PowerPoint template, or the built-in template made from the resolved brand. Footers and slide numbers come from the layout's own placeholders. Layouts are found automatically |
| PDF | Option A (decided): built with the existing PDF engine. Colours from the resolved brand, bundled fonts, the template's PDF margins, a footer with the company name and "Page x of y". No letterhead, no base design |
| Excel | Resolved brand colours and font for header rows, totals and accents |
| Web artifacts, dashboards | Resolved brand colours, palette and fonts as CSS variables |

PDF cannot follow a Word template exactly, because there is no Office renderer on the server.
Brand fonts are not available to the PDF engine, since fonts are no longer uploaded. A PDF carries
the brand through its colours and the company name. Rendering the finished Word file with LibreOffice
would give an identical look and make the letterhead problem go away; it needs LibreOffice in the
image and the brand fonts installed on the server. That is a separate decision, later.

### What the model is told

When a template applies, the model gets, read-only: primary, accent and text colour, the palette,
the heading and body font names, and the fields of the template. It is told that a font is only a
name, which may not be installed on the reader's computer, so web artifacts use a fallback stack.

Tool arguments that the files now decide are removed from the tools: `primaryColor`, `accentColor`,
`font`, `header`, `footer`, `pageSize`, `orientation`, `pageNumbers`. Content choices stay (`title`,
`subtitle`, `author`, `date`, `language`, `markdown`, `toc`, `coverPage`, `filename`, `template`,
`templateFileId`, `templateMode`) and `fields` is added. The exact list is fixed in the
implementation, per format.

`templateFileId` (a Word file the user uploaded in the chat) stays as it is and gets the same
built-in placeholders, including `{{year}}`, `{{toc}}`, `{{page}}` and `{{pages}}`. It has no custom
fields.

### Export dialog

The built-in PDF designs `professional` and `minimal` go with the base design. The export dialog
offers the enabled document templates, and one neutral built-in when none exists. A request that names
an unknown template, including the two old built-ins, uses the default template. This changes the
`template` values of the export endpoint; external callers that send `professional` or `minimal` get
the default template without an error. Per the clean-break decision there is no `Deprecation` header
or alias.

### Admin page

1. General: name, description, enabled, default.
2. Company and brand: company name, the three colours with "Take colours from this file", the derived
   palette and fonts, shown read-only with their source ("from the PowerPoint template").
3. Word template: upload and what was found: styles, first-page header, placeholders and fields.
   Below it the four PDF margins, with their source ("from the Word template").
4. PowerPoint template: upload and what was found: layouts per kind, with a warning where the
   fallback is used, and the theme colours and fonts.
5. Fields: the declared fields of the template.
6. A sample document per format, rendered with sample content and sample field values.

The colour field shows black for an empty or non-`#rrggbb` value, and a report says it also stays
black after a colour was picked. That bug is reproduced first (Playwright) and fixed in this work.

## Migration

`V{NNN}__document_templates_rework.js`, with the next free number when the work starts (`V264` is
taken on `main` by the removal of Qwant). For every
`contents/document-templates/<id>/template.json`:

- Move `document.margins` to `pdf.margins`, so a margin an admin set is not lost.
- Remove the keys that go: `brand.headingFont`, `bodyFont`, `fontSize`, `logo`, `document` (the rest
  of it), `fonts`, `pdf.theme`, `pdf.letterhead`, `pdf.letterheadFollowing`, `pptx.layouts`,
  `pptx.slots`, `pptx.footer`, `pptx.slideNumbers`, `pptx.aspectRatio`.
- Delete the files they named: logo, fonts and both letterhead PDFs.
- Declare the placeholders found in the Word template as fields (at most 50, see Custom fields), so
  nothing prints its braces.
- Keep brand colours and company name. A template that had no Office file stays valid and now has the
  neutral design in its colours.

The schema is `.strict()`, so a `template.json` with old keys would be refused. The migration runs on
startup and is forward-only. The ids `professional` and `minimal` stop being reserved.

The release note under `docs/releases/next/` says what admins lose and what to do: put the logo and
the letterhead into the Word and PowerPoint templates, and check the PDF look.

## Relation to #3605

[#3605](https://github.com/intrafind/ihub-apps/issues/3605) is open and not built. It asks for a
template to be created automatically from uploaded brand documents: a deterministic read of theme
colours and fonts, logo, page size, margins and header and footer text, plus an optional AI step
that reads a brand guideline and flags where it disagrees with the files. The admin confirms before
anything is saved.

This rework changes the ground under it:

- **The deterministic half is already part of this concept.** Resolving colours, palette and fonts
  from the themes and the "Take colours from this file" button do what #3605 slice 1 describes for
  those values.
- **Most of the extraction targets disappear.** Logo, header and footer text, page size and font files
  are no longer template settings, so there is nothing to propose for them. Margins stay, but only
  for PDFs and prefilled from the Word template (see "PDF margins").
- **What remains for #3605:** company name, the three colours, the PDF margins, the declared fields,
  and the optional AI step that reconciles a guideline with the themes. Its `_propose` and `_accept`
  API and its review interface need to be rewritten against the smaller schema.

Proposal: implement this rework first, then reduce #3605 to that remainder and update its text.

## Not in this rework

- Custom fields for PowerPoint. The PowerPoint template stays automatic. Fields can come later with
  the same `{{name}}` syntax in the master and layouts.
- Brand fonts in PDFs, and rendering PDFs from Word with LibreOffice.
- Per-language variants of one template. Separate templates do that today.

## Risks

- **Customers who use a letterhead PDF or font files lose them.** Mitigation: the release note, and
  the Word template's first-page header as the replacement. PDFs will not show the letterhead.
- **Automatic layout detection for PowerPoint has no override any more.** Mitigation: what was found
  is shown with warnings, and the sample deck shows the result. The guide stays the reference.
- **The model guesses values instead of asking.** Mitigation: the error says to ask, names the
  allowed values, and a test covers a model that retries without asking.
- **Odd themes**: greys only, or fewer than six accents. Mitigation: palette shorter than six is
  fine; a theme with no colourful accent is skipped, so the next theme in the resolution order
  provides the colours, and the neutral primary is used only when neither theme has one.

## To verify before relying on it

- The Word merge keeps "different first page" (`w:titlePg`) and first-page headers and footers of the
  template. If it does not, the letterhead replacement above does not work yet.
- Why the letterhead sample put the whole document on the first-page paper. The code that picks the
  first or following page looks right, so the sample file is needed. The cause may exist elsewhere.
- The colour picker bug, reproduced in a browser.

## Plan

One release, built in this order (as pull requests, or as commits on one branch):

1. Brand resolution from the themes, `fields` and `pdf.margins` in the schema, tests. Done. The
   migration and the removal of the old keys from the schema move to step 4, because the migration
   deletes files and has to land together with the code that stops reading them.
2. Placeholder engine: built-ins, custom fields, `{{toc}}`, `{{page}}`, `{{pages}}`, tests with split
   runs.
3. Tools: arguments, `fields`, the missing-fields error, the skill texts (`docx`, `pdf`, `pptx`,
   `xlsx`, `web-artifacts`).
4. PDF without letterhead, fonts and base design; the export dialog.
5. Admin page, English and German texts, the colour picker fix, `docs/document-templates.md`,
   `docs/powerpoint-template-guide.md`, `docs/pdf-generation.md`, release note, end-to-end test.

## Open points

- PDF footer: a fixed "company, Page x of y", or the text of the Word template's footer when it is
  plain text. Proposal: fixed.
- A paragraph whose placeholders are all empty: remove it, or leave it. Proposal: remove it.
- The format of `{{date}}`: today it is ISO (`2026-11-24`). A per-language format would suit
  German documents better.
