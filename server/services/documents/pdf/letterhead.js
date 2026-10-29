// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState
} from 'pdf-lib';

/**
 * Print a document on the company's letterhead.
 *
 * A document template can carry a letterhead PDF (logo, address block,
 * footer lines — the stationery). Its first page goes under the first page
 * of the document, and the following pages get the template's
 * "following pages" letterhead, or the letterhead's second page, or —
 * when it has neither — the first page again.
 *
 * The letterhead is drawn *beneath* the content: its drawing operations are
 * put in front of the page's own content stream, so text and pictures stay on
 * top and links, outlines and the document metadata are untouched. It is
 * scaled to the page when the sizes differ.
 */

/**
 * @param {Buffer} pdfBytes - The rendered document.
 * @param {Object} letterhead
 * @param {Uint8Array} [letterhead.first] - Letterhead PDF.
 * @param {Uint8Array} [letterhead.following] - Letterhead for pages 2 and later.
 * @param {Object} [options]
 * @param {number} [options.skipPages] - Leading pages without letterhead (a cover page).
 * @returns {Promise<Buffer>}
 */
export async function applyLetterhead(pdfBytes, { first, following } = {}, { skipPages = 0 } = {}) {
  if (!first && !following) return pdfBytes;
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const firstSource = first ? await PDFDocument.load(first, { updateMetadata: false }) : null;
  const followingSource = following
    ? await PDFDocument.load(following, { updateMetadata: false })
    : null;

  let firstPage = null;
  let nextPage = null;
  if (firstSource) {
    [firstPage] = await doc.embedPdf(firstSource, [0]);
    if (!followingSource && firstSource.getPageCount() > 1) {
      [nextPage] = await doc.embedPdf(firstSource, [1]);
    }
  }
  if (followingSource) [nextPage] = await doc.embedPdf(followingSource, [0]);
  if (!nextPage) nextPage = firstPage;
  if (!firstPage) firstPage = nextPage;

  doc.getPages().forEach((page, index) => {
    if (index < skipPages) return;
    const embedded = index === skipPages ? firstPage : nextPage;
    if (!embedded) return;
    const { width, height } = page.getSize();
    const name = page.node.newXObject('Letterhead', embedded.ref);
    const stream = doc.context.contentStream([
      pushGraphicsState(),
      concatTransformationMatrix(width / embedded.width, 0, 0, height / embedded.height, 0, 0),
      drawObject(name),
      popGraphicsState()
    ]);
    const ref = doc.context.register(stream);
    const { Contents } = page.node.normalizedEntries();
    if (Contents && typeof Contents.insert === 'function') Contents.insert(0, ref);
    else page.node.addContentStream(ref);
  });
  return Buffer.from(await doc.save({ updateFieldAppearances: false }));
}
