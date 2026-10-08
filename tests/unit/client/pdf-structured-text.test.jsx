/**
 * Structure-preserving PDF extraction (concepts/document-extraction/, PR 3): page markers with
 * printed labels, real lines, flagged pages without a text layer, and the scanned-PDF
 * fallback that markers must not switch off (PM-01).
 *
 * pdf.js is ESM-only and cannot be loaded by jest: the assembly is tested as pure functions on
 * items shaped like real pdf.js output (empty `hasEOL` items included — see
 * server/tests/document-extraction-pdf.test.js for the same assertions on real pdf.js), and
 * `processDocumentFile` runs against a fake pdf.js document.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));
jest.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn() }), {
  virtual: true
});

const pdfjs = require('pdfjs-dist');
const config = require('../../../client/src/api/endpoints/config');
const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const {
  assemblePdfText,
  extractPdfText,
  itemsToLines
} = require('../../../shared/documentExtraction/pdfText');
const {
  MIN_REAL_TEXT_CHARS,
  pageMarker,
  realTextLength
} = require('../../../shared/documentExtraction/markers');
const { renderUserMessage } = require('../../../shared/promptContext');
const { makeFile } = require('../../utils/officeFixtures');

/** Items as pdf.js reports them: an empty item with hasEOL ends each line. */
const line = (...runs) => [...runs.map(str => ({ str, hasEOL: false })), { str: '', hasEOL: true }];
const page = (...lines) => lines.flat();

/** A fake pdf.js document over per-page item lists. */
function fakePdf(pages, labels = null) {
  return {
    numPages: pages.length,
    getPageLabels: jest.fn(async () => labels),
    getPage: jest.fn(async number => ({
      getTextContent: async () => ({ items: pages[number - 1] }),
      getViewport: () => ({ width: 10, height: 10 }),
      render: () => ({ promise: Promise.resolve() })
    }))
  };
}

const LONG = 'Dieser Vertrag gilt fuer alle Parteien und regelt die Zusammenarbeit.';

describe('PDF text assembly', () => {
  it('T-PDF-01: page markers carry the printed label only when it differs', () => {
    const pages = [page(line('Titel')), page(line('Inhalt')), page(line('Ende'))];
    expect(assemblePdfText(pages, ['i', '1', '2'])).toBe(
      [
        '[Page 1 (printed: i)]',
        'Titel',
        '',
        '[Page 2 (printed: 1)]',
        'Inhalt',
        '',
        '[Page 3 (printed: 2)]',
        'Ende'
      ].join('\n')
    );
    // Label equal to the physical number, missing labels, missing array: plain marker.
    expect(assemblePdfText(pages, ['1', '2', '3'])).toBe(
      '[Page 1]\nTitel\n\n[Page 2]\nInhalt\n\n[Page 3]\nEnde'
    );
    expect(assemblePdfText(pages, null)).toBe(assemblePdfText(pages, []));
    expect(assemblePdfText(pages, [null, '', undefined])).toBe(
      '[Page 1]\nTitel\n\n[Page 2]\nInhalt\n\n[Page 3]\nEnde'
    );
  });

  it('labels from the file cannot break out of the marker', () => {
    expect(pageMarker(2, '1)]\n[Page 99')).toBe('[Page 2 (printed: 1 Page 99)]');
    expect(pageMarker(2, '  \n ')).toBe('[Page 2]');
    expect(pageMarker(2, 'x'.repeat(200))).toBe(`[Page 2 (printed: ${'x'.repeat(40)})]`);
    expect(realTextLength(pageMarker(2, '1)]\n[Page 99'))).toBe(0);
  });

  it('T-PDF-02: one line per line end, no double spaces, spacer items kept as one space', () => {
    const items = page(
      line('Zelle 1.1', ' ', 'Zelle 1.2'),
      line('Zwei  Leerzeichen', '   ', 'und', '\t', 'Tab'),
      // Empty lines and items without text (marked content) disappear.
      [
        { str: '', hasEOL: true },
        { type: 'beginMarkedContent', id: 'x' },
        { str: '', hasEOL: true }
      ],
      line('letzte Zeile'),
      // Runs of one word (font change, kerning) are not separated: pdf.js adds the spaces itself.
      line('Bund', 'es', 'recht')
    );
    expect(itemsToLines(items)).toEqual([
      'Zelle 1.1 Zelle 1.2',
      'Zwei Leerzeichen und Tab',
      'letzte Zeile',
      'Bundesrecht'
    ]);
  });

  it('keeps the last line of a page that has no closing line end', () => {
    expect(
      itemsToLines([
        { str: 'a', hasEOL: true },
        { str: 'b', hasEOL: false }
      ])
    ).toEqual(['a', 'b']);
    expect(itemsToLines(undefined)).toEqual([]);
  });

  it('T-PDF-03: a page without a text layer is flagged, not skipped', () => {
    expect(
      assemblePdfText([page(line('Seite eins')), [], page(line('Seite drei'))], ['1', '2', '3'])
    ).toBe('[Page 1]\nSeite eins\n\n[Page 2: no extractable text]\n\n[Page 3]\nSeite drei');
    // Items that only hold whitespace are no text either.
    expect(assemblePdfText([page(line('x')), page(line('  ', ' '))], null)).toContain(
      '[Page 2: no extractable text]'
    );
  });

  it('a PDF in which no page has text assembles to an empty string (scan)', () => {
    expect(assemblePdfText([[], page(line(' '))], ['i', 'ii'])).toBe('');
    expect(assemblePdfText([], null)).toBe('');
  });

  it('T-PDF-07: a hyphen at the end of a line stays, with its line break', () => {
    const text = assemblePdfText([
      page(line('Dieser Vertrag gilt fuer alle Parteien und re-'), line('gelt die Zusammenarbeit.'))
    ]);
    expect(text).toBe(
      '[Page 1]\nDieser Vertrag gilt fuer alle Parteien und re-\ngelt die Zusammenarbeit.'
    );
  });

  it('extractPdfText reads page by page and survives a broken label tree', async () => {
    const pdf = fakePdf([page(line('a')), page(line('b'))], ['i', '1']);
    expect(await extractPdfText(pdf)).toBe('[Page 1 (printed: i)]\na\n\n[Page 2 (printed: 1)]\nb');

    const broken = fakePdf([page(line('a'))]);
    broken.getPageLabels.mockRejectedValue(new Error('bad label tree'));
    expect(await extractPdfText(broken)).toBe('[Page 1]\na');
  });

  it('T-PERF-02: a 600-page document assembles quickly', () => {
    const pages = Array.from({ length: 600 }, (_, n) =>
      page(...Array.from({ length: 60 }, (_, l) => line(`Seite ${n + 1}`, ' ', `Zeile ${l}`)))
    );
    const started = Date.now();
    const text = assemblePdfText(pages, null);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(text.startsWith('[Page 1]\nSeite 1 Zeile 0\n')).toBe(true);
    expect(text.match(/^\[Page \d+\]$/gm)).toHaveLength(600);
    expect(text.endsWith('Seite 600 Zeile 59')).toBe(true);
  });
});

describe('PDF upload', () => {
  let toDataURL;
  let getContext;
  let warn;
  let log;

  const upload = async pages => {
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.resolve(fakePdf(pages, ['i', '1', '2']))
    });
    return processDocumentFile(makeFile(new ArrayBuffer(8), 'vertrag.pdf', 'application/pdf'));
  };

  beforeEach(() => {
    config.fetchPlatformConfig.mockReset();
    config.fetchPlatformConfig.mockResolvedValue({ features: [] });
    getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
    toDataURL = jest
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,AAAA');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    getContext.mockRestore();
    toDataURL.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  });

  it('delivers structured text with markers and no page images', async () => {
    const result = await upload([page(line(LONG)), [], page(line(LONG))]);
    expect(result.content).toBe(
      `[Page 1 (printed: i)]\n${LONG}\n\n[Page 2: no extractable text]\n\n[Page 3 (printed: 2)]\n${LONG}`
    );
    expect(result.pageImages).toBeUndefined();
  });

  it('T-PDF-05: mixed pages with enough real text — flagged page, no image fallback', async () => {
    const result = await upload([[], page(line(LONG))]);
    expect(result.content).toContain('[Page 1: no extractable text]');
    expect(result.pageImages).toBeUndefined();
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('T-PDF-04: a scan (no page has text) is rendered as images, content stays empty', async () => {
    const result = await upload([[], [], []]);
    expect(result.content).toBe('');
    expect(result.pageImages).toHaveLength(3);
  });

  it('T-PDF-06: markers do not count as text — 40 real characters still fall back to images', async () => {
    const forty = 'x'.repeat(40);
    const result = await upload([page(line(forty)), page(line(''))]);
    expect(realTextLength(`[Page 1]\n${forty}\n\n[Page 2: no extractable text]`)).toBe(40);
    expect(40).toBeLessThan(MIN_REAL_TEXT_CHARS);
    expect(result.content).toBe('');
    expect(result.pageImages).toHaveLength(2);
  });

  it('counts the characters, not the separators between pages: 20 pages with one character each are a scan', async () => {
    const pages = Array.from({ length: 20 }, () => page(line('x')));
    const result = await upload(pages);
    // 20 characters, whatever the markers and blank lines around them add up to.
    expect(result.content).toBe('');
    // The first five pages are rendered, as before.
    expect(result.pageImages).toHaveLength(5);
  });

  it('keeps the short text when the pages cannot be rendered', async () => {
    toDataURL.mockImplementation(() => {
      throw new Error('canvas tainted');
    });
    const result = await upload([page(line('Nur ein Satz.'))]);
    expect(result.content).toBe('[Page 1 (printed: i)]\nNur ein Satz.');
    expect(result.pageImages).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('PDF page rendering failed:', expect.any(Error));
  });

  it('T-DOWN-02: the fileData of a scan renders as pages_as_images', async () => {
    const result = await upload([[], []]);
    const message = renderUserMessage({
      content: 'Fasse zusammen',
      files: { fileName: 'scan.pdf', fileType: 'application/pdf', ...result }
    });
    expect(message).toContain('pages_as_images="2"');
    expect(message).not.toContain('[Page');
  });

  it('T-PDF-09: switch off — items joined by spaces, one line per page, legacy threshold', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const result = await upload([
      page(line('Eins', ' ', 'zwei'), line(LONG)),
      page(line('Seite zwei hat auch genug Text hier'))
    ]);
    // The plain text of before, double spaces included.
    expect(result.content).toBe(`Eins   zwei  ${LONG} \nSeite zwei hat auch genug Text hier`);
    expect(result.pageImages).toBeUndefined();
  });

  it('T-PDF-09: switch off — a short text keeps its content next to the page images, as before', async () => {
    config.fetchPlatformConfig.mockResolvedValue({
      features: [{ id: 'structuredDocumentExtraction', enabled: false }]
    });
    const result = await upload([page(line('Kurz'))]);
    expect(result.content).toBe('Kurz');
    expect(result.pageImages).toHaveLength(1);
  });

  it('falls back to the plain text when the structured step fails', async () => {
    const pdf = fakePdf([page(line(LONG))]);
    pdf.getPageLabels.mockImplementation(() => {
      throw new Error('unexpected');
    });
    // getPageLabels failures are tolerated; a failing page read is not: make the first read fail once.
    let failed = false;
    const original = pdf.getPage;
    pdf.getPage = jest.fn(async number => {
      if (!failed) {
        failed = true;
        throw new Error('page read failed');
      }
      return original(number);
    });
    pdfjs.getDocument.mockReturnValue({ promise: Promise.resolve(pdf) });
    const result = await processDocumentFile(
      makeFile(new ArrayBuffer(8), 'vertrag.pdf', 'application/pdf')
    );
    expect(warn).toHaveBeenCalledWith(
      '[fileProcessing] structured extraction failed, using legacy',
      expect.any(Error)
    );
    expect(result.content).toBe(LONG);
  });

  it('T-PDF-10: a PDF that pdf.js cannot open fails exactly as before', async () => {
    pdfjs.getDocument.mockReturnValue({ promise: Promise.reject(new Error('PasswordException')) });
    await expect(
      processDocumentFile(makeFile(new ArrayBuffer(8), 'locked.pdf', 'application/pdf'))
    ).rejects.toThrow('PasswordException');
  });
});
