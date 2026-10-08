/**
 * Text markers of structured document extraction.
 *
 * Fixed English vocabulary, consistent with the existing `[Sheet: …]` / `[Slide N]`
 * markers; models read them in any document language. Documented in
 * docs/file-upload-feature.md ("Extracted text format").
 *
 * @module shared/documentExtraction/markers
 */

/** An explicit page break in a Word document (never numbered — Word does not store pages). */
export const PAGE_BREAK_MARKER = '[Page break]';

/** Below this many characters of real text a PDF counts as scanned (page images are rendered). */
export const MIN_REAL_TEXT_CHARS = 50;

/**
 * Marker line of a PDF page. The printed label (roman front matter, `A-1`, …) is
 * only added when it differs from the physical page number.
 *
 * @param {number} pageNumber - 1-based physical page number
 * @param {string|null} [label] - Printed page label, if the PDF defines labels
 * @returns {string}
 */
export function pageMarker(pageNumber, label) {
  // The label is read from the PDF: no line breaks or brackets, so it cannot break the marker.
  const cleaned =
    label == null
      ? ''
      : String(label)
          .replace(/[\s[\]()]+/g, ' ')
          .trim()
          .slice(0, 40);
  const printed = cleaned !== '' && cleaned !== String(pageNumber) ? cleaned : '';
  return printed ? `[Page ${pageNumber} (printed: ${printed})]` : `[Page ${pageNumber}]`;
}

/** Marker of a PDF page without a text layer inside a PDF that has text elsewhere. */
export const noTextPageMarker = pageNumber => `[Page ${pageNumber}: no extractable text]`;

/** Prefixes of the header / footer block of a Word document. */
export const HEADER_PREFIX = '[Header]';
export const FOOTER_PREFIX = '[Footer]';

const MARKER_LINE =
  /^\[(?:Page \d+(?: \(printed: [^)\n]*\))?(?:: no extractable text)?|Page break)\]$/;

/**
 * Number of characters of real text: what is left when page markers, blank lines and the line
 * breaks between lines are not counted. The scanned-PDF check must use this instead of the raw
 * length: markers alone would make a scan look like text and silently disable the page-image
 * fallback, and so would the separators between many pages with a single character each.
 *
 * @param {string} text
 * @returns {number}
 */
export function realTextLength(text) {
  if (typeof text !== 'string') return 0;
  let total = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!MARKER_LINE.test(line)) total += line.length;
  }
  return total;
}

const PAGE_START = /^\[Page (\d+)(?: \(printed: [^)\n]*\))?\]$/;

/**
 * Physical number of the last page that has real text (0 when there is none). A PDF with text on
 * a page the fallback does not render must keep that text: the images alone would lose it.
 *
 * @param {string} text - Structured PDF text with page markers
 * @returns {number}
 */
export function lastPageWithText(text) {
  if (typeof text !== 'string') return 0;
  let current = 0;
  let last = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const start = PAGE_START.exec(line);
    if (start) current = Number(start[1]);
    else if (line !== '' && !MARKER_LINE.test(line)) last = current;
  }
  return last;
}
