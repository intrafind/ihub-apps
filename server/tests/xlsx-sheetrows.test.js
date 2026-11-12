// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Excel extraction reads only the rows it can use (#3648): the workbook is read with
 * `sheetRows` = row limit + 1, yet a workbook with more rows than the limit is still flagged
 * truncated (through `!fullref`) and its text is identical to the text of a full read.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractText } from '../services/projects/extractText.js';
import {
  MAX_SHEET_ROWS,
  extractXlsxText,
  readWorkbook
} from '../../shared/documentExtraction/xlsx.js';

const XLSX = (await import('xlsx')).default || (await import('xlsx'));

function makeBook(sheets, { merges = {} } = {}) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    if (merges[name]) sheet['!merges'] = merges[name].map(r => XLSX.utils.decode_range(r));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

const table = (rows, cols = 3) => [
  Array.from({ length: cols }, (_, c) => `Col${c}`),
  ...Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`))
];

/** What the extraction produced before: a full read, then the limits. */
function baseline(bytes, limits = {}) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  const report = {};
  const text = extractXlsxText({ XLSX, workbook, limits, report });
  return { text, truncated: !!report.truncated };
}

async function extracted(bytes, sheetRows) {
  const result = await extractText(
    { bytes, name: 'data.xlsx' },
    sheetRows ? { sheetRows } : undefined
  );
  return { text: result.text, truncated: result.truncated };
}

describe('xlsx read with sheetRows', () => {
  it('reads only limit + 1 rows of a large sheet but keeps the real extent in !fullref', () => {
    const bytes = makeBook({ Big: table(MAX_SHEET_ROWS + 500) });
    const workbook = readWorkbook({
      XLSX,
      data: bytes,
      readOptions: { type: 'buffer', cellDates: true }
    });
    const sheet = workbook.Sheets.Big;
    assert.equal(XLSX.utils.decode_range(sheet['!ref']).e.r, MAX_SHEET_ROWS);
    assert.equal(XLSX.utils.decode_range(sheet['!fullref']).e.r, MAX_SHEET_ROWS + 500);
  });

  it('flags a workbook with more rows than the limit as truncated, text unchanged', async () => {
    const bytes = makeBook({ Big: table(MAX_SHEET_ROWS + 500) });
    const expected = baseline(bytes);
    assert.equal(expected.truncated, true);
    assert.match(expected.text, /500 more rows omitted|rows omitted/);
    assert.deepEqual(await extracted(bytes), expected);
  });

  it('does not flag a sheet that is exactly at the limit, or one row over it', async () => {
    // Header + MAX_SHEET_ROWS - 1 data rows = exactly the limit; one more row is over it.
    for (const rows of [MAX_SHEET_ROWS - 1, MAX_SHEET_ROWS]) {
      const bytes = makeBook({ S: table(rows) });
      const expected = baseline(bytes);
      assert.deepEqual(await extracted(bytes), expected, `${rows} data rows`);
    }
    assert.equal((await extracted(makeBook({ S: table(MAX_SHEET_ROWS - 1) }))).truncated, false);
    assert.equal((await extracted(makeBook({ S: table(MAX_SHEET_ROWS) }))).truncated, true);
  });

  it('honours a caller sheetRows, header included', async () => {
    const bytes = makeBook({ S: table(10) });
    for (const sheetRows of [1, 2, 5, 11, 12]) {
      assert.deepEqual(await extracted(bytes, sheetRows), baseline(bytes, { sheetRows }));
    }
    assert.equal((await extracted(bytes, 5)).truncated, true);
    assert.equal((await extracted(bytes, 11)).truncated, false);
  });

  it('keeps several sheets, merged cells and the cell limit identical', async () => {
    const bytes = makeBook(
      {
        Small: table(4),
        Wide: table(MAX_SHEET_ROWS + 50, 40),
        Merged: [
          ['Group', 'Item'],
          ['A', 'x'],
          [null, 'y'],
          [null, 'z']
        ]
      },
      { merges: { Merged: ['A2:A4'] } }
    );
    assert.deepEqual(await extracted(bytes), baseline(bytes));
  });

  it('reads in full a sheet whose data starts below row 1, as before', async () => {
    const rows = [...Array.from({ length: 3 }, () => []), ...table(MAX_SHEET_ROWS + 20)];
    const bytes = makeBook({ Shifted: rows });
    assert.deepEqual(await extracted(bytes), baseline(bytes));
  });

  it('reads a file that is not an .xlsx package in full', () => {
    const csv = Buffer.from('a,b\n1,2\n3,4\n5,6\n');
    const workbook = readWorkbook({
      XLSX,
      data: csv,
      readOptions: { type: 'buffer' },
      limits: { sheetRows: 1 }
    });
    assert.equal(XLSX.utils.decode_range(workbook.Sheets.Sheet1['!ref']).e.r, 3);
  });
});
