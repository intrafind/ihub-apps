/**
 * Single-document exports — a markdown string the caller already has (a
 * workflow report, a markdown viewer, an agent artifact, the canvas) saved
 * as Markdown, HTML, PDF or Word.
 *
 * The files are generated, labelled and signed by the server
 * (`POST /api/exports`, EU AI Act Art. 50(2), issues #2571/#2576): the
 * document goes out as the one message of the request (`messages[0]`,
 * role `assistant`) with the `source` that tells the server what it is —
 * `markdown`, `workflow`, `artifact`, or `canvas` for a document the user
 * edited (labelled "AI-assisted, edited by the user"). There is no
 * browser-side generation or print dialog any more.
 *
 * @module shared/utils/markdownExports
 */

import { requestExport } from '../../api/endpoints/exports';

/** Formats the document download menus offer, in menu order. */
export const DOCUMENT_EXPORT_FORMATS = Object.freeze(['markdown', 'html', 'pdf', 'docx']);

/** Where a single document comes from (`source` of `POST /api/exports`). */
export const DOCUMENT_EXPORT_SOURCES = Object.freeze([
  'markdown',
  'workflow',
  'artifact',
  'canvas'
]);

const MAX_TITLE_CHARS = 300;
const MAX_CONTENT_CHARS = 500000;

/**
 * A name without a text-file extension (`report.md` → `report`).
 *
 * @param {string} name
 * @param {string} [fallback='document']
 * @returns {string}
 */
export function baseNameWithoutExtension(name, fallback = 'document') {
  if (typeof name !== 'string' || !name.trim()) return fallback;
  return name.trim().replace(/\.(md|markdown|txt)$/i, '') || fallback;
}

/**
 * A document title from its first heading, else its first non-empty line.
 *
 * @param {string} markdown
 * @param {string} [fallback='']
 * @returns {string}
 * @example
 * deriveDocumentTitle('# Quarterly report\n\nText'); // → 'Quarterly report'
 */
export function deriveDocumentTitle(markdown, fallback = '') {
  if (typeof markdown !== 'string') return fallback;
  const lines = markdown.split('\n').map(line => line.trim());
  const heading = lines.find(line => /^#{1,6}\s+\S/.test(line));
  const candidate = heading ? heading.replace(/^#{1,6}\s+/, '') : lines.find(Boolean) || '';
  const clean = candidate
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

/**
 * Build the `POST /api/exports` body for one document.
 *
 * @param {Object} params
 * @param {string} params.content - The document as markdown
 * @param {string} params.format - One of {@link DOCUMENT_EXPORT_FORMATS} (any server format works)
 * @param {string} [params.source='markdown'] - One of {@link DOCUMENT_EXPORT_SOURCES}
 * @param {string} [params.name] - File-name hint, used as title (`report.md` → `report`)
 * @param {string} [params.title] - Explicit document title (wins over `name`)
 * @param {string} [params.appId] - App the document belongs to (canvas)
 * @returns {Object} The request body
 * @throws {Error} When there is no content to export
 */
export function buildDocumentExportRequest({
  content,
  format,
  source = 'markdown',
  name,
  title,
  appId
}) {
  const text = typeof content === 'string' ? content : String(content ?? '');
  if (!text.trim()) throw new Error('There is no content to export');
  const resolvedTitle =
    (typeof title === 'string' && title.trim()) ||
    baseNameWithoutExtension(name, '') ||
    deriveDocumentTitle(text, 'Document');
  return {
    format,
    source: DOCUMENT_EXPORT_SOURCES.includes(source) ? source : 'markdown',
    ...(appId ? { appId } : {}),
    title: resolvedTitle.slice(0, MAX_TITLE_CHARS),
    messages: [{ role: 'assistant', content: text.slice(0, MAX_CONTENT_CHARS) }],
    single: true
  };
}

/**
 * Export one markdown document through the server and save the file.
 *
 * @param {Object} params - See {@link buildDocumentExportRequest}
 * @returns {Promise<{filename: string, manifestId: (string|null)}>}
 * @throws {import('../../api/endpoints/exports').ExportRequestError}
 * @example
 * await exportMarkdownDocument({ content: report, name: 'audit.md', format: 'pdf', source: 'workflow' });
 */
export function exportMarkdownDocument(params) {
  return requestExport(buildDocumentExportRequest(params));
}
