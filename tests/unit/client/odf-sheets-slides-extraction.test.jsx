/**
 * OpenDocument spreadsheets and presentations in extracted text (concepts/document-extraction/,
 * release 2, WP-C): a sheet with a header row becomes a Markdown table exactly like an Excel
 * sheet (same limits, same hidden-sheet flag), a slide is written like a PowerPoint slide (title
 * as heading, hidden slides flagged, speaker notes only on request). The structures here are the
 * ones LibreOffice writes — repeated empty cells and rows, `covered-table-cell`, the visibility
 * of a slide in its page style. The behaviour of before stays whenever the admin switch is off.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

jest.mock('../../../shared/documentExtraction/odf.js', () => {
  const actual = jest.requireActual('../../../shared/documentExtraction/odf.js');
  return { ...actual, extractOdfText: jest.fn(actual.extractOdfText) };
});

const JSZip = require('jszip');
const config = require('../../../client/src/api/endpoints/config');
const { extractOdfText } = require('../../../shared/documentExtraction/odf.js');
const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const { buildOdfFile, odfP: p } = require('../../utils/officeFixtures');
const { SHEET_NOTICE_RESERVE } = require('../../../shared/documentExtraction/sheets.js');

beforeEach(() => {
  config.fetchPlatformConfig.mockReset();
  config.fetchPlatformConfig.mockResolvedValue({ features: [] });
  extractOdfText.mockClear();
});

// ---- spreadsheets ------------------------------------------------------------------------

const text = (shown, attrs = '') =>
  `<table:table-cell office:value-type="string" ${attrs}>${p(shown)}</table:table-cell>`;
const number = (value, shown = String(value), attrs = '') =>
  `<table:table-cell office:value-type="float" office:value="${value}" ${attrs}>${p(shown)}</table:table-cell>`;
const blanks = count => `<table:table-cell table:number-columns-repeated="${count}"/>`;
const row = (...cells) => `<table:table-row>${cells.join('')}</table:table-row>`;
const sheet = (name, rows, style = '') =>
  `<table:table table:name="${name}"${style ? ` table:style-name="${style}"` : ''}>${rows.join('')}</table:table>`;

const hiddenStyle = (name, hidden) =>
  `<style:style style:name="${name}" style:family="table"><style:table-properties table:display="${hidden ? 'false' : 'true'}"/></style:style>`;

const extractSheets = async (sheets, { automatic = '', options, name } = {}) =>
  (
    await processDocumentFile(
      await buildOdfFile({ type: 'spreadsheet', body: sheets.join(''), automatic }, name),
      options
    )
  ).content;

/** The reader called directly, to set limits that the app does not set. */
async function extractWithLimits(sheets, limits) {
  const file = await buildOdfFile({ type: 'spreadsheet', body: sheets.join('') });
  return extractOdfText({
    arrayBuffer: await file.arrayBuffer(),
    JSZip,
    DOMParser,
    limits
  });
}

describe('spreadsheets with a header row', () => {
  it('T-ODS-01: become Markdown tables, numbers as the sheet shows them', async () => {
    const body = sheet('Preise', [
      row(text('Artikel'), text('Menge'), text('Anteil'), blanks(16381)),
      row(text('Schraube'), number(10), number(0.256, '25.6%'), blanks(16381)),
      row(text('Mutter'), number(5), number(0.5, '50.0%'), blanks(16381))
    ]);
    expect(await extractSheets([body])).toBe(
      [
        '[Sheet: Preise]',
        '| Artikel | Menge | Anteil |',
        '| --- | --- | --- |',
        '| Schraube | 10 | 25.6% |',
        '| Mutter | 5 | 50.0% |'
      ].join('\n')
    );
  });

  it('a cell saved without its display text shows its value', async () => {
    const bare = (type, attrs) => `<table:table-cell office:value-type="${type}" ${attrs}/>`;
    const body = sheet('Werte', [
      row(text('Art'), text('Wert')),
      row(text('Zahl'), bare('float', 'office:value="42.5"')),
      row(text('Text'), bare('string', 'office:string-value="ohne Anzeige"')),
      row(text('Ja/Nein'), bare('boolean', 'office:boolean-value="true"')),
      row(text('Datum'), bare('date', 'office:date-value="2026-01-15"'))
    ]);
    expect(await extractSheets([body])).toBe(
      [
        '[Sheet: Werte]',
        '| Art | Wert |',
        '| --- | --- |',
        '| Zahl | 42.5 |',
        '| Text | ohne Anzeige |',
        '| Ja/Nein | true |',
        '| Datum | 2026-01-15 |'
      ].join('\n')
    );
  });

  it('several sheets are separated; an empty sheet is skipped; a pipe or line break does not break the table', async () => {
    const one = sheet('Eins', [row(text('a'), text('b')), row(text('1'), text('2'))]);
    const none = sheet('Leer', [row(blanks(16384))]);
    const two = sheet('Zwei', [
      row(text('Name'), text('Notiz')),
      row(
        text('a|b'),
        `<table:table-cell office:value-type="string">${p('erste')}${p('zweite Zeile')}</table:table-cell>`
      )
    ]);
    expect(await extractSheets([one, none, two])).toBe(
      '[Sheet: Eins]\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n[Sheet: Zwei]\n| Name | Notiz |\n| --- | --- |\n| a\\|b | erste zweite Zeile |'
    );
  });

  it('empty rows and columns that are stored as a repeat count cost nothing and show nothing', async () => {
    const body = sheet('Weit', [
      `<table:table-row table:number-rows-repeated="3">${blanks(16384)}</table:table-row>`,
      row(blanks(2), text('Name'), text('Wert')),
      row(blanks(2), text('x'), number(1)),
      `<table:table-row table:number-rows-repeated="1048570">${blanks(16384)}</table:table-row>`
    ]);
    const started = Date.now();
    expect(await extractSheets([body])).toBe(
      '[Sheet: Weit]\n| Name | Wert |\n| --- | --- |\n| x | 1 |'
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('T-ODS-02: merged cells — a row span repeats its text in each row, a column span keeps it in the first column', async () => {
    const covered = '<table:covered-table-cell/>';
    const grouped = sheet('S', [
      row(text('Gruppe'), text('Name'), text('Wert')),
      row(
        text('Alpha', 'table:number-rows-spanned="2" table:number-columns-spanned="1"'),
        text('x'),
        number(1)
      ),
      row(covered, text('y'), number(2)),
      row(text('Beta'), text('z'), number(3))
    ]);
    const titled = sheet('T', [
      row(
        text('Jahr 2026', 'table:number-columns-spanned="2" table:number-rows-spanned="1"'),
        covered,
        text('Summe')
      ),
      row(text('Q1'), text('Q2'), text('alles')),
      row(number(1), number(2), number(3))
    ]);
    expect(await extractSheets([grouped, titled])).toBe(
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

  it('the comment of a cell is not part of its text', async () => {
    const commented = `<table:table-cell office:value-type="string"><office:annotation><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Eva</dc:creator>${p('Bitte prüfen')}</office:annotation>${p('Preis')}</table:table-cell>`;
    const body = sheet('S', [row(text('Art'), commented), row(text('x'), number(1))]);
    expect(await extractSheets([body])).toBe(
      '[Sheet: S]\n| Art | Preis |\n| --- | --- |\n| x | 1 |'
    );
  });
});

describe('spreadsheets without a header row stay as before', () => {
  it('numbers in the first row, a single row, an incomplete first row: tab-separated text', async () => {
    const numbers = sheet('Zahlen', [row(number(1), number(2)), row(number(3), number(4))]);
    const single = sheet('Eine', [row(text('nur'), text('eine Zeile'))]);
    const gap = sheet('Luecke', [
      row(text('Kopf'), blanks(1), text('x')),
      row(text('x'), text('y'), text('z'))
    ]);
    expect(await extractSheets([numbers, single, gap])).toBe(
      '[Sheet: Zahlen]\n1\t2\n3\t4\n\n[Sheet: Eine]\nnur\teine Zeile\n\n[Sheet: Luecke]\nKopf\t\tx\nx\ty\tz'
    );
  });
});

describe('hidden sheets', () => {
  it('are flagged, not dropped', async () => {
    const data = [row(text('a'), text('b')), row(text('1'), text('2'))];
    expect(
      await extractSheets(
        [sheet('Sichtbar', data, 'ta1'), sheet('Reserve', data, 'ta2'), sheet('Ohne Stil', data)],
        { automatic: hiddenStyle('ta1', false) + hiddenStyle('ta2', true) }
      )
    ).toMatch(
      /\[Sheet: Sichtbar\]\n[\s\S]*\[Sheet: Reserve \(hidden\)\]\n[\s\S]*\[Sheet: Ohne Stil\]\n/
    );
  });
});

describe('size limits', () => {
  const dataRows = count =>
    Array.from({ length: count }, (_, i) => row(number(i + 1), text(`Zeile ${i + 1}`)));

  it('T-ODS-03: rows beyond the limit are omitted with a notice — counted, not read', async () => {
    const body = sheet('S', [row(text('Nr'), text('Text')), ...dataRows(30)]);
    const lines = (await extractWithLimits([body], { sheetRows: 10 })).split('\n');
    expect(lines).toHaveLength(1 + 1 + 1 + 9 + 1);
    expect(lines.at(-2)).toBe('| 9 | Zeile 9 |');
    expect(lines.at(-1)).toBe('[… 21 more rows omitted]');
  });

  it('empty rows above the data do not use up the limit; empty rows after it are not counted as omitted', async () => {
    const body = sheet('S', [
      `<table:table-row table:number-rows-repeated="500">${blanks(16384)}</table:table-row>`,
      row(text('Nr'), text('Text')),
      ...dataRows(3),
      `<table:table-row table:number-rows-repeated="1000000">${blanks(16384)}</table:table-row>`
    ]);
    expect(await extractWithLimits([body], { sheetRows: 10 })).toBe(
      '[Sheet: S]\n| Nr | Text |\n| --- | --- |\n| 1 | Zeile 1 |\n| 2 | Zeile 2 |\n| 3 | Zeile 3 |'
    );
  });

  it('a row that is stored once and repeated past the limit is cut at the limit', async () => {
    const body = sheet('S', [
      row(text('Nr'), text('Text')),
      `<table:table-row table:number-rows-repeated="100">${text('x')}${text('y')}</table:table-row>`
    ]);
    const lines = (await extractWithLimits([body], { sheetRows: 5 })).split('\n');
    expect(lines.at(-1)).toBe('[… 96 more rows omitted]');
    expect(lines.filter(line => line === '| x | y |')).toHaveLength(4);
  });

  it('a large cell in a row that is repeated 2,000 times is not copied past the character budget', async () => {
    const huge = 'x'.repeat(1_000_000);
    const body = sheet('S', [
      row(text('Nr'), text('Text')),
      `<table:table-row table:number-rows-repeated="2000">${text('1')}${text(huge)}</table:table-row>`
    ]);
    const started = Date.now();
    const output = await extractWithLimits([body], { workbookChars: 100000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(output.length).toBeLessThan(110000);
    // Everything that was not written is counted, copies included.
    expect(output.split('\n').at(-1)).toMatch(/^\[… 2000 more rows omitted\]$/);
  });

  it('a first row of numbers, dates or times is data however the sheet prints it', async () => {
    const body = sheet('S', [
      row(number(45931, 'Oct 2026'), text('Betrag')),
      row(text('a'), text('b'))
    ]);
    const output = await extractWithLimits([body], {});
    expect(output).not.toContain('| --- |');
    expect(output).toContain('Oct 2026\tBetrag');
  });

  it('the budget is a bound for many sheets: titles stop, the rest is counted', async () => {
    const sheets = Array.from({ length: 400 }, (_, i) =>
      sheet(`Sheet${i}`, [row(text('Nr'), text('Text')), row(number(i), text('x'.repeat(40)))])
    );
    const output = await extractWithLimits(sheets, { workbookChars: 100 });
    expect(output.length).toBeLessThan(100 + SHEET_NOTICE_RESERVE + 200);
    expect(output.split('\n').at(-1)).toMatch(/^\[… \d+ more sheets omitted\]$/);
    expect(output).toContain('[Sheet: Sheet0]');
    expect(output).not.toContain('[Sheet: Sheet399]');
  });

  it('the character budget covers the whole workbook: later sheets say what was left out', async () => {
    const big = rows => [
      row(text('Nr'), text('Text')),
      ...Array.from({ length: rows }, (_, i) => row(number(i + 1), text('x'.repeat(50))))
    ];
    const output = await extractWithLimits([sheet('A', big(40)), sheet('B', big(20))], {
      workbookChars: 1000
    });
    expect(output.length).toBeLessThan(1400);
    expect(output).toMatch(/\[Sheet: A\][\s\S]*\[… \d+ more rows omitted\]/);
    expect(output).toMatch(/\[Sheet: B\]\n\[… 21 rows omitted\]/);
  });

  it('a very wide sheet is cut at 1,000 columns and says so', async () => {
    const wide = `<table:table-cell office:value-type="float" office:value="1" table:number-columns-repeated="1500">${p('1')}</table:table-cell>`;
    const output = await extractWithLimits([sheet('S', [row(wide), row(wide)])]);
    const lines = output.split('\n');
    expect(lines.at(-1)).toBe('[… columns beyond 1000 omitted]');
    expect(lines[1].split('\t')).toHaveLength(1000);
  });

  it('a very large sheet is cut quickly', async () => {
    const started = Date.now();
    const output = await extractSheets([
      sheet('Gross', [row(text('Nr'), text('Wert')), ...dataRows(60000)])
    ]);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(output).toContain('[… 58001 more rows omitted]');
    expect(output.length).toBeLessThan(301000);
  });
});

describe('spreadsheets: the switch and the fallback', () => {
  it('T-ODS-04: switch off — every text node, as before', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const output = await extractSheets([
      sheet('S', [row(text('Name'), text('Wert')), row(text('a'), number(1))])
    ]);
    expect(output.split('\n').filter(Boolean)).toEqual(['Name', 'Wert', 'a', '1']);
    expect(extractOdfText).not.toHaveBeenCalled();
  });

  it('a failing structured step falls back to the text of before', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    extractOdfText.mockImplementationOnce(async () => {
      throw new Error('unexpected');
    });
    const output = await extractSheets([sheet('S', [row(text('Name'), text('Wert'))])]);
    expect(output).toContain('Name');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an empty spreadsheet has no text', async () => {
    expect(await extractSheets([sheet('Leer', [])])).toBe('');
  });
});

// ---- presentations -----------------------------------------------------------------------

const box = (paragraphs, cls = '') =>
  `<draw:frame${cls ? ` presentation:class="${cls}"` : ''}><draw:text-box>${paragraphs
    .map(t => p(t))
    .join('')}</draw:text-box></draw:frame>`;
const slide = (shapes, style = '') =>
  `<draw:page draw:name="Folie"${style ? ` draw:style-name="${style}"` : ''}>${shapes.join('')}</draw:page>`;
const notes = (...shapes) => `<presentation:notes>${shapes.join('')}</presentation:notes>`;
const slideStyle = (name, hidden, parent = '') =>
  `<style:style style:name="${name}" style:family="drawing-page"${parent ? ` style:parent-style-name="${parent}"` : ''}><style:drawing-page-properties ${hidden ? 'presentation:visibility="hidden"' : ''}/></style:style>`;

const DOTS =
  '<text:list-style style:name="Dots"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/><text:list-level-style-bullet text:level="2" text:bullet-char="–"/></text:list-style>';

const extractSlides = async (slides, { automatic = '', options } = {}) =>
  (
    await processDocumentFile(
      await buildOdfFile({ type: 'presentation', body: slides.join(''), automatic }),
      options
    )
  ).content;

describe('presentations', () => {
  it('T-ODP-01: slides in the order of the file, the title as a heading, text in the order of the shapes', async () => {
    const outline =
      '<draw:frame presentation:class="outline"><draw:text-box><text:list text:style-name="Dots"><text:list-item>' +
      p('Umsatz steigt') +
      '<text:list><text:list-item>' +
      p('Europa +5%') +
      '</text:list-item></text:list></text:list-item><text:list-item>' +
      p('Kosten sinken') +
      '</text:list-item></text:list></draw:text-box></draw:frame>';
    expect(
      await extractSlides(
        [
          slide([box(['Quartalsbericht'], 'title'), box(['Stand: Oktober'], 'subtitle'), outline]),
          slide([box(['Ausblick'], 'title'), box(['Wachstum'])])
        ],
        { automatic: DOTS }
      )
    ).toBe(
      [
        '[Slide 1]',
        '# Quartalsbericht',
        'Stand: Oktober',
        '- Umsatz steigt',
        '  - Europa +5%',
        '- Kosten sinken',
        '',
        '[Slide 2]',
        '# Ausblick',
        'Wachstum'
      ].join('\n')
    );
  });

  it('lists keep their bullets and numbers; shapes with text of their own, groups and links are read', async () => {
    const list =
      '<draw:frame><draw:text-box><text:list text:style-name="N"><text:list-item>' +
      p('erstens') +
      '</text:list-item><text:list-item>' +
      p('zweitens') +
      '</text:list-item></text:list></draw:text-box></draw:frame>';
    const styles =
      '<text:list-style style:name="N"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/></text:list-style>';
    const shapes = [
      list,
      `<draw:custom-shape>${p('Nur im Kasten')}<draw:enhanced-geometry draw:type="rectangle"/></draw:custom-shape>`,
      `<draw:g>${box(['In der Gruppe'])}<draw:g>${box(['Tief verschachtelt'])}</draw:g></draw:g>`,
      `<draw:a xlink:href="https://example.org">${box(['Mit Link'])}</draw:a>`,
      '<draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame>'
    ];
    const file = await buildOdfFile({
      type: 'presentation',
      body: slide(shapes),
      automatic: styles
    });
    expect((await processDocumentFile(file)).content).toBe(
      '[Slide 1]\n1. erstens\n2. zweitens\nNur im Kasten\nIn der Gruppe\nTief verschachtelt\nMit Link'
    );
  });

  it('T-ODP-02: a hidden slide is flagged, not dropped — by its page style, also an inherited one', async () => {
    const automatic =
      slideStyle('dp1', false) + slideStyle('dp2', true) + slideStyle('dp3', false, 'dp2');
    const output = await extractSlides(
      [
        slide([box(['sichtbar'], 'title')], 'dp1'),
        slide([box(['versteckt'], 'title')], 'dp2'),
        slide([box(['auch versteckt'], 'title')], 'dp3')
      ],
      { automatic }
    );
    expect(output).toBe(
      '[Slide 1]\n# sichtbar\n\n[Slide 2 (hidden)]\n# versteckt\n\n[Slide 3 (hidden)]\n# auch versteckt'
    );
  });

  it('slide number and date placeholders are not content; an empty slide is skipped, the numbering goes on', async () => {
    const output = await extractSlides([
      slide([box(['Erste'], 'title'), box(['7'], 'page-number'), box(['08.10.2026'], 'date-time')]),
      slide([box([''], 'title'), box(['  '])]),
      slide([box(['Dritte'], 'title')])
    ]);
    expect(output).toBe('[Slide 1]\n# Erste\n\n[Slide 3]\n# Dritte');
  });

  it('T-ODP-03: tables become Markdown tables; the header is the first row when the table says so', async () => {
    const table = (attrs, rows) =>
      `<draw:frame><table:table ${attrs}>${rows
        .map(
          r =>
            `<table:table-row>${r.map(c => `<table:table-cell>${p(c)}</table:table-cell>`).join('')}</table:table-row>`
        )
        .join('')}</table:table></draw:frame>`;
    const output = await extractSlides([
      slide([
        box(['Zahlen'], 'title'),
        table('table:use-first-row-styles="true"', [
          ['Region', 'Umsatz'],
          ['Nord', '10'],
          ['Süd', '20']
        ])
      ]),
      slide([
        box(['Ohne Kopf'], 'title'),
        table('', [
          ['Nord', '10'],
          ['Süd', '20']
        ])
      ])
    ]);
    expect(output).toBe(
      [
        '[Slide 1]',
        '# Zahlen',
        '',
        '| Region | Umsatz |',
        '| --- | --- |',
        '| Nord | 10 |',
        '| Süd | 20 |',
        '',
        '[Slide 2]',
        '# Ohne Kopf',
        '',
        '| Nord | 10 |',
        '| Süd | 20 |'
      ].join('\n')
    );
  });

  it('T-ODP-04: speaker notes only for an app that asks for them; layout placeholders of the notes page are not notes', async () => {
    const thumbnail = '<draw:page-thumbnail presentation:class="page" draw:page-number="1"/>';
    const slides = [
      slide([
        box(['Folie mit Notizen'], 'title'),
        notes(
          thumbnail,
          box(['Zahlen nennen.', 'Nach Fragen fragen.'], 'notes'),
          box(['Fußzeile'], 'footer'),
          box(['3'], 'page-number')
        )
      ]),
      slide([notes(box(['Nur eine Notiz']))])
    ];
    expect(await extractSlides(slides)).toBe('[Slide 1]\n# Folie mit Notizen');
    expect(await extractSlides(slides, { options: { speakerNotes: 'include' } })).toBe(
      '[Slide 1]\n# Folie mit Notizen\n[Notes]\nZahlen nennen.\nNach Fragen fragen.\n\n[Slide 2]\n[Notes]\nNur eine Notiz'
    );
  });

  it('T-ODP-05: switch off — every text node, as before', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const output = await extractSlides([slide([box(['Titel'], 'title'), box(['Text'])])]);
    expect(output.split('\n').filter(Boolean)).toEqual(['Titel', 'Text']);
    expect(extractOdfText).not.toHaveBeenCalled();
  });

  it('a presentation without slides has no text', async () => {
    expect(await extractSlides([])).toBe('');
  });
});
