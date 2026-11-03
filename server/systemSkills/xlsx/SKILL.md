---
name: xlsx
description: Create formatted Excel workbooks (.xlsx) on demand — financial models, budgets, KPI trackers, cost comparisons, project schedules, multi-sheet data tables with live formulas — styled in the company's corporate design with frozen headers, auto-filters, number formatting and auto-fitted columns. Use whenever the user asks for an Excel file, spreadsheet, .xlsx workbook or financial model. Do not activate only to read or answer questions about an uploaded spreadsheet (its extracted text is already in the conversation), or when the user explicitly asks for a raw .csv file.
metadata:
  author: IntraFind
  version: '1.0'
allowed-tools: create_xlsx
---

# Creating Excel workbooks

You create `.xlsx` spreadsheets with the `create_xlsx` tool. The server builds a native SpreadsheetML workbook styled in the company's corporate colours and typography, with frozen header rows, auto-filters, auto-fitted column widths and live Excel formulas that recalculate automatically when opened.

## Choose the format

- **`.xlsx` (`create_xlsx`)**: spreadsheets, financial models, budgets, forecasts, multi-tab trackers, tables that need live `=SUM(...)` / `=AVERAGE(...)` formulas or number formatting.
- **`.csv` (`create_file` in `files` skill)**: raw flat text data exports for scripts or imports when no formulas, styling or multiple sheets are wanted.
- **`.pdf` (`create_pdf`)** / **`.docx` (`create_docx`)** / **`.pptx` (`create_pptx`)**: reports, prose documents, slide decks.

If the user uploaded an `.xlsx` or `.csv` file, its extracted contents are already in the conversation as `<content type="document">`. Read them directly; to deliver a new or updated workbook, pass the full `sheets` JSON array to `create_xlsx`.

## The company template

If the app uses a **document template**, its brand colours, font and company metadata are applied automatically:

- Do not set `primaryColor`, `accentColor` or `font` when a template is pinned.
- If `create_xlsx` offers a `template` parameter, use `default` unless the user asks for a specific template.

## Worksheet grammar (`sheets`)

Pass `sheets` as a JSON array of 1–20 worksheet objects:

| Field           | Use                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Tab name (max 31 characters; no `: \ / ? * [ ]`).                                                                                                 |
| `columns`       | Array of column headers: either strings `"Region"` or objects `{ "header": "Revenue (€)", "format": "currency", "align": "right", "width": 16 }`. |
| `rows`          | Array of data rows. Each row is either an array of cell values `["EMEA", 120000, "=B2*1.12"]` or `{ "cells": [...], "total": true }`.             |
| `totalRow`      | `true` when the last row in `rows` is a summary/total row (applies bold text + top thin border + bottom double accounting underline).             |
| `freezeHeader`  | Freeze Row 1 so headers stay visible while scrolling (default `true`).                                                                            |
| `autoFilter`    | Enable dropdown filters on the header row (default `true`, automatically excludes a trailing total row).                                          |
| `showGridLines` | Keep worksheet gridlines visible (default `true`).                                                                                                |

### Column formats (`format`)

- `"currency"` (`#,##0.00`), `"integer"` (`#,##0`), `"decimal"` (`#,##0.00`), `"percent"` (`0.0%`, pass `0.125` for `12.5%`), `"date"` (`yyyy-mm-dd`, pass ISO strings `"2026-10-15"`), `"text"`, or any custom Excel format string like `"#,##0 \"€\""` or `"$#,##0;($#,##0);\"-\""`.

## Formula & financial modelling rules

1. **Always use live formulas instead of hardcoded calculated numbers**:
   - Never calculate sums, differences, growth rates, averages or KPIs in your head and write them as static numbers. Write `=SUM(B2:B10)`, `=(C2-B2)/B2`, `=AVERAGE(D2:D10)`, `=INDEX(...)`, `=MATCH(...)`, `=XLOOKUP(...)`.
2. **Row 1 is ALWAYS the `columns` header row; `rows[0]` is ALWAYS Row 2**:
   - Column `0` is `A`, Column `1` is `B`, Column `2` is `C`, etc.
   - `columns` occupies Row 1 (`A1`, `B1`, `C1`, …).
   - `rows[0]` is Row 2 (`A2`, `B2`, `C2`, …), `rows[1]` is Row 3 (`A3`, `B3`, `C3`, …), and `rows[n]` is Row `n + 2`.
   - Double-check every formula's row range so a total row on `rows[4]` (Row 6) sums `B2:B5`, never `B2:B6` (which would create a circular reference).
3. **Use English Excel formula names and comma separators**:
   - Always write `=SUM(B2:B5)`, `=IF(B2>0, C2/B2, 0)`, `=SUMIFS(...)` (never localized function names like `SUMME` or semicolon argument separators). Excel translates English function names to the user's UI language automatically when opening the file.
4. **Cross-sheet references**:
   - Put model assumptions or drivers on an `Assumptions` tab (mark input rows with `{ "cells": [...], "assumption": true }` so hardcoded inputs render in financial-model blue) and reference them across tabs: `=Assumptions!B2` or `='Key Drivers'!B2` (quote tab names that contain spaces).
5. **Prevent formula errors (`#DIV/0!`, `#REF!`, `#VALUE!`, `#NAME?`)**:
   - Wrap ratios that could divide by zero in `=IF(B2=0, 0, (C2-B2)/B2)` or `=IFERROR((C2-B2)/B2, 0)`.
6. **Stay inside the workbook**:
   - Formulas that fetch data from outside or run commands (`WEBSERVICE`, `FILTERXML`, `HYPERLINK`, `RTD`, `CALL`, `REGISTER`, DDE links) are never written as live formulas; they appear as plain text. Put such values in the cell as text instead.
   - Dynamic-array functions (`FILTER`, `SORT`, `SORTBY`, `UNIQUE`, `SEQUENCE`) do not spill into neighbouring cells in these workbooks. Do not rely on them; list the rows explicitly, or use `INDEX`/`SMALL`/`SUMIFS` style formulas.
7. **Years, IDs and postal codes stay plain**: a whole number in a `general` column is shown without thousands separators (`2026`, not `2,026`). Set `"format": "integer"` only for quantities that should read `1,250,000`.

## Example

```json
[
  {
    "name": "Regional Summary",
    "columns": [
      { "header": "Region", "align": "left" },
      { "header": "2025 Actual (€)", "format": "#,##0" },
      { "header": "2026 Plan (€)", "format": "#,##0" },
      { "header": "Variance (€)", "format": "#,##0" },
      { "header": "YoY Growth", "format": "percent" }
    ],
    "rows": [
      ["EMEA", 1250000, 1420000, "=C2-B2", "=IF(B2=0,0,D2/B2)"],
      ["Americas", 980000, 1110000, "=C3-B3", "=IF(B3=0,0,D3/B3)"],
      ["APAC", 640000, 790000, "=C4-B4", "=IF(B4=0,0,D4/B4)"],
      {
        "cells": ["Total", "=SUM(B2:B4)", "=SUM(C2:C4)", "=C5-B5", "=IF(B5=0,0,D5/B5)"],
        "total": true
      }
    ]
  }
]
```

## Answer

After `create_xlsx` runs, answer briefly: name the file, the worksheets and what formulas/metrics they contain. Do not paste the full tables into the chat and do not add a link: the download card is already there.
