// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { renderPagePreview } from './PdfService.js';

/**
 * Render up to `maxPages` pages of a scanned PDF as base64 PNG images with
 * pdfium (`renderPagePreview`). The work is CPU-bound WASM: callers on the
 * server go through `services/projects/extractionPool.js`, which runs this in
 * a worker thread; the thread and the thread-less fallback both land here.
 *
 * @param {Buffer|Uint8Array} bytes - PDF bytes.
 * @param {number} maxPages
 * @returns {Promise<{pageImages: string[], pages: number}>}
 */
export async function renderScannedPdfPagesInProcess(bytes, maxPages) {
  const first = await renderPagePreview(bytes, 1);
  const totalPages = first.pages || 1;
  const pageImages = [first.png.toString('base64')];
  const limit = Math.min(totalPages, maxPages);
  for (let p = 2; p <= limit; p += 1) {
    const rendered = await renderPagePreview(bytes, p);
    pageImages.push(rendered.png.toString('base64'));
  }
  return { pageImages, pages: totalPages };
}
