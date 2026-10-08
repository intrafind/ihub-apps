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
  MAX_SHEET_ROWS,
  MAX_WORKBOOK_CHARS,
  SHEET_NOTICE_RESERVE,
  looksLikeHeader,
  renderSheets
} from './sheets.js';

export { MAX_SHEET_ROWS, MAX_WORKBOOK_CHARS, SHEET_NOTICE_RESERVE, looksLikeHeader };

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
function withVerticalMerges(XLSX, sheet, lastRow) {
  let filled = sheet;
  for (const merge of sheet['!merges'] || []) {
    const origin = sheet[XLSX.utils.encode_cell(merge.s)];
    if (!origin) continue;
    for (let row = merge.s.r + 1; row <= Math.min(merge.e.r, lastRow); row += 1) {
      if (filled === sheet) filled = { ...sheet };
      filled[XLSX.utils.encode_cell({ r: row, c: merge.s.c })] = { ...origin };
    }
  }
  return filled;
}

/**
 * @param {Object} args
 * @param {Object} args.XLSX - SheetJS
 * @param {Object} args.workbook - `XLSX.read(...)` result
 * @param {{sheetRows?: number, workbookChars?: number}} [args.limits]
 * @returns {string} `[Sheet: name]` blocks; '' when no sheet has content
 */
export function extractXlsxText({ XLSX, workbook, limits = {} }) {
  const sheetRows = limits.sheetRows ?? MAX_SHEET_ROWS;
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
        const lastRow = Math.min(range.e.r, range.s.r + sheetRows - 1);
        const rows = XLSX.utils.sheet_to_json(withVerticalMerges(XLSX, sheet, lastRow), {
          header: 1,
          raw: false,
          defval: '',
          blankrows: false,
          range: { s: range.s, e: { r: lastRow, c: range.e.c } }
        });
        // Columns that a merged cell of the first row covers: a title over several columns.
        const covered = new Set();
        for (const merge of sheet['!merges'] || []) {
          if (merge.s.r === range.s.r) {
            for (let c = merge.s.c + 1; c <= merge.e.c; c += 1) covered.add(c - range.s.c);
          }
        }
        // Columns whose first cell the file stores as a number, a date or a boolean.
        const typed = new Set();
        for (let c = 0; c <= range.e.c - range.s.c; c += 1) {
          const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: range.s.c + c })];
          if (cell && ['n', 'd', 'b'].includes(cell.t)) typed.add(c);
        }
        return { rows, covered, typed, rowsBeyond: Math.max(0, range.e.r - lastRow) };
      }
    });
  });
  return renderSheets(sheets, limits);
}
