/**
 * Progress and Stop while a document is extracted in the browser (PDF, Word, PowerPoint, TIFF;
 * spreadsheets, OpenDocument files and mails can only be read with progress): what the
 * extractors report, that Stop lands at the next page, slide or step and is never mistaken for a
 * failure to try again the plain way, and that the call sites which pass no options keep
 * working as they did.
 *
 * pdf.js is ESM-only and cannot be loaded by jest: `processDocumentFile` runs against a fake
 * pdf.js document (server/tests/document-extraction-pdf.test.js runs the same code on the real
 * one). UTIF is replaced as well; the Office packages are real.
 */
import '@testing-library/jest-dom';
import { waitFor } from '@testing-library/react';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));
jest.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: jest.fn() }), {
  virtual: true
});
jest.mock('utif2', () => ({
  __esModule: true,
  default: { decode: jest.fn(), decodeImage: jest.fn(), toRGBA8: jest.fn() }
}));

const JSZip = require('jszip');
const XLSX = require('xlsx');
const pdfjs = require('pdfjs-dist');
const UTIF = require('utif2').default;
const config = require('../../../client/src/api/endpoints/config');
const {
  processDocumentFile,
  processGenericTextFile,
  processImageFile,
  processTiffFile,
  renderPdfPagesToImages
} = require('../../../client/src/features/upload/utils/fileProcessing');
const {
  createProgressReporter,
  itemProgress,
  isAbortError
} = require('../../../shared/documentExtraction/progress');
const { buildDocxFile, buildOdfFile, makeFile, odfP, p } = require('../../utils/officeFixtures');

const STRUCTURED_OFF = { features: [{ id: 'structuredDocumentExtraction', enabled: false }] };
const LONG = 'Dieser Vertrag gilt fuer alle Parteien und regelt die Zusammenarbeit.';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let warn;
let error;

beforeEach(() => {
  config.fetchPlatformConfig.mockReset();
  config.fetchPlatformConfig.mockResolvedValue({ features: [] });
  pdfjs.getDocument.mockReset();
  UTIF.decode.mockReset();
  UTIF.decodeImage.mockReset();
  UTIF.toRGBA8.mockReset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Collects what is reported. */
function listener() {
  const events = [];
  return { events, onProgress: event => events.push(event) };
}

/** The stages in the order they first show up. */
const stagesOf = events => [...new Set(events.map(event => event.stage))];
/** The `current` of the details reported, in order, without repeats. */
const currentsOf = events => [
  ...new Set(events.filter(event => event.detail).map(event => event.detail.current))
];
/** Overall progress as the uploader gets it: whole numbers that never go down. */
function expectOverallProgress(events) {
  const percents = events.map(event => event.percent).filter(percent => percent !== null);
  expect(percents.length).toBeGreaterThan(0);
  percents.forEach(percent => expect(Number.isInteger(percent)).toBe(true));
  percents.forEach(percent => expect(percent).toBeGreaterThanOrEqual(0));
  percents.forEach(percent => expect(percent).toBeLessThanOrEqual(100));
  expect(percents).toEqual([...percents].sort((a, b) => a - b));
}

const abortedError = { name: 'AbortError', code: 'aborted', message: 'aborted' };
const legacyWarning = '[fileProcessing] structured extraction failed, using legacy';
const triedLegacy = () => warn.mock.calls.some(([message]) => message === legacyWarning);

describe('the progress reporter', () => {
  const stages = { read: [0, 10], extract: [10, 90], finalize: [90, 100] };

  /** A reporter on a clock the test sets. */
  function reporter() {
    const events = [];
    const clock = { time: 0 };
    const report = createProgressReporter(event => events.push(event), stages, {
      now: () => clock.time
    });
    return { events, clock, report };
  }

  it('maps the percent of a stage onto its span of the whole bar, as whole numbers', () => {
    const { events, report } = reporter();
    report({ stage: 'read', percent: 0 });
    report({ stage: 'read', percent: 50 });
    report({ stage: 'extract', percent: 0 });
    report({ stage: 'extract', percent: 33.4 });
    report({ stage: 'extract', percent: 100 });
    report({ stage: 'finalize', percent: 100 });
    expect(events.map(event => [event.stage, event.percent])).toEqual([
      ['read', 0],
      ['read', 5],
      ['extract', 10],
      ['extract', 37],
      ['extract', 90],
      ['finalize', 100]
    ]);
  });

  it('never goes down: a stage that starts over waits until it passes the mark reached', () => {
    const { events, report } = reporter();
    report({ stage: 'extract', percent: 50 });
    report({ stage: 'extract', percent: 0 });
    report({ stage: 'extract', percent: 25 });
    report({ stage: 'extract', percent: 75 });
    expect(events.map(event => event.percent)).toEqual([50, 70]);
  });

  it('reports no percent where a stage has nothing to measure, and goes on from the last mark', () => {
    const { events, report } = reporter();
    report({ stage: 'extract', percent: 50 });
    report({ stage: 'finalize', percent: null });
    report({ stage: 'finalize', percent: null });
    report({ stage: 'finalize', percent: 100 });
    expect(events).toEqual([
      { stage: 'extract', percent: 50 },
      { stage: 'finalize', percent: null },
      { stage: 'finalize', percent: 100 }
    ]);
  });

  it('does not repeat itself', () => {
    const { events, report } = reporter();
    for (let i = 0; i < 5; i += 1) report({ stage: 'read', percent: 10.2 });
    report({ stage: 'read', percent: 10.4 });
    expect(events).toHaveLength(1);
  });

  it('reports a stage it does not know without a percent', () => {
    const { events, report } = reporter();
    report({ stage: 'mystery', percent: 40 });
    expect(events).toEqual([{ stage: 'mystery', percent: null }]);
  });

  it('passes the detail on, as a copy', () => {
    const { events, report } = reporter();
    const detail = { unit: 'page', current: 3, total: 9 };
    report({ stage: 'extract', percent: 20, detail });
    detail.current = 4;
    expect(events[0].detail).toEqual({ unit: 'page', current: 3, total: 9 });
  });

  it('holds back a detail that changes without moving the percentage: one report per 100 ms', () => {
    const { events, clock, report } = reporter();
    // 1,000 pages arriving at once: every page changes the detail, 12 of them the percentage
    for (let page = 1; page <= 1000; page += 1) {
      report({
        stage: 'extract',
        percent: ((page - 1) / 1000) * 15,
        detail: { unit: 'page', current: page, total: 1000 }
      });
    }
    expect(events.length).toBeLessThanOrEqual(13);
    // The pages that came after the interval are reported again
    clock.time += 100;
    const before = events.length;
    report({
      stage: 'extract',
      percent: 14.5,
      detail: { unit: 'page', current: 1001, total: 1001 }
    });
    expect(events.length).toBe(before + 1);
  });

  it('always reports a change of stage, and a change of percent, however quickly', () => {
    const { events, report } = reporter();
    report({ stage: 'read', percent: 0 });
    report({ stage: 'read', percent: 50 });
    report({ stage: 'extract', percent: 0 });
    report({ stage: 'finalize', percent: 0 });
    expect(events).toHaveLength(4);
  });

  it('is a function that does nothing without a listener', () => {
    const report = createProgressReporter(undefined, stages);
    expect(() => report({ stage: 'read', percent: 10 })).not.toThrow();
  });

  it('itemProgress: the share done before the item, and which item it is', () => {
    expect(itemProgress('extract', 'page', 1, 4)).toEqual({
      stage: 'extract',
      percent: 0,
      detail: { unit: 'page', current: 1, total: 4 }
    });
    expect(itemProgress('render', 'page', 3, 4)).toEqual({
      stage: 'render',
      percent: 50,
      detail: { unit: 'page', current: 3, total: 4 }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// PDF

/** A fake pdf.js document; `hangAt` is a page whose request pdf.js never answers. */
function fakePdf(pageCount, { text = true, hangAt } = {}) {
  return {
    numPages: pageCount,
    getPageLabels: jest.fn(async () => null),
    getPage: jest.fn(number => {
      if (number === hangAt) return new Promise(() => {});
      return Promise.resolve({
        getTextContent: async () => ({
          items: text
            ? [
                { str: LONG, hasEOL: false },
                { str: '', hasEOL: true }
              ]
            : []
        }),
        getViewport: () => ({ width: 10, height: 10 }),
        render: () => ({ promise: Promise.resolve() })
      });
    })
  };
}

/** Every opening of a document gets a loading task of its own, as in pdf.js. */
function openPdfsWith(pdf) {
  const tasks = [];
  pdfjs.getDocument.mockImplementation(() => {
    const task = { promise: Promise.resolve(pdf), destroy: jest.fn(async () => {}) };
    tasks.push(task);
    return task;
  });
  return tasks;
}

const pdfFile = () => makeFile(new ArrayBuffer(8), 'vertrag.pdf', 'application/pdf');

describe('PDF', () => {
  beforeEach(() => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
    jest
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,AAAA');
  });

  it('reports reading, opening, every page with its number, and finishing, in that order', async () => {
    const pdf = fakePdf(3);
    openPdfsWith(pdf);
    const { events, onProgress } = listener();

    const result = await processDocumentFile(pdfFile(), {}, { onProgress });

    expect(result.content).toContain('[Page 3]');
    expect(stagesOf(events)).toEqual(['read', 'parse', 'extract', 'finalize']);
    expect(currentsOf(events)).toEqual([1, 2, 3]);
    expect(events.find(event => event.detail).detail).toEqual({
      unit: 'page',
      current: 1,
      total: 3
    });
    expectOverallProgress(events);
  });

  it('reports the same percentage for the same page of the same document, whatever else it did', async () => {
    openPdfsWith(fakePdf(4));
    const first = listener();
    const second = listener();
    await processDocumentFile(pdfFile(), {}, { onProgress: first.onProgress });
    await processDocumentFile(pdfFile(), {}, { onProgress: second.onProgress });
    expect(second.events).toEqual(first.events);
  });

  it('extracts exactly what it extracted without progress', async () => {
    openPdfsWith(fakePdf(3));
    const plain = await processDocumentFile(pdfFile());
    const reported = await processDocumentFile(
      pdfFile(),
      {},
      { signal: new AbortController().signal, onProgress: () => {} }
    );
    expect(reported).toEqual(plain);
  });

  it('destroys the document when it is done, and when it fails', async () => {
    const tasks = openPdfsWith(fakePdf(2));
    await processDocumentFile(pdfFile(), {}, { onProgress: () => {} });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].destroy).toHaveBeenCalled();

    const broken = fakePdf(2);
    broken.getPage.mockImplementation(async () => {
      throw new Error('broken');
    });
    const brokenTasks = openPdfsWith(broken);
    // Both extractions fail: the structured one is retried the plain way, which fails too
    await expect(processDocumentFile(pdfFile(), {}, { onProgress: () => {} })).rejects.toThrow(
      'broken'
    );
    expect(brokenTasks[0].destroy).toHaveBeenCalled();
  });

  it('a PDF that cannot be opened fails as it did, with the progress listening', async () => {
    pdfjs.getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error('PasswordException')),
      destroy: jest.fn()
    }));
    await expect(processDocumentFile(pdfFile(), {}, { onProgress: () => {} })).rejects.toThrow(
      'PasswordException'
    );
  });

  it('Stop while pdf.js is working on a page rejects at once, destroys the document and extracts nothing more', async () => {
    const pdf = fakePdf(5, { hangAt: 2 });
    const tasks = openPdfsWith(pdf);
    const controller = new AbortController();
    const { events, onProgress } = listener();

    const result = processDocumentFile(pdfFile(), {}, { signal: controller.signal, onProgress });
    await waitFor(() => expect(currentsOf(events)).toContain(2));
    controller.abort();

    await expect(result).rejects.toMatchObject(abortedError);
    expect(isAbortError(await result.catch(e => e))).toBe(true);
    expect(tasks[0].destroy).toHaveBeenCalled();
    expect(pdf.getPage).toHaveBeenCalledTimes(2);
    // Not tried again the plain way, not rendered as images
    expect(triedLegacy()).toBe(false);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });

  it('Stop between two pages does not start the next one, nor the plain extraction', async () => {
    const pdf = fakePdf(5);
    openPdfsWith(pdf);
    const controller = new AbortController();

    const result = processDocumentFile(
      pdfFile(),
      {},
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.detail?.current === 3) controller.abort();
        }
      }
    );

    await expect(result).rejects.toMatchObject(abortedError);
    expect(pdf.getPage).toHaveBeenCalledTimes(3);
    expect(triedLegacy()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Stop during the plain text extraction (switch off) lands at the next page too', async () => {
    config.fetchPlatformConfig.mockResolvedValue(STRUCTURED_OFF);
    const pdf = fakePdf(6);
    const tasks = openPdfsWith(pdf);
    const { events, onProgress } = listener();
    const controller = new AbortController();

    const result = processDocumentFile(
      pdfFile(),
      {},
      {
        signal: controller.signal,
        onProgress: event => {
          onProgress(event);
          if (event.detail?.current === 2) controller.abort();
        }
      }
    );

    await expect(result).rejects.toMatchObject(abortedError);
    expect(pdf.getPage).toHaveBeenCalledTimes(2);
    expect(stagesOf(events)).toEqual(['read', 'parse', 'extract']);
    expect(tasks[0].destroy).toHaveBeenCalled();
  });

  it('the plain text extraction reports its pages', async () => {
    config.fetchPlatformConfig.mockResolvedValue(STRUCTURED_OFF);
    openPdfsWith(fakePdf(3));
    const { events, onProgress } = listener();
    await processDocumentFile(pdfFile(), {}, { onProgress });
    expect(currentsOf(events)).toEqual([1, 2, 3]);
    expectOverallProgress(events);
  });

  it('a structured extraction that failed is retried the plain way, and the bar does not go back', async () => {
    const pdf = fakePdf(3);
    // The structured extraction fails on its second page, the plain one is fine
    const getPage = pdf.getPage.getMockImplementation();
    let calls = 0;
    pdf.getPage.mockImplementation(number => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('page read failed'));
      return getPage(number);
    });
    openPdfsWith(pdf);
    const { events, onProgress } = listener();

    const result = await processDocumentFile(pdfFile(), {}, { onProgress });

    expect(triedLegacy()).toBe(true);
    // The plain text of before: the items of a page joined with spaces, a line per page
    expect(result.content).toBe([`${LONG} `, `${LONG} `, LONG].join('\n'));
    expectOverallProgress(events);
  });

  it('Stop before anything started opens no document', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      processDocumentFile(pdfFile(), {}, { signal: controller.signal, onProgress: () => {} })
    ).rejects.toMatchObject(abortedError);

    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });

  it('a scan: rendering its pages is a stage of its own, with the page being rendered', async () => {
    const pdf = fakePdf(8, { text: false });
    const tasks = openPdfsWith(pdf);
    const { events, onProgress } = listener();

    const result = await processDocumentFile(pdfFile(), {}, { onProgress });

    expect(result.pageImages).toHaveLength(5);
    expect(stagesOf(events)).toEqual(['read', 'parse', 'extract', 'finalize', 'render']);
    const rendering = events.filter(event => event.stage === 'render');
    expect(rendering.map(event => event.detail)).toEqual(
      [1, 2, 3, 4, 5].map(current => ({ unit: 'page', current, total: 5 }))
    );
    expect(rendering.every(event => event.percent >= 90 && event.percent < 100)).toBe(true);
    expectOverallProgress(events);
    // Both openings are closed
    expect(tasks).toHaveLength(2);
    tasks.forEach(task => expect(task.destroy).toHaveBeenCalled());
  });

  it('Stop while the pages of a scan are rendered is not a failure to render them', async () => {
    const pdf = fakePdf(8, { text: false });
    const tasks = openPdfsWith(pdf);
    const controller = new AbortController();

    const result = processDocumentFile(
      pdfFile(),
      {},
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.stage === 'render' && event.detail.current === 2) controller.abort();
        }
      }
    );

    await expect(result).rejects.toMatchObject(abortedError);
    expect(warn).not.toHaveBeenCalledWith('PDF page rendering failed:', expect.anything());
    expect(tasks[1].destroy).toHaveBeenCalled();
  });

  it('renders pages for a caller that passes no progress, as before', async () => {
    openPdfsWith(fakePdf(2, { text: false }));
    await expect(renderPdfPagesToImages(pdfFile(), 5)).resolves.toHaveLength(2);
  });

  it('a 1,000-page PDF is a few dozen reports, not a thousand', async () => {
    // Every page at the same moment: only what moves the bar is reported
    jest.spyOn(performance, 'now').mockReturnValue(1000);
    openPdfsWith(fakePdf(1000));
    const { events, onProgress } = listener();

    await processDocumentFile(pdfFile(), {}, { onProgress });

    expect(events.length).toBeLessThan(100);
    expect(events.filter(event => event.stage === 'extract').length).toBeGreaterThan(30);
    expectOverallProgress(events);
  });

  it('a caller that passes no options reads the file as it always did, without a FileReader', async () => {
    const reading = jest.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    openPdfsWith(fakePdf(2));

    const result = await processDocumentFile(pdfFile());

    expect(result.content).toContain('[Page 2]');
    expect(reading).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// PowerPoint

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** A deck of `count` slides with one line each. */
async function deck(count, name = 'deck.pptx') {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  );
  zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
  for (let number = 1; number <= count; number += 1) {
    zip.file(
      `ppt/slides/slide${number}.xml`,
      `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:sp><p:txBody>` +
        `<a:p><a:r><a:t>Folie ${number}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    );
  }
  return makeFile(await zip.generateAsync({ type: 'arraybuffer' }), name, PPTX_MIME);
}

describe('PowerPoint', () => {
  it('reports opening the deck and every slide with its number', async () => {
    const { events, onProgress } = listener();

    const result = await processDocumentFile(await deck(5), {}, { onProgress });

    expect(result.content).toBe(
      [1, 2, 3, 4, 5].map(number => `[Slide ${number}]\nFolie ${number}`).join('\n\n')
    );
    expect(stagesOf(events)).toEqual(['read', 'parse', 'extract']);
    expect(currentsOf(events)).toEqual([1, 2, 3, 4, 5]);
    expect(events.find(event => event.detail).detail).toEqual({
      unit: 'slide',
      current: 1,
      total: 5
    });
    expectOverallProgress(events);
  });

  it('extracts exactly what it extracted without progress', async () => {
    const file = await deck(4);
    const plain = await processDocumentFile(file);
    const reported = await processDocumentFile(
      file,
      {},
      { signal: new AbortController().signal, onProgress: () => {} }
    );
    expect(reported).toEqual(plain);
  });

  it('Stop lands at the next slide and does not fall back to the plain extraction', async () => {
    const controller = new AbortController();
    const { events, onProgress } = listener();

    const result = processDocumentFile(
      await deck(5),
      {},
      {
        signal: controller.signal,
        onProgress: event => {
          onProgress(event);
          if (event.detail?.current === 2) controller.abort();
        }
      }
    );

    await expect(result).rejects.toMatchObject(abortedError);
    expect(currentsOf(events)).toEqual([1, 2]);
    expect(triedLegacy()).toBe(false);
  });

  it('the plain extraction (switch off) reports its slides and stops at the next one', async () => {
    config.fetchPlatformConfig.mockResolvedValue(STRUCTURED_OFF);
    const file = await deck(4);
    const { events, onProgress } = listener();
    const full = await processDocumentFile(file, {}, { onProgress });
    expect(full.content).toContain('[Slide 4]');
    expect(currentsOf(events)).toEqual([1, 2, 3, 4]);
    expect(stagesOf(events)).toEqual(['read', 'parse', 'extract']);

    const controller = new AbortController();
    const seen = [];
    await expect(
      processDocumentFile(
        file,
        {},
        {
          signal: controller.signal,
          onProgress: event => {
            seen.push(event);
            if (event.detail?.current === 3) controller.abort();
          }
        }
      )
    ).rejects.toMatchObject(abortedError);
    expect(currentsOf(seen)).toEqual([1, 2, 3]);
  });

  it('a file that is no deck still falls back to the plain extraction when it is not stopped', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    const file = makeFile(await zip.generateAsync({ type: 'arraybuffer' }), 'x.pptx', PPTX_MIME);
    const { onProgress } = listener();

    const result = await processDocumentFile(file, {}, { onProgress });

    expect(triedLegacy()).toBe(true);
    expect(result.content).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Word

describe('Word', () => {
  const docx = () => buildDocxFile({ body: p('Erster Absatz') + p('Zweiter Absatz') });

  it('reports every step in order, and the same text as without progress', async () => {
    const file = await docx();
    const plain = await processDocumentFile(file);
    const { events, onProgress } = listener();

    const result = await processDocumentFile(file, {}, { onProgress });

    expect(result).toEqual(plain);
    expect(result.content).toBe('Erster Absatz\n\nZweiter Absatz');
    expect(stagesOf(events)).toEqual(['read', 'parse', 'convert', 'finalize']);
    // What cannot be measured is reported without a percent
    expect(events.filter(event => event.stage === 'convert')).toEqual([
      { stage: 'convert', percent: null }
    ]);
    expect(events.filter(event => event.stage === 'finalize')).toEqual([
      { stage: 'finalize', percent: null }
    ]);
    expectOverallProgress(events);
  });

  it.each(['parse', 'convert'])(
    'Stop during the %s step ends it at the next one, with no plain extraction after it',
    async stage => {
      const file = await docx();
      const controller = new AbortController();
      const { events, onProgress } = listener();

      const result = processDocumentFile(
        file,
        {},
        {
          signal: controller.signal,
          onProgress: event => {
            onProgress(event);
            if (event.stage === stage) controller.abort();
          }
        }
      );

      await expect(result).rejects.toMatchObject(abortedError);
      expect(stagesOf(events)).not.toContain('finalize');
      expect(triedLegacy()).toBe(false);
    }
  );

  it('the plain extraction (switch off) reports converting, and stops before it', async () => {
    config.fetchPlatformConfig.mockResolvedValue(STRUCTURED_OFF);
    const file = await docx();
    const { events, onProgress } = listener();

    const result = await processDocumentFile(file, {}, { onProgress });

    expect(result.content).toContain('Erster Absatz');
    expect(stagesOf(events)).toEqual(['read', 'convert']);

    const controller = new AbortController();
    controller.abort();
    await expect(
      processDocumentFile(file, {}, { signal: controller.signal, onProgress: () => {} })
    ).rejects.toMatchObject(abortedError);
  });

  it('Stop while the file is read ends the read', async () => {
    const file = await docx();
    const controller = new AbortController();
    const result = processDocumentFile(
      file,
      {},
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.stage === 'read') controller.abort();
        }
      }
    );
    await expect(result).rejects.toMatchObject(abortedError);
  });
});

// ---------------------------------------------------------------------------------------------
// TIFF

describe('TIFF', () => {
  let revoke;

  const tiff = (name = 'scan.tiff') => makeFile(new ArrayBuffer(16), name, 'image/tiff');
  const pages = count => Array.from({ length: count }, () => ({ width: 4, height: 4 }));

  beforeEach(() => {
    UTIF.decode.mockImplementation(() => pages(3));
    UTIF.toRGBA8.mockReturnValue(new Uint8Array(64));
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: () => ({ data: { set: jest.fn() } }),
      putImageData: jest.fn(),
      drawImage: jest.fn()
    });
    jest
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,AAAA');
    global.fetch = jest.fn(async () => ({ blob: async () => new Blob(['png']) }));
    URL.createObjectURL = jest.fn(() => 'blob:preview');
    revoke = jest.fn();
    URL.revokeObjectURL = revoke;
  });

  afterEach(() => {
    delete global.fetch;
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  it('reports every page before it is converted, as the stage of its own', async () => {
    const order = [];
    UTIF.decodeImage.mockImplementation(() => order.push('decode'));
    const { events, onProgress } = listener();

    const converted = await processTiffFile(
      tiff(),
      {},
      {
        onProgress: event => {
          onProgress(event);
          if (event.stage === 'convert') order.push(`page ${event.detail.current}`);
        }
      }
    );

    expect(converted).toHaveLength(3);
    expect(order).toEqual(['page 1', 'decode', 'page 2', 'decode', 'page 3', 'decode']);
    expect(stagesOf(events)).toEqual(['read', 'parse', 'convert']);
    expect(events.find(event => event.stage === 'convert').detail).toEqual({
      unit: 'page',
      current: 1,
      total: 3
    });
  });

  it('lets the browser in between pages', async () => {
    const order = [];
    UTIF.decodeImage.mockImplementation(() => order.push('decode'));

    await processTiffFile(
      tiff(),
      {},
      {
        onProgress: event => {
          // A task queued as the page is announced runs before the page is converted
          if (event.stage === 'convert' && event.detail.current === 2) {
            setTimeout(() => order.push('browser'), 0);
          }
        }
      }
    );

    expect(order).toEqual(['decode', 'browser', 'decode', 'decode']);
  });

  it('Stop lands between pages: the next one is not decoded, and it is not a TIFF error', async () => {
    const controller = new AbortController();
    const result = processTiffFile(
      tiff(),
      {},
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.stage === 'convert' && event.detail.current === 2) controller.abort();
        }
      }
    );

    await expect(result).rejects.toMatchObject(abortedError);
    expect(UTIF.decodeImage).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('a TIFF that cannot be decoded is still a TIFF error', async () => {
    UTIF.decode.mockImplementation(() => {
      throw new Error('bad tiff');
    });
    await expect(processTiffFile(tiff(), {}, { onProgress: () => {} })).rejects.toThrow(
      'tiff-processing-error'
    );
  });

  it('as an upload: overall progress through the pages and their previews', async () => {
    const { events, onProgress } = listener();

    const result = await processImageFile(tiff(), { allowMultiple: true }, { onProgress });

    expect(result.multipleResults).toHaveLength(3);
    expect(stagesOf(events)).toEqual(['read', 'parse', 'convert', 'finalize']);
    expect(currentsOf(events.filter(event => event.stage === 'convert'))).toEqual([1, 2, 3]);
    expect(currentsOf(events.filter(event => event.stage === 'finalize'))).toEqual([1, 2, 3]);
    expectOverallProgress(events);
  });

  it('as an upload: Stop between pages is not a failure', async () => {
    const controller = new AbortController();
    const result = processImageFile(
      tiff(),
      { allowMultiple: true },
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.stage === 'convert' && event.detail.current === 2) controller.abort();
        }
      }
    );
    await expect(result).rejects.toMatchObject(abortedError);
    expect(error).not.toHaveBeenCalled();
  });

  it('as an upload: Stop while the previews are made lets go of the ones made', async () => {
    const controller = new AbortController();
    const result = processImageFile(
      tiff(),
      { allowMultiple: true },
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.stage === 'finalize' && event.detail.current === 2) controller.abort();
        }
      }
    );

    await expect(result).rejects.toMatchObject(abortedError);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('processImageFile without options converts as before', async () => {
    const result = await processImageFile(tiff(), { allowMultiple: true });
    expect(result.multipleResults).toHaveLength(3);
    expect(result.multipleResults[1].data.pageNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Everything else

describe('spreadsheets, OpenDocument files and mails', () => {
  const workbook = () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['Name', 'Wert'],
        ['a', 1],
        ['b', 2]
      ]),
      'Daten'
    );
    const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
    return makeFile(new Uint8Array(bytes).buffer, 'daten.xlsx', XLSX_MIME);
  };

  it('a spreadsheet reports its read, then an indeterminate extraction', async () => {
    const file = workbook();
    const plain = await processDocumentFile(file);
    const { events, onProgress } = listener();

    const result = await processDocumentFile(file, {}, { onProgress });

    expect(result).toEqual(plain);
    expect(stagesOf(events)).toEqual(['read', 'extract']);
    expect(events.at(-1)).toEqual({ stage: 'extract', percent: null });
    expectOverallProgress(events);
  });

  it('Stop while a spreadsheet is read ends the read', async () => {
    const controller = new AbortController();
    const result = processDocumentFile(
      workbook(),
      {},
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.stage === 'read') controller.abort();
        }
      }
    );
    await expect(result).rejects.toMatchObject(abortedError);
  });

  it('an OpenDocument file reports its read, then an indeterminate extraction', async () => {
    const file = await buildOdfFile({ type: 'text', body: odfP('Ein Absatz') });
    const plain = await processDocumentFile(file);
    const { events, onProgress } = listener();

    const result = await processDocumentFile(file, {}, { onProgress });

    expect(result).toEqual(plain);
    expect(result.content).toContain('Ein Absatz');
    expect(stagesOf(events)).toEqual(['read', 'extract']);
    expect(events.at(-1)).toEqual({ stage: 'extract', percent: null });
  });

  it('plain text reports its read as all there is, and stops with it', async () => {
    const file = new File(['Zeile eins\nZeile zwei\n'], 'notizen.md', { type: 'text/markdown' });
    const { events, onProgress } = listener();

    const result = await processDocumentFile(file, {}, { onProgress });

    expect(result.content).toBe('Zeile eins\nZeile zwei\n');
    expect(stagesOf(events)).toEqual(['read']);
    expect(events.at(-1).percent).toBeLessThanOrEqual(100);
    expectOverallProgress(events);

    const controller = new AbortController();
    controller.abort();
    await expect(
      processDocumentFile(file, {}, { signal: controller.signal })
    ).rejects.toMatchObject(abortedError);
  });

  it('a generic text file reports its read and stops with it', async () => {
    const file = new File(['2026-10-15 INFO started\n'], 'server.log', { type: '' });
    const { events, onProgress } = listener();

    await expect(processGenericTextFile(file, { onProgress })).resolves.toEqual({
      content: '2026-10-15 INFO started\n'
    });
    expect(stagesOf(events)).toEqual(['read']);

    const controller = new AbortController();
    controller.abort();
    await expect(processGenericTextFile(file, { signal: controller.signal })).rejects.toMatchObject(
      abortedError
    );
  });

  it('a generic text file without options is read as before', async () => {
    const file = new File(['hello'], 'a.log', { type: '' });
    await expect(processGenericTextFile(file)).resolves.toEqual({ content: 'hello' });
  });
});

describe('plain images', () => {
  class FakeImage {
    constructor() {
      this.width = 8;
      this.height = 6;
    }

    set src(value) {
      this.source = value;
      setTimeout(() => this.onload?.(), 0);
    }
  }

  beforeEach(() => {
    jest.spyOn(global, 'Image').mockImplementation(() => new FakeImage());
    URL.createObjectURL = jest.fn(() => 'blob:preview');
  });

  afterEach(() => {
    delete URL.createObjectURL;
  });

  const png = () => new File(['not really a png'], 'bild.png', { type: 'image/png' });

  it('reports its read and hands the image over as before', async () => {
    const { events, onProgress } = listener();

    const result = await processImageFile(png(), { resize: false }, { onProgress });

    expect(result.data.base64).toMatch(/^data:image\/png;base64,/);
    expect(result.data).toMatchObject({ width: 8, height: 6, fileName: 'bild.png' });
    expect(stagesOf(events)).toEqual(['read']);
    expectOverallProgress(events);
  });

  it('Stop while the image is read ends the read', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      processImageFile(png(), { resize: false }, { signal: controller.signal })
    ).rejects.toMatchObject(abortedError);
  });

  it('works without options', async () => {
    const result = await processImageFile(png(), { resize: false });
    expect(result.preview.url).toBe('blob:preview');
  });
});

describe('call sites that pass no options', () => {
  it('processDocumentFile takes the extraction options only, as the cloud picker and the Office add-in call it', async () => {
    const file = await buildDocxFile({ body: p('Text') });
    await expect(processDocumentFile(file, { trackedChanges: 'markup' })).resolves.toEqual({
      content: 'Text',
      pageImages: undefined
    });
    await expect(processDocumentFile(file, undefined, undefined)).resolves.toMatchObject({
      content: 'Text'
    });
  });

  it('read the file without a FileReader, as before', async () => {
    const reading = jest.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    await processDocumentFile(await buildDocxFile({ body: p('Text') }));
    await processDocumentFile(await deck(2));
    expect(reading).not.toHaveBeenCalled();
  });
});
