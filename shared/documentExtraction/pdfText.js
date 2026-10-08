/**
 * Text of a PDF as the model should read it: one block per page, introduced by a
 * `[Page N]` marker (with the printed label when the PDF defines page labels), real lines
 * instead of one run of words, pages without a text layer flagged instead of silently
 * missing — and, where the PDF offers it, headings (`#`) and tables (`|`).
 *
 * Pure functions on pdf.js output. pdf.js itself is not imported here (`shared/` has no bare
 * imports; the browser loads pdfjs-dist lazily, the server tests use the legacy build) — the
 * document object is passed in. Where the structure comes from is described in
 * {@link module:shared/documentExtraction/pdfStructure}.
 *
 * @module shared/documentExtraction/pdfText
 */

import { noTextPageMarker, pageMarker } from './markers.js';
import {
  MAX_OUTLINE_ENTRIES,
  MAX_OUTLINE_NODES,
  applyFontHeadings,
  applyOutlineHeadings,
  countHeadings,
  pageBlocks
} from './pdfStructure.js';

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
  return pageBlocks(items, null, null).map(block => block.text);
}

/**
 * A page of the document model: its blocks (lines, headings, tables) before they are rendered.
 *
 * @param {Array} items - Text items of the page
 * @param {number} number - 1-based physical page number
 * @param {string|null} [label] - Printed page label
 * @param {object|null} [structTree] - `await page.getStructTree()`, null for an untagged PDF
 * @param {object|null} [styles] - `getTextContent().styles` (font families by font name)
 * @returns {{number: number, label: string|null, blocks: Array}}
 */
export function buildPdfPage(items, number, label, structTree, styles) {
  let blocks;
  try {
    blocks = pageBlocks(items, structTree, styles);
  } catch {
    // A tree that cannot be read must not cost the lines of the page.
    blocks = pageBlocks(items, null, styles);
  }
  return { number, label: label ?? null, blocks };
}

function renderTable(rows) {
  const cell = text =>
    text.includes('|') ? text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|') : text;
  const lines = rows.map(row => `| ${row.cells.map(cell).join(' | ')} |`);
  // Only a header the PDF itself marks as one gets the separator: a table continued from the
  // previous page starts with a data row, which must not pose as its header.
  if (rows.length > 0 && rows[0].header) {
    lines.splice(1, 0, `| ${rows[0].cells.map(() => '---').join(' | ')} |`);
  }
  return lines;
}

/**
 * One page as marker line plus text lines.
 *
 * @param {{number: number, label: string|null, blocks: Array}} page
 * @returns {{text: string, hasText: boolean}}
 */
export function renderPdfPage(page) {
  const lines = [];
  const blank = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  };
  for (const block of page.blocks) {
    if (block.type === 'heading') lines.push(`${'#'.repeat(block.level)} ${block.text}`);
    else if (block.type === 'table') {
      blank();
      lines.push(...renderTable(block.rows));
      lines.push('');
    } else lines.push(block.text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { text: noTextPageMarker(page.number), hasText: false };
  return { text: [pageMarker(page.number, page.label), ...lines].join('\n'), hasText: true };
}

/**
 * One page as marker line plus text lines, without structure sources (lines only).
 *
 * @param {Array} items - Text items of the page
 * @param {number} pageNumber - 1-based physical page number
 * @param {string|null} [label] - Printed page label
 * @returns {{text: string, hasText: boolean}}
 */
export function formatPdfPage(items, pageNumber, label) {
  return renderPdfPage(buildPdfPage(items, pageNumber, label, null));
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
 * Headings for the whole document, from the first source that has any: tags (already in the
 * blocks), outline, font size. Never throws — a document whose structure cannot be read keeps
 * its lines.
 *
 * @param {Array<{blocks: Array}>} pages
 * @param {Array<{title: string, depth: number, pageIndex: number}>} outline
 */
function addHeadings(pages, outline) {
  try {
    if (countHeadings(pages) > 0) return;
    if (applyOutlineHeadings(pages, outline) > 0) return;
    applyFontHeadings(pages);
  } catch {
    // Keep the lines as they are.
  }
}

/**
 * Text of a whole PDF from the items of every page (pure; the document-level entry point is
 * {@link extractPdfText}).
 *
 * @param {Array<Array|{items: Array, structTree?: object|null, styles?: object}>} pagesItems - Text
 *   items per page, or `{ items, structTree, styles }` where the PDF is tagged or fonts are known
 * @param {Array<string>|null} [labels] - `pdf.getPageLabels()`
 * @param {{outline?: Array<{title: string, depth: number, pageIndex: number}>}} [options]
 *   Resolved outline entries (see {@link readOutline})
 * @returns {string}
 */
export function assemblePdfText(pagesItems, labels, options = {}) {
  const list = Array.isArray(labels) ? labels : [];
  const pages = pagesItems.map((entry, index) => {
    const tagged = !Array.isArray(entry) && entry ? entry : { items: entry };
    return buildPdfPage(tagged.items, index + 1, list[index], tagged.structTree, tagged.styles);
  });
  addHeadings(pages, options.outline || []);
  return joinPdfPages(pages.map(renderPdfPage));
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

async function readStructTree(page) {
  try {
    return typeof page.getStructTree === 'function' ? await page.getStructTree() : null;
  } catch {
    return null;
  }
}

/**
 * The outline of a pdf.js document as flat entries in document order: title, depth (1 = top
 * level) and the 0-based index of the page the entry points to. Entries without a resolvable
 * page (external links, broken destinations) are left out.
 *
 * @param {object} pdf - pdf.js document
 * @returns {Promise<Array<{title: string, depth: number, pageIndex: number}>>}
 */
export async function readOutline(pdf) {
  const entries = [];
  try {
    const outline = typeof pdf.getOutline === 'function' ? await pdf.getOutline() : null;
    if (!Array.isArray(outline)) return entries;
    // Iterative, depth first, one frame per level: nothing is copied up front, and the nodes
    // visited are counted whether they resolve or not (a hostile outline may be huge and deep).
    const stack = [{ items: outline, next: 0, depth: 1 }];
    let visited = 0;
    while (
      stack.length > 0 &&
      entries.length < MAX_OUTLINE_ENTRIES &&
      visited < MAX_OUTLINE_NODES
    ) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.items.length) {
        stack.pop();
        continue;
      }
      const item = frame.items[frame.next];
      frame.next += 1;
      visited += 1;
      if (!item || typeof item !== 'object') continue;
      try {
        let destination = item.dest;
        if (typeof destination === 'string') destination = await pdf.getDestination(destination);
        if (Array.isArray(destination) && typeof item.title === 'string') {
          const target = destination[0];
          const pageIndex = Number.isInteger(target) ? target : await pdf.getPageIndex(target);
          if (Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pdf.numPages) {
            entries.push({ title: item.title, depth: frame.depth, pageIndex });
          }
        }
      } catch {
        // An entry that does not resolve is skipped; its children may still be fine.
      }
      if (Array.isArray(item.items) && item.items.length > 0) {
        stack.push({ items: item.items, next: 0, depth: frame.depth + 1 });
      }
    }
  } catch {
    return [];
  }
  return entries;
}

/**
 * Text of a pdf.js document. Reads page by page, so a long document never holds more than the
 * blocks of its pages (small compared to the items they come from).
 *
 * @param {{numPages: number, getPage: Function, getPageLabels: Function}} pdf - pdf.js document
 * @returns {Promise<string>} Markers and text, or '' when no page has a text layer
 */
export async function extractPdfText(pdf) {
  const labels = await readPageLabels(pdf);
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    // Marked content is what ties text to the structure tree; plain pages are unaffected.
    const { items, styles } = await page.getTextContent({ includeMarkedContent: true });
    pages.push(buildPdfPage(items, number, labels[number - 1], await readStructTree(page), styles));
  }
  addHeadings(pages, await readOutline(pdf));
  return joinPdfPages(pages.map(renderPdfPage));
}
