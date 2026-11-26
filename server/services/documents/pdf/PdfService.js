// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { PNG } from 'pngjs';
import logger from '../../../utils/logger.js';
import { DEFAULT_TIMEOUT_MS, DocumentGenerationError, renderInWorker } from '../renderService.js';

/**
 * Server-side PDF generation.
 *
 * `createPdf` builds and renders a document spec (see `buildDocument.js`) in
 * a worker thread (`../renderService.js`): layout is CPU-bound and the input
 * may come from a model. `renderPagePreview` rasterises one page with pdfium
 * (WASM), so a model can look at what it produced.
 */

const COMPONENT = 'PdfService';

export { DEFAULT_TIMEOUT_MS };

/**
 * Build and render a document spec.
 *
 * @param {import('./buildDocument.js').PdfSpec} spec - Plain JSON.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Object} [options.assets] - Template files (fonts, letterhead), see
 *   `../templates/applyTemplate.js`.
 * @returns {Promise<{ buffer: Buffer, pages: number, warnings: string[] }>}
 */
export async function createPdf(spec, { timeoutMs = DEFAULT_TIMEOUT_MS, assets } = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new DocumentGenerationError('A document spec is required.', 'invalid');
  }
  const started = Date.now();
  try {
    const { buffer, meta, warnings } = await renderInWorker('pdf', { spec, assets }, { timeoutMs });
    logger.info('PDF generated', {
      component: COMPONENT,
      pages: meta.pages,
      bytes: buffer.length,
      durationMs: Date.now() - started,
      warnings: warnings.length
    });
    return { buffer, pages: meta.pages, warnings };
  } catch (error) {
    logger.warn('PDF generation failed', {
      component: COMPONENT,
      code: error.code,
      error: error.message,
      durationMs: Date.now() - started
    });
    throw error;
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

/** Longest edge of a page rendered for text recognition, in pixels. */
const RECOGNITION_MAX_EDGE = 2400;

/**
 * Render chosen pages of a PDF to PNG for text recognition: scale 2 (about
 * 1190 px wide for A4), the longest edge capped so an oversized page cannot
 * take the memory of the process. The document is loaded once for all of them.
 * Page numbers past the end are skipped.
 *
 * @param {Buffer|Uint8Array} buffer - PDF bytes.
 * @param {number[]} pageNumbers - 1-based.
 * @returns {Promise<{ images: Array<{ page: number, base64: string }>, pages: number }>}
 */
export async function renderPagesForRecognition(buffer, pageNumbers) {
  const library = await getPdfium();
  const document = await library.loadDocument(new Uint8Array(buffer));
  try {
    const pages = document.getPageCount();
    const images = [];
    for (const pageNumber of pageNumbers) {
      const number = Math.floor(pageNumber);
      if (!(number >= 1 && number <= pages)) continue;
      const page = document.getPage(number - 1);
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const scale = Math.min(2, RECOGNITION_MAX_EDGE / Math.max(originalWidth, originalHeight, 1));
      const image = await page.render({ scale, render: 'bitmap' });
      const png = new PNG({ width: image.width, height: image.height });
      png.data = Buffer.from(image.data);
      images.push({ page: number, base64: PNG.sync.write(png).toString('base64') });
    }
    return { images, pages };
  } finally {
    document.destroy();
  }
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
