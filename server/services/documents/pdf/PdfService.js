import { Worker } from 'worker_threads';
import { PNG } from 'pngjs';
import logger from '../../../utils/logger.js';

/**
 * Server-side PDF generation.
 *
 * `createPdf` builds and renders a document spec (see `buildDocument.js`) in
 * a worker thread: layout is CPU-bound and the input may come from a model,
 * so each document gets a fresh worker, a time budget and a memory cap, and a
 * small concurrency limit keeps a burst of documents from starving chat
 * traffic. `renderPagePreview` rasterises one page with pdfium (WASM), so a
 * model can look at what it produced.
 */

const COMPONENT = 'PdfService';
const WORKER_URL = new URL('./pdfWorker.js', import.meta.url);

export const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 20;
const WORKER_MEMORY_MB = 512;

export class PdfGenerationError extends Error {
  /**
   * @param {string} message
   * @param {string} code - `invalid`, `timeout`, `busy`, `failed`
   */
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'PdfGenerationError';
    this.code = code;
  }
}

let running = 0;
const queue = [];

function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  if (queue.length >= MAX_QUEUED) {
    return Promise.reject(
      new PdfGenerationError('The PDF service is busy. Try again in a moment.', 'busy')
    );
  }
  return new Promise(resolve => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next();
  else running -= 1;
}

function runWorker(spec, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB }
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new PdfGenerationError(
          `Rendering the PDF took longer than ${Math.round(timeoutMs / 1000)} s. Simplify or split the document.`,
          'timeout'
        )
      );
    }, timeoutMs);
    worker.once('message', message => {
      if (message?.ok) {
        finish(resolve, {
          buffer: Buffer.from(
            message.bytes.buffer,
            message.bytes.byteOffset,
            message.bytes.byteLength
          ),
          pages: message.pages,
          warnings: message.warnings || []
        });
      } else {
        finish(reject, new PdfGenerationError(message?.error || 'PDF rendering failed', 'invalid'));
      }
    });
    worker.once('error', error => {
      const outOfMemory = error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish(
        reject,
        new PdfGenerationError(
          outOfMemory
            ? 'The document needs too much memory to render. Split it into smaller documents.'
            : `PDF rendering failed: ${error?.message || error}`,
          outOfMemory ? 'invalid' : 'failed'
        )
      );
    });
    worker.once('exit', code => {
      if (!settled) {
        finish(reject, new PdfGenerationError(`PDF renderer exited (code ${code})`, 'failed'));
      }
    });
    worker.postMessage({ spec });
  });
}

/**
 * Build and render a document spec.
 *
 * @param {import('./buildDocument.js').PdfSpec} spec - Plain JSON.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ buffer: Buffer, pages: number, warnings: string[] }>}
 */
export async function createPdf(spec, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new PdfGenerationError('A document spec is required.', 'invalid');
  }
  await acquire();
  const started = Date.now();
  try {
    const result = await runWorker(spec, timeoutMs);
    logger.info('PDF generated', {
      component: COMPONENT,
      pages: result.pages,
      bytes: result.buffer.length,
      durationMs: Date.now() - started,
      warnings: result.warnings.length
    });
    return result;
  } catch (error) {
    logger.warn('PDF generation failed', {
      component: COMPONENT,
      code: error.code,
      error: error.message,
      durationMs: Date.now() - started
    });
    throw error;
  } finally {
    release();
  }
}

let pdfiumLibrary = null;

async function getPdfium() {
  if (!pdfiumLibrary) {
    const { PDFiumLibrary } = await import('@hyzyla/pdfium');
    pdfiumLibrary = await PDFiumLibrary.init();
  }
  return pdfiumLibrary;
}

/** Longest edge of a preview image, in pixels. */
const PREVIEW_MAX_EDGE = 1400;

/**
 * Render one page of a PDF to PNG.
 *
 * @param {Buffer} buffer - PDF bytes.
 * @param {number} pageNumber - 1-based.
 * @returns {Promise<{ png: Buffer, width: number, height: number, pages: number }>}
 */
export async function renderPagePreview(buffer, pageNumber = 1) {
  const library = await getPdfium();
  const document = await library.loadDocument(new Uint8Array(buffer));
  try {
    const pages = document.getPageCount();
    const index = Math.min(Math.max(Math.floor(pageNumber) || 1, 1), pages) - 1;
    const page = document.getPage(index);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const scale = Math.min(2, PREVIEW_MAX_EDGE / Math.max(originalWidth, originalHeight, 1));
    const image = await page.render({ scale, render: 'bitmap' });
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data);
    return {
      png: PNG.sync.write(png),
      width: image.width,
      height: image.height,
      pages,
      page: index + 1
    };
  } finally {
    document.destroy();
  }
}
