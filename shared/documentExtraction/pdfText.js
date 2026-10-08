/**
 * Text of a PDF as the model should read it: one block per page, introduced by a
 * `[Page N]` marker (with the printed label when the PDF defines page labels), real lines
 * instead of one run of words, and pages without a text layer flagged instead of silently
 * missing.
 *
 * Pure functions on pdf.js output. pdf.js itself is not imported here (`shared/` has no bare
 * imports; the browser loads pdfjs-dist lazily, the server tests use the legacy build) — the
 * document object is passed in.
 *
 * @module shared/documentExtraction/pdfText
 */

import { noTextPageMarker, pageMarker } from './markers.js';

/**
 * Lines of one page from pdf.js text items.
 *
 * pdf.js reports a line end as `hasEOL` on an item (usually an empty one) and puts the spaces
 * between words of one line into the items itself, so the items of a line are concatenated
 * without a separator — joining them with a space, as the plain extraction did, doubles every
 * space and glues the lines of the page into one. Line ends are kept as they are (no
 * dehyphenation: `Bundes-` / `und Landesrecht` must stay readable).
 *
 * @param {Array<{str?: string, hasEOL?: boolean}>} items - `getTextContent().items`
 * @returns {string[]} Non-empty lines, whitespace collapsed
 */
export function itemsToLines(items) {
  const lines = [];
  let current = '';
  for (const item of Array.isArray(items) ? items : []) {
    // Marked-content items carry no text.
    if (!item || typeof item.str !== 'string') continue;
    current += item.str;
    if (item.hasEOL) {
      lines.push(current);
      current = '';
    }
  }
  lines.push(current);
  return lines.map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(line => line !== '');
}

/**
 * One page as marker line plus text lines.
 *
 * @param {Array} items - Text items of the page
 * @param {number} pageNumber - 1-based physical page number
 * @param {string|null} [label] - Printed page label
 * @returns {{text: string, hasText: boolean}}
 */
export function formatPdfPage(items, pageNumber, label) {
  const lines = itemsToLines(items);
  if (lines.length === 0) return { text: noTextPageMarker(pageNumber), hasText: false };
  return { text: [pageMarker(pageNumber, label), ...lines].join('\n'), hasText: true };
}

/**
 * Join the pages. A PDF in which no page has text (a scan) yields an empty string, never a row
 * of "no extractable text" markers: callers read an empty result as "render the pages as
 * images instead".
 *
 * @param {Array<{text: string, hasText: boolean}>} pages
 * @returns {string}
 */
export function joinPdfPages(pages) {
  return pages.some(page => page.hasText) ? pages.map(page => page.text).join('\n\n') : '';
}

/**
 * Text of a whole PDF from the items of every page (pure; the document-level entry point is
 * {@link extractPdfText}).
 *
 * @param {Array<Array>} pagesItems - Text items per page
 * @param {Array<string>|null} [labels] - `pdf.getPageLabels()`
 * @returns {string}
 */
export function assemblePdfText(pagesItems, labels) {
  const list = Array.isArray(labels) ? labels : [];
  return joinPdfPages(
    pagesItems.map((items, index) => formatPdfPage(items, index + 1, list[index]))
  );
}

async function readPageLabels(pdf) {
  try {
    const labels = await pdf.getPageLabels();
    return Array.isArray(labels) ? labels : [];
  } catch {
    // Broken label tree: physical page numbers only, the text itself is fine.
    return [];
  }
}

/**
 * Text of a pdf.js document. Reads page by page, so a long document never holds more than one
 * page of items.
 *
 * @param {{numPages: number, getPage: Function, getPageLabels: Function}} pdf - pdf.js document
 * @returns {Promise<string>} Markers and text, or '' when no page has a text layer
 */
export async function extractPdfText(pdf) {
  const labels = await readPageLabels(pdf);
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const { items } = await page.getTextContent();
    pages.push(formatPdfPage(items, number, labels[number - 1]));
  }
  return joinPdfPages(pages);
}
