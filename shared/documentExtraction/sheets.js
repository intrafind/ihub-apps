/**
 * Sheets of a spreadsheet → text a model can read: a sheet with a header row as a Markdown table,
 * hidden sheets flagged, and a size limit with a notice — a spreadsheet's text can be far larger
 * than its file, and the file size limit does not protect the context window.
 *
 * Shared by the readers of the spreadsheet formats (Excel through SheetJS, OpenDocument): they
 * bring the cells as text, this module decides how they are written. A sheet without a header
 * row stays tab-separated, as before: a Markdown table needs a header row, and none is made up.
 *
 * @module shared/documentExtraction/sheets
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
 * format makes of it ("Oct 2026", "10 AM", "USD 10").
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
    return text !== '' && !typed.has(column) && !NUMBER_LIKE.test(text);
  });
}

export const oneLine = text => String(text).replace(/\s+/g, ' ').trim();

/**
 * @typedef {Object} SheetData
 * @property {string} name
 * @property {boolean} [hidden]
 * @property {() => SheetData} [read] - A sheet that is read only when the budget still has room
 *   for it: `name` and `hidden` are enough to decide, the rest comes from `read()` (rows and the
 *   fields below). Without it the sheet is already read, and `rows` is set.
 * @property {string[][]} [rows] - The rows that were read, without the empty ones
 * @property {Set<number>} [covered] - Columns of the first row that a merged cell covers
 * @property {Set<number>} [typed] - Columns whose first cell the file stores as a number, a date,
 *   a time or a boolean (not as text)
 * @property {number} [rowsBeyond] - Rows of the sheet that were not read (past the row limit)
 * @property {string[]} [notices] - Lines appended to the sheet, e.g. what was cut off
 */

/**
 * @param {SheetData[]} sheets
 * @param {{workbookChars?: number}} [limits]
 * @returns {string} `[Sheet: name]` blocks; '' when no sheet has content
 */
export function renderSheets(sheets, limits = {}) {
  let budget = limits.workbookChars ?? MAX_WORKBOOK_CHARS;
  const blocks = [];
  let leftOut = 0;

  // A sheet that is not read yet counts as one with content: that is only known once it is read.
  const hasContent = sheet => sheet.read !== undefined || sheet.rows.length > 0;

  for (const [at, entry] of sheets.entries()) {
    if (!hasContent(entry)) continue;
    // The budget is a bound: when the rows have used it, the sheets that follow get a title and
    // a notice — within the reserve. A sheet whose title no longer fits ends the workbook; the
    // sheets after it are only counted, and not even read.
    const title = `[Sheet: ${entry.name}${entry.hidden ? ' (hidden)' : ''}]`;
    if (budget + SHEET_NOTICE_RESERVE < title.length + 1) {
      leftOut = sheets.slice(at).filter(hasContent).length;
      break;
    }
    const sheet = entry.read ? { ...entry, ...entry.read() } : entry;
    if (sheet.rows.length === 0) continue;
    const rows = sheet.rows.map(row => row.map(oneLine));

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
    const grid = rows.map(row => {
      const cells = row.slice(0, width);
      while (cells.length < width) cells.push('');
      return cells;
    });
    const header = looksLikeHeader(grid, sheet.covered, sheet.typed);
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
    const omitted = grid.length - shown + (sheet.rowsBeyond ?? 0);
    const notices = [];
    if (omitted > 0) notices.push(`[… ${omitted}${shown === 0 ? '' : ' more'} rows omitted]`);
    notices.push(...(sheet.notices ?? []));
    for (const notice of notices) budget -= notice.length + 1;
    out.push(...notices);
    blocks.push(out.join('\n'));
  }
  if (leftOut > 0) blocks.push(`[… ${leftOut} more sheets omitted]`);
  return blocks.join('\n\n').trim();
}
