import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';

/**
 * Fonts for generated PDFs.
 *
 * DejaVu comes from the `dejavu-fonts-ttf` npm package, so no font binaries
 * live in the repository. It covers Latin, Greek and Cyrillic plus the
 * symbols LLM output leans on (arrows, check marks, box drawing, bullets),
 * and pdfkit subsets each font into the file, so a document only carries
 * the glyphs it uses.
 *
 * The bytes are read once and handed to pdfmake through its virtual file
 * system. Rendering therefore never needs a local path, which lets the
 * renderer deny every local file access (see `renderPdf.js`).
 */

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');

/** Font families a document may use, by the name documents refer to them. */
export const FONT_FAMILIES = Object.freeze({
  Sans: {
    normal: 'DejaVuSans.ttf',
    bold: 'DejaVuSans-Bold.ttf',
    italics: 'DejaVuSans-Oblique.ttf',
    bolditalics: 'DejaVuSans-BoldOblique.ttf'
  },
  Serif: {
    normal: 'DejaVuSerif.ttf',
    bold: 'DejaVuSerif-Bold.ttf',
    italics: 'DejaVuSerif-Italic.ttf',
    bolditalics: 'DejaVuSerif-BoldItalic.ttf'
  },
  Mono: {
    normal: 'DejaVuSansMono.ttf',
    bold: 'DejaVuSansMono-Bold.ttf',
    italics: 'DejaVuSansMono-Oblique.ttf',
    bolditalics: 'DejaVuSansMono-BoldOblique.ttf'
  }
});

/**
 * Other names a document (or an SVG inside it) may use for the same fonts.
 * Matched case-insensitively.
 */
const FONT_ALIASES = Object.freeze({
  sans: 'Sans',
  'sans-serif': 'Sans',
  helvetica: 'Sans',
  arial: 'Sans',
  roboto: 'Sans',
  dejavusans: 'Sans',
  'dejavu sans': 'Sans',
  serif: 'Serif',
  times: 'Serif',
  'times new roman': 'Serif',
  georgia: 'Serif',
  dejavuserif: 'Serif',
  'dejavu serif': 'Serif',
  mono: 'Mono',
  monospace: 'Mono',
  courier: 'Mono',
  'courier new': 'Mono',
  consolas: 'Mono',
  menlo: 'Mono',
  'dejavu sans mono': 'Mono'
});

export const DEFAULT_FONT = 'Sans';

/**
 * Resolve a font name a document asked for to a registered family.
 *
 * @param {unknown} name - Requested family (any case, may be an alias).
 * @param {string} [fallback] - Family to use for an unknown name.
 * @returns {string} A key of {@link FONT_FAMILIES}.
 */
export function resolveFontFamily(name, fallback = DEFAULT_FONT) {
  if (typeof name !== 'string' || !name.trim()) return fallback;
  const trimmed = name.trim();
  if (Object.hasOwn(FONT_FAMILIES, trimmed)) return trimmed;
  return FONT_ALIASES[trimmed.toLowerCase()] || fallback;
}

let fontBytes = null;

/**
 * All font files, read once per process.
 *
 * @returns {Map<string, Buffer>} File name → bytes.
 */
export function loadFontBytes() {
  if (!fontBytes) {
    fontBytes = new Map();
    for (const family of Object.values(FONT_FAMILIES)) {
      for (const file of Object.values(family)) {
        if (!fontBytes.has(file)) fontBytes.set(file, readFileSync(path.join(FONT_DIR, file)));
      }
    }
  }
  return fontBytes;
}

/**
 * The font dictionary pdfmake gets: every family plus its aliases. The file
 * names are virtual file system keys, not paths.
 *
 * @returns {Object<string, {normal: string, bold: string, italics: string, bolditalics: string}>}
 */
export function pdfmakeFontDescriptors() {
  const descriptors = {};
  for (const [family, files] of Object.entries(FONT_FAMILIES)) {
    descriptors[family] = { ...files };
  }
  for (const [alias, family] of Object.entries(FONT_ALIASES)) {
    if (!descriptors[alias]) descriptors[alias] = { ...FONT_FAMILIES[family] };
  }
  return descriptors;
}

const glyphCoverage = new Map();

/**
 * Whether a family's regular face has a glyph for a code point.
 *
 * @param {string} family - Key of {@link FONT_FAMILIES}.
 * @returns {(codePoint: number) => boolean}
 */
export function glyphCheckerFor(family) {
  const key = Object.hasOwn(FONT_FAMILIES, family) ? family : DEFAULT_FONT;
  if (!glyphCoverage.has(key)) {
    const font = fontkit.create(loadFontBytes().get(FONT_FAMILIES[key].normal));
    const cache = new Map();
    glyphCoverage.set(key, codePoint => {
      if (!cache.has(codePoint)) cache.set(codePoint, font.hasGlyphForCodePoint(codePoint));
      return cache.get(codePoint);
    });
  }
  return glyphCoverage.get(key);
}
