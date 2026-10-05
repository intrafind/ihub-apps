/**
 * The Unicode font the PDF export embeds (Liberation Sans, metric-compatible
 * with Arial) and helpers around it:
 *
 * - `toFontSafeText` replaces characters the font has no glyph for, so emoji
 *   or CJK text never breaks the PDF: visible characters become "?",
 *   invisible ones (variation selectors, zero-width joiners, ...) are dropped.
 * - `measureText` gives Arial-compatible text widths, which the PPTX
 *   renderer uses to decide when a slide is full.
 *
 * The font is read lazily on first use and cached for the process.
 *
 * @module services/provenance/export/renderers/fontMetrics
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fontkit from '@pdf-lib/fontkit';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Same font as the OCR processor's PDF text layer (`server/assets/fonts`). */
const FONT_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'assets',
  'fonts',
  'LiberationSans-Regular.ttf'
);

/** Width assumed for a character the font cannot draw, in em. */
const MISSING_GLYPH_EM = 1;

let fontBytes = null;
let fontkitFont = null;
const glyphCache = new Map();
const advanceCache = new Map();
let graphemeSegmenter = null;

/**
 * Raw bytes of the embedded font.
 *
 * @returns {Buffer} TTF bytes
 */
export function getFontBytes() {
  if (!fontBytes) fontBytes = readFileSync(FONT_PATH);
  return fontBytes;
}

function getFontkitFont() {
  if (!fontkitFont) fontkitFont = fontkit.create(getFontBytes());
  return fontkitFont;
}

/**
 * Whether the font has a glyph for a code point.
 *
 * @param {number} codePoint - Unicode code point
 * @returns {boolean} true when the font can draw it
 */
export function hasGlyph(codePoint) {
  let known = glyphCache.get(codePoint);
  if (known === undefined) {
    known = getFontkitFont().hasGlyphForCodePoint(codePoint);
    glyphCache.set(codePoint, known);
  }
  return known;
}

/** Characters that take no space: format controls, combining and enclosing marks, variation selectors, emoji modifiers. */
const INVISIBLE_CHAR =
  /^[\p{Cc}\p{Cf}\p{Mn}\p{Me}\p{Emoji_Modifier}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]$/u;
const SPACE_CHAR = /^[\s\p{Zs}]$/u;

function getSegmenter() {
  if (!graphemeSegmenter) graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return graphemeSegmenter;
}

/**
 * Make text drawable with the embedded font.
 *
 * Works per grapheme cluster, so an emoji sequence (👨‍👩‍👧, 👍🏽) becomes a
 * single "?" instead of one per code point. Spaces the font lacks (thin
 * space, ...) become a normal space; soft hyphens and other invisible
 * characters are dropped. Line breaks are the caller's business and are not
 * expected here.
 *
 * @param {string} text - any text
 * @returns {string} text whose every character has a glyph
 * @example
 * toFontSafeText('Grüße 😀'); // "Grüße ?"
 */
export function toFontSafeText(text) {
  const normalized = String(text ?? '')
    .normalize('NFC')
    .replace(/­/g, '');
  let drawable = true;
  for (const char of normalized) {
    if (!hasGlyph(char.codePointAt(0))) {
      drawable = false;
      break;
    }
  }
  if (drawable) return normalized;

  let out = '';
  for (const { segment } of getSegmenter().segment(normalized)) {
    const chars = Array.from(segment);
    if (hasGlyph(chars[0].codePointAt(0))) {
      out += chars.filter(char => hasGlyph(char.codePointAt(0))).join('');
    } else if (SPACE_CHAR.test(chars[0])) {
      out += ' ';
    } else if (chars.every(char => INVISIBLE_CHAR.test(char))) {
      // zero-width / formatting characters: nothing to draw
    } else {
      out += '?';
    }
  }
  return out;
}

function advanceWidthEm(codePoint) {
  let width = advanceCache.get(codePoint);
  if (width === undefined) {
    const font = getFontkitFont();
    width = hasGlyph(codePoint)
      ? font.glyphForCodePoint(codePoint).advanceWidth / font.unitsPerEm
      : MISSING_GLYPH_EM;
    advanceCache.set(codePoint, width);
  }
  return width;
}

/**
 * Approximate rendered width of text in Arial/Liberation Sans.
 *
 * Sums glyph advances without kerning; bold text is about 7% wider, which
 * callers account for when they need to.
 *
 * @param {string} text - text on one line
 * @param {number} size - font size in points
 * @returns {number} width in points
 */
export function measureText(text, size) {
  let em = 0;
  for (const char of String(text ?? '')) em += advanceWidthEm(char.codePointAt(0));
  return em * size;
}
