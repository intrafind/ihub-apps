import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { filenameFromContentDisposition } from '../../utils/fileDownload';

/**
 * iFinder document access.
 *
 * Every call goes through `apiClient` rather than a bare `fetch(…, {
 * credentials: 'include' })`. Cookies only authenticate the plain web app:
 * the Outlook task pane, the browser extension's side panel and the Nextcloud
 * embed all authenticate with a Bearer token that `apiClient`'s interceptors
 * attach (and silently refresh on a 401). A raw fetch from those hosts reaches
 * the proxy unauthenticated and comes back 401, which is why document preview,
 * details and download only ever worked in the browser.
 *
 * Binaries can be large and iFinder's PDF conversion is not instant, so these
 * requests get a longer timeout than the 30s `apiClient` default.
 */
const DOCUMENT_TIMEOUT = 120000;

const documentQuery = ({ documentId, searchProfile, convertToPdf = false }) => {
  const params = new URLSearchParams({ documentId });
  if (searchProfile) params.set('searchProfile', searchProfile);
  if (convertToPdf) params.set('convertToPdf', 'true');
  return params.toString();
};

/**
 * Fetch a document's binary through the iFinder proxy.
 *
 * @param {Object} options
 * @param {string} options.documentId
 * @param {string} [options.searchProfile]
 * @param {boolean} [options.convertToPdf] ask iFinder for a generated PDF.
 * @param {'blob'|'arraybuffer'} [options.responseType]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ data: Blob|ArrayBuffer, contentType: string, filename: string|null }>}
 */
export const fetchIFinderDocument = async ({
  documentId,
  searchProfile,
  convertToPdf = false,
  responseType = 'blob',
  signal
} = {}) => {
  const response = await apiClient.get(
    `/integrations/ifinder/document?${documentQuery({ documentId, searchProfile, convertToPdf })}`,
    { responseType, signal, timeout: DOCUMENT_TIMEOUT }
  );

  return {
    data: response.data,
    contentType: response.headers?.['content-type'] || 'application/octet-stream',
    filename: filenameFromContentDisposition(response.headers?.['content-disposition'])
  };
};

/**
 * Text fallback for documents the proxy cannot hand out as a binary.
 *
 * @param {Object} options
 * @param {string} options.documentId
 * @param {string} [options.searchProfile]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 */
export const fetchIFinderDocumentText = async ({ documentId, searchProfile, signal } = {}) => {
  const response = await apiClient.get(
    `/integrations/ifinder/document/content?${documentQuery({ documentId, searchProfile })}`,
    { responseType: 'text', signal, timeout: DOCUMENT_TIMEOUT }
  );
  return typeof response.data === 'string' ? response.data : '';
};

/**
 * Document metadata (file type, size, author, navigation tree, …).
 *
 * @param {Object} options
 * @param {string} options.documentId
 * @param {string} [options.searchProfile]
 * @returns {Promise<Object>}
 */
export const fetchIFinderDocumentMetadata = async ({ documentId, searchProfile } = {}) =>
  handleApiResponse(
    () =>
      apiClient.get(
        `/integrations/ifinder/document/metadata?${documentQuery({ documentId, searchProfile })}`
      ),
    null,
    null,
    false
  );
