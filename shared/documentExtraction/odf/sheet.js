/**
 * OpenDocument spreadsheets (.ods) → sheets for the shared spreadsheet text (`sheets.js`): the
 * cells as the sheet shows them (an ODS stores the text of every cell next to its value), merged
 * cells that keep every row complete, hidden sheets flagged.
 *
 * An ODS stores empty rows and columns as a repeat count (a sheet "ends" a million rows later),
 * so nothing is expanded that has no content, and what is read is bounded by the row and
 * character limits — the rows past them are only counted.
 *
 * @module shared/documentExtraction/odf/sheet
 */
import { MAX_SHEET_ROWS, MAX_WORKBOOK_CHARS } from '../sheets.js';
import { attr, is, kids } from './xml.js';

const MAX_COLUMNS = 1000;
const MAX_REPEAT = 1048576; // rows or columns of a sheet in Excel and Calc
const MAX_GROUP_DEPTH = 16; // row groups inside row groups

const countOf = (el, name) => {
  const value = Number(attr(el, 'table', name) ?? 1);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_REPEAT) : 1;
};

/** The text of a cell: what the sheet shows; a cell saved without it, its value. */
function cellText(cell, reader) {
  const text = reader.plainText(cell);
  if (text !== '') return text;
  switch (attr(cell, 'office', 'value-type')) {
    case undefined:
      return '';
    case 'string':
      return attr(cell, 'office', 'string-value') ?? '';
    case 'boolean':
      return attr(cell, 'office', 'boolean-value') ?? '';
    case 'date':
      return attr(cell, 'office', 'date-value') ?? '';
    case 'time':
      return attr(cell, 'office', 'time-value') ?? '';
    default:
      return attr(cell, 'office', 'value') ?? '';
  }
}

/** Whether a cell has anything in it: cheap, for the rows that are only counted. */
function cellHasContent(cell) {
  if (attr(cell, 'office', 'value-type') !== undefined) return true;
  return kids(cell, 'text', 'p').some(paragraph => (paragraph.textContent || '').trim() !== '');
}

/** Value types a cell can have other than text: what the file says is a number, date, … */
const NOT_TEXT = new Set(['float', 'percentage', 'currency', 'date', 'time', 'boolean']);

/** Cell texts of a row, the columns whose cell is not text, and the cells that span rows or columns. */
function readRow(row, reader) {
  const cells = [];
  const typed = [];
  const spans = [];
  let column = 0;
  let content = false;
  let cut = false;
  for (const cell of kids(row)) {
    const covered = is(cell, 'table', 'covered-table-cell');
    if (!covered && !is(cell, 'table', 'table-cell')) continue;
    const repeat = countOf(cell, 'number-columns-repeated');
    if (!covered) {
      const text = cellText(cell, reader);
      if (text !== '') {
        content = true;
        const notText = NOT_TEXT.has(attr(cell, 'office', 'value-type'));
        for (let i = 0; i < repeat && column + i < MAX_COLUMNS; i += 1) {
          cells[column + i] = text;
          if (notText) typed.push(column + i);
        }
        if (column + repeat > MAX_COLUMNS) cut = true;
        const rowspan = countOf(cell, 'number-rows-spanned');
        const colspan = countOf(cell, 'number-columns-spanned');
        if ((rowspan > 1 || colspan > 1) && column < MAX_COLUMNS) {
          spans.push({ column, rowspan, colspan, text });
        }
      }
    }
    column += repeat;
  }
  return { cells, typed, spans, content, cut };
}

const rowHasContent = row => kids(row, 'table', 'table-cell').some(cell => cellHasContent(cell));

/**
 * One sheet. `rowLimit` and `charLimit` stop the reading; the rows after them are counted
 * (`rowsBeyond`), up to the last one that has content.
 */
function readSheet(table, reader, { rowLimit, charLimit }) {
  const rows = []; // by row index of the sheet; empty rows stay holes
  const spans = []; // { row, column, rowspan, colspan, text }
  let rowIndex = 0;
  let readTo = 0; // rows of the sheet that were read: [0, readTo)
  let firstContent = -1;
  let lastContent = -1;
  let limitEnd = rowLimit; // the row limit counts from the first row with content
  let firstTyped = []; // columns of the first row whose cell is not text
  let chars = 0;
  let reading = true;
  let cut = false;

  const visit = (parent, depth) => {
    for (const child of kids(parent)) {
      if (child.namespaceURI !== parent.namespaceURI) continue;
      const name = child.localName;
      if (name === 'table-header-rows' || name === 'table-rows' || name === 'table-row-group') {
        if (depth < MAX_GROUP_DEPTH) visit(child, depth + 1);
      } else if (name === 'table-row') {
        const repeat = countOf(child, 'number-rows-repeated');
        if (reading) {
          const { cells, typed, spans: rowSpans, content, cut: rowCut } = readRow(child, reader);
          if (!content && firstContent < 0) {
            rowIndex += repeat; // empty rows above the data are not rows
            continue;
          }
          if (firstContent < 0) {
            firstContent = rowIndex;
            limitEnd = rowIndex + rowLimit;
            firstTyped = typed;
          }
          // The rows within the row limit — and within the character limit: a row repeated many
          // times is not copied beyond the copy that crosses it (the rest is counted as left
          // out), so a small file cannot make the rendering work on gigabytes of repeated text.
          const rowChars = content
            ? cells.reduce((sum, text) => sum + (text?.length ?? 0) + 1, 0)
            : 0;
          const byChars =
            rowChars > 0 ? Math.floor(Math.max(charLimit - chars, 0) / rowChars) + 1 : Infinity;
          const copies = Math.min(repeat, limitEnd - rowIndex, byChars);
          if (content) {
            for (let i = 0; i < copies; i += 1) {
              rows[rowIndex + i] = cells.slice();
              chars += rowChars;
            }
            for (const span of rowSpans) spans.push({ row: rowIndex, ...span });
            if (rowCut) cut = true;
            lastContent = rowIndex + repeat - 1;
          }
          readTo = rowIndex + copies;
          if (copies < repeat || readTo >= limitEnd || chars >= charLimit) reading = false;
        } else if (rowHasContent(child)) {
          lastContent = rowIndex + repeat - 1;
        }
        rowIndex += repeat;
      }
    }
  };
  visit(table, 0);

  // A cell that spans rows shows its text in each of them.
  for (const span of spans) {
    for (let r = span.row + 1; r < Math.min(span.row + span.rowspan, readTo); r += 1) {
      rows[r] = rows[r] ?? [];
      rows[r][span.column] = span.text;
    }
  }
  const grid = [];
  for (let r = 0; r < readTo; r += 1) {
    const cells = Array.from(rows[r] ?? [], text => text ?? '');
    if (cells.every(text => text === '')) continue;
    grid.push({ r, cells });
  }
  // Columns on the left that are empty in every row are not columns.
  let left = Infinity;
  for (const { cells } of grid) {
    const at = cells.findIndex(text => text !== '');
    if (at >= 0) left = Math.min(left, at);
  }
  if (!Number.isFinite(left)) left = 0;

  // Columns a merged cell of the first row covers: a title over several columns.
  const covered = new Set();
  for (const span of spans) {
    if (span.row === firstContent) {
      for (let c = span.column + 1; c < span.column + span.colspan; c += 1) covered.add(c - left);
    }
  }
  const typed = new Set(firstTyped.filter(c => c >= left).map(c => c - left));
  return {
    rows: grid.map(({ cells }) => cells.slice(left)),
    covered,
    typed,
    rowsBeyond: Math.max(0, lastContent + 1 - readTo),
    chars,
    cut
  };
}

/**
 * @param {Object} args
 * @param {Element} args.spreadsheet - `office:spreadsheet`
 * @param {Object} args.reader - `createOdfReader(...)`
 * @param {Object} args.styles - `readStyles(...)`
 * @param {{sheetRows?: number, workbookChars?: number}} [args.limits]
 * @returns {import('../sheets.js').SheetData[]}
 */
export function odsSheets({ spreadsheet, reader, styles, limits = {} }) {
  const rowLimit = Math.max(limits.sheetRows ?? MAX_SHEET_ROWS, 1);
  let budget = limits.workbookChars ?? MAX_WORKBOOK_CHARS;
  const sheets = [];
  for (const table of kids(spreadsheet, 'table', 'table')) {
    const name = attr(table, 'table', 'name') ?? `Sheet${sheets.length + 1}`;
    const read = readSheet(table, reader, { rowLimit, charLimit: Math.max(budget, 0) });
    budget -= read.chars;
    sheets.push({
      name,
      hidden: styles.tableHidden(attr(table, 'table', 'style-name')),
      rows: read.rows,
      covered: read.covered,
      typed: read.typed,
      rowsBeyond: read.rowsBeyond,
      notices: read.cut ? [`[… columns beyond ${MAX_COLUMNS} omitted]`] : []
    });
  }
  return sheets;
}
