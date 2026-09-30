import { DEFAULT_FONT, resolveFontFamily } from './fonts.js';

/**
 * Visual themes for generated PDFs.
 *
 * The three names match the chat export templates the export dialog has
 * always offered (`default`, `professional`, `minimal`), so a template chosen
 * there and a theme the model picks mean the same thing.
 */

const BASE = {
  font: DEFAULT_FONT,
  baseFontSize: 10.5,
  lineHeight: 1.25,
  text: '#1f2937',
  muted: '#6b7280',
  heading: '#111827',
  primary: '#1d4ed8',
  accent: '#0f766e',
  link: '#1d4ed8',
  border: '#e5e7eb',
  tableHeaderFill: '#f3f4f6',
  tableHeaderText: '#111827',
  tableStripeFill: '#fafafa',
  codeBackground: '#f3f4f6',
  codeText: '#1f2937',
  inlineCodeBackground: '#f3f4f6',
  quoteBorder: '#d1d5db',
  quoteText: '#4b5563',
  headingRule: false,
  userFill: '#eff6ff',
  userBorder: '#3b82f6',
  assistantFill: '#f0fdf4',
  assistantBorder: '#22c55e',
  tableLines: 'grid'
};

export const THEMES = Object.freeze({
  default: {
    ...BASE,
    label: 'Default',
    description: 'Colourful, friendly layout with blue headings and shaded tables.',
    heading: '#1e3a8a',
    headingRule: true
  },
  professional: {
    ...BASE,
    label: 'Professional',
    description: 'Restrained greys and a serif body for business documents.',
    font: 'Serif',
    primary: '#212529',
    heading: '#212529',
    accent: '#495057',
    link: '#1f4e79',
    tableHeaderFill: '#343a40',
    tableHeaderText: '#ffffff',
    tableStripeFill: '#f8f9fa',
    codeBackground: '#f8f9fa',
    userFill: '#f8f9fa',
    userBorder: '#495057',
    assistantFill: '#f8f9fa',
    assistantBorder: '#adb5bd',
    headingRule: true
  },
  minimal: {
    ...BASE,
    label: 'Minimal',
    description: 'Plain black on white with thin rules and no fills.',
    primary: '#111827',
    heading: '#111827',
    accent: '#374151',
    tableHeaderFill: null,
    tableStripeFill: null,
    codeBackground: '#fafafa',
    inlineCodeBackground: null,
    userFill: null,
    userBorder: '#d1d5db',
    assistantFill: null,
    assistantBorder: '#d1d5db',
    tableLines: 'horizontal'
  }
});

export const DEFAULT_THEME = 'default';

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const NAMED_COLOR_PATTERN = /^[a-z]{3,20}$/i;

/**
 * Whether a value is a colour pdfkit understands: `#rgb`, `#rrggbb` or a CSS
 * colour name.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isColor(value) {
  return (
    typeof value === 'string' && (COLOR_PATTERN.test(value) || NAMED_COLOR_PATTERN.test(value))
  );
}

/**
 * The theme a document uses: a named theme plus the overrides a caller may
 * set. Unknown names fall back to the default theme; invalid overrides are
 * ignored.
 *
 * @param {string} [name] - Theme name.
 * @param {Object} [overrides]
 * @param {string} [overrides.primaryColor] - Headings, rules and accents.
 * @param {string} [overrides.accentColor] - Secondary accents.
 * @param {string} [overrides.font] - `sans`, `serif` or `mono`.
 * @param {number} [overrides.fontSize] - Body font size in points (7–16).
 * @returns {Object} Resolved theme.
 */
export function resolveTheme(name, overrides = {}) {
  const key = typeof name === 'string' && THEMES[name] ? name : DEFAULT_THEME;
  const theme = { ...THEMES[key], name: key };
  if (overrides && typeof overrides === 'object') {
    if (isColor(overrides.primaryColor)) {
      theme.primary = overrides.primaryColor;
      theme.heading = overrides.primaryColor;
      theme.link = overrides.primaryColor;
    }
    if (isColor(overrides.accentColor)) theme.accent = overrides.accentColor;
    if (overrides.font) theme.font = resolveFontFamily(overrides.font, theme.font);
    const size = Number(overrides.fontSize);
    if (Number.isFinite(size) && size >= 7 && size <= 16) theme.baseFontSize = size;
  }
  return theme;
}

/**
 * pdfmake styles for a theme. Heading sizes scale with the body size.
 *
 * @param {Object} theme - From {@link resolveTheme}.
 * @returns {Object<string, Object>}
 */
export function themeStyles(theme) {
  const s = theme.baseFontSize;
  const heading = (scale, top, bottom) => ({
    fontSize: Math.round(s * scale * 10) / 10,
    bold: true,
    color: theme.heading,
    margin: [0, top, 0, bottom],
    lineHeight: 1.15
  });
  return {
    h1: heading(2.0, 14, 8),
    h2: heading(1.55, 12, 6),
    h3: heading(1.3, 10, 4),
    h4: heading(1.12, 8, 3),
    h5: { ...heading(1.0, 6, 2) },
    h6: { ...heading(0.95, 6, 2), color: theme.muted },
    paragraph: { margin: [0, 0, 0, 7] },
    list: { margin: [0, 0, 0, 7] },
    tableCell: { fontSize: s - 0.5 },
    tableHeader: { bold: true, fontSize: s - 0.5, color: theme.tableHeaderText },
    code: { font: 'Mono', fontSize: s - 1.5, color: theme.codeText, lineHeight: 1.2 },
    caption: { fontSize: s - 1.5, color: theme.muted, italics: true },
    small: { fontSize: s - 2, color: theme.muted },
    muted: { color: theme.muted },
    quote: { color: theme.quoteText, italics: true },
    title: { fontSize: s * 2.6, bold: true, color: theme.heading, lineHeight: 1.1 },
    subtitle: { fontSize: s * 1.35, color: theme.muted },
    tocTitle: { ...heading(1.55, 0, 10) },
    tocItem: { fontSize: s }
  };
}
