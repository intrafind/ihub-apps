// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Spreadsheets (.xlsx, .xls) → text a model can read: a sheet with a header row as a Markdown
 * table, merged cells that keep every row complete, hidden sheets flagged, and a size limit with
 * a notice — a spreadsheet's text can be far larger than its file, and the file size limit does
 * not protect the context window.
 *
 * Pure functions over a workbook that SheetJS read (the library is passed in, like the other
 * extractors' libraries). A sheet without a header row stays tab-separated, as before: a
 * Markdown table needs a header row, and none is made up.
 *
 * @module shared/documentExtraction/xlsx
 */
import {
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_WORKBOOK_CHARS,
  SHEET_NOTICE_RESERVE,
  looksLikeHeader,
  renderSheets
} from './sheets.js';

export {
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_WORKBOOK_CHARS,
  SHEET_NOTICE_RESERVE,
  looksLikeHeader
};

/**
 * A cell that spans rows shows its text in each row (every row stays self-contained); one that
 * spans columns keeps it in the first column, the others are empty. Only the rows that are read
 * are filled, so a merge down a million rows costs nothing.
 *
 * The filled cells go into a copy of the sheet (made only when there is something to fill): the
 * workbook belongs to the caller, who may read it again.
 *
 * @returns {Object} The sheet to read the rows from
 */
function withVerticalMerges(XLSX, sheet, lastRow, lastColumn = Infinity) {
  let filled = sheet;
  for (const merge of sheet['!merges'] || []) {
    if (merge.s.c > lastColumn) continue;
    const origin = sheet[XLSX.utils.encode_cell(merge.s)];
    if (!origin) continue;
    for (let row = merge.s.r + 1; row <= Math.min(merge.e.r, lastRow); row += 1) {
      if (filled === sheet) filled = { ...sheet };
      filled[XLSX.utils.encode_cell({ r: row, c: merge.s.c })] = { ...origin };
    }
  }
  return filled;
}

/** True for a ZIP package (.xlsx): only its reader reliably sets `!fullref` when `sheetRows` cuts. */
function isZipPackage(data) {
  const head = ArrayBuffer.isView(data) ? data : new Uint8Array(data.buffer ?? data);
  return head[0] === 0x50 && head[1] === 0x4b;
}

/**
 * Reads a workbook, parsing only the rows `extractXlsxText` can use. SheetJS otherwise parses
 * every row of every sheet (up to ~1 s of blocked event loop for 30,000 rows) and the row limit
 * throws most of them away afterwards.
 *
 * `sheetRows` is the number of rows to read counted from row 1 of the sheet, header included:
 * one more than the row limit, so a sheet that is exactly at the limit is not flagged as cut.
 * SheetJS then shortens `!ref` and keeps the real range in `!fullref`, which
 * `extractXlsxText` reads to report what was left out. Two cases are read in full instead, as
 * before: a file that is not an .xlsx package (its readers do not all keep `!fullref`), and a
 * sheet whose data starts below row 1 (the count is absolute, so leading blank rows would eat
 * into the limit).
 *
 * @param {Object} args
 * @param {Object} args.XLSX - SheetJS
 * @param {ArrayBuffer|Uint8Array|Buffer} args.data
 * @param {Object} [args.readOptions] - SheetJS read options (`type`, `cellDates`, …)
 * @param {{sheetRows?: number}} [args.limits] - The limits later passed to `extractXlsxText`
 * @returns {Object} The workbook
 */
export function readWorkbook({ XLSX, data, readOptions = {}, limits = {} }) {
  if (!isZipPackage(data)) return XLSX.read(data, readOptions);
  const rowLimit = limits.sheetRows ?? MAX_SHEET_ROWS;
  const workbook = XLSX.read(data, { ...readOptions, sheetRows: rowLimit + 1 });
  const shifted = Object.values(workbook.Sheets).some(
    sheet => sheet?.['!fullref'] && XLSX.utils.decode_range(sheet['!fullref']).s.r > 0
  );
  return shifted ? XLSX.read(data, readOptions) : workbook;
}

/**
 * @param {Object} args
 * @param {Object} args.XLSX - SheetJS
 * @param {Object} args.workbook - `XLSX.read(...)` result
 * @param {{sheetRows?: number, sheetColumns?: number, sheetCells?: number,
 *   workbookChars?: number}} [args.limits]
 * @param {{truncated?: boolean}} [args.report] - `truncated` is set when rows or sheets were
 *   left out on the limits
 * @returns {string} `[Sheet: name]` blocks; '' when no sheet has content
 */
export function extractXlsxText({ XLSX, workbook, limits = {}, report = null }) {
  const sheetRows = limits.sheetRows ?? MAX_SHEET_ROWS;
  const sheetColumns = limits.sheetColumns ?? MAX_SHEET_COLUMNS;
  const sheetCells = limits.sheetCells ?? MAX_SHEET_CELLS;
  const sheets = [];

  workbook.SheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name];
    if (!sheet || !sheet['!ref']) return;
    sheets.push({
      name,
      hidden: !!workbook.Workbook?.Sheets?.[index]?.Hidden,
      // Read when the renderer gets to the sheet: a workbook of thousands of sheets does not
      // have all of them turned into rows for the few that fit the budget.
      read: () => {
        const range = XLSX.utils.decode_range(sheet['!ref']);
        // A read that stopped at `sheetRows` keeps the real extent in `!fullref`.
        const lastSheetRow = sheet['!fullref']
          ? XLSX.utils.decode_range(sheet['!fullref']).e.r
          : range.e.r;
        // Width first, then as many rows as the cell limit leaves for that width.
        const width = Math.min(range.e.c - range.s.c + 1, sheetColumns);
        const lastColumn = range.s.c + width - 1;
        const rowLimit = Math.max(1, Math.min(sheetRows, Math.floor(sheetCells / width)));
        const lastRow = Math.min(range.e.r, range.s.r + rowLimit - 1);
        const rows = XLSX.utils.sheet_to_json(
          withVerticalMerges(XLSX, sheet, lastRow, lastColumn),
          {
            header: 1,
            raw: false,
            defval: '',
            blankrows: false,
            range: { s: range.s, e: { r: lastRow, c: lastColumn } }
          }
        );
        // Columns that a merged cell of the first row covers: a title over several columns.
        const covered = new Set();
        for (const merge of sheet['!merges'] || []) {
          if (merge.s.r === range.s.r) {
            const end = Math.min(merge.e.c, lastColumn);
            for (let c = merge.s.c + 1; c <= end; c += 1) covered.add(c - range.s.c);
          }
        }
        // Columns whose first cell the file stores as a number, a date or a boolean.
        const typed = new Set();
        for (let c = 0; c < width; c += 1) {
          const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: range.s.c + c })];
          if (cell && ['n', 'd', 'b'].includes(cell.t)) typed.add(c);
        }
        const notices = lastColumn < range.e.c ? [`[… columns beyond ${width} omitted]`] : [];
        return { rows, covered, typed, rowsBeyond: Math.max(0, lastSheetRow - lastRow), notices };
      }
    });
  });
  return renderSheets(sheets, limits, report);
}
