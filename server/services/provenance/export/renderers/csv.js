/**
 * CSV export renderer.
 *
 * Like the former browser export (`exportToCSV` in
 * `client/src/utils/exportFormats.js`): a UTF-8 BOM so Excel detects the
 * encoding, a short preamble (AI label, title, app, date), then one row per
 * message. Machine-readable columns: `role`, `content`, `timestamp` (ISO),
 * `model`, `ai_generated` and `verification`.
 *
 * Every field is quoted (RFC 4180) and passed through the formula-injection
 * guard. Quoting every field also means the file always ends with a quoted
 * cell, which `ExportSigner` relies on when it adds the text signpost.
 *
 * @module services/provenance/export/renderers/csv
 */
import { formatDateTime, prepareCommon, sanitizeForSpreadsheet } from './common.js';

/** Column names of the message table. */
export const CSV_COLUMNS = Object.freeze([
  'role',
  'content',
  'timestamp',
  'model',
  'ai_generated',
  'verification'
]);

/**
 * Quote one CSV field (RFC 4180) after the formula-injection guard.
 *
 * @param {*} value - field value
 * @returns {string} the quoted field
 * @example
 * csvField('=SUM(A1)'); // "\"'=SUM(A1)\""
 */
export function csvField(value) {
  return `"${sanitizeForSpreadsheet(value).replace(/"/g, '""')}"`;
}

/**
 * One CSV record, padded to the table width.
 * @param {Array<*>} values
 * @returns {string}
 */
function record(values) {
  const padded = [...values];
  while (padded.length < CSV_COLUMNS.length) padded.push('');
  return padded.map(csvField).join(',');
}

/**
 * Render the export as CSV.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} UTF-8 bytes with BOM
 */
export async function renderCsv(doc) {
  const { t, label } = prepareCommon(doc);
  const rows = [];
  if (label.show) {
    rows.push(record([label.text]));
    for (const detail of label.details) rows.push(record([detail]));
  }
  rows.push(record([doc.title]));
  rows.push(record([t('export.header.app'), doc.appName]));
  rows.push(
    record([t('export.header.exportedOnLabel'), formatDateTime(doc.exportedAt, doc.language)])
  );
  rows.push(record([]));
  rows.push(record(CSV_COLUMNS));
  for (const message of doc.messages) {
    rows.push(
      record([
        message.role,
        message.content,
        message.timestamp || '',
        message.model || '',
        message.role === 'assistant' ? 'true' : 'false',
        message.verification
      ])
    );
  }
  return Buffer.from(`﻿${rows.join('\r\n')}`, 'utf8');
}
