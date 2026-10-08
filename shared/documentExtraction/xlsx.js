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
import { markdownTableLines } from './markdown.js';

/** Rows read from one sheet. */
export const MAX_SHEET_ROWS = 2000;

/** Characters of all sheets together; the next row that would go beyond is left out. */
export const MAX_WORKBOOK_CHARS = 300000;

/**
 * Once the rows have used the budget, a sheet still gets its title and the count of its rows
 * left out (the model should know the sheet exists) — up to this many characters more. Sheets
 * after that are only counted.
 */
export const SHEET_NOTICE_RESERVE = 5000;

// What a number, a percentage, a date or a time looks like as text: not a column name.
const NUMBER_LIKE = /^[-+(]?[\d.,/:'’\s€$£%)-]+$/;

/**
 * Whether the first row names the columns: at least two named columns, every cell filled with
 * text that is not a number or a date, and a row of data below. A cell that is the covered part
 * of a merged header (`covered`: column indexes) is empty by nature and does not count against
 * it — nor as a column: a title merged across the sheet is a title, not a header. A cell the
 * file stores as a number, date or time (`typed`: column indexes) is data, whatever text its
 * format makes of it.
 *
 * @param {string[][]} rows
 * @param {Set<number>} [covered]
 * @param {Set<number>} [typed]
 * @returns {boolean}
 */
export function looksLikeHeader(rows, covered = new Set(), typed = new Set()) {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first.filter((_, column) => !covered.has(column)).length < 2) return false;
  return first.every((cell, column) => {
    const text = cell.trim();
    if (covered.has(column)) return text === '';
    // A number, date or time stays one however it is formatted ("Oct 2026", "10 AM", "USD 10").
    return text !== '' && !typed.has(column) && !NUMBER_LIKE.test(text);
  });
}

const oneLine = text => String(text).replace(/\s+/g, ' ').trim();

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
  let budget = limits.workbookChars ?? MAX_WORKBOOK_CHARS;
  const blocks = [];

  let leftOut = 0;
  for (const [index, name] of workbook.SheetNames.entries()) {
    const sheet = workbook.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    // The budget is a bound: when the rows have used it, the sheets that follow get a title and
    // a notice — within the reserve. A sheet whose title no longer fits ends the workbook; the
    // sheets after it are only counted.
    const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden;
    const title = `[Sheet: ${name}${hidden ? ' (hidden)' : ''}]`;
    if (budget + SHEET_NOTICE_RESERVE < title.length + 1) {
      leftOut = workbook.SheetNames.slice(index).filter(n => workbook.Sheets[n]?.['!ref']).length;
      break;
    }
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const lastRow = Math.min(range.e.r, range.s.r + sheetRows - 1);
    const rows = XLSX.utils
      .sheet_to_json(withVerticalMerges(XLSX, sheet, lastRow), {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
        range: { s: range.s, e: { r: lastRow, c: range.e.c } }
      })
      .map(row => row.map(oneLine));
    if (rows.length === 0) continue;

    // Columns without anything in them, at the right, are not columns.
    let width = 0;
    for (const row of rows) {
      for (let c = row.length - 1; c >= width; c -= 1) {
        if (row[c] !== '') {
          width = c + 1;
          break;
        }
      }
    }
    const grid = rows.map(row => row.slice(0, width));
    // Columns that a merged cell of the first row covers: a title over several columns.
    const covered = new Set();
    for (const merge of sheet['!merges'] || []) {
      if (merge.s.r === range.s.r) {
        for (let c = merge.s.c + 1; c <= merge.e.c; c += 1) covered.add(c - range.s.c);
      }
    }
    // Columns whose first cell the file stores as a number, a date or a boolean.
    const typed = new Set();
    for (let c = 0; c < width; c += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: range.s.c + c })];
      if (cell && ['n', 'd', 'b'].includes(cell.t)) typed.add(c);
    }
    const header = looksLikeHeader(grid, covered, typed);
    const lines = header ? markdownTableLines(grid, { header: true }) : grid.map(r => r.join('\t'));
    // Every line is a row of the sheet, except the separator of a table (its second line).
    const entries = lines.map((line, at) => ({ line, isRow: !(header && at === 1) }));

    const out = [title];
    budget -= title.length + 1;

    let shown = 0;
    for (const { line, isRow } of entries) {
      if (budget < line.length + 1) break;
      out.push(line);
      budget -= line.length + 1;
      if (isRow) shown += 1;
    }
    // Rows left out: those that were read but did not fit, and those beyond the row limit.
    const omitted = grid.length - shown + Math.max(0, range.e.r - lastRow);
    if (omitted > 0) {
      const notice = `[… ${omitted}${shown === 0 ? '' : ' more'} rows omitted]`;
      out.push(notice);
      budget -= notice.length + 1;
    }
    blocks.push(out.join('\n'));
  }
  if (leftOut > 0) blocks.push(`[… ${leftOut} more sheets omitted]`);
  return blocks.join('\n\n').trim();
}
