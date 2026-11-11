# Dashboard spec reference

The `data` of `create_web_artifact` with `preset: "dashboard"`: one JSON object, passed as text. Unknown fields are dropped. Text may be a string or a number. Limits are checked and a message names the field that breaks one.

## Page

| Field     | Type                       | Notes                                                                                    |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `title`   | text, required             | Page heading and browser title, at most 200 characters                                   |
| `lang`    | `en`, `de`, ...            | Language of the page's own texts (buttons, headings). Built in: `en`, `de`; default `en` |
| `summary` | text                       | The headline sentence, at most 800 characters. `**bold**` marks figures                  |
| `notes`   | text[]                     | Up to 6 short grey lines under the summary (scope, date, what is counted)                |
| `asOf`    | text                       | Date of the data; shown as "Data as of"                                                  |
| `kpis`    | array                      | Up to 8 tiles, see below                                                                 |
| `blocks`  | array                      | Up to 20 views in order, see below                                                       |
| `method`  | `{ title?, paragraphs[] }` | Open section at the bottom, up to 10 paragraphs                                          |
| `sources` | array                      | Up to 20, see below. Collapsed section "Sources and formulas"                            |
| `labels`  | object                     | Replaces interface texts, see below                                                      |

At least one of `kpis` and `blocks` is required.

## Formats

`format` is one of: `int` (default, whole number with the language's thousands separator), `decimal` (one decimal), `percent` (the value is already in percent: `44.1` shows `44.1%`), `compact` (`12.9K`), `text`, and for table columns `status`.

## `kpis[]`

`{ "label", "value", "format?", "note?" }`. `value` is a number (formatted) or a short text (shown as given, up to 40 characters).

## `blocks[]`

Every block has `type` (`bars`, `line`, `table`, `text`) and optionally `title` (required except for `text`), `description` (one or two sentences under the title) and `source` (the `id` of an entry in `sources`; adds a "Source: ..." button).

### `bars` - ranked horizontal bars

| Field                        | Notes                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `items`                      | 1 to 500 of `{ "label", "value", "note?" }`; `value` is a number that is not negative; `note` shows in the tooltip                                                 |
| `sort`                       | `desc` (default, largest first) or `none` (keep the order given)                                                                                                   |
| `top`                        | 1 to 50: show this many bars and fold the rest into one grey bar with their sum                                                                                    |
| `otherLabel`                 | Label of that bar; `{n}` is the number of items folded, e.g. `"{n} smaller sections"`                                                                              |
| `share`                      | `true`: show each bar as a percentage of the sum of **all** items. Only when the items are parts of one whole                                                      |
| `format`                     | Format of the values                                                                                                                                               |
| `marks`                      | Up to 6 of `{ "label", "value" }`: vertical reference lines in the bars' scale (a limit, a target). They enlarge the scale, so a far-off mark makes the bars short |
| `labelHeader`, `valueHeader` | Column headings of the table view                                                                                                                                  |

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

`{ "id", "name", "description?", "formula?" }`. `id` is letters, digits, `-` or `_` (at most 40). `formula` is shown in a code box: write the calculation or the query, e.g. `share(section) = tokens(section) / SUM(tokens) * 100`, or the tool and field the figures came from.

## `labels`

Replaces the page's own texts. Keys: `asOf`, `sources`, `source`, `tableView`, `chartView`, `showAll` (use `{n}`), `showFewer`, `item`, `value`, `share`, `noData`, `other` (use `{n}`), `sortBy` (use `{col}`), `method`. Needed only for a language other than `en` and `de`.

## What the page does by itself

- Orders bars, computes shares and the sum of a folded tail, sorts tables.
- Gives every chart a table view with the same numbers, a tooltip on hover and focus, and keyboard access (arrow keys on a line chart).
- Light and dark colours, a phone layout, and the app's brand colour for the header rule.
- Shows nothing that is not in the spec; it never fetches anything.
