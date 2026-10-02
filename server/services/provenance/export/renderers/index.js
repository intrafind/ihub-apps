/**
 * Export format renderers (EU AI Act Art. 50 content marking, concept
 * `concepts/2026-09-27 EU AI Act Content Marking.md` §5.3 / §8.3).
 *
 * Each renderer turns the prepared export document into a clean file with
 * the visible AI label. They do not sign anything and add no provenance
 * metadata — `ExportService` runs the result through `ExportSigner`.
 *
 * @module services/provenance/export/renderers
 */
import { normalizeDoc } from './common.js';
import { renderCsv } from './csv.js';
import { renderDocx } from './docx.js';
import { renderHtml } from './html.js';
import { renderJson, renderJsonl } from './json.js';
import { renderPdf } from './pdf.js';
import { renderPptx } from './pptx.js';
import { renderMarkdown, renderTxt } from './text.js';
import { renderXlsx } from './xlsx.js';

/** Every format `renderExport` supports. */
export const EXPORT_FORMATS = Object.freeze([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'txt',
  'markdown',
  'html',
  'json',
  'jsonl'
]);

/** Content type and file extension per format. */
export const FORMAT_INFO = Object.freeze({
  pdf: Object.freeze({ mimeType: 'application/pdf', extension: 'pdf' }),
  docx: Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx'
  }),
  pptx: Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx'
  }),
  xlsx: Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx'
  }),
  csv: Object.freeze({ mimeType: 'text/csv; charset=utf-8', extension: 'csv' }),
  txt: Object.freeze({ mimeType: 'text/plain; charset=utf-8', extension: 'txt' }),
  markdown: Object.freeze({ mimeType: 'text/markdown; charset=utf-8', extension: 'md' }),
  html: Object.freeze({ mimeType: 'text/html; charset=utf-8', extension: 'html' }),
  json: Object.freeze({ mimeType: 'application/json; charset=utf-8', extension: 'json' }),
  jsonl: Object.freeze({ mimeType: 'application/x-ndjson; charset=utf-8', extension: 'jsonl' })
});

const RENDERERS = Object.freeze({
  pdf: renderPdf,
  docx: renderDocx,
  pptx: renderPptx,
  xlsx: renderXlsx,
  csv: renderCsv,
  txt: renderTxt,
  markdown: renderMarkdown,
  html: renderHtml,
  json: renderJson,
  jsonl: renderJsonl
});

/**
 * An error the HTTP layer can pass on as-is.
 * @param {string} message
 * @returns {Error & {status: number}}
 */
function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Render an export document in one format.
 *
 * @param {string} format - one of `EXPORT_FORMATS`
 * @param {Object} doc - the verified, prepared export document:
 *   `{ title, appName, exportedAt, language, settings, messages, source, label, template, single }`
 *   (see `ExportService`); missing or unknown values fall back to safe defaults
 * @returns {Promise<{ buffer: Buffer, mimeType: string, extension: string }>} the file
 * @throws {Error} with `status = 400` for an unknown format or a missing document
 * @example
 * const { buffer, mimeType, extension } = await renderExport('pdf', doc);
 */
export async function renderExport(format, doc) {
  if (typeof format !== 'string' || !Object.prototype.hasOwnProperty.call(RENDERERS, format)) {
    throw badRequest(`Unknown export format: ${String(format)}`);
  }
  if (!doc || typeof doc !== 'object') throw badRequest('Missing export document');
  const output = await RENDERERS[format](normalizeDoc(doc));
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
  return { buffer, ...FORMAT_INFO[format] };
}
