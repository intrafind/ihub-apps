import { apiClient } from '../client';

/**
 * Server-side exports (`POST /api/exports/pdf`): a chat, or Markdown the UI
 * offers for download, rendered as a real PDF file.
 */

// Rendering runs on the server with a 90 s budget; the request may wait a
// little longer than that for a free renderer.
const EXPORT_REQUEST_TIMEOUT = 120000;

/**
 * With `responseType: 'blob'` a JSON error body arrives as a Blob; read its
 * `error` message so the user sees the reason rather than a status code.
 *
 * @param {unknown} data
 * @returns {Promise<string|null>}
 */
const blobErrorMessage = async data => {
  if (!(data instanceof Blob)) return null;
  try {
    const body = JSON.parse(await data.text());
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
};

/**
 * Render a PDF on the server (`POST /api/exports/pdf`).
 *
 * @param {Object} payload - `{ kind: 'chat', messages, settings, … }` or
 *   `{ kind: 'markdown', markdown, title, … }`.
 * @returns {Promise<Blob>} The PDF.
 */
export const exportPdfOnServer = async payload => {
  try {
    const response = await apiClient.post('/exports/pdf', payload, {
      responseType: 'blob',
      timeout: EXPORT_REQUEST_TIMEOUT
    });
    return response.data;
  } catch (error) {
    const message = await blobErrorMessage(error?.response?.data);
    if (message) throw new Error(message);
    throw error;
  }
};
