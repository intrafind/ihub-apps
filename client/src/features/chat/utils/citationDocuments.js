import { fetchIFinderDocument } from '../../../api/endpoints/documents';
import {
  filenameFromContentDisposition,
  openExternalUrl,
  saveBlobAs
} from '../../../utils/externalNavigation';
import {
  MAX_ATTACHMENT_BYTES,
  attachFileToOutlookItem,
  canAttachFileToOutlookItem,
  isOutlookAttachmentHost
} from '../../office/utilities/outlookAttachments';

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
 *   | { ok: false, reason: 'unavailable'|'blocked'|'failed'|'notComposing'|'tooLarge',
 *       error?: Error, message?: string }} DocumentActionResult
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

/** Extensions to fall back on when the name iFinder sent carries none. */
const EXTENSION_BY_CONTENT_TYPE = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'image/png': 'png',
  'image/jpeg': 'jpg'
};

/**
 * What to call the file once the bytes are in hand: the name the server sent,
 * then the document's own file name, then its id.
 *
 * The name is stripped of path separators and of the characters Windows
 * rejects, and gets an extension from the content type when it has none —
 * Outlook picks the attachment's icon, and Windows the application that opens
 * it, from the extension alone, so a bare title would arrive as a file nobody
 * can open.
 *
 * @param {Object} item Citation document.
 * @param {import('axios').AxiosResponse} response
 * @param {{documentId: string}} access
 * @returns {string}
 */
export function resolveCitationFilename(item, response, access) {
  const candidate =
    filenameFromContentDisposition(response?.headers?.['content-disposition']) ||
    getCitationFileName(item) ||
    access.documentId;

  const base =
    String(candidate)
      .replace(/[\\/]+/g, '_')
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .trim()
      .slice(0, 180) || access.documentId;

  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base;

  const contentType = String(response?.headers?.['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
  return extension ? `${base}.${extension}` : base;
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

    return saveBlobAs(response.data, resolveCitationFilename(item, response, access))
      ? { ok: true }
      : { ok: false, reason: 'failed' };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}

/** Read a Blob as base64, without the `data:` prefix. */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the document'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * True where attaching a document to a mail exists as an action at all, i.e.
 * in the Outlook task pane. Everywhere else the entry is not rendered.
 *
 * @returns {boolean}
 */
export const isCitationAttachSupported = () => isOutlookAttachmentHost();

/**
 * True when the Outlook item open right now can take the attachment — the
 * user is writing a mail rather than reading one. Re-read on
 * `ihub:itemchanged`.
 *
 * @returns {boolean}
 */
export const canAttachCitationDocument = () => canAttachFileToOutlookItem();

/**
 * Attach the document to the mail being written: fetched with the user's own
 * iFinder permissions through the authenticated proxy, then handed to Outlook
 * as bytes.
 *
 * @param {Object} item Citation document.
 * @returns {Promise<DocumentActionResult & {filename?: string}>}
 */
export async function attachCitationDocumentToMail(item) {
  const access = getCitationDocumentAccess(item);
  if (!access) return { ok: false, reason: 'unavailable' };
  if (!canAttachCitationDocument()) return { ok: false, reason: 'notComposing' };

  try {
    const response = await fetchIFinderDocument({
      documentId: access.documentId,
      searchProfile: access.searchProfile
    });

    const blob = response.data;
    if (blob?.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: 'tooLarge' };
    }

    const filename = resolveCitationFilename(item, response, access);
    const result = await attachFileToOutlookItem({
      base64: await blobToBase64(blob),
      filename
    });

    return result.ok ? { ok: true, filename } : result;
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}
