/**
 * Server-side exports (EU AI Act Art. 50(2); issues #2571, #2576).
 *
 * Every export file — chat transcripts, single messages, canvas documents,
 * workflow reports and agent artifacts — is rendered, labelled and signed by
 * the server (`POST /api/exports`). The browser only requests the file and
 * saves the bytes it gets back; it never generates an export itself, so the
 * signed provenance can vouch for exactly what iHub produced.
 *
 * Request body (see `server/routes/exports.js`):
 * `{ format, appId?, chatId?, title?, messageIds?, messages?, settings?, source?, options?, single? }`.
 * Build it with `features/chat/utils/exportRequest.js` (chat) or
 * `shared/utils/markdownExports.js` (one document).
 *
 * @module api/endpoints/exports
 */
import { apiClient } from '../client';
import { filenameFromContentDisposition, saveBlobAs } from '../../utils/externalNavigation';
import { buildExportFallbackFilename } from '../../utils/exportFormats';

/**
 * Rendering a long transcript to PDF (and signing it) can take well over the
 * default 30 s API timeout.
 */
export const EXPORT_REQUEST_TIMEOUT = 120000;

/**
 * An export request the server refused or that never reached it.
 *
 * `status` is the HTTP status (`400` invalid request, `403` exports disabled,
 * `404` chat not found, …) or `null` for a network failure / blocked download,
 * so a caller can pick a translated message without parsing `message`.
 */
export class ExportRequestError extends Error {
  /**
   * @param {string} message - Server error text (English) or a local reason
   * @param {number|null} [status=null] - HTTP status, when there was a response
   * @param {Object} [options]
   * @param {string} [options.code] - Local failure code, e.g. `'DOWNLOAD_BLOCKED'`
   * @param {unknown} [options.cause] - The underlying error
   */
  constructor(message, status = null, { code = null, cause } = {}) {
    super(message);
    this.name = 'ExportRequestError';
    this.status = status;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Text of a Blob, also where `Blob#text` is missing (older WebViews, jsdom).
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function readBlobText(blob) {
  if (!blob) return Promise.resolve('');
  if (typeof blob === 'string') return Promise.resolve(blob);
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/**
 * The server's `{ error }` message from a failed blob request. With
 * `responseType: 'blob'` axios hands even a JSON error body over as a Blob.
 *
 * @param {unknown} error - Axios error
 * @returns {Promise<string>}
 */
async function readErrorMessage(error) {
  const data = error?.response?.data;
  try {
    if (data && typeof data === 'object' && !(data instanceof Blob) && data.error) {
      return String(data.error);
    }
    if (data instanceof Blob) {
      const text = await readBlobText(data);
      const parsed = JSON.parse(text);
      if (parsed?.error) return String(parsed.error);
    }
  } catch {
    // Not a JSON error body — fall back to the transport message.
  }
  return error?.message || 'Export failed';
}

/**
 * Request an export and return the file without saving it.
 *
 * @param {Object} body - Export request body (see module doc)
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{blob: Blob, filename: string, manifestId: (string|null), mimeType: string}>}
 * @throws {ExportRequestError} When the server refuses the request or is unreachable
 */
export async function fetchExport(body, { signal } = {}) {
  let response;
  try {
    response = await apiClient.post('/exports', body, {
      responseType: 'blob',
      timeout: EXPORT_REQUEST_TIMEOUT,
      signal
    });
  } catch (error) {
    throw new ExportRequestError(await readErrorMessage(error), error?.response?.status ?? null, {
      cause: error
    });
  }

  const headers = response?.headers || {};
  const blob =
    response?.data instanceof Blob
      ? response.data
      : new Blob([response?.data ?? ''], { type: headers['content-type'] || '' });
  return {
    blob,
    filename:
      filenameFromContentDisposition(headers['content-disposition']) ||
      buildExportFallbackFilename({ title: body?.title, format: body?.format }),
    manifestId: headers['x-ai-export-manifest'] || null,
    mimeType: headers['content-type'] || blob.type || ''
  };
}

/**
 * Request an export and save it to the user's downloads.
 *
 * @param {Object} body - Export request body (see module doc)
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{filename: string, manifestId: (string|null)}>}
 * @throws {ExportRequestError} On a refused request, or with code
 *   `'DOWNLOAD_BLOCKED'` when the browser/host would not start the download
 * @example
 * await requestExport({ format: 'pdf', source: 'chat', appId: 'chat', messages: [...] });
 */
export async function requestExport(body, options = {}) {
  const { blob, filename, manifestId } = await fetchExport(body, options);
  if (!saveBlobAs(blob, filename)) {
    throw new ExportRequestError('The download could not be started', null, {
      code: 'DOWNLOAD_BLOCKED'
    });
  }
  return { filename, manifestId };
}

/**
 * Request a text export (txt, markdown, json, jsonl) and return its text —
 * used for "Copy" in the export dialog, so the clipboard gets the same
 * labelled content as the downloaded file.
 *
 * @param {Object} body - Export request body with a text `format`
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 * @throws {ExportRequestError}
 */
export async function requestExportText(body, options = {}) {
  const { blob } = await fetchExport(body, options);
  return readBlobText(blob);
}

/**
 * The text to put on the clipboard: with the invisible C2PA text signpost
 * appended when the admin switched the clipboard signpost on (platform-wide
 * or for this app), otherwise the text unchanged.
 *
 * @param {string} text - Text the user copies
 * @param {string} [appId] - App whose signpost override applies
 * @returns {Promise<string>} The text for the clipboard
 */
export async function signClipboardText(text, appId) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const response = await apiClient.post('/provenance/signpost', {
    text,
    ...(appId ? { appId } : {})
  });
  return typeof response?.data?.text === 'string' ? response.data.text : text;
}
