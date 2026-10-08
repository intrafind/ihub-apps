/**
 * Headings and tables in extracted PDF text (concepts/document-extraction/, release 2, WP-F):
 * the tagged structure tree, the outline and the font-size heuristic, in that order of trust.
 *
 * pdf.js is ESM-only and cannot be loaded by jest, so the pure functions run on items and trees
 * shaped like real pdf.js output (`getTextContent({ includeMarkedContent: true })`,
 * `getStructTree()`, `getOutline()`); server/tests/document-extraction-pdf-structure.test.js
 * runs the same code on real pdf.js and real PDFs.
 */
import '@testing-library/jest-dom';

const {
  assemblePdfText,
  buildPdfPage,
  extractPdfText,
  readOutline
} = require('../../../shared/documentExtraction/pdfText');
const {
  indexStructTree,
  headingLevelOfRole,
  pageBlocks
} = require('../../../shared/documentExtraction/pdfStructure');
const { lastPageWithText, realTextLength } = require('../../../shared/documentExtraction/markers');

// ---- pdf.js shaped fixtures --------------------------------------------------------------------

/**
 * One chunk of marked content. pdf.js ends the previous line with an empty `hasEOL` item at the
 * start of the next chunk; `sameLine` puts the gap item pdf.js emits between two cells instead.
 */
function mc(id, str, { height = 11, sameLine = false, mono = false, tag = 'P' } = {}) {
  return [
    { type: 'beginMarkedContentProps', id, tag },
    sameLine
      ? { str: ' ', hasEOL: false, height: 0, fontName: 'f1' }
      : { str: '', hasEOL: true, height: 0, fontName: 'f1' },
    { str, hasEOL: false, height, fontName: mono ? 'mono' : 'f1' },
    { type: 'endMarkedContent' }
  ];
}

/** A line outside any structure element (untagged PDF, artifacts). */
const plain = (str, options = {}) => [
  { str: '', hasEOL: true, height: 0, fontName: 'f1' },
  { str, hasEOL: false, height: options.height ?? 11, fontName: options.mono ? 'mono' : 'f1' }
];

const STYLES = { f1: { fontFamily: 'sans-serif' }, mono: { fontFamily: 'monospace' } };

const leaf = id => ({ type: 'content', id });
const el = (role, ...children) => ({ role, children });
const root = (...children) => ({ role: 'Root', children: [el('Document', ...children)] });

const page = (items, structTree = null, styles = STYLES) => ({
  items: items.flat(),
  structTree,
  styles
});
const lines = text => text.split('\n').slice(1); // without the [Page N] marker

// ---- tagged structure tree -----------------------------------------------------------------------

describe('tagged PDF: structure tree', () => {
  it('T-PDF-11: H1…H6 become # … ######, paragraphs stay lines', () => {
    const items = [
      mc('p1_mc0', 'Vertrag', { height: 20 }),
      mc('p1_mc1', 'Dieser Vertrag gilt fuer alle Parteien.'),
      mc('p1_mc2', '1.1 Definitionen', { height: 15 }),
      mc('p1_mc3', 'Im Folgenden', { height: 13 }),
      mc('p1_mc4', 'Tiefe Ebene', { height: 11 })
    ];
    const tree = root(
      el('H1', leaf('p1_mc0')),
      el('P', leaf('p1_mc1')),
      el('H2', leaf('p1_mc2')),
      el('H3', leaf('p1_mc3')),
      el('H6', leaf('p1_mc4'))
    );
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      '# Vertrag',
      'Dieser Vertrag gilt fuer alle Parteien.',
      '## 1.1 Definitionen',
      '### Im Folgenden',
      '###### Tiefe Ebene'
    ]);
  });

  it('a heading of two chunks on one line (code span + text) is one heading', () => {
    const items = [
      mc('p1_mc0', 'cloudStorageUpload', { mono: true }),
      mc('p1_mc1', 'Options', { sameLine: true })
    ];
    const tree = root(el('H3', el('Span', leaf('p1_mc0')), leaf('p1_mc1')));
    // The gap item is a space: pdf.js puts it into the second chunk.
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual(['### cloudStorageUpload Options']);
  });

  it('a heading that wraps over two lines is one heading line', () => {
    const items = [
      mc('p1_mc0', 'Ein sehr langer Kapitelname, der', { height: 16 }),
      mc('p1_mc1', 'ueber zwei Zeilen laeuft', { height: 16 }),
      mc('p1_mc2', 'Text danach.')
    ];
    const tree = root(el('H2', leaf('p1_mc0'), leaf('p1_mc1')), el('P', leaf('p1_mc2')));
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      '## Ein sehr langer Kapitelname, der ueber zwei Zeilen laeuft',
      'Text danach.'
    ]);
  });

  it('two headings in a row stay two headings', () => {
    const items = [mc('p1_mc0', 'Kapitel 1'), mc('p1_mc1', 'Abschnitt 1.1')];
    const tree = root(el('H1', leaf('p1_mc0')), el('H2', leaf('p1_mc1')));
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      '# Kapitel 1',
      '## Abschnitt 1.1'
    ]);
  });

  it('role Title is # ; the untyped H and unknown roles are not headings', () => {
    expect(headingLevelOfRole('Title')).toBe(1);
    expect(headingLevelOfRole('H4')).toBe(4);
    for (const role of ['H', 'H7', 'H0', 'Heading1', 'P', 'Sect', '', undefined, null, 42]) {
      expect(headingLevelOfRole(role)).toBe(0);
    }
    const items = [mc('p1_mc0', 'Titel'), mc('p1_mc1', 'Ohne Ebene')];
    const tree = root(el('Title', leaf('p1_mc0')), el('H', leaf('p1_mc1')));
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual(['# Titel', 'Ohne Ebene']);
  });

  it('text outside the tree (artifacts, running headers) stays as it was', () => {
    const items = [plain('Vertraulich - Entwurf'), mc('p1_mc0', 'Kapitel'), plain('Seite 3')];
    const tree = root(el('H1', leaf('p1_mc0')));
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      'Vertraulich - Entwurf',
      '# Kapitel',
      'Seite 3'
    ]);
  });

  it('no text is lost or duplicated: the structure only adds markers', () => {
    const items = [
      mc('p1_mc0', 'Kapitel', { height: 20 }),
      mc('p1_mc1', 'A'),
      mc('p1_mc2', 'B', { sameLine: true }),
      mc('p1_mc3', 'C'),
      mc('p1_mc4', 'D', { sameLine: true })
    ];
    const tree = root(
      el('H1', leaf('p1_mc0')),
      el(
        'Table',
        el('TR', el('TH', leaf('p1_mc1')), el('TH', leaf('p1_mc2'))),
        el('TR', el('TD', leaf('p1_mc3')), el('TD', leaf('p1_mc4')))
      )
    );
    const text = assemblePdfText([page(items, tree)]);
    expect(text.replace('[Page 1]', '').replace(/[#|\-\s]/g, '')).toBe('KapitelABCD');
  });
});

describe('tagged PDF: tables', () => {
  const header = ['p1_mc0', 'p1_mc1', 'p1_mc2'];

  it('T-PDF-12: a table with a header row becomes a Markdown table, cells on one line stay apart', () => {
    const items = [
      mc('p1_mc0', 'Field'),
      mc('p1_mc1', 'Type', { sameLine: true }),
      mc('p1_mc2', 'Default', { sameLine: true }),
      mc('p1_mc3', 'enabled'),
      mc('p1_mc4', 'boolean', { sameLine: true }),
      mc('p1_mc5', 'false', { sameLine: true })
    ];
    const tree = root(
      el(
        'Table',
        el('TR', ...header.map(id => el('TH', el('P', leaf(id))))),
        el('TR', el('TD', leaf('p1_mc3')), el('TD', leaf('p1_mc4')), el('TD', leaf('p1_mc5')))
      )
    );
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      '| Field | Type | Default |',
      '| --- | --- | --- |',
      '| enabled | boolean | false |'
    ]);
  });

  it('a cell that wraps over lines is one cell; the rest of the row stays where it was', () => {
    const items = [
      mc('p1_mc0', 'Name'),
      mc('p1_mc1', 'Beschreibung', { sameLine: true }),
      mc('p1_mc2', 'enabled'),
      mc('p1_mc3', 'Zeigt den Dialog', { sameLine: true }),
      mc('p1_mc4', 'zur Dateiauswahl')
    ];
    const tree = root(
      el(
        'Table',
        el('TR', el('TH', leaf('p1_mc0')), el('TH', leaf('p1_mc1'))),
        el('TR', el('TD', leaf('p1_mc2')), el('TD', leaf('p1_mc3'), leaf('p1_mc4')))
      )
    );
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      '| Name | Beschreibung |',
      '| --- | --- |',
      '| enabled | Zeigt den Dialog zur Dateiauswahl |'
    ]);
  });

  it('an empty cell keeps its column', () => {
    const items = [mc('p1_mc0', 'A'), mc('p1_mc1', 'C', { sameLine: true })];
    const tree = root(
      el('Table', el('TR', el('TD', leaf('p1_mc0')), el('TD'), el('TD', leaf('p1_mc1'))))
    );
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual(['| A |  | C |']);
  });

  it('a trailing empty cell keeps its column too', () => {
    const items = [mc('p1_mc0', 'A'), mc('p1_mc1', 'B', { sameLine: true })];
    const tree = root(
      el('Table', el('TR', el('TD', leaf('p1_mc0')), el('TD', leaf('p1_mc1')), el('TD')))
    );
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual(['| A | B |  |']);
  });

  it('a pipe in a cell is escaped, a backslash before it too', () => {
    const items = [mc('p1_mc0', 'a|b'), mc('p1_mc1', 'c\\|d', { sameLine: true })];
    const tree = root(el('Table', el('TR', el('TD', leaf('p1_mc0')), el('TD', leaf('p1_mc1')))));
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual(['| a\\|b | c\\\\\\|d |']);
  });

  it('a table that continues from the previous page does not turn its first row into a header', () => {
    const items = [mc('p1_mc0', 'x'), mc('p1_mc1', 'y', { sameLine: true })];
    const tree = root(el('Table', el('TR', el('TD', leaf('p1_mc0')), el('TD', leaf('p1_mc1')))));
    const text = assemblePdfText([page(items, tree)]);
    expect(lines(text)).toEqual(['| x | y |']);
    expect(text).not.toContain('---');
  });

  it('rows are as wide as the widest row (merged cells leave the short rows padded)', () => {
    const items = [
      mc('p1_mc0', 'Titel ueber alles'),
      mc('p1_mc1', 'a'),
      mc('p1_mc2', 'b', { sameLine: true })
    ];
    const tree = root(
      el(
        'Table',
        el('TR', el('TH', leaf('p1_mc0'))),
        el('TR', el('TD', leaf('p1_mc1')), el('TD', leaf('p1_mc2')))
      )
    );
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      '| Titel ueber alles |  |',
      '| --- | --- |',
      '| a | b |'
    ]);
  });

  it('text around a table is kept apart by blank lines', () => {
    const items = [mc('p1_mc0', 'Davor.'), mc('p1_mc1', 'x'), mc('p1_mc2', 'Danach.')];
    const tree = root(
      el('P', leaf('p1_mc0')),
      el('Table', el('TR', el('TD', leaf('p1_mc1')))),
      el('P', leaf('p1_mc2'))
    );
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual([
      'Davor.',
      '',
      '| x |',
      '',
      'Danach.'
    ]);
  });

  it('a line that mixes a table cell with other text stays a plain line', () => {
    const items = [mc('p1_mc0', 'Zelle'), mc('p1_mc1', 'Randnotiz', { sameLine: true })];
    const tree = root(el('Table', el('TR', el('TD', leaf('p1_mc0')))), el('P', leaf('p1_mc1')));
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual(['Zelle Randnotiz']);
  });

  it('two tables in a row are two tables; a nested table is flattened into its cell', () => {
    const items = [
      mc('p1_mc0', 'eins'),
      mc('p1_mc1', 'zwei'),
      mc('p1_mc2', 'aussen'),
      mc('p1_mc3', 'innen', { sameLine: true })
    ];
    const tree = root(
      el('Table', el('TR', el('TD', leaf('p1_mc0')))),
      el('Table', el('TR', el('TD', leaf('p1_mc1')))),
      el(
        'Table',
        el('TR', el('TD', leaf('p1_mc2'), el('Table', el('TR', el('TD', leaf('p1_mc3'))))))
      )
    );
    expect(lines(assemblePdfText([page(items, tree)])).filter(Boolean)).toEqual([
      '| eins |',
      '| zwei |',
      '| aussen innen |'
    ]);
  });

  it('a heading inside a table cell is plain cell text', () => {
    const items = [mc('p1_mc0', 'Kopf')];
    const tree = root(el('Table', el('TR', el('TD', el('H2', leaf('p1_mc0'))))));
    expect(lines(assemblePdfText([page(items, tree)]))).toEqual(['| Kopf |']);
  });
});

describe('tagged PDF: hostile and broken trees', () => {
  it('a very deep tree does not overflow the stack', () => {
    let deepest = el('P', leaf('p1_mc0'));
    for (let i = 0; i < 50000; i += 1) deepest = el('Sect', deepest);
    const tree = { role: 'Root', children: [deepest] };
    const text = assemblePdfText([page([mc('p1_mc0', 'Text')], tree)]);
    expect(lines(text)).toEqual(['Text']);
  });

  it('a huge tree is cut, the lines stay', () => {
    const children = Array.from({ length: 300000 }, () => ({ role: 'Span', children: [] }));
    children.push(el('H1', leaf('p1_mc0')));
    const tree = { role: 'Root', children: [{ role: 'Document', children }] };
    const text = assemblePdfText([page([mc('p1_mc0', 'Kapitel')], tree)]);
    // Beyond the node limit the heading is simply not found; the text is there either way.
    expect(text).toContain('Kapitel');
  });

  it('junk in the tree is ignored', () => {
    const tree = {
      role: 'Root',
      children: [
        null,
        3,
        'x',
        { role: 'H1', children: 'not an array' },
        { role: 'P', children: [{ type: 'content' }] }
      ]
    };
    expect(lines(assemblePdfText([page([mc('p1_mc0', 'Text')], tree)]))).toEqual(['Text']);
    expect(indexStructTree(null)).toBeNull();
    expect(indexStructTree('x')).toBeNull();
  });

  it('a tree that throws while it is read costs the structure, not the lines', () => {
    const tree = {
      role: 'Root',
      get children() {
        throw new Error('broken tree');
      }
    };
    const built = buildPdfPage(page([mc('p1_mc0', 'Text')]).items, 1, null, tree, STYLES);
    expect(built.blocks.map(block => block.text)).toEqual(['Text']);
  });

  it('unbalanced marked content does not break the lines', () => {
    const items = [
      { type: 'endMarkedContent' },
      { type: 'endMarkedContent' },
      ...mc('p1_mc0', 'Text'),
      { type: 'beginMarkedContentProps', id: 'p1_mc9', tag: 'P' }
    ];
    expect(pageBlocks(items, null).map(block => block.text)).toEqual(['Text']);
  });
});

// ---- outline -------------------------------------------------------------------------------------

describe('outline', () => {
  const pages = [
    page([
      plain('Allgemeine Bestimmungen'),
      plain('Dieser Vertrag gilt fuer alle Parteien und regelt die Zusammenarbeit.'),
      plain('1.1 Definitionen'),
      plain('Begriffe sind im Anhang erklaert.')
    ]),
    page([
      plain('Ein sehr langer Titel, der'),
      plain('ueber zwei Zeilen laeuft'),
      plain('Text.'),
      plain('Kuendigung')
    ])
  ];

  it('T-PDF-13: lines named in the outline become headings of the outline depth', () => {
    const outline = [
      { title: 'Allgemeine Bestimmungen', depth: 1, pageIndex: 0 },
      { title: 'Definitionen', depth: 2, pageIndex: 0 },
      { title: 'Ein sehr langer Titel, der ueber zwei Zeilen laeuft', depth: 1, pageIndex: 1 },
      { title: 'Kuendigung', depth: 3, pageIndex: 1 }
    ];
    const text = assemblePdfText(pages, null, { outline });
    expect(text).toBe(
      [
        '[Page 1]',
        '# Allgemeine Bestimmungen',
        'Dieser Vertrag gilt fuer alle Parteien und regelt die Zusammenarbeit.',
        // The chapter label of the text is in front of the outline title.
        '## 1.1 Definitionen',
        'Begriffe sind im Anhang erklaert.',
        '',
        '[Page 2]',
        '# Ein sehr langer Titel, der ueber zwei Zeilen laeuft',
        'Text.',
        '### Kuendigung'
      ].join('\n')
    );
  });

  it('a line without letters never becomes part of a title', () => {
    const closing = [
      page([plain('"a": 1'), plain('}'), plain('Property Details'), plain('Text.')])
    ];
    const text = assemblePdfText(closing, null, {
      outline: [{ title: 'Property Details', depth: 1, pageIndex: 0 }]
    });
    expect(lines(text)).toEqual(['"a": 1', '}', '# Property Details', 'Text.']);
  });

  it('a chapter label that looks like the start of the title still matches: Roman numerals, letters, multi-level numbers', () => {
    const labelled = [
      page([
        plain('II Introduction'),
        plain('Text.'),
        plain('III Definitionen'),
        plain('c) Leistungen'),
        plain('10.1.1 Zahlung'),
        plain('Ende.')
      ])
    ];
    const outline = [
      { title: 'Introduction', depth: 1, pageIndex: 0 },
      { title: 'Definitionen', depth: 1, pageIndex: 0 },
      { title: 'Leistungen', depth: 2, pageIndex: 0 },
      { title: 'Zahlung', depth: 3, pageIndex: 0 }
    ];
    expect(lines(assemblePdfText(labelled, null, { outline }))).toEqual([
      '# II Introduction',
      'Text.',
      '# III Definitionen',
      '## c) Leistungen',
      '### 10.1.1 Zahlung',
      'Ende.'
    ]);
  });

  it('a label never turns a line into a heading of another title', () => {
    const other = [page([plain('II Einleitung der Parteien'), plain('Text.')])];
    const outline = [{ title: 'Introduction', depth: 1, pageIndex: 0 }];
    expect(lines(assemblePdfText(other, null, { outline }))).toEqual([
      'II Einleitung der Parteien',
      'Text.'
    ]);
  });

  it('the outline is not trusted when most entries are not found in the text', () => {
    const outline = [
      { title: 'Allgemeine Bestimmungen', depth: 1, pageIndex: 0 },
      { title: 'Abbildung 1: Architektur', depth: 1, pageIndex: 0 },
      { title: 'Abbildung 2: Ablauf', depth: 1, pageIndex: 0 },
      { title: 'Tabelle 3', depth: 1, pageIndex: 1 }
    ];
    expect(assemblePdfText(pages, null, { outline })).not.toMatch(/^#/m);
  });

  it('titles that occur twice on a page are found in order; titles shorter than 3 letters are skipped', () => {
    const doubled = [page([plain('Anhang'), plain('Text.'), plain('Anhang'), plain('Mehr.')])];
    const text = assemblePdfText(doubled, null, {
      outline: [
        { title: 'Anhang', depth: 1, pageIndex: 0 },
        { title: 'Anhang', depth: 2, pageIndex: 0 },
        { title: 'A', depth: 3, pageIndex: 0 }
      ]
    });
    expect(lines(text)).toEqual(['# Anhang', 'Text.', '## Anhang', 'Mehr.']);
  });

  it('an entry that points to a page that does not exist is ignored', () => {
    const text = assemblePdfText(pages, null, {
      outline: [
        { title: 'Allgemeine Bestimmungen', depth: 1, pageIndex: 0 },
        { title: 'Nirgends', depth: 1, pageIndex: 99 }
      ]
    });
    expect(text).toContain('# Allgemeine Bestimmungen');
  });

  it('depth beyond 6 is shown as ######', () => {
    const text = assemblePdfText(pages, null, {
      outline: [{ title: 'Kuendigung', depth: 9, pageIndex: 1 }]
    });
    expect(text).toContain('###### Kuendigung');
  });

  describe('readOutline', () => {
    const entry = (title, dest, ...items) => ({ title, dest, items });
    const fakePdf = (outline, { numPages = 3 } = {}) => ({
      numPages,
      getOutline: jest.fn(async () => outline),
      getDestination: jest.fn(async name =>
        name === 'chapter2' ? [{ num: 22, gen: 0 }, { name: 'XYZ' }] : null
      ),
      getPageIndex: jest.fn(async ref => ref.num - 21)
    });

    it('resolves page references and named destinations, keeps depth and order', async () => {
      const pdf = fakePdf([
        entry(
          'Kapitel 1',
          [{ num: 21, gen: 0 }, { name: 'XYZ' }],
          entry('Abschnitt', [{ num: 22, gen: 0 }])
        ),
        entry('Kapitel 2', 'chapter2'),
        entry('Seite drei (Zahl)', [2, { name: 'Fit' }])
      ]);
      expect(await readOutline(pdf)).toEqual([
        { title: 'Kapitel 1', depth: 1, pageIndex: 0 },
        { title: 'Abschnitt', depth: 2, pageIndex: 1 },
        { title: 'Kapitel 2', depth: 1, pageIndex: 1 },
        { title: 'Seite drei (Zahl)', depth: 1, pageIndex: 2 }
      ]);
    });

    it('skips entries that cannot be resolved and keeps their children', async () => {
      const pdf = fakePdf([
        entry('Extern', null, entry('Kind', [{ num: 21, gen: 0 }])),
        entry('Unbekannt', 'missing'),
        entry('Kaputt', [{ num: 500, gen: 0 }]),
        { title: 42, dest: [0] }
      ]);
      pdf.getPageIndex.mockImplementation(async ref => {
        if (ref.num === 500) throw new Error('no such page');
        return ref.num - 21;
      });
      expect(await readOutline(pdf)).toEqual([{ title: 'Kind', depth: 2, pageIndex: 0 }]);
    });

    it('survives a missing, null or throwing outline', async () => {
      expect(await readOutline({ numPages: 1 })).toEqual([]);
      expect(await readOutline(fakePdf(null))).toEqual([]);
      const broken = fakePdf([]);
      broken.getOutline.mockRejectedValue(new Error('bad outline'));
      expect(await readOutline(broken)).toEqual([]);
    });

    it('is bounded: a very deep and a very long outline are cut, not followed', async () => {
      let deep = entry('Ende', [0]);
      for (let i = 0; i < 50000; i += 1) deep = entry(`E${i}`, [0], deep);
      expect((await readOutline(fakePdf([deep]))).length).toBeLessThanOrEqual(2000);
      const wide = Array.from({ length: 5000 }, (_, i) => entry(`Eintrag ${i}`, [0]));
      expect((await readOutline(fakePdf(wide))).length).toBe(2000);
    });
  });
});

// ---- trust order ---------------------------------------------------------------------------------

describe('limits', () => {
  it('T-PERF-03: 600 pages with headings, tables and an outline assemble quickly', () => {
    const outline = [];
    const pages = Array.from({ length: 600 }, (_, n) => {
      outline.push({ title: `Kapitel ${n}`, depth: 1, pageIndex: n });
      const items = [plain(`Kapitel ${n}`, { height: 18 })];
      for (let l = 0; l < 60; l += 1) {
        items.push(plain(`Zeile ${l} mit etwas Text darin, damit sie nicht leer ist`));
      }
      return page(items);
    });
    const started = Date.now();
    const text = assemblePdfText(pages, null, { outline });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(text.match(/^# Kapitel \d+$/gm)).toHaveLength(600);
  });

  it('an outline with thousands of entries for one page of thousands of lines stays bounded', () => {
    const items = Array.from({ length: 4000 }, (_, i) => plain(`Zeile Nummer ${i} Text`));
    const outline = Array.from({ length: 2000 }, (_, i) => ({
      title: `Gibt es nirgends ${i}`,
      depth: 1,
      pageIndex: 0
    }));
    const started = Date.now();
    const text = assemblePdfText([page(items)], null, { outline });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(text).not.toMatch(/^#/m);
  });

  it('a table of many thousand rows is assembled without a stack overflow', () => {
    const items = [];
    const rows = [];
    for (let i = 0; i < 20000; i += 1) {
      items.push(mc(`p1_mc${i}`, `Zelle ${i}`));
      rows.push(el('TR', el('TD', leaf(`p1_mc${i}`))));
    }
    const text = assemblePdfText([page(items, root(el('Table', ...rows.slice(0, 5000))))]);
    expect(text.split('\n').filter(line => line.startsWith('| Zelle'))).toHaveLength(5000);
  });
});

describe('order of trust', () => {
  const outline = [{ title: 'Aus der Gliederung', depth: 1, pageIndex: 0 }];

  it('tags win over the outline', () => {
    const items = [mc('p1_mc0', 'Aus den Tags'), ...[plain('Aus der Gliederung')]];
    const tree = root(el('H2', leaf('p1_mc0')));
    expect(lines(assemblePdfText([page(items, tree)], null, { outline }))).toEqual([
      '## Aus den Tags',
      'Aus der Gliederung'
    ]);
  });

  it('a tagged PDF without headings still gets its tables and falls through to the outline', () => {
    const items = [mc('p1_mc0', 'Fliesstext.'), mc('p1_mc1', 'x'), plain('Aus der Gliederung')];
    const tree = root(el('P', leaf('p1_mc0')), el('Table', el('TR', el('TD', leaf('p1_mc1')))));
    expect(lines(assemblePdfText([page(items, tree)], null, { outline }))).toEqual([
      'Fliesstext.',
      '',
      '| x |',
      '',
      '# Aus der Gliederung'
    ]);
  });

  it('the outline wins over the font size', () => {
    const items = [
      plain('Aus der Gliederung', { height: 11 }),
      plain('Gross gesetzt aber nicht in der Gliederung', { height: 24 }),
      ...Array.from({ length: 12 }, () => plain('Normaler Fliesstext in elf Punkt, ganz normal.'))
    ];
    const text = assemblePdfText([page(items)], null, { outline });
    expect(lines(text)[0]).toBe('# Aus der Gliederung');
    expect(text).not.toContain('# Gross gesetzt');
  });
});

// ---- font heuristic ------------------------------------------------------------------------------

describe('font size heuristic', () => {
  const body = (n, height = 11) =>
    Array.from({ length: n }, (_, i) =>
      plain(`Das ist Fliesstext Nummer ${i} mit genug Woertern fuer einen Absatz`, { height })
    );

  it('T-PDF-14: clearly larger short lines become headings by size tier', () => {
    const items = [
      plain('Vertrag ueber Zusammenarbeit', { height: 22 }),
      ...body(6),
      plain('Geltungsbereich', { height: 16 }),
      ...body(6),
      plain('Begriffe', { height: 13 }),
      ...body(6)
    ];
    const out = lines(assemblePdfText([page(items)]));
    expect(out.filter(line => line.startsWith('#'))).toEqual([
      '# Vertrag ueber Zusammenarbeit',
      '## Geltungsbereich',
      '### Begriffe'
    ]);
    expect(out).toHaveLength(items.length);
  });

  it('a document without larger text is untouched, byte for byte', () => {
    const items = body(10);
    const text = assemblePdfText([page(items)]);
    expect(text).toBe(assemblePdfText([items.flat()]));
    expect(text).not.toMatch(/^#/m);
  });

  it('sentences, long lines, page numbers and code are never headings', () => {
    const items = [
      ...body(10),
      plain('Das ist ein grosser Satz, der endet.', { height: 18 }),
      plain(`${'Sehr lang '.repeat(20)}`, { height: 18 }),
      plain('17', { height: 18 }),
      plain('} else {', { height: 18, mono: true }),
      plain('Echte Ueberschrift', { height: 18 })
    ];
    const out = lines(assemblePdfText([page(items)]));
    expect(out.filter(line => line.startsWith('#'))).toEqual(['# Echte Ueberschrift']);
  });

  it('running headers (the same large line on most pages) are not headings', () => {
    const pages = Array.from({ length: 6 }, (_, n) =>
      page([plain(`Handbuch Seite ${n + 1}`, { height: 14 }), ...body(8)])
    );
    pages[2] = page([
      plain('Eigenes Kapitel', { height: 14 }),
      plain('Handbuch Seite 3', { height: 14 }),
      ...body(8)
    ]);
    const text = assemblePdfText(pages);
    expect(text).toContain('# Eigenes Kapitel');
    expect(text).not.toContain('# Handbuch');
  });

  it('large text that is a big share of the document is a design, not headings', () => {
    const items = [
      ...Array.from({ length: 6 }, () => plain('Folientitel in gross gesetzt', { height: 28 })),
      ...body(2)
    ];
    expect(assemblePdfText([page(items)])).not.toMatch(/^#/m);
  });

  it('more than four sizes is not a clean picture: nothing is promoted', () => {
    const items = [
      ...[26, 22, 18, 15, 13].map(height => plain(`Stufe ${height}`, { height })),
      ...body(30)
    ];
    expect(assemblePdfText([page(items)])).not.toMatch(/^#/m);
  });

  it('code that the PDF does not mark as fixed-width does not become the body size', () => {
    // 12 pt text is the real body; 10 pt code is more frequent but also looks like "body".
    const code = Array.from({ length: 30 }, () =>
      plain('const value = computeSomething(argument, other);', { height: 10 })
    );
    const text = Array.from({ length: 16 }, () =>
      plain('Das ist der eigentliche Fliesstext des Dokuments mit mehreren Woertern und', {
        height: 12
      })
    );
    const items = [
      plain('Titel', { height: 20 }),
      ...code,
      ...text,
      plain('Abschnitt', { height: 15 })
    ];
    const out = lines(assemblePdfText([page(items)]));
    expect(out.filter(line => line.startsWith('#'))).toEqual(['# Titel', '## Abschnitt']);
  });

  it('a numbered line a little larger than the body is a heading, an unnumbered one is not', () => {
    const items = [
      ...body(20),
      plain('2.1 Geltungsbereich', { height: 12 }),
      plain('Nur etwas groesser', { height: 12 }),
      ...body(4)
    ];
    const out = lines(assemblePdfText([page(items)]));
    expect(out.filter(line => line.startsWith('#'))).toEqual(['# 2.1 Geltungsbereich']);
  });

  it('a heading that wraps is one heading, two numbered headings in a row are two', () => {
    const items = [
      ...body(20),
      plain('Ein langer Kapitelname', { height: 16 }),
      plain('mit Fortsetzung', { height: 16 }),
      ...body(3),
      plain('3.1 Erster', { height: 16 }),
      plain('3.2 Zweiter', { height: 16 }),
      ...body(3)
    ];
    const out = lines(assemblePdfText([page(items)]));
    expect(out.filter(line => line.startsWith('#'))).toEqual([
      '# Ein langer Kapitelname mit Fortsetzung',
      '# 3.1 Erster',
      '# 3.2 Zweiter'
    ]);
  });

  it('lines without a font size (spacers only) are never headings', () => {
    const items = [...body(10), plain('Ohne Hoehe', { height: 0 })];
    expect(assemblePdfText([page(items)])).not.toMatch(/^#/m);
  });
});

// ---- document level ------------------------------------------------------------------------------

describe('extractPdfText with structure', () => {
  const fakePdf = ({ items, tree, outline, styles = STYLES }) => ({
    numPages: 1,
    getPageLabels: jest.fn(async () => null),
    getOutline: jest.fn(async () => outline ?? null),
    getDestination: jest.fn(),
    getPageIndex: jest.fn(),
    getPage: jest.fn(async () => ({
      getTextContent: jest.fn(async () => ({ items: items.flat(), styles })),
      getStructTree: jest.fn(async () => tree ?? null)
    }))
  });

  it('asks pdf.js for marked content and reads the structure tree', async () => {
    const pdf = fakePdf({
      items: [mc('p1_mc0', 'Kapitel'), mc('p1_mc1', 'Text.')],
      tree: root(el('H1', leaf('p1_mc0')), el('P', leaf('p1_mc1')))
    });
    expect(await extractPdfText(pdf)).toBe('[Page 1]\n# Kapitel\nText.');
    const readPage = await pdf.getPage.mock.results[0].value;
    expect(readPage.getTextContent).toHaveBeenCalledWith({ includeMarkedContent: true });
  });

  it('a tree or outline that cannot be read leaves the lines as they are', async () => {
    const pdf = fakePdf({ items: [plain('Nur Text.')] });
    pdf.getOutline.mockRejectedValue(new Error('bad outline'));
    const readPage = await pdf.getPage();
    readPage.getStructTree.mockRejectedValue(new Error('bad tree'));
    pdf.getPage.mockResolvedValue(readPage);
    expect(await extractPdfText(pdf)).toBe('[Page 1]\nNur Text.');
  });

  it('a pdf.js without the structure methods works as before', async () => {
    const pdf = {
      numPages: 1,
      getPageLabels: async () => null,
      getPage: async () => ({ getTextContent: async () => ({ items: plain('Text.') }) })
    };
    expect(await extractPdfText(pdf)).toBe('[Page 1]\nText.');
  });

  it('uses the outline of the document', async () => {
    const pdf = fakePdf({
      items: [plain('Einleitung'), plain('Fliesstext.')],
      outline: [{ title: 'Einleitung', dest: [0, { name: 'Fit' }], items: [] }]
    });
    expect(await extractPdfText(pdf)).toBe('[Page 1]\n# Einleitung\nFliesstext.');
  });
});

// ---- scan detection with markup ----------------------------------------------------------------------

describe('real text length with headings and tables', () => {
  it('counts the words, not the Markdown around them', () => {
    expect(realTextLength('[Page 1]\n# Titel\n\n| a | b |\n| --- | --- |\n| c | d |')).toBe(
      'Titel'.length + 'a b'.length + 'c d'.length
    );
    expect(realTextLength('[Page 1]\n###### x')).toBe(1);
    expect(realTextLength('[Page 1]\n| a\\|b |')).toBe('a b'.length);
  });

  it('a heading inside a text keeps its page for lastPageWithText', () => {
    expect(lastPageWithText('[Page 1]\n# Titel\n\n[Page 2: no extractable text]')).toBe(1);
  });
});
