// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { DEFAULT_FONT, textMeasurerFor } from './fonts.js';

/**
 * Column widths that keep a table inside the page.
 *
 * pdfmake sizes `auto` and `*` columns itself, but it never breaks inside a
 * word and gives every `*` column the width of the widest word of any of
 * them, so a table with many columns, or a few long words, runs off the
 * page where the right-hand columns are simply cut off. This module measures
 * the text with the document's font and picks, in this order:
 *
 *  1. the table's natural widths, when it fits as it is;
 *  2. proportional widths, when only wrapping lines is needed;
 *  3. tighter cell padding, then a smaller font, when even the longest word
 *     of each column does not fit at the normal size;
 *  4. columns that share what is left, with words wider than their column
 *     broken at a zero-width space, as the last resort.
 *
 * Widths are returned as percentages so pdfmake resolves them against the
 * width it really has, which is less than the page's when the table sits in
 * a list item or a quote. `available` is only the estimate used to decide
 * what fits.
 */

const ZWSP = '​';
/** Measured text is widened a little: kerning, bold runs inside a cell. */
const SAFETY = 1.05;
const MIN_FONT_SIZE = 6.5;
const VLINE = 0.5;
const NORMAL_PADDING = 6;
const DENSE_PADDING = 3;
/** A table narrower than this share of the line keeps its natural width. */
const NARROW_SHARE = 0.6;
/**
 * The most of the table's width one column may demand for its longest word.
 * A longer word (a URL, a token) is broken inside its column rather than
 * shrinking the whole table to fit it on one line.
 */
const MAX_WORD_SHARE = 0.35;

/** Where a line may break inside a cell: spaces and hyphens before a letter. */
const BREAK_POINTS = /\s+|(?<=[-‐–—])(?=\p{L})/u;

/**
 * @typedef {Object} FitCell
 * @property {string} text - Plain text of the cell.
 * @property {boolean} [bold] - Whether the cell is set in bold (headers).
 * @property {boolean} [mono] - Whether the cell is set in the monospace font.
 */

function measureCell(cell, family, measureText) {
  const measure = measureText(cell.mono ? 'Mono' : family, Boolean(cell.bold));
  let preferred = 0;
  let longestWord = 0;
  for (const line of String(cell.text ?? '').split('\n')) {
    preferred = Math.max(preferred, measure(line, 1));
    for (const word of line.split(BREAK_POINTS)) {
      if (word) longestWord = Math.max(longestWord, measure(word, 1));
    }
  }
  return { preferred, longestWord };
}

/** Per column, the widest line and the widest word, in em. */
function columnMetrics(rows, columns, family, measureText) {
  const preferred = new Array(columns).fill(0);
  const longestWord = new Array(columns).fill(0);
  for (const row of rows) {
    for (let i = 0; i < columns; i += 1) {
      if (!row[i]) continue;
      const m = measureCell(row[i], family, measureText);
      preferred[i] = Math.max(preferred[i], m.preferred);
      longestWord[i] = Math.max(longestWord[i], m.longestWord);
    }
  }
  return { preferred, longestWord };
}

const sum = values => values.reduce((a, b) => a + b, 0);

/** Widths for columns that cannot all keep their longest word: share what there is. */
function shareEvenly(min, available) {
  const widths = new Array(min.length).fill(0);
  let open = min.map((_, i) => i);
  let left = available;
  for (;;) {
    const share = left / open.length;
    const small = open.filter(i => min[i] <= share);
    if (small.length === 0) break;
    for (const i of small) {
      widths[i] = min[i];
      left -= min[i];
    }
    open = open.filter(i => !small.includes(i));
    if (open.length === 0) return widths;
  }
  for (const i of open) widths[i] = left / open.length;
  return widths;
}

/** Content widths, given each column's widest word and widest line. */
function allocate(min, preferred, available) {
  const natural = sum(preferred);
  if (natural <= available) {
    // Everything fits on single lines: spread the slack in proportion.
    const slack = available - natural;
    return preferred.map(p => p + (natural > 0 ? (slack * p) / natural : slack / min.length));
  }
  // Every column gets its longest word, and the rest goes to the columns
  // that have more to say than that.
  const spare = available - sum(min);
  const wanted = natural - sum(min);
  return min.map((m, i) => m + ((preferred[i] - m) * spare) / wanted);
}

/** The sizes tried, from the theme's to the smallest. */
function attempts(baseSize) {
  const floor = Math.min(MIN_FONT_SIZE, baseSize);
  const list = [
    { fontSize: baseSize, padding: NORMAL_PADDING },
    { fontSize: baseSize, padding: DENSE_PADDING }
  ];
  for (let size = baseSize - 0.5; size > floor; size -= 0.5) {
    list.push({ fontSize: size, padding: DENSE_PADDING });
  }
  if (floor < baseSize) list.push({ fontSize: floor, padding: DENSE_PADDING });
  return list;
}

const percent = value => `${(Math.floor(value * 1000) / 1000).toFixed(3)}%`;

/**
 * Choose widths, layout and font size for a table.
 *
 * @param {Object} params
 * @param {FitCell[][]} params.rows - Every row, header rows included.
 * @param {Object} params.theme - Resolved theme (`font`, `baseFontSize`).
 * @param {number} params.available - Width of the line the table sits on, in points.
 * @param {(family: string, bold: boolean) => (text: string, size: number) => number}
 *   [params.measureText] - Text measurer factory (replaced in tests).
 * @returns {{ widths: string[], layout: string, fontSize: number,
 *   shrunk: boolean, breakAt: (number[]|null) }} `fontSize` is the size the
 *   cells are set in and `shrunk` whether that is smaller than the theme's;
 *   `breakAt` holds each column's content width, in points, where words
 *   have to be broken to fit (Infinity for a column that needs none), else null.
 */
export function fitTable({ rows, theme, available, measureText = textMeasurerFor }) {
  const columns = Math.max(0, ...rows.map(row => row.length));
  const family = theme?.font || DEFAULT_FONT;
  const baseSize = (theme?.baseFontSize ?? 10) - 0.5;
  const metrics = columnMetrics(rows, columns, family, measureText);
  const tryList = attempts(baseSize);

  // Columns whose longest word is wider than the width they end up with.
  const breaksFor = (widths, rawMin, fontSize) => {
    const needed = rawMin.map((em, i) => em * fontSize * SAFETY > widths[i] + 0.01);
    return needed.some(Boolean)
      ? widths.map((w, i) => (needed[i] ? Math.max(w / SAFETY, 1) : Number.POSITIVE_INFINITY))
      : null;
  };

  let last = null;
  for (const { fontSize, padding } of tryList) {
    const fixed = columns * 2 * padding + (columns + 1) * VLINE;
    const content = available - fixed;
    const rawMin = metrics.longestWord;
    const min = rawMin.map(em => Math.min(em * fontSize * SAFETY, content * MAX_WORD_SHARE));
    const preferred = metrics.preferred.map(em => em * fontSize * SAFETY);
    last = { fontSize, padding, content, min, rawMin };
    if (sum(min) > content) continue;

    const layout = padding === NORMAL_PADDING ? 'ihubTable' : 'ihubTableDense';
    const shrunk = fontSize < baseSize;
    if (sum(preferred) <= content && sum(preferred) + fixed <= NARROW_SHARE * available) {
      return {
        widths: new Array(columns).fill('auto'),
        layout,
        fontSize,
        shrunk,
        breakAt: null
      };
    }
    const widths = allocate(min, preferred, content);
    return {
      widths: widths.map(w => percent(((w + 2 * padding + VLINE) / available) * 100)),
      layout,
      fontSize,
      shrunk,
      breakAt: breaksFor(widths, rawMin, fontSize)
    };
  }

  // Not even the capped longest words fit at the smallest size: the columns
  // share the line and long words are broken to their column.
  const { fontSize, padding, content, min, rawMin } = last;
  const widths = shareEvenly(min, Math.max(content, columns));
  return {
    widths: widths.map(w => percent(((w + 2 * padding + VLINE) / available) * 100)),
    layout: 'ihubTableDense',
    fontSize,
    shrunk: fontSize < baseSize,
    breakAt: breaksFor(widths, rawMin, fontSize)
  };
}

/**
 * Break words wider than `maxWidth` at zero-width spaces, which pdfmake
 * treats as a place to wrap.
 *
 * @param {string} text
 * @param {number} maxWidth - Points.
 * @param {number} fontSize
 * @param {(text: string, size: number) => number} measure
 * @returns {string}
 */
export function breakLongWords(text, maxWidth, fontSize, measure) {
  return String(text).replaceAll(/\S+/gu, word => {
    if (measure(word, fontSize) <= maxWidth) return word;
    let out = '';
    let chunk = '';
    for (const char of word) {
      if (chunk && measure(chunk + char, fontSize) > maxWidth) {
        out += chunk + ZWSP;
        chunk = char;
      } else {
        chunk += char;
      }
    }
    return out + chunk;
  });
}

/**
 * Apply {@link breakLongWords} to every string of a pdfmake cell, in place.
 *
 * @param {Object} node - A cell (text, runs, or a stack/list of those).
 * @param {(text: string) => string} transform
 */
export function mapCellText(node, transform) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.text === 'string') {
    node.text = transform(node.text);
  } else if (Array.isArray(node.text)) {
    node.text = node.text.map(part => {
      if (typeof part === 'string') return transform(part);
      if (part && typeof part.text === 'string') return { ...part, text: transform(part.text) };
      return part;
    });
  }
  for (const key of ['stack', 'ul', 'ol']) {
    if (Array.isArray(node[key])) node[key].forEach(child => mapCellText(child, transform));
  }
}

/**
 * The width a table can use where it sits: the page's content width less
 * what lists, quotes and table cells around it take. An estimate, used only
 * to decide what fits; pdfmake resolves the percentages against the real one.
 *
 * @param {Object} ctx - Conversion context (`contentWidth`, `containerDepth`).
 * @param {number} depth - How deeply the table is nested in lists and quotes.
 * @returns {number} Points.
 */
export function tableLineWidth(ctx, depth = 0) {
  const inset = depth * 24 + (ctx.containerDepth || 0) * 14;
  return Math.max((ctx.contentWidth || 495) - inset, 120);
}

/**
 * Carry out what {@link fitTable} decided on the cells of a table body, in
 * place: the smaller font, and broken words.
 *
 * @param {Object[][]} body - pdfmake table body.
 * @param {ReturnType<typeof fitTable>} fit
 * @param {Object} theme
 */
export function applyFitToBody(body, fit, theme) {
  if (!fit.shrunk && !fit.breakAt) return;
  const measure = textMeasurerFor(theme?.font || DEFAULT_FONT, true);
  for (const row of body) {
    row.forEach((cell, i) => {
      if (!cell || typeof cell !== 'object') return;
      if (fit.shrunk && cell.fontSize === undefined) cell.fontSize = fit.fontSize;
      if (fit.breakAt) {
        mapCellText(cell, text => breakLongWords(text, fit.breakAt[i], fit.fontSize, measure));
      }
    });
  }
}

const NON_TEXT_KEYS = ['table', 'image', 'svg', 'canvas', 'qr', 'columns', 'toc'];

/**
 * A sanitised pdfmake cell as {@link FitCell}, or null when it holds
 * something whose width cannot be told from its text (an image, a nested
 * table, a column span), in which case the table keeps the widths it has.
 *
 * @param {unknown} node
 * @param {boolean} header - Whether the cell is in a header row.
 * @returns {FitCell | null}
 */
export function fitCellFromNode(node, header) {
  const lines = [];
  let bold = header;
  let mono = false;
  let usable = true;
  const visit = (value, inherit) => {
    if (!usable || value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') {
      lines.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(child => visit(child, inherit));
      return;
    }
    if (typeof value !== 'object') return;
    if (value.colSpan || value.rowSpan || NON_TEXT_KEYS.some(key => value[key] !== undefined)) {
      usable = false;
      return;
    }
    if (value.bold || value.style === 'tableHeader') bold = true;
    if (value.font === 'Mono') mono = true;
    if (value.text !== undefined) {
      const parts = Array.isArray(value.text) ? value.text : [value.text];
      const own = parts.map(part => (part && typeof part === 'object' ? part : { text: part }));
      for (const part of own) {
        if (part.bold) bold = true;
        if (part.font === 'Mono') mono = true;
      }
      lines.push(own.map(part => (typeof part.text === 'string' ? part.text : '')).join(''));
    }
    for (const key of ['stack', 'ul', 'ol']) visit(value[key], inherit);
  };
  visit(node, bold);
  return usable ? { text: lines.join('\n'), bold, mono } : null;
}
