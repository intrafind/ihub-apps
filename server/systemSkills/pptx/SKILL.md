---
name: pptx
description: Create PowerPoint presentations (.pptx) on demand — pitch decks, status updates, board and project reviews, trainings, workshop agendas, results summaries — on the company's slide template, with bullet slides, tables, native editable charts, pictures, two-column comparisons, section slides and speaker notes. Use whenever the user asks for slides, a deck, a presentation or a PowerPoint file.
metadata:
  author: IntraFind
  version: '1.0'
allowed-tools: create_pptx
---

# Creating presentations

You create presentations with the `create_pptx` tool. You decide what goes on each slide; the server puts it on the company's slide template (its master, layouts, fonts, colours and logo), so the deck looks like the company's own. Charts are real PowerPoint charts the user can edit.

## The company template

If the app uses a **document template**, its slide design is applied automatically. Then:

- Do not set colours or fonts, and do not describe the design in the slides.
- Do not add the company name or a confidentiality note to every slide: the template's footer has it.
- If `create_pptx` offers a `template` parameter, use `default` unless the user asks for a specific template.

## Workflow

1. **Plan the storyline** before writing slides: the audience, the one message of the deck, and 5–15 slides that build it up. For longer decks, group slides into parts with section slides.
2. **Write the slides** as a JSON array (see below). One idea per slide; the title says the takeaway ("Revenue grew 12 % in Q3", not "Revenue").
3. **Call `create_pptx`** with a descriptive `filename`, the deck `title`, the `language` of the content (e.g. `en-US`, `de-DE`) and the `slides`.
4. **Answer briefly**: name the file, the number of slides and the storyline in one or two sentences. Do not paste the slides into the chat and do not add a link: the download card is already there.

If `create_pptx` returns `warnings`, read them: a table was cut, text was shrunk to fit, an image was skipped. Fix it (split the slide, shorten the text) and create the deck again.

## Slides

Pass `slides` as JSON text: an array of slide objects.

| Field           | Use                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `layout`        | `title` (opening slide), `section` (divider between parts), `content` (default), `two-column`, `title-only`, `blank` |
| `title`         | The slide title: the takeaway, at most about 8 words                                                                 |
| `subtitle`      | Title and section slides: subtitle, date, presenter                                                                  |
| `text`          | Markdown: bullets (`- `), sub-bullets (two spaces + `- `), numbered steps (`1. `), short paragraphs, `**bold**`      |
| `table`         | `{ "header": ["Region", "Revenue (k€)"], "rows": [["EMEA", "1,200"]], "align": ["left", "right"] }`                  |
| `chart`         | `{ "type": "column", "categories": ["Q1", "Q2"], "series": [{ "name": "2026", "values": [1.2, 1.4] }] }`             |
| `image`         | `{ "data": "data:image/png;base64,…", "caption": "…" }`                                                              |
| `left`, `right` | `two-column` slides: each `{ "heading": "…", "text": "…" }`, or a table, chart or image                              |
| `notes`         | Speaker notes: what the presenter says; details that do not fit on the slide                                         |

A slide with `text` and a `table`, `chart` or `image` shows the text on the left and the visual on the right.

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
    "text": "- 40 new customers, 25 of them enterprise\n- Churn down to 3.1 %\n- APAC grows fastest",
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

- **3–6 bullets per slide, one line each** (about 10 words). More detail goes into `notes` or onto another slide. Text that does not fit is shrunk, and the tool warns you.
- **Numbers belong in charts or tables**, not in bullet lists. Give units in the header or the text ("in € million").
- **Tables**: at most 6 columns and about 8 rows per slide; split longer tables over several slides.
- **Open with a `title` slide**, structure longer decks with `section` slides, and end with a summary or next-steps slide.
- **Consistent wording**: parallel bullets (all verbs or all nouns), the same number format everywhere.
- **No Markdown headings, code blocks or images inside `text`**. Use the slide `title` and the `image` field.
- Images only as `data:image/png|jpeg;base64,…` URIs; you cannot fetch images from URLs.

## Quality checklist

- Every slide has a title that states its point.
- No slide is overloaded; the warnings list is empty.
- The `language` matches the content; the file name fits.
- For a revision, create the whole deck again: presentations are never edited in place.
