import { fetchIFinderDocument } from '../../../api/endpoints/documents';
import {
  filenameFromContentDisposition,
  openExternalUrl,
  saveBlobAs
} from '../../../utils/externalNavigation';

/**
 * Shared behaviour behind the per-document actions on a citation: reading the
 * bits of iFinder metadata the UI needs, opening the document in the user's
 * browser, and downloading it.
 *
 * Both the citation panel's built-in handling and `AppChat`'s
 * `onDocumentAction` override run through here so the two cannot drift, and
 * so neither can fall back to a raw `window.open()` — which is a silent no-op
 * in the Outlook task pane and the extension side panel (issue #2453).
 *
 * @typedef {{ ok: true }
 *   | { ok: false, reason: 'unavailable'|'blocked'|'failed', error?: Error }} DocumentActionResult
 */

/**
 * Safely extract a value from `additional_document_metadata`.
 * Values are typically arrays (e.g. `["Filesystem"]`), so unwrap the first element.
 */
export const getCitationMeta = (item, key, fallback = '') => {
  const val = item?.additional_document_metadata?.[key];
  return Array.isArray(val) && val.length > 0 ? val[0] : val || fallback;
};

/** The document's canonical URL in its source system, when iFinder knows one. */
export const getCitationDeepLink = item => getCitationMeta(item, 'accessInfo.deepLink');

/** The document's original file name, when iFinder knows one. */
export const getCitationFileName = item => getCitationMeta(item, 'file.name');

/**
 * Extract document access info (documentId + searchProfile) from a citation
 * item's links array. Returns null if no ACCESS link is present.
 */
export const getCitationDocumentAccess = item => {
  const links = item?.links;
  if (!Array.isArray(links)) return null;
  const accessLink = links.find(l => l.type === 'ACCESS');
  if (!accessLink?.documentId) return null;
  return { documentId: accessLink.documentId, searchProfile: accessLink.searchProfile };
};

/** True when the document can be fetched through the iFinder proxy. */
export const hasCitationProxyAccess = item => !!getCitationDocumentAccess(item);

/**
 * Open the document's deep link in the user's browser.
 *
 * @param {Object} item Citation document.
 * @returns {DocumentActionResult}
 */
export function openCitationDocument(item) {
  const deepLink = getCitationDeepLink(item);
  if (!deepLink) return { ok: false, reason: 'unavailable' };
  return openExternalUrl(deepLink) ? { ok: true } : { ok: false, reason: 'blocked' };
}

/**
 * Download the document through the authenticated iFinder proxy and save it.
 *
 * @param {Object} item Citation document.
 * @returns {Promise<DocumentActionResult>}
 */
export async function downloadCitationDocument(item) {
  const access = getCitationDocumentAccess(item);
  if (!access) return { ok: false, reason: 'unavailable' };

  try {
    const response = await fetchIFinderDocument({
      documentId: access.documentId,
      searchProfile: access.searchProfile
    });
    const filename =
      filenameFromContentDisposition(response.headers?.['content-disposition']) ||
      getCitationFileName(item) ||
      access.documentId;

    return saveBlobAs(response.data, filename) ? { ok: true } : { ok: false, reason: 'failed' };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}
