import { DEFAULT_FONT, glyphCheckerFor } from './fonts.js';
import { warn } from './markdownToPdfmake.js';

/**
 * Make every character of a document printable with the bundled fonts.
 *
 * pdfkit draws a character its font lacks as an empty box. Walking the laid
 * out text first avoids that: a character missing from the run's font but
 * present in DejaVu Sans (symbols in a serif document) is drawn in Sans, a
 * few common colour emoji map to their monochrome counterparts, and anything
 * still unprintable is dropped and reported once.
 */

const EMOJI_SUBSTITUTES = new Map(
  Object.entries({
    '✅': '✔',
    '✔️': '✔',
    '☑️': '☑',
    '❌': '✘',
    '❎': '✘',
    '✖️': '✖',
    '⚠️': '⚠',
    '❗': '!',
    '❓': '?',
    '⭐': '★',
    '🌟': '★',
    '➡️': '→',
    '⬅️': '←',
    '⬆️': '↑',
    '⬇️': '↓',
    '👉': '→',
    '👈': '←',
    '🔹': '◆',
    '🔸': '◆',
    '🔴': '●',
    '🟢': '●',
    '🟡': '●',
    '🔵': '●',
    '⚫': '●',
    '⚪': '○',
    '📌': '•',
    '📍': '•',
    '💡': '•',
    '📝': '•',
    '📊': '•',
    '📈': '↗',
    '📉': '↘'
  })
);

/**
 * Characters that only modify the one before them and carry no glyph: the
 * zero-width joiner (U+200D), variation selectors 15/16 (U+FE0E, U+FE0F) and the
 * emoji skin-tone modifiers (U+1F3FB..U+1F3FF). Spelled as alternatives rather than
 * one character class, which would mix marks with the characters before them.
 */
const INVISIBLE = /\u200D|[\uFE0E\uFE0F]|[\u{1f3fb}-\u{1f3ff}]/gu;

/**
 * Split one string into runs its fonts can draw.
 *
 * @param {string} text
 * @param {string} font - The run's font family.
 * @param {{ dropped: number }} stats
 * @returns {string|Array<Object>} The string itself when nothing changes.
 */
export function printableRuns(text, font, stats) {
  let source = text;
  for (const [emoji, substitute] of EMOJI_SUBSTITUTES) {
    if (source.includes(emoji)) source = source.split(emoji).join(substitute);
  }
  source = source.replace(INVISIBLE, '');
  const has = glyphCheckerFor(font);
  const hasSans = glyphCheckerFor(DEFAULT_FONT);
  const runs = [];
  let current = '';
  let currentFallback = false;
  let changed = source !== text;
  const flush = () => {
    if (!current) return;
    runs.push(currentFallback ? { text: current, font: DEFAULT_FONT } : current);
    current = '';
  };
  for (const char of source) {
    const cp = char.codePointAt(0);
    // Whitespace and control characters are laid out, not drawn.
    if (cp < 0x21 || cp === 0xa0 || has(cp)) {
      if (currentFallback) flush();
      currentFallback = false;
      current += char;
    } else if (font !== DEFAULT_FONT && hasSans(cp)) {
      if (!currentFallback) flush();
      currentFallback = true;
      current += char;
      changed = true;
    } else {
      stats.dropped += 1;
      changed = true;
    }
  }
  flush();
  if (!changed) return text;
  if (runs.length === 0) return '';
  if (runs.length === 1 && typeof runs[0] === 'string') return runs[0];
  return runs;
}

function fontOf(node, styles, inherited) {
  if (typeof node.font === 'string') return node.font;
  const names = Array.isArray(node.style) ? node.style : node.style ? [node.style] : [];
  for (let i = names.length - 1; i >= 0; i -= 1) {
    const font = styles[names[i]]?.font;
    if (typeof font === 'string') return font;
  }
  return inherited;
}

function fixText(value, font, styles, stats) {
  if (typeof value === 'string') return printableRuns(value, font, stats);
  if (Array.isArray(value)) {
    const out = [];
    for (const part of value) {
      if (typeof part === 'string') {
        const fixed = printableRuns(part, font, stats);
        if (Array.isArray(fixed)) out.push(...fixed);
        else out.push(fixed);
      } else if (part && typeof part === 'object') {
        const partFont = fontOf(part, styles, font);
        out.push({ ...part, text: fixText(part.text, partFont, styles, stats) });
      }
    }
    return out;
  }
  return value;
}

function walk(node, font, styles, stats) {
  if (typeof node === 'string') return printableRuns(node, font, stats);
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(child => walk(child, font, styles, stats));
  const own = fontOf(node, styles, font);
  if (node.text !== undefined) node.text = fixText(node.text, own, styles, stats);
  for (const key of ['stack', 'columns', 'ul', 'ol']) {
    if (Array.isArray(node[key])) node[key] = node[key].map(c => walk(c, own, styles, stats));
  }
  if (node.table && Array.isArray(node.table.body)) {
    node.table.body = node.table.body.map(row =>
      Array.isArray(row) ? row.map(cell => walk(cell, own, styles, stats)) : row
    );
  }
  return node;
}

/**
 * Rewrite a content tree in place so every character is printable.
 *
 * @param {Array|Object} content
 * @param {Object} params
 * @param {string} params.font - Document default font.
 * @param {Object} params.styles - Document styles (for fonts set by style).
 * @param {Object} [ctx] - Conversion context, for the warning.
 * @returns {Array|Object} The content.
 */
export function makePrintable(content, { font, styles }, ctx) {
  const stats = { dropped: 0 };
  const result = walk(content, font, styles || {}, stats);
  if (stats.dropped > 0 && ctx) {
    warn(
      ctx,
      `${stats.dropped} character(s) (e.g. colour emoji or CJK) are not in the PDF fonts and were left out.`
    );
  }
  return result;
}

/**
 * Printable text for a plain string outside the content tree (header,
 * footer, watermark).
 *
 * @param {string} text
 * @param {string} font
 * @returns {string}
 */
export function printableString(text, font) {
  const stats = { dropped: 0 };
  const runs = printableRuns(String(text ?? ''), font, stats);
  if (typeof runs === 'string') return runs;
  return runs.map(r => (typeof r === 'string' ? r : r.text)).join('');
}
