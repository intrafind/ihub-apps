/**
 * Glue between pdf.js text extraction and the shadow-text passage matcher.
 *
 * The matcher works on "page indexes" (a shadow text plus normalization
 * diffs). It returns match positions in *text-layer coordinates*: offsets into
 * the concatenation of the page's `textContent.items[].str`, with the synthetic
 * end-of-line markers removed again. Those offsets are what
 * {@link matchToItemSlices} turns back into per-text-item slices so the DOM
 * ranges of the rendered text layer can be highlighted.
 */

import { normalize, buildShadow, computePassageMatches } from './passageMatcher.js';

/**
 * Builds the page index the matcher expects from a pdf.js text content object.
 *
 * The extraction buffer mirrors what pdf.js's own find controller builds: the
 * item strings concatenated, with a newline pushed wherever an item ends a
 * line. `normalize()` folds those newlines away again, so the resulting diffs
 * map normalized offsets back to the item strings without them.
 *
 * @param {{items: Array<{str: string, hasEOL: boolean}>}} textContent
 * @returns {{shadow: object, diffs: Array<[number, number]>|null}}
 */
export function buildPageIndex(textContent) {
  const strBuf = [];
  for (const item of textContent.items) {
    if (item.str === undefined) continue;
    strBuf.push(item.str);
    if (item.hasEOL) {
      strBuf.push('\n');
    }
  }
  const [content, diffs] = normalize(strBuf.join(''));
  return { shadow: buildShadow(content), diffs };
}

/**
 * The item strings a match's offsets are relative to.
 *
 * Uses the same rule as pdf.js's `TextLayer` (`item.str === undefined` marks a
 * marked-content boundary rather than text), so this list is index-aligned with
 * the layer's `textContentItemsStr` / `textDivs` — which is what lets a match
 * offset be resolved to a rendered element.
 *
 * @param {{items: Array<{str: string}>}} textContent
 * @returns {string[]}
 */
export function itemStringsOf(textContent) {
  return textContent.items.filter(item => item.str !== undefined).map(item => item.str);
}

/** Page index for a page whose text could not be extracted. */
export function emptyPageIndex() {
  return { shadow: buildShadow(''), diffs: null };
}

/**
 * Splits a match into the text items it covers.
 *
 * @param {string[]} itemStrings the page's `textContent.items[].str`, in order.
 * @param {number} matchStart offset into the concatenated item strings.
 * @param {number} matchLength length of the match in the same coordinates.
 * @returns {Array<{itemIdx: number, start: number, end: number}>} per-item
 *   slices, `start`/`end` being offsets within that item's string.
 */
export function matchToItemSlices(itemStrings, matchStart, matchLength) {
  const slices = [];
  const matchEnd = matchStart + matchLength;
  let offset = 0;
  for (let i = 0; i < itemStrings.length; i += 1) {
    const itemStart = offset;
    const itemEnd = offset + itemStrings[i].length;
    offset = itemEnd;
    if (itemEnd <= matchStart) continue;
    if (itemStart >= matchEnd) break;
    const start = Math.max(0, matchStart - itemStart);
    const end = Math.min(itemStrings[i].length, matchEnd - itemStart);
    if (end > start) {
      slices.push({ itemIdx: i, start, end });
    }
  }
  return slices;
}

/**
 * Flattens the matcher's per-page result into a document-ordered list, which
 * is what the viewer's "next/previous match" navigation walks.
 *
 * @param {{pageMatches: number[][], pageMatchesLength: number[][]}} result
 * @returns {Array<{pageIdx: number, matchIdx: number, start: number, length: number}>}
 */
export function flattenMatches(result) {
  const flat = [];
  result.pageMatches.forEach((positions, pageIdx) => {
    positions.forEach((start, matchIdx) => {
      flat.push({
        pageIdx,
        matchIdx,
        start,
        length: result.pageMatchesLength[pageIdx][matchIdx]
      });
    });
  });
  return flat;
}

export { computePassageMatches };
