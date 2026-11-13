// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Document extraction runs in worker threads, off the event loop (#3649): the
 * pool reads every format, answers exactly as the in-process path does,
 * terminates a thread that runs past its time budget, replaces a thread that
 * died, stops cleanly, and leaves the event loop free while a large workbook
 * is read.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';

import {
  ExtractionError,
  extractText,
  extractTextInProcess
} from '../services/projects/extractText.js';
import {
  ExtractionPoolError,
  configureExtractionPool,
  extractionPoolStats,
  renderScannedPdfPages,
  runInThread,
  shutdownExtractionPool
} from '../services/projects/extractionPool.js';
import { renderScannedPdfPagesInProcess } from '../services/documents/pdf/scannedPages.js';
import { createPdf } from '../services/documents/pdf/PdfService.js';
import { renderPptx } from '../services/documents/pptx/renderPptx.js';
import { projectSettings } from '../services/projects/projectSettings.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { initializeMetrics } from '../telemetry/metrics.js';

const XLSX = (await import('xlsx')).default || (await import('xlsx'));
const { default: JSZip } = await import('jszip');

const SETTINGS = { threads: 2, timeoutMs: 60_000, memoryMb: 1024 };

function xlsxOf(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Data');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

function bigXlsx(rowCount = 30_000) {
  const rows = [['id', 'name', 'amount', 'note']];
  for (let i = 0; i < rowCount; i += 1) rows.push([i, `customer ${i}`, i * 1.5, `row ${i}`]);
  return xlsxOf(rows);
}

async function docxOf(paragraphs) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  const body = paragraphs
    .map(
      ({ text, heading }) =>
        `<w:p>${heading ? `<w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`
    )
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function fixtures() {
  const { buffer: pptx } = await renderPptx(
    {
      title: 'Deck',
      language: 'en-US',
      slideNumbers: false,
      brand: {},
      slides: [
        { layout: 'title', title: 'Vendor Briefing', subtitle: 'Mai 2026' },
        { layout: 'two-column', title: 'Options', left: { text: '- A' }, right: { text: '- B' } }
      ]
    },
    {}
  );
  const { buffer: pdf } = await createPdf({
    title: 'Lease',
    markdown: '# Lease\n\nThe rent is due on the first day of each month.\n'
  });
  return {
    text: { bytes: Buffer.from('Plain text\r\nsecond line\u0000'), name: 'notes.txt' },
    markdown: { bytes: Buffer.from('# Title\n\nBody text.'), name: 'readme.md' },
    html: {
      bytes: Buffer.from('<html><body><h1>Page</h1><p>Some paragraph.</p></body></html>'),
      name: 'page.html',
      contentType: 'text/html'
    },
    csv: { bytes: Buffer.from('a,b\n1,2\n3,4\n'), name: 'table.csv' },
    xlsx: {
      bytes: xlsxOf([
        ['a', 'b'],
        [1, 2],
        [3, 4]
      ]),
      name: 'book.xlsx'
    },
    docx: {
      bytes: await docxOf([
        { text: 'Heading', heading: 1 },
        { text: 'A paragraph of the document.' }
      ]),
      name: 'doc.docx'
    },
    pptx: { bytes: pptx, name: 'deck.pptx' },
    pdf: { bytes: pdf, name: 'lease.pdf' }
  };
}

const copyOf = file => ({ ...file, bytes: Buffer.from(file.bytes) });

before(() => configureExtractionPool(SETTINGS));
afterEach(() => configureExtractionPool(SETTINGS));
after(async () => {
  await shutdownExtractionPool();
  configureExtractionPool(null);
});

describe('extraction in worker threads', () => {
  it('reads every format and answers exactly as the in-process path does', async () => {
    const files = await fixtures();
    for (const [format, file] of Object.entries(files)) {
      const inThread = await extractText(copyOf(file));
      const inProcess = await extractTextInProcess(copyOf(file));
      assert.ok(inThread.text.length > 0, `${format} has text`);
      assert.deepEqual(inThread, inProcess, `${format}: thread and event loop agree`);
    }
    assert.ok(extractionPoolStats().threads >= 1, 'the work ran in a thread');
  });

  it('answers a failed file with the same ExtractionError code', async () => {
    const cases = [
      [{ bytes: Buffer.from('MZ\u0090\u0000executable'), name: 'tool.exe' }, 'UNSUPPORTED_TYPE'],
      [{ bytes: Buffer.from('   \n  '), name: 'blank.txt' }, 'NO_TEXT'],
      [{ bytes: Buffer.from('PK\x03\x04not-a-zip'), name: 'broken.docx' }, 'UNSUPPORTED_TYPE']
    ];
    for (const [file, code] of cases) {
      const inProcess = await extractTextInProcess(copyOf(file)).catch(error => error);
      const inThread = await extractText(copyOf(file)).catch(error => error);
      assert.ok(inThread instanceof ExtractionError, `${code} stays an ExtractionError`);
      assert.equal(inThread.code, code);
      assert.equal(inThread.message, inProcess.message);
    }
  });

  it('keeps the zip-bomb check: a package that unpacks past the limit is refused', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document>' + 'a'.repeat(64 * 1024 * 1024) + '</w:document>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const inProcess = await extractTextInProcess({ bytes: Buffer.from(bytes), name: 'bomb.docx' })
      .then(() => null)
      .catch(error => error);
    const inThread = await extractText({ bytes: Buffer.from(bytes), name: 'bomb.docx' })
      .then(() => null)
      .catch(error => error);
    assert.ok(inProcess, 'the in-process path refuses it');
    assert.ok(inThread instanceof ExtractionError, 'the thread refuses it the same way');
    assert.equal(inThread.code, inProcess.code);
  });

  it('copies the bytes unless the caller hands the buffer over', async () => {
    const { text } = await fixtures();
    const kept = Buffer.from(text.bytes);
    await extractText({ ...text, bytes: kept });
    assert.equal(kept.length, text.bytes.length, 'the caller still has its bytes');

    // A buffer that owns its whole ArrayBuffer and is handed over moves to the thread.
    const owned = Buffer.from(new Uint8Array(text.bytes).buffer);
    assert.equal(owned.byteOffset, 0);
    await extractText({ ...text, bytes: owned }, { transferBytes: true });
    assert.equal(owned.length, 0, 'the transferred buffer is detached');

    // A slice of a larger ArrayBuffer (Node's small-buffer pool) is never detached.
    const shared = Buffer.from(text.bytes);
    const slice = shared.subarray(0, 5);
    await extractText({ ...text, bytes: Buffer.from(slice) }, { transferBytes: true });
    await extractText({ ...text, bytes: slice }, { transferBytes: true });
    assert.equal(shared.length, text.bytes.length, 'the shared pool stays intact');
  });

  it('renders scanned PDF pages in a thread, identical to the in-process render', async () => {
    const { pdf } = await fixtures();
    const inThread = await renderScannedPdfPages(Buffer.from(pdf.bytes), 5);
    const inProcess = await renderScannedPdfPagesInProcess(Buffer.from(pdf.bytes), 5);
    assert.ok(inThread.pageImages.length >= 1);
    assert.deepEqual(inThread, inProcess);
  });

  it('runs more jobs than threads by queueing them', async () => {
    configureExtractionPool({ ...SETTINGS, threads: 1 });
    const { text } = await fixtures();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        extractText({ bytes: Buffer.from(`file ${i}`), name: `f${i}.txt` })
      )
    );
    assert.deepEqual(
      results.map(result => result.text),
      Array.from({ length: 6 }, (_, i) => `file ${i}`)
    );
    assert.equal(extractionPoolStats().threads, 1, 'one thread served all of them');
    assert.ok(text);
  });

  it('terminates a thread that runs past the time budget and rejects with EXTRACTION_TIMEOUT', async () => {
    configureExtractionPool({ ...SETTINGS, timeoutMs: 100 });
    await shutdownExtractionPool();
    configureExtractionPool({ ...SETTINGS, timeoutMs: 100 });
    const error = await extractText({ bytes: bigXlsx(), name: 'huge.xlsx' }).catch(e => e);
    assert.ok(error instanceof ExtractionError);
    assert.equal(error.code, 'EXTRACTION_TIMEOUT');
    assert.match(error.message, /huge\.xlsx/);
    assert.equal(extractionPoolStats().threads, 0, 'the thread was terminated, not left running');

    // The pool recovers: the next file gets a fresh thread and its full budget.
    configureExtractionPool(SETTINGS);
    const ok = await extractText({ bytes: Buffer.from('after the timeout'), name: 'a.txt' });
    assert.equal(ok.text, 'after the timeout');
  });

  it('starts the time budget when a job starts, not while it waits in the queue', async () => {
    configureExtractionPool({ ...SETTINGS, threads: 1, timeoutMs: 20_000 });
    const jobs = [bigXlsx(8000), bigXlsx(8000), bigXlsx(8000)].map(bytes =>
      runInThread('extract', { name: 'b.xlsx', options: {} }, { bytes, timeoutMs: 20_000 })
    );
    const outcomes = await Promise.all(jobs);
    assert.ok(outcomes.every(({ envelope }) => envelope.ok));
    assert.ok(outcomes[2].queueMs > outcomes[0].queueMs, 'later jobs waited for the thread');
  });

  it('replaces a thread that crashed', async () => {
    // A heap limit too small for the extractors makes the thread die with an
    // out-of-memory error, as a pathological file would.
    configureExtractionPool({ ...SETTINGS, threads: 1, memoryMb: 8 });
    await shutdownExtractionPool();
    configureExtractionPool({ ...SETTINGS, threads: 1, memoryMb: 8 });
    const error = await extractText({ bytes: bigXlsx(2000), name: 'big.xlsx' }).catch(e => e);
    assert.ok(error instanceof ExtractionError, String(error));
    assert.equal(error.code, 'EXTRACTION_FAILED');
    assert.equal(extractionPoolStats().threads, 0, 'the dead thread is gone');

    configureExtractionPool(SETTINGS);
    const ok = await extractText({ bytes: Buffer.from('still works'), name: 'a.txt' });
    assert.equal(ok.text, 'still works');
    assert.equal(extractionPoolStats().threads, 1, 'a new thread took over');
  });

  it('rejects waiting and running jobs on shutdown and refuses new ones', async () => {
    configureExtractionPool({ ...SETTINGS, threads: 1 });
    const running = extractText({ bytes: bigXlsx(), name: 'running.xlsx' }).catch(e => e);
    const waiting = extractText({ bytes: bigXlsx(), name: 'waiting.xlsx' }).catch(e => e);
    await new Promise(resolve => setTimeout(resolve, 50));
    await shutdownExtractionPool();
    for (const error of await Promise.all([running, waiting])) {
      assert.ok(error instanceof ExtractionError);
      assert.equal(error.code, 'INTERRUPTED');
    }
    assert.equal(extractionPoolStats().threads, 0);
    await assert.rejects(
      runInThread('extract', { name: 'x.txt', options: {} }, { bytes: Buffer.from('x') }),
      error => error instanceof ExtractionPoolError && error.code === 'shutdown'
    );
  });

  it('reads on the event loop with threads: 0', async () => {
    configureExtractionPool({ ...SETTINGS, threads: 0 });
    const result = await extractText({ bytes: Buffer.from('inline'), name: 'a.txt' });
    assert.equal(result.text, 'inline');
    assert.equal(extractionPoolStats().threads, 0);
  });
});

/** The longest gap between two ticks of a 2 ms timer while `work` runs. */
async function longestStall(work) {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - 2);
    last = now;
  }, 2);
  try {
    await work();
    // A block that ends with the work leaves no tick behind: count the gap up to now.
    longest = Math.max(longest, performance.now() - last - 2);
  } finally {
    clearInterval(timer);
  }
  return longest;
}

describe('the event loop', () => {
  it('stays free while a large workbook is read', async () => {
    const bytes = bigXlsx();
    // Warm up: the thread loads its extractors on first use, which is not what is measured.
    await extractText({ bytes: Buffer.from('warm'), name: 'w.txt' });
    await extractText({ bytes: xlsxOf([['a'], [1]]), name: 'w.xlsx' });

    const inProcess = await longestStall(() =>
      extractTextInProcess({ bytes: Buffer.from(bytes), name: 'large.xlsx' })
    );
    const inThread = await longestStall(() =>
      extractText({ bytes: Buffer.from(bytes), name: 'large.xlsx' })
    );
    // The copy of the bytes and the result's structured clone stay on the loop; the parse does not.
    // A fast runner may stall little in process; then there is nothing to compare, and
    // the thread must still be quiet in absolute terms.
    assert.ok(
      inThread < 100 && (inProcess < 40 || inThread < inProcess / 3),
      `reading in a thread does not stall the loop (${inThread.toFixed(0)} ms vs ${inProcess.toFixed(0)} ms in process)`
    );
  });
});

describe('extraction metrics', () => {
  it('records the duration of the extraction proper per format, and the queue wait', async () => {
    const records = [];
    const instrument = (name, _options) => ({
      record: (value, attributes) => records.push({ name, value, attributes }),
      add() {},
      addCallback() {}
    });
    initializeMetrics({
      getMeter: () =>
        new Proxy(
          {},
          {
            get: (_, method) => (name, options) =>
              method === 'createHistogram' ? instrument(name, options) : instrument(name)
          }
        )
    });
    try {
      const { xlsx } = await fixtures();
      await extractText(copyOf(xlsx));
      await extractText({ bytes: Buffer.from('   '), name: 'blank.txt' }).catch(() => {});
      const durations = records.filter(r => r.name === 'ihub.extraction.duration');
      assert.deepEqual(
        durations.map(r => r.attributes.format),
        ['xlsx', 'text'],
        'the format is the one resolved in the thread, failures included'
      );
      assert.ok(durations.every(r => r.value > 0));
      assert.equal(records.filter(r => r.name === 'ihub.extraction.queue.duration').length, 2);
    } finally {
      initializeMetrics({
        getMeter: () =>
          new Proxy({}, { get: () => () => ({ record() {}, add() {}, addCallback() {} }) })
      });
    }
  });
});

describe('projects.extraction settings', () => {
  const read = extraction => projectSettings({ projects: { extraction } }).extraction;

  it('falls back to defaults and clamps what is out of range', () => {
    const defaults = read(undefined);
    assert.equal(defaults.threads, 1);
    assert.equal(defaults.timeoutMs, 60_000);
    const heapMb = Math.floor(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
    assert.equal(defaults.memoryMb, Math.min(1024, Math.max(128, Math.floor(heapMb / 2))));
    assert.deepEqual(read({ threads: null, timeoutMs: '', memoryMb: 'lots' }), defaults);
    assert.equal(read({ threads: 0 }).threads, 0, '0 turns the threads off');
    assert.equal(read({ threads: 99 }).threads, 4);
    assert.equal(read({ threads: -1 }).threads, 0);
    assert.equal(read({ timeoutMs: 5 }).timeoutMs, 1000);
    assert.equal(read({ timeoutMs: 9e9 }).timeoutMs, 600_000);
    assert.equal(read({ memoryMb: 1 }).memoryMb, 128);
  });

  it('is validated in the platform schema', () => {
    const parse = extraction => platformConfigSchema.safeParse({ projects: { extraction } });
    assert.ok(parse({ threads: 2, timeoutMs: 30_000, memoryMb: 512 }).success);
    assert.ok(parse({ threads: 0 }).success);
    assert.ok(parse(undefined).success, 'the block is optional');
    for (const bad of [
      { threads: 5 },
      { threads: -1 },
      { threads: 1.5 },
      { timeoutMs: 10 },
      { timeoutMs: 700_000 },
      { memoryMb: 64 },
      { memoryMb: 'big' }
    ]) {
      assert.equal(parse(bad).success, false, JSON.stringify(bad));
    }
  });
});
