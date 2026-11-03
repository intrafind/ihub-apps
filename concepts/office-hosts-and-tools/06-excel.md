# 06 — Excel Add-in and Tools

**Phase:** P5 (needs P1, P3)
**Parent:** [README](README.md)

## Goal

In Excel the user can:
- ask about the workbook, the sheet or the selection
- get formulas explained and generated
- have the model write values or formulas, tables, sorts, filters and formats

Two constraints hold throughout:
- **Cell data is capped and counted.** Workbooks often hold sensitive data, and every read says how many cells went to the model.
- **Every write needs approval.**

## Host adapter (`client/src/features/office/hosts/excel.js`)

- **`readMessageContext()`** returns `hostContext` `type:"sheet"`: workbook name, active sheet, selection address, header row, and the selected values as CSV, capped by `officeIntegration.hosts.excel.maxCells` (default 2,000). It reports `cells="n of m"`.
- **Toggle:** *Include selection* (on).
- **Insert action:** write the answer into the active cell as text. For a table answer (Markdown table), write the parsed rows starting at the active cell. Writing a table **asks first**, because it overwrites cells.

## Tool set (v1)

| Tool | Excel API | Min ExcelApi | Approval |
|---|---|---|---|
| `getWorkbookOutline` | worksheets (name, visibility, used range address), named items | 1.4 | never |
| `listTables` | `workbook.tables` (name, sheet, address, headers, row count) | 1.1 | never |
| `getSelectionContext` | selected range: address, values, formulas, number formats, surrounding header | 1.1 | never |
| `readRange` | `getRange(address)`: values, formulas; capped | 1.1 | never |
| `writeValues` | `range.values = …` | 1.1 | **always** (preview: address, cell count, first rows; overwritten cells flagged) |
| `writeFormulas` | `range.formulas = …` | 1.1 | **always** |
| `createTable` | `tables.add(address, hasHeaders)` | 1.1 | **always** |
| `sortRange` | `range.sort.apply(…)` / `table.sort` | 1.2 | **always** |
| `filterTable` | `table.columns.getItem(…).filter.apply(…)` | 1.2 | never (reversible) |
| `clearFilter` | `table.autoFilter.clearCriteria()` | 1.9 | never |
| `formatRange` | number format, fill, font, borders, column width | 1.1 | never |
| `addConditionalFormat` | `range.conditionalFormats.add(…)` | 1.6 | never |
| `addWorksheet` | `worksheets.add(name)` | 1.1 | never |

Later, not in v1: charts (`worksheet.charts.add`, 1.1), pivot tables (1.8), freeze panes, removing duplicates, deleting rows and columns. Each new write enters with `approval:'always'`.

### Limits and data handling

- **Cell cap per call.** Every read tool enforces `maxCells`. The result states the cap so the model can narrow the range instead of guessing. The activity row shows *n cells sent*.
- **Write cap per call.** At most 10,000 cells.
- **Formula language.** Formulas are written in English (`range.formulas`). `formulasLocal` is used only for display in the approval preview.
- **Same redaction as every client tool.** Cell values read through tools are never stored ([01](01-client-executed-tools.md#redaction-what-is-stored)).

## Ribbon (pane handoff)

| Button | Action prompt (configurable) |
|---|---|
| Explain formula | read the active cell with `getSelectionContext`, explain the formula step by step in chat |
| Summarize sheet | `getWorkbookOutline` + `readRange` on the used range (capped), 3–5 bullet summary; no writes |
| Generate formula | propose formulas for the selected cell from its neighbours; write with `writeFormulas` only after the user picks one |
| Format as table | `createTable` on the current region (approval) |

## Default app

`excel-assistant` under `server/defaults/apps/`.

Server-side `.xlsx` generation does not exist yet. The concept [Document Templates and Office System Skills](../2026-10-29%20Document%20Templates%20and%20Office%20System%20Skills.md) lists it under *Not yet*. It is not needed for these tools.

## Tests

- **Executor unit tests** against an Excel.js mock: the cell caps (read and write), the `cells="n of m"` report, the overwrite flag in the write preview, and the formula vs `formulasLocal` handling.
- **Manual matrix:** Excel for the web, Windows and Mac.

## Acceptance criteria

- "Explain the formula in B7" works from the ribbon and from the chat.
- "Add a column with the margin" proposes a formula, then writes it after approval, filled down the table.
- Reading a 50,000-row sheet never sends more than `maxCells` cells per call, and the user can see how many were sent.
