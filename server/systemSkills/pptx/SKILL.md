---
name: pptx
description: Create PowerPoint presentations (.pptx) on demand — pitch decks, status updates, board and project reviews, trainings, workshop agendas, results summaries — on the company's slide template, with bullet slides, KPI metric cards, tables, native editable charts, pictures, two-column comparisons, section slides and speaker notes. Use whenever the user asks for slides, a deck, a presentation or a PowerPoint file. Do not activate only to summarize or answer questions about an uploaded .pptx (its extracted text is already in the conversation).
metadata:
  author: IntraFind
  version: '1.4'
allowed-tools: create_pptx restyle_pptx
---

# Creating presentations

You create presentations with the `create_pptx` tool. You decide what goes on each slide; the server puts it on the company's slide template (its master, layouts, fonts, colours and logo), so the deck looks like the company's own. Charts are real PowerPoint charts the user can edit.

## Choose the format

- **`.pptx` (`create_pptx`)**: slide decks, pitches, board reviews, workshops, status presentations.
- **`.pdf` (`create_pdf`)**: print-ready reports, letters, invoices, certificates, visual posters.
- **`.docx` (`create_docx`)**: editable prose documents, contracts, policies, proposals.
- **`.xlsx` (`create_xlsx`)**: multi-sheet workbooks, financial models, tables with live formulas.

If the user uploaded a `.pptx`, its extracted text is already in the conversation as `<content type="document">`. Read it directly; to revise or reformat it as a new deck, build the full `slides` array and call `create_pptx`.

When its `<content>` tag says `can_use_as_template="true"`, pass the tag's `id` as `templateFileId` to build the new slides on that deck's own master, layouts and theme. `templateMode` is `styles_only` (default: the deck's old slides are dropped) or `append` (its slides stay and yours follow).

## The company template

If the app uses a **document template**, its slide design is applied automatically. Then:

- Do not set colours or fonts, and do not describe the design in the slides.
- Do not add the company name or a confidentiality note to every slide: the template's footer has it.
- If `create_pptx` offers a `template` parameter, use `default` unless the user asks for a specific template.

## Moving an existing deck into the company design

When the user uploads a `.pptx` and wants **that deck itself** in the company design, keeping its pictures, charts, tables and speaker notes, call `restyle_pptx` with the id of the uploaded file (the `id` of its `<content>` tag, only when `can_use_as_template="true"`). Its slides are put on the company template's master and layouts: titles, footers and slide numbers take the template's positions, fonts and colours; text alone on a slide takes the template's content area; pictures, charts, tables and other shapes keep their arrangement and are scaled into the content area. Slide backgrounds and the old master are dropped, and colours the deck took from its old theme follow the new one.

- Use `restyle_pptx` to **move a deck into the company design**; use `create_pptx` to **write a new deck** or to rewrite a deck's text (pictures of the old deck are not carried over then).
- The result is the old deck's content on a new master, not a new design of it: formatting a shape carries itself (a fixed colour or font on a run) stays. Say so, and tell the user to look through the slides, especially those with several pictures or tight layouts. Read the tool's `warnings`.

## Workflow

1. **Plan the storyline** before writing slides: the audience, the one message of the deck, and 5–15 slides that build it up. For longer decks, group slides into parts with section slides.
2. **Vary the visual rhythm**: never repeat the same bullet-only layout on every slide. Mix `metrics` (KPI callout cards), `chart`, `table`, `two-column` comparisons, and text+visual side-by-side slides.
3. **Write the slides** as a JSON array (see below). One idea per slide; the title says the takeaway ("Revenue grew 12 % in Q3", not "Revenue").
4. **Call `create_pptx`** with a descriptive `filename`, the deck `title`, the `language` of the content (e.g. `en-US`, `de-DE`) and the `slides`.
5. **Answer briefly**: name the file, the number of slides and the storyline in one or two sentences. Do not paste the slides into the chat and do not add a link: the download card is already there.

If `create_pptx` returns `warnings`, read them: a table was cut, text was shrunk to fit, an image was skipped. Fix it (split the slide, shorten the text) and create the deck again.

## Slides

Pass `slides` as JSON text: an array of slide objects.

| Field           | Use                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout`        | `title` (opening slide), `section` (divider between parts), `content` (default), `two-column`, `title-only`, `blank`                                                                                                                                                                |
| `title`         | The slide title: the takeaway, at most about 8 words                                                                                                                                                                                                                                |
| `slots`         | Optional text slots of the company template besides title and content, an object of text by slot id: `{ "kicker": "VISION 2027", "lead": "One sentence of context." }`. The tool description lists the ids the template has, where each sits and how much text fits: use only those |
| `subtitle`      | Title and section slides: subtitle, date, presenter                                                                                                                                                                                                                                 |
| `footer`        | Title slide only: the text of the footer strip, e.g. `Strategy 2027 · November 2026` (the template's own text if unset)                                                                                                                                                             |
| `text`          | Markdown: bullets (`- `), sub-bullets (two spaces + `- `), numbered steps (`1. `), short paragraphs, `**bold**`                                                                                                                                                                     |
| `metrics`       | 1–4 KPI callout cards: `[{ "value": "+18 %", "label": "Revenue YoY", "note": "vs. +11 % plan" }]`                                                                                                                                                                                   |
| `table`         | `{ "header": ["Region", "Revenue (k€)"], "rows": [["EMEA", "1,200"]], "align": ["left", "right"] }`                                                                                                                                                                                 |
| `chart`         | `{ "type": "column", "categories": ["Q1", "Q2"], "series": [{ "name": "2026", "values": [1.2, 1.4] }] }`                                                                                                                                                                            |
| `image`         | `{ "data": "data:image/png;base64,…", "caption": "…" }`                                                                                                                                                                                                                             |
| `left`, `right` | `two-column` slides: each `{ "heading": "…", "text": "…" }`, or `metrics`, `table`, `chart` or `image`                                                                                                                                                                              |
| `notes`         | Speaker notes: what the presenter says; details that do not fit on the slide                                                                                                                                                                                                        |

- `slots` fill what the company template's slide types offer (see the tool description). A slot the slide's layout does not have is left out, or becomes the first paragraph of the text, as the template says: put nothing essential in a slot that is only decoration.
- A slide with `text` and a `table`, `chart` or `image` shows the text on the left and the visual on the right.
- A slide with `metrics` alone shows large KPI callout cards across the slide; `metrics` combined with `text`, `chart` or `table` places a KPI ribbon across the top and the content below.

**Charts**: `type` is `column` (compare values), `bar` (long category names, rankings), `line` (trends over time), `area`, `pie` or `doughnut` (shares of one whole, at most 6 slices, one series). Options: `"stacked": true` (column, bar, area), `"showValues": true` (data labels), `"numberFormat": "#,##0"` or `"0.0%"`, `"title"`. Values are plain numbers: `1200`, not `"1.2k"`. At most 12 series and 60 categories.

Example:

```json
[
  {
    "layout": "title",
    "title": "Q3 Business Review",
    "subtitle": "Board meeting · 12 October 2026"
  },
  {
    "title": "Revenue grew 12 % — all regions above plan",
    "metrics": [
      { "value": "€3.05M", "label": "Q3 Revenue", "note": "+12 % YoY" },
      { "value": "40", "label": "New Customers", "note": "25 enterprise" },
      { "value": "3.1 %", "label": "Logo Churn", "note": "-0.8 pp vs. Q2" }
    ],
    "text": "- Enterprise segment drove 70 % of net new ARR\n- APAC expanded fastest at +18 % YoY\n- Gross margin improved to 78 %",
    "notes": "Start with the enterprise deals."
  },
  { "layout": "section", "title": "Financials" },
  {
    "title": "EMEA leads, APAC catches up",
    "chart": {
      "type": "column",
      "categories": ["EMEA", "APAC", "Americas"],
      "series": [
        { "name": "2025", "values": [1.1, 0.7, 1.0] },
        { "name": "2026", "values": [1.2, 0.8, 1.05] }
      ],
      "showValues": true,
      "numberFormat": "0.0"
    },
    "text": "Revenue in € million"
  },
  {
    "layout": "two-column",
    "title": "Build or buy?",
    "left": { "heading": "Build", "text": "- Full control\n- 9 months" },
    "right": { "heading": "Buy", "text": "- Live in 2 months\n- Licence fees" }
  },
  {
    "title": "Next steps",
    "table": {
      "header": ["Action", "Owner", "Due"],
      "rows": [
        ["Sign contract", "CFO", "15 Nov"],
        ["Kick-off", "PMO", "1 Dec"]
      ]
    }
  }
]
```

## Design rules

- **Action titles**: every slide title states the takeaway ("Cloud migration cuts hosting cost by 28 %"), never a generic topic label ("Cloud migration").
- **3–6 bullets per slide, one line each** (about 10 words). Never use wall-of-text paragraphs on slides. More detail goes into `notes` or onto another slide. Text that does not fit is shrunk, and the tool warns you.
- **Headline numbers belong in `metrics`, `chart` or `table`**, not buried in bullet lists. Give units in the header, card label or note ("in € million").
- **Tables**: at most 6 columns and about 8 rows per slide; split longer tables over several slides. Right-align numeric columns (`"align": ["left", "right"]`).
- **Open with a `title` slide**, structure longer decks with `section` slides, and end with a summary or next-steps slide.
- **Consistent wording**: parallel bullets (all verbs or all nouns), the same number format everywhere.
- **No Markdown headings, code blocks or images inside `text`**. Use the slide `title` and the `image` field.
- Images only as `data:image/png|jpeg;base64,…` URIs; you cannot fetch images from URLs.

## Quality checklist

- Every slide has a title that states its point.
- No slide is overloaded; the warnings list is empty.
- The `language` matches the content; the file name fits.
- For a revision, create the whole deck again: presentations are never edited in place.
