# Dashboard spec reference

The `data` of `create_dashboard`: one JSON object, passed as text. Unknown fields are dropped. Text may be a string or a number. Limits are checked and a message names the field that breaks one.

## Page

| Field     | Type                       | Notes                                                                                             |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `title`   | text, required             | Page heading and browser title, at most 200 characters                                            |
| `lang`    | `en`, `de`, ...            | Language of the page's own texts (buttons, headings). Built in: `en`, `de`; default `en`          |
| `summary` | text                       | The headline sentence, at most 800 characters. `**bold**` marks figures                           |
| `notes`   | text[]                     | Up to 6 short grey lines under the summary (scope, date, what is counted)                         |
| `asOf`    | `YYYY-MM-DD`, required     | Date of the data (not today's, not a guess); shown as "Data as of". Warned when over 3 months old |
| `kpis`    | array                      | Up to 8 tiles, see below                                                                          |
| `blocks`  | array                      | Up to 20 views in order, see below                                                                |
| `method`  | `{ title?, paragraphs[] }` | Open section at the bottom, up to 10 paragraphs                                                   |
| `sources` | array, required            | 1 to 20, see below. Collapsed section "Sources and formulas"                                      |
| `labels`  | object                     | Replaces interface texts, see below                                                               |

At least one of `kpis` and `blocks` is required.

## Formats

`format` is one of: `int` (default, whole number with the language's thousands separator), `decimal` (one decimal), `percent` (the value is already in percent: `44.1` shows `44.1%`), `compact` (`12.9K`), `text`, and for table columns `status`.

## `kpis[]`

`{ "label", "value", "format?", "note?" }`. `value` is a number (formatted) or a short text (shown as given, up to 40 characters).

## `blocks[]`

Every block has `type` (`bars`, `line`, `table`, `text`) and optionally `title` (required except for `text`), `description` (one or two sentences under the title) and `source` (the `id` of an entry in `sources`; adds a "Source: ..." button).

### `bars` - ranked horizontal bars

| Field                        | Notes                                                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items`                      | 1 to 500 of `{ "label", "value", "note?" }`; `value` is a number, negative allowed (growth, change, margin: the bar runs left of a zero line, in its own colour); `note` shows in the tooltip |
| `sort`                       | `desc` (default, largest first) or `none` (keep the order given)                                                                                                                              |
| `top`                        | 1 to 50: show this many bars and fold the rest into one grey bar with their sum                                                                                                               |
| `otherLabel`                 | Label of that bar; `{n}` is the number of items folded, e.g. `"{n} smaller sections"`                                                                                                         |
| `share`                      | `true`: show each bar as a percentage of the sum of **all** items. Only when the items are parts of one whole; refused when an item is negative                                               |
| `format`                     | Format of the values                                                                                                                                                                          |
| `marks`                      | Up to 6 of `{ "label", "value" }`: vertical reference lines in the bars' scale (a limit, a target). They enlarge the scale, so a far-off mark makes the bars short                            |
| `labelHeader`, `valueHeader` | Column headings of the table view                                                                                                                                                             |

### `line` - lines over time or steps

| Field               | Notes                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `x`                 | Labels of the points in order, 1 to 500 (months, dates, versions)                                      |
| `series`            | 1 to 8 of `{ "name", "values" }`. `values` has exactly one entry per `x`, a number or `null` for a gap |
| `format`, `xHeader` | Format of the values; heading of the first column of the table view                                    |

Colours follow the series order and stay the same when series are added, so keep the order stable across dashboards. One axis only.

### `table`

| Field         | Notes                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `columns`     | 1 to 20 of `{ "key", "label", "format?", "align?" }`; `align` is `left` or `right` (numbers are right by default)                                                                                   |
| `rows`        | 1 to 2000 objects keyed by column `key`. A cell is text, a number, `null`, or `{ "text", "status" }` where `status` is `good`, `warning`, `critical` or `neutral` (shown with an icon and the text) |
| `sort`        | `{ "key", "dir": "asc" or "desc" }`: the order the table opens in; headers sort on click                                                                                                            |
| `visibleRows` | Rows shown before "Show all N rows": 0 (all) to 200, default 15                                                                                                                                     |

### `text`

`{ "paragraphs": [ ... ] }`: 1 to 20 paragraphs, each up to 2000 characters, `**bold**` allowed. Use it for the verdict and the caveats, briefly.

## `sources[]`

`{ "id", "name", "description?", "formula?", "ref?", "url?" }`. `id` is letters, digits, `-` or `_` (at most 40). `formula` is shown in a code box: write the calculation or the query, e.g. `share(section) = tokens(section) / SUM(tokens) * 100`, or the tool and field the figures came from. `ref` is where the figures were taken from, as text (a document and page, a table, a tool call), up to 300 characters; `url` is an `http(s)` address, shown as text (the page opens no links). Give them whenever a reader could check the number there.

## `labels`

Replaces the page's own texts. Keys: `asOf`, `sources`, `source`, `tableView`, `chartView`, `showAll` (use `{n}`), `showFewer`, `item`, `value`, `share`, `noData`, `other` (use `{n}`), `sortBy` (use `{col}`), `method`. Needed only for a language other than `en` and `de`.

## What the page does by itself

- Orders bars, computes shares and the sum of a folded tail, sorts tables.
- Gives every chart a table view with the same numbers, a tooltip on hover and focus, and keyboard access (arrow keys on a line chart).
- Light and dark colours, a phone layout, and the app's brand colour for the header rule.
- Shows nothing that is not in the spec; it never fetches anything.

## Example: a trend, a target and a status table

A second complete `data`, in German, using what the example in the skill does not: a `line` block with a gap, `marks` on bars, a `table` with `status` cells and a start `sort`, a `text` verdict and a `notes` line. The figures are invented example data; keep the structure, never the numbers.

```json
{
  "lang": "de",
  "title": "Service-Desk November 2026",
  "summary": "**1.284** Tickets im November, **6 %** mehr als im Oktober; die Erstlösungsquote liegt mit **71 %** unter dem Ziel von 75 %.",
  "asOf": "2026-11-30",
  "notes": ["Alle Tickets der Queues IT und Facility, ohne Spam."],
  "kpis": [
    { "label": "Tickets", "value": 1284, "note": "Oktober: 1.211" },
    { "label": "Erstlösungsquote", "value": 71, "format": "percent", "note": "Ziel 75 %" },
    { "label": "Ø Lösungszeit (h)", "value": 9.4, "format": "decimal" }
  ],
  "blocks": [
    {
      "type": "line",
      "title": "Tickets pro Woche",
      "x": ["KW 44", "KW 45", "KW 46", "KW 47", "KW 48"],
      "series": [
        { "name": "IT", "values": [212, 238, null, 251, 244] },
        { "name": "Facility", "values": [41, 39, 44, 47, 45] }
      ],
      "xHeader": "Woche",
      "source": "tickets"
    },
    {
      "type": "bars",
      "title": "Erstlösungsquote nach Team (%)",
      "format": "percent",
      "marks": [{ "label": "Ziel", "value": 75 }],
      "items": [
        { "label": "Arbeitsplatz", "value": 78 },
        { "label": "Netzwerk", "value": 64 },
        { "label": "Anwendungen", "value": 69 },
        { "label": "Facility", "value": 81 }
      ],
      "source": "fcr"
    },
    {
      "type": "table",
      "title": "Teams im Überblick",
      "columns": [
        { "key": "team", "label": "Team" },
        { "key": "tickets", "label": "Tickets", "format": "int" },
        { "key": "fcr", "label": "Erstlösung", "format": "percent" },
        { "key": "state", "label": "Status", "format": "status" }
      ],
      "rows": [
        {
          "team": "Arbeitsplatz",
          "tickets": 512,
          "fcr": 78,
          "state": { "text": "Im Ziel", "status": "good" }
        },
        {
          "team": "Netzwerk",
          "tickets": 301,
          "fcr": 64,
          "state": { "text": "Deutlich unter Ziel", "status": "critical" }
        },
        {
          "team": "Anwendungen",
          "tickets": 287,
          "fcr": 69,
          "state": { "text": "Unter Ziel", "status": "warning" }
        },
        {
          "team": "Facility",
          "tickets": 184,
          "fcr": 81,
          "state": { "text": "Im Ziel", "status": "good" }
        }
      ],
      "sort": { "key": "fcr", "dir": "asc" }
    },
    {
      "type": "text",
      "title": "Einschätzung",
      "paragraphs": [
        "Das Netzwerk-Team zieht die Quote nach unten: **64 %** bei der zweithöchsten Ticketzahl.",
        "KW 46 fehlt für die IT-Queue (Exportfehler); die Wochenlinie hat dort eine Lücke."
      ]
    }
  ],
  "method": {
    "paragraphs": [
      "Gezählt sind Tickets mit Eingang im November 2026. Erstlösung heißt: ohne Weiterleitung an ein zweites Team gelöst."
    ]
  },
  "sources": [
    {
      "id": "tickets",
      "name": "Ticket-Export",
      "description": "Wöchentlicher Export der Queues IT und Facility.",
      "ref": "Export tickets-2026-11.csv, Blatt Wochen"
    },
    {
      "id": "fcr",
      "name": "Erstlösungsquote",
      "formula": "fcr(team) = gelöst ohne Weiterleitung / alle gelösten Tickets * 100"
    }
  ]
}
```
