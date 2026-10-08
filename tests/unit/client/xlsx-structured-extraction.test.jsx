/**
 * Spreadsheets in extracted text (concepts/document-extraction/, release 2, WP-D): a sheet with
 * a header row becomes a Markdown table, merged cells keep every row complete, hidden sheets are
 * flagged, and a spreadsheet can no longer fill the context window on its own — rows and
 * characters are capped with a notice. A sheet without a header row, and everything while the
 * admin switch is off, stays the tab-separated text of before.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

jest.mock('../../../shared/documentExtraction/xlsx.js', () => {
  const actual = jest.requireActual('../../../shared/documentExtraction/xlsx.js');
  return { ...actual, extractXlsxText: jest.fn(actual.extractXlsxText) };
});

const XLSX = require('xlsx');
const config = require('../../../client/src/api/endpoints/config');
const {
  extractXlsxText,
  MAX_SHEET_ROWS,
  MAX_WORKBOOK_CHARS,
  SHEET_NOTICE_RESERVE
} = require('../../../shared/documentExtraction/xlsx.js');
const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const { makeFile } = require('../../utils/officeFixtures');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A workbook file from sheets `{ name: rows[][] }` (+ optional per-sheet settings). */
function book(sheets, { hidden = {}, merges = {}, bookType = 'xlsx', name = 'daten.xlsx' } = {}) {
  const workbook = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([sheetName, rows]) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
    if (merges[sheetName])
      sheet['!merges'] = merges[sheetName].map(r => XLSX.utils.decode_range(r));
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  });
  workbook.Workbook = {
    Sheets: Object.keys(sheets).map(n => ({ name: n, Hidden: hidden[n] || 0 }))
  };
  const bytes = XLSX.write(workbook, { type: 'array', bookType });
  const buffer = new Uint8Array(bytes).buffer;
  return makeFile(buffer, name, bookType === 'xlsx' ? XLSX_MIME : 'application/vnd.ms-excel');
}

const extract = async (file, options) => (await processDocumentFile(file, options)).content;

beforeEach(() => {
  config.fetchPlatformConfig.mockReset();
  config.fetchPlatformConfig.mockResolvedValue({ features: [] });
  extractXlsxText.mockClear();
});

describe('sheets with a header row', () => {
  it('T-XLS-01: become Markdown tables, numbers as the sheet shows them', async () => {
    const file = book({
      Preise: [
        ['Artikel', 'Menge', 'Preis'],
        ['Schraube', 10, 0.5],
        ['Mutter', 5, 0.25]
      ]
    });
    expect(await extract(file)).toBe(
      [
        '[Sheet: Preise]',
        '| Artikel | Menge | Preis |',
        '| --- | --- | --- |',
        '| Schraube | 10 | 0.5 |',
        '| Mutter | 5 | 0.25 |'
      ].join('\n')
    );
  });

  it('several sheets are separated; an empty sheet is skipped', async () => {
    const file = book({
      Eins: [
        ['a', 'b'],
        ['1', '2']
      ],
      Leer: [],
      Zwei: [
        ['c', 'd'],
        ['3', '4']
      ]
    });
    expect(await extract(file)).toBe(
      '[Sheet: Eins]\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n[Sheet: Zwei]\n| c | d |\n| --- | --- |\n| 3 | 4 |'
    );
  });

  it('a pipe or a line break in a cell does not break the table', async () => {
    const file = book({
      S: [
        ['Name', 'Notiz'],
        ['a|b', 'erste\nzweite Zeile']
      ]
    });
    expect(await extract(file)).toBe(
      '[Sheet: S]\n| Name | Notiz |\n| --- | --- |\n| a\\|b | erste zweite Zeile |'
    );
  });

  it('T-XLS-02: merged cells — a vertical merge repeats its text in each row, a horizontal one keeps it in the first column', async () => {
    const file = book(
      {
        S: [
          ['Gruppe', 'Name', 'Wert'],
          ['Alpha', 'x', 1],
          [null, 'y', 2],
          ['Beta', 'z', 3]
        ],
        T: [
          ['Jahr 2026', null, 'Summe'],
          ['Q1', 'Q2', 'alles'],
          [1, 2, 3]
        ]
      },
      { merges: { S: ['A2:A3'], T: ['A1:B1'] } }
    );
    expect(await extract(file)).toBe(
      [
        '[Sheet: S]',
        '| Gruppe | Name | Wert |',
        '| --- | --- | --- |',
        '| Alpha | x | 1 |',
        '| Alpha | y | 2 |',
        '| Beta | z | 3 |',
        '',
        '[Sheet: T]',
        '| Jahr 2026 |  | Summe |',
        '| --- | --- | --- |',
        '| Q1 | Q2 | alles |',
        '| 1 | 2 | 3 |'
      ].join('\n')
    );
  });

  it('T-XLS-03: a title merged across the sheet is a title, not the header — the row below is not turned into a table body', async () => {
    const file = book(
      {
        S: [
          ['Bericht 2026', null, null],
          ['Name', 'Betrag', 'Datum'],
          ['a', 1, 'x']
        ]
      },
      { merges: { S: ['A1:C1'] } }
    );
    const text = await extract(file);
    expect(text).not.toContain('| --- |');
    expect(text).toContain('Bericht 2026');
    expect(text).toContain('Name\tBetrag\tDatum');
  });
});

describe('sheets without a header row stay as before', () => {
  it('numbers in the first row, a single row, an incomplete first row: tab-separated text', async () => {
    const file = book({
      Zahlen: [
        [1, 2],
        [3, 4]
      ],
      Eine: [['nur', 'eine Zeile']],
      Luecke: [
        ['Kopf', null],
        ['x', 'y']
      ]
    });
    expect(await extract(file)).toBe(
      '[Sheet: Zahlen]\n1\t2\n3\t4\n\n[Sheet: Eine]\nnur\teine Zeile\n\n[Sheet: Luecke]\nKopf\t\nx\ty'
    );
  });
});

describe('hidden sheets', () => {
  it('are flagged, not dropped', async () => {
    const file = book(
      {
        Sichtbar: [
          ['a', 'b'],
          ['1', '2']
        ],
        Reserve: [
          ['c', 'd'],
          ['3', '4']
        ],
        Intern: [
          ['e', 'f'],
          ['5', '6']
        ]
      },
      { hidden: { Reserve: 1, Intern: 2 } }
    );
    const text = await extract(file);
    expect(text).toContain('[Sheet: Sichtbar]\n');
    expect(text).toContain('[Sheet: Reserve (hidden)]\n');
    expect(text).toContain('[Sheet: Intern (hidden)]\n');
  });
});

describe('size limits', () => {
  it('T-XLS-03: rows beyond the limit are omitted with a notice', async () => {
    const rows = [
      ['Nr', 'Text'],
      ...Array.from({ length: 30 }, (_, i) => [i + 1, `Zeile ${i + 1}`])
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'S');
    const text = extractXlsxText({ XLSX, workbook, limits: { sheetRows: 10 } });
    const lines = text.split('\n');
    expect(lines).toHaveLength(1 + 1 + 1 + 9 + 1);
    expect(lines.at(-2)).toBe('| 9 | Zeile 9 |');
    expect(lines.at(-1)).toBe('[… 21 more rows omitted]');
  });

  it('the budget is a bound even for a workbook of many sheets: titles stop, the rest is counted', async () => {
    const workbook = XLSX.utils.book_new();
    for (let i = 0; i < 400; i += 1) {
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ['Nr', 'Text'],
          [i, 'x'.repeat(40)]
        ]),
        `Sheet${i}`
      );
    }
    const text = extractXlsxText({ XLSX, workbook, limits: { workbookChars: 100 } });
    expect(text.length).toBeLessThan(100 + SHEET_NOTICE_RESERVE + 200);
    expect(text.split('\n').at(-1)).toMatch(/^\[… \d+ more sheets omitted\]$/);
    expect(text).toContain('[Sheet: Sheet0]');
    expect(text).not.toContain('[Sheet: Sheet399]');
  });

  it('a number, date or time first row is data however its format prints it', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      [45931, 'Betrag'],
      ['a', 'b']
    ]);
    sheet.A1.z = 'mmm yyyy'; // prints as "Oct 2025": text that is no number to look at
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'S');
    const text = extractXlsxText({ XLSX, workbook });
    expect(text).not.toContain('| --- |');
    expect(text).toContain('Oct 2025\tBetrag');
  });

  it('the character budget covers the whole workbook: later sheets say what was left out', async () => {
    const big = rows => [
      ['Nr', 'Text'],
      ...Array.from({ length: rows }, (_, i) => [i + 1, 'x'.repeat(50)])
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(big(40)), 'A');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(big(20)), 'B');
    const text = extractXlsxText({ XLSX, workbook, limits: { workbookChars: 1000 } });
    expect(text.length).toBeLessThan(1400);
    expect(text).toMatch(/\[Sheet: A\][\s\S]*\[… \d+ more rows omitted\]/);
    expect(text).toMatch(/\[Sheet: B\]\n\[… 21 rows omitted\]/);
  });

  it('the defaults protect a context window: 2,000 rows per sheet, 300,000 characters per workbook', () => {
    expect(MAX_SHEET_ROWS).toBe(2000);
    expect(MAX_WORKBOOK_CHARS).toBe(300000);
  });

  it('a very large sheet is cut quickly', async () => {
    const rows = [['Nr', 'Wert'], ...Array.from({ length: 60000 }, (_, i) => [i, `Wert ${i}`])];
    const file = book({ Gross: rows });
    const started = Date.now();
    const text = await extract(file);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(text).toContain('[… 58001 more rows omitted]');
    expect(text.length).toBeLessThan(MAX_WORKBOOK_CHARS + 1000);
  });
});

describe('formats, the switch and the fallback', () => {
  it('a binary .xls is read the same way', async () => {
    const file = book(
      {
        S: [
          ['a', 'b'],
          ['1', '2']
        ]
      },
      { bookType: 'biff8', name: 'alt.xls' }
    );
    expect(await extract(file)).toBe('[Sheet: S]\n| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('T-XLS-04: switch off — tab-separated text of every sheet, as before', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const file = book({
      S: [
        ['a', 'b'],
        ['1', '2']
      ]
    });
    expect(await extract(file)).toBe('[Sheet: S]\na\tb\n1\t2');
    expect(extractXlsxText).not.toHaveBeenCalled();
  });

  it('a failing structured step falls back to the text of before', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    extractXlsxText.mockImplementationOnce(() => {
      throw new Error('unexpected');
    });
    expect(
      await extract(
        book({
          S: [
            ['a', 'b'],
            ['1', '2']
          ]
        })
      )
    ).toBe('[Sheet: S]\na\tb\n1\t2');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an empty workbook has no text', async () => {
    expect(await extract(book({ Leer: [] }))).toBe('');
  });
});
