import { apiClient } from '../client';

// Documents can be large and iFinder resolves the real download link before
// streaming, so give these calls more room than the 30s client default.
const DOCUMENT_REQUEST_TIMEOUT = 120000;

/**
 * Build the query string for the iFinder document proxy.
 *
 * @param {{ documentId: string, searchProfile?: string, convertToPdf?: boolean }} params
 * @returns {URLSearchParams}
 */
export const buildIFinderDocumentParams = ({ documentId, searchProfile, convertToPdf } = {}) => {
  const params = new URLSearchParams({ documentId: documentId || '' });
  if (searchProfile) params.set('searchProfile', searchProfile);
  if (convertToPdf) params.set('convertToPdf', 'true');
  return params;
};

/**
 * Fetch a document from the iFinder proxy through `apiClient`.
 *
 * Going through `apiClient` rather than a bare `fetch(..., { credentials:
 * 'include' })` is what makes these work outside the web app: the Outlook task
 * pane and the browser extension authenticate with an `Authorization: Bearer`
 * header installed as an interceptor (plus a silent refresh on 401), and they
 * have no session cookie to send. See `officeAuthBridge.js`.
 *
 * @param {Object} options
 * @param {string} options.documentId
 * @param {string} [options.searchProfile]
 * @param {boolean} [options.convertToPdf] Ask iFinder for a PDF rendition.
 * @param {'blob'|'arraybuffer'} [options.responseType='blob']
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export const fetchIFinderDocument = async ({
  documentId,
  searchProfile,
  convertToPdf = false,
  responseType = 'blob',
  signal
} = {}) => {
  const params = buildIFinderDocumentParams({ documentId, searchProfile, convertToPdf });
  return apiClient.get(`/integrations/ifinder/document?${params}`, {
    responseType,
    signal,
    timeout: DOCUMENT_REQUEST_TIMEOUT
  });
};

/**
 * Fetch a document's iFinder metadata (used by the citation details dialog).
 *
 * @param {Object} options
 * @param {string} options.documentId
 * @param {string} [options.searchProfile]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Object>} The parsed metadata payload.
 */
export const fetchIFinderDocumentMetadata = async ({ documentId, searchProfile, signal } = {}) => {
  const params = buildIFinderDocumentParams({ documentId, searchProfile });
  const response = await apiClient.get(`/integrations/ifinder/document/metadata?${params}`, {
    signal
  });
  return response.data;
};

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
      timeout: DOCUMENT_REQUEST_TIMEOUT
    });
    return response.data;
  } catch (error) {
    const message = await blobErrorMessage(error?.response?.data);
    if (message) throw new Error(message);
    throw error;
  }
};
