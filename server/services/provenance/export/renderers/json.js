/**
 * JSON and JSON Lines export renderers.
 *
 * Content is written verbatim. The visible label becomes a top-level
 * `aiLabel` string (when the label is shown); `aiGenerated` flags assistant
 * messages. Provenance fields (`aiGenerated` at the top, `provenance`, the
 * JSONL head line) are added later by `ExportSigner`.
 *
 * JSON:  `{ title, appName, exportedAt, aiLabel?, settings, messages: [...] }`
 * JSONL: first line `{ meta: { title, appName, exportedAt, settings }, aiLabel? }`
 *        (the `meta` line of the former browser export), then one message per line.
 *
 * @module services/provenance/export/renderers/json
 */
import { prepareCommon } from './common.js';

/**
 * The exported shape of one message.
 * @param {Object} message - normalised message
 * @returns {{role: string, content: string, timestamp: string|null, model: string|null, verification: string, aiGenerated: boolean}}
 */
function exportMessage(message) {
  return {
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    model: message.model,
    verification: message.verification,
    aiGenerated: message.role === 'assistant'
  };
}

/**
 * Render the export as JSON.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} UTF-8 JSON
 */
export async function renderJson(doc) {
  const { label } = prepareCommon(doc);
  const body = {
    title: doc.title,
    appName: doc.appName,
    exportedAt: doc.exportedAt,
    ...(label.show ? { aiLabel: label.text } : {}),
    settings: doc.settings,
    messages: doc.messages.map(exportMessage)
  };
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/**
 * Render the export as JSON Lines.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} UTF-8 JSONL, one object per line
 */
export async function renderJsonl(doc) {
  const { label } = prepareCommon(doc);
  const head = {
    meta: {
      title: doc.title,
      appName: doc.appName,
      exportedAt: doc.exportedAt,
      settings: doc.settings
    },
    ...(label.show ? { aiLabel: label.text } : {})
  };
  const lines = [head, ...doc.messages.map(exportMessage)].map(entry => JSON.stringify(entry));
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
