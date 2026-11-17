// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { parseStructured } from '../documentToolHelpers.js';
import { GeneratedFileError } from '../generatedFiles.js';

/**
 * Sheet operations of `edit_xlsx`: set cells, append, insert and delete
 * rows, and replace, add, delete or rename sheets of a workbook's stored
 * `sheets`, without the model writing the others again.
 *
 * Cells are addressed as in Excel: row 1 is the header row (the sheet's
 * `columns`), row 2 is `rows[0]`. Formulas are text and are not adjusted when
 * rows move; the tool says so in its description.
 *
 * @module services/documents/xlsx/xlsxEdit
 */

/** Most sheet operations one call may carry. */
export const MAX_SHEET_CHANGES = 100;

/** Most sheets a workbook may have (as `create_xlsx`). */
const MAX_SHEETS = 20;

/** Most cells one `setCells` may write. */
const MAX_CELLS_PER_CHANGE = 10000;

const OPS = [
  'setCells',
  'appendRows',
  'insertRows',
  'deleteRows',
  'replaceSheet',
  'addSheet',
  'deleteSheet',
  'renameSheet'
];

function invalid(message) {
  return new GeneratedFileError(message, 'invalid');
}

/** Column letters to a 0-based index: A → 0, AA → 26. */
export function columnIndexOf(letters) {
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** `"B3"` → `{ row: 3, column: 1 }`. */
function cellOf(value, where) {
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/.exec(String(value ?? '').trim());
  if (!match) throw invalid(`${where} must be a cell such as "B3".`);
  return { row: Number(match[2]), column: columnIndexOf(match[1]) };
}

/** The index of a sheet named (case-insensitive) or numbered (1-based) by `ref`. */
function sheetIndexOf(sheets, ref, where) {
  if (Number.isInteger(ref) && ref >= 1 && ref <= sheets.length) return ref - 1;
  const name = String(ref ?? '')
    .trim()
    .toLowerCase();
  const index = sheets.findIndex(sheet => String(sheet?.name || '').toLowerCase() === name);
  if (index < 0) {
    const names = sheets.map((sheet, i) => `"${sheet?.name || `Sheet ${i + 1}`}"`).join(', ');
    throw invalid(`${where}: no sheet "${ref}". The workbook has: ${names}.`);
  }
  return index;
}

/** A list of rows from an operation. */
function rowsOf(value, where) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${where} must be a non-empty list of rows, as in create_xlsx.`);
  }
  return value;
}

/** A sheet object from an operation. */
function sheetOf(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${where} must be a sheet object, as in create_xlsx.`);
  }
  return value;
}

/** The cells of a row, whether it is a plain list or `{ cells, … }`; written back by `set`. */
function cellsOfRow(row) {
  if (Array.isArray(row)) return { cells: row, set: cells => cells };
  if (row && typeof row === 'object' && Array.isArray(row.cells)) {
    return { cells: row.cells, set: cells => ({ ...row, cells }) };
  }
  return { cells: [], set: cells => cells };
}

/** Write a block of values into a sheet, starting at `cell`; row 1 is the header. */
function setCells(sheet, cell, values, where) {
  if (!Array.isArray(values) || values.length === 0 || !values.every(Array.isArray)) {
    throw invalid(`${where}.values must be a list of rows, each a list of values: [["a", 1]].`);
  }
  const count = values.reduce((sum, row) => sum + row.length, 0);
  if (count > MAX_CELLS_PER_CHANGE) {
    throw invalid(
      `${where} writes ${count} cells; one operation writes at most ${MAX_CELLS_PER_CHANGE}.`
    );
  }
  const start = cellOf(cell, `${where}.cell`);
  const next = { ...sheet, rows: [...(Array.isArray(sheet.rows) ? sheet.rows : [])] };
  values.forEach((rowValues, i) => {
    const rowNumber = start.row + i;
    if (rowNumber === 1) {
      const columns = [...(Array.isArray(next.columns) ? next.columns : [])];
      rowValues.forEach((value, j) => {
        const at = start.column + j;
        while (columns.length <= at) columns.push({ header: '' });
        const column = columns[at];
        columns[at] =
          column && typeof column === 'object'
            ? { ...column, header: String(value ?? '') }
            : { header: String(value ?? '') };
      });
      next.columns = columns;
      return;
    }
    const at = rowNumber - 2;
    while (next.rows.length <= at) next.rows.push([]);
    const { cells, set } = cellsOfRow(next.rows[at]);
    const updated = [...cells];
    rowValues.forEach((value, j) => {
      const column = start.column + j;
      while (updated.length <= column) updated.push(null);
      updated[column] = value;
    });
    next.rows[at] = set(updated);
  });
  return next;
}

/** A row number (≥ 2, as in Excel) that exists in the sheet, or one past its last row. */
function rowNumberOf(value, sheet, where, { allowEnd = false } = {}) {
  const last = (Array.isArray(sheet.rows) ? sheet.rows.length : 0) + 1;
  const max = allowEnd ? last + 1 : last;
  if (!Number.isInteger(value) || value < 2 || value > max) {
    throw invalid(
      `${where} must be a row number from 2 to ${max} (row 1 is the header; the sheet's last row is ${last}).`
    );
  }
  return value;
}

/**
 * Apply sheet operations to a workbook's sheets, all or none.
 *
 * @param {Array<Object>} sheets - The stored sheets; not changed.
 * @param {unknown} value - `changes`, as a list or its JSON.
 * @returns {Array<Object>} The changed copy.
 */
export function applySheetChanges(sheets, value) {
  const changes = parseStructured(value, 'changes', 'a list of sheet operations');
  if (changes === undefined) return sheets;
  if (!Array.isArray(changes)) throw invalid('"changes" must be a list of sheet operations.');
  if (changes.length > MAX_SHEET_CHANGES) {
    throw invalid(`One call can carry at most ${MAX_SHEET_CHANGES} sheet operations.`);
  }
  const book = structuredClone(sheets);
  changes.forEach((change, index) => {
    const where = `changes[${index}]`;
    const op = change?.op;
    if (!OPS.includes(op)) throw invalid(`${where}.op must be one of: ${OPS.join(', ')}.`);
    if (op === 'addSheet') {
      if (book.length >= MAX_SHEETS) throw invalid(`A workbook has at most ${MAX_SHEETS} sheets.`);
      const sheet = sheetOf(change.sheet, `${where}.sheet`);
      const after =
        change.after === undefined
          ? book.length
          : sheetIndexOf(book, change.after, `${where}.after`) + 1;
      book.splice(after, 0, sheet);
      return;
    }
    const at = sheetIndexOf(book, change.sheet, `${where}.sheet`);
    const sheet = book[at];
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (op === 'setCells') {
      book[at] = setCells(sheet, change.cell, change.values, where);
    } else if (op === 'appendRows') {
      book[at] = { ...sheet, rows: [...rows, ...rowsOf(change.rows, `${where}.rows`)] };
    } else if (op === 'insertRows') {
      const before = rowNumberOf(change.before, sheet, `${where}.before`, { allowEnd: true });
      const next = [...rows];
      next.splice(before - 2, 0, ...rowsOf(change.rows, `${where}.rows`));
      book[at] = { ...sheet, rows: next };
    } else if (op === 'deleteRows') {
      const from = rowNumberOf(change.row, sheet, `${where}.row`);
      const count = change.count === undefined ? 1 : change.count;
      if (!Number.isInteger(count) || count < 1 || from - 2 + count > rows.length) {
        throw invalid(`${where}.count must be at least 1 and stay within the sheet's rows.`);
      }
      const next = [...rows];
      next.splice(from - 2, count);
      book[at] = { ...sheet, rows: next };
    } else if (op === 'replaceSheet') {
      book[at] = sheetOf(change.with, `${where}.with`);
    } else if (op === 'deleteSheet') {
      if (book.length === 1) throw invalid('A workbook keeps at least one sheet.');
      book.splice(at, 1);
    } else {
      const to = typeof change.to === 'string' ? change.to.trim() : '';
      if (!to) throw invalid(`${where}.to must be the new sheet name.`);
      book[at] = { ...sheet, name: to };
    }
  });
  return book;
}
