import { apiClient } from '../client';

// Documents can be large and a provider may resolve the real download link
// before streaming, so give these calls more room than the 30s client default.
const CONTENT_REQUEST_TIMEOUT = 120000;

/**
 * The query string naming a source to its provider: its `ref`, and the format
 * wanted.
 *
 * @param {{id: string, scope?: string}} ref
 * @param {'original'|'pdf'|'text'} [format]
 * @returns {URLSearchParams}
 */
export const buildSourceParams = (ref, format) => {
  const params = new URLSearchParams({ id: ref?.id || '' });
  if (ref?.scope) params.set('scope', ref.scope);
  if (format && format !== 'original') params.set('format', format);
  return params;
};

/**
 * A source's content, from its provider (`GET /api/sources/:provider/content`),
 * fetched with the signed-in user's own permissions in that system.
 *
 * Going through `apiClient` rather than a bare `fetch(..., { credentials:
 * 'include' })` is what makes this work outside the web app: the Outlook task
 * pane and the browser extension authenticate with an `Authorization: Bearer`
 * header installed as an interceptor (plus a silent refresh on 401), and they
 * have no session cookie to send. See `officeAuthBridge.js`.
 *
 * @param {Object} options
 * @param {{provider: string, ref: {id: string, scope?: string}}} options.source
 * @param {'original'|'pdf'|'text'} [options.format='original']
 * @param {'blob'|'arraybuffer'} [options.responseType='blob']
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export const fetchSourceContent = async ({
  source,
  format = 'original',
  responseType = 'blob',
  signal
} = {}) => {
  const params = buildSourceParams(source?.ref, format);
  return apiClient.get(`/sources/${encodeURIComponent(source?.provider || '')}/content?${params}`, {
    responseType,
    signal,
    timeout: CONTENT_REQUEST_TIMEOUT
  });
};

/**
 * A source's details, from its provider (`GET /api/sources/:provider/metadata`).
 *
 * @param {Object} options
 * @param {{provider: string, ref: {id: string, scope?: string}}} options.source
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Object>} the provider's details
 */
export const fetchSourceMetadata = async ({ source, signal } = {}) => {
  const params = buildSourceParams(source?.ref);
  const response = await apiClient.get(
    `/sources/${encodeURIComponent(source?.provider || '')}/metadata?${params}`,
    { signal }
  );
  return response.data;
};
