/**
 * Filename helpers for downloads the browser saves.
 *
 * Every export file is generated on the server since the EU AI Act work
 * (`POST /api/exports`, concept `concepts/2026-09-27 EU AI Act Content
 * Marking.md` §8.3), and the server names the file in its
 * `Content-Disposition` header. The helpers below only provide the fallback
 * name for a response without that header, and the date stamp other
 * downloads (e.g. the `/verify` report) use.
 *
 * @module utils/exportFormats
 */

/**
 * File extension per export format id of `POST /api/exports`.
 * @type {Readonly<Record<string, string>>}
 */
export const EXPORT_FILE_EXTENSIONS = Object.freeze({
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  csv: 'csv',
  txt: 'txt',
  markdown: 'md',
  html: 'html',
  json: 'json',
  jsonl: 'jsonl'
});

/**
 * Strip markdown noise, collapse whitespace, ASCII-kebab-case, cap length.
 *
 * @param {string} text - Any human-readable text (title, first message, …)
 * @param {number} [maxChars=40] - Maximum length of the slug
 * @returns {string} The slug, or '' when nothing usable is left
 * @example
 * slugifyForFilename('**Pricing** für Q3?'); // → 'pricing-fur-q3'
 */
export const slugifyForFilename = (text, maxChars = 40) => {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code
    .replace(/`[^`]*`/g, ' ') // drop inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // drop images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // unwrap links
    .replace(/[*_~#>]/g, ' ') // drop markdown markers
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, maxChars)
    .replace(/-+$/, '');
};

const pad2 = n => String(n).padStart(2, '0');

/**
 * `2026-06-09_1530` — filesystem-safe, sortable, local time.
 *
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export const formatDateTimeForFilename = (date = new Date()) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_` +
  `${pad2(date.getHours())}${pad2(date.getMinutes())}`;

/**
 * The name to save an export under when the server response carries no
 * usable `Content-Disposition` filename.
 *
 * @param {Object} params
 * @param {string} [params.title] - Document title sent with the export request
 * @param {string} params.format - Export format id (see {@link EXPORT_FILE_EXTENSIONS})
 * @param {Date} [params.date=new Date()]
 * @returns {string} e.g. `sales-assistant-pricing-2026-06-09_1530.pdf`
 */
export const buildExportFallbackFilename = ({ title, format, date = new Date() }) => {
  const extension = EXPORT_FILE_EXTENSIONS[format] || String(format || 'bin').toLowerCase();
  const base = slugifyForFilename(title || '', 60) || 'export';
  return `${base}-${formatDateTimeForFilename(date)}.${extension}`;
};
