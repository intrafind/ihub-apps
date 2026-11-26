// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How much of each PDF page pictures and drawings cover, for the "smart" page
 * selection of text recognition (`services/ocr/textRecognition.js`): a page
 * whose text sits next to a large chart, diagram, table or photo is worth
 * recognizing, a page with a logo is not.
 *
 * Read from pdf.js' operator list, nothing is rendered:
 *
 * - an image (`paintImageXObject` and its kin) covers the unit square under
 *   the current transformation;
 * - a vector drawing (`constructPath`) covers its bounding box under the
 *   current transformation (a line chart's polyline covers the plot area, a
 *   table grid the table);
 * - forms (`paintFormXObjectBegin`) apply their matrix like a `save` and
 *   `transform`.
 *
 * Coverage is counted on a coarse grid over the page, so overlapping shapes
 * (grid lines and bars of one chart) are not counted twice. A shape that
 * covers nearly the whole page is a background, a frame or a scanned page
 * under a text layer, not a figure next to text, and is left out.
 *
 * CPU-bound like the extraction: callers go through the extraction pool
 * (`analyzePdfPageFigures` in `services/projects/extractionPool.js`).
 *
 * @module services/documents/pdf/pageFigures
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Cells per side of the coverage grid. */
const GRID = 32;

/** A shape covering at least this share of the page is a background, not a figure. */
const BACKGROUND_SHARE = 0.9;

const OPS = pdfjs.OPS || {};

const IMAGE_OPS = new Set(
  [
    OPS.paintImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintJpegXObject
  ].filter(op => op !== undefined)
);

/** `a`–`f` of two matrices multiplied (`m` then `n`, as PDF's `cm` concatenates). */
function multiply(m, n) {
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5]
  ];
}

/** The axis-aligned box of a rectangle under a matrix: [minX, minY, maxX, maxY]. */
function transformBox(matrix, [x0, y0, x1, y1]) {
  const xs = [];
  const ys = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1]
  ]) {
    xs.push(matrix[0] * x + matrix[2] * y + matrix[4]);
    ys.push(matrix[1] * x + matrix[3] * y + matrix[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The share of a page (0–1) that the figure boxes cover.
 *
 * @param {Array<[number, number, number, number]>} boxes - In page space.
 * @param {[number, number, number, number]} view - The page box.
 * @returns {number}
 */
export function coveredShare(boxes, view) {
  const [px0, py0, px1, py1] = view;
  const width = px1 - px0;
  const height = py1 - py0;
  if (!(width > 0 && height > 0)) return 0;
  const cells = new Uint8Array(GRID * GRID);
  for (const [x0, y0, x1, y1] of boxes) {
    const share = (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / (width * height);
    if (share >= BACKGROUND_SHARE) continue;
    const c0 = Math.max(0, Math.floor(((x0 - px0) / width) * GRID));
    const c1 = Math.min(GRID - 1, Math.ceil(((x1 - px0) / width) * GRID) - 1);
    const r0 = Math.max(0, Math.floor(((y0 - py0) / height) * GRID));
    const r1 = Math.min(GRID - 1, Math.ceil(((y1 - py0) / height) * GRID) - 1);
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) cells[r * GRID + c] = 1;
    }
  }
  let covered = 0;
  for (const cell of cells) covered += cell;
  return covered / cells.length;
}

/**
 * The figure boxes of one page's operator list, in page space.
 *
 * @param {{fnArray: number[], argsArray: Array}} opList
 * @returns {Array<[number, number, number, number]>}
 */
export function figureBoxes(opList) {
  const boxes = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const op = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (op === OPS.save) {
      stack.push(ctm);
    } else if (op === OPS.restore) {
      ctm = stack.pop() || ctm;
    } else if (op === OPS.transform && Array.isArray(args) && args.length >= 6) {
      ctm = multiply(ctm, args);
    } else if (op === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = args?.[0];
      if (matrix && matrix.length >= 6) ctm = multiply(ctm, Array.from(matrix));
    } else if (op === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() || ctm;
    } else if (IMAGE_OPS.has(op)) {
      boxes.push(transformBox(ctm, [0, 0, 1, 1]));
    } else if (op === OPS.constructPath) {
      // pdf.js 5+: [drawOp, [pathData], minMax] with minMax = [minX, minY, maxX, maxY].
      const minMax = args?.[2];
      if (minMax && minMax.length >= 4 && Number.isFinite(minMax[0])) {
        boxes.push(transformBox(ctm, [minMax[0], minMax[1], minMax[2], minMax[3]]));
      }
    }
  }
  return boxes;
}

/**
 * The figure coverage of every page of a PDF, in percent (0–100, rounded).
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {Promise<{pages: Array<{page: number, figurePercent: number}>}>}
 */
export async function analyzePageFigures(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      try {
        const opList = await page.getOperatorList();
        const share = coveredShare(figureBoxes(opList), page.view);
        pages.push({ page: number, figurePercent: Math.round(share * 100) });
      } finally {
        page.cleanup();
      }
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}
