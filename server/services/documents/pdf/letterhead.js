// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState
} from 'pdf-lib';
import { PAGE_SIZES } from './buildDocument.js';

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
 * Embed one letterhead page as it is meant to be printed: its TrimBox (which
 * falls back to the CropBox and MediaBox), wherever the box's origin is.
 * A page exported with bleed is thus not shrunk, and a page whose MediaBox
 * does not start at 0,0 is not shifted.
 */
async function embedTrimmed(doc, source, index) {
  const page = source.getPage(index);
  const box = page.getTrimBox();
  return doc.embedPage(page, {
    left: box.x,
    bottom: box.y,
    right: box.x + box.width,
    top: box.y + box.height
  });
}

/**
 * The printed size of a letterhead's first page, matched to a page format.
 *
 * @param {Uint8Array} bytes - Letterhead PDF.
 * @returns {Promise<{ size: string, orientation: string } | null>} null when
 *   it matches no format the documents support.
 */
export async function letterheadPageFormat(bytes) {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const { width, height } = source.getPage(0).getTrimBox();
  const orientation = width > height ? 'landscape' : 'portrait';
  const [short, long] = [Math.min(width, height), Math.max(width, height)];
  for (const [size, [w, h]] of Object.entries(PAGE_SIZES)) {
    if (Math.abs(short - w) / w < 0.02 && Math.abs(long - h) / h < 0.02) {
      return { size, orientation };
    }
  }
  return null;
}

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
    firstPage = await embedTrimmed(doc, firstSource, 0);
    if (!followingSource && firstSource.getPageCount() > 1) {
      nextPage = await embedTrimmed(doc, firstSource, 1);
    }
  }
  if (followingSource) nextPage = await embedTrimmed(doc, followingSource, 0);
  if (!nextPage) nextPage = firstPage;
  if (!firstPage) firstPage = nextPage;

  doc.getPages().forEach((page, index) => {
    if (index < skipPages) return;
    const embedded = index === skipPages ? firstPage : nextPage;
    if (!embedded) return;
    const { width, height } = page.getSize();
    // Scaled evenly and centred, so a letterhead of another size keeps its
    // proportions.
    const scale = Math.min(width / embedded.width, height / embedded.height);
    const dx = (width - embedded.width * scale) / 2;
    const dy = (height - embedded.height * scale) / 2;
    const name = page.node.newXObject('Letterhead', embedded.ref);
    const stream = doc.context.contentStream([
      pushGraphicsState(),
      concatTransformationMatrix(scale, 0, 0, scale, dx, dy),
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
