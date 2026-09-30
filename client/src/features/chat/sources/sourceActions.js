import { fetchSourceContent } from '../../../api/endpoints/sources';
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
 * What the user can do with a source, whoever found it.
 *
 * The actions are one vocabulary, and which of them a source offers follows
 * from its data alone (`shared/sources/source.js`), never from the producer:
 *
 *   open        its `url`, in the user's browser
 *   copyLink    its `url`, to the clipboard
 *   preview     a PDF rendition, with its passages highlighted   } its `ref`, through the
 *   download    the file                                         } provider that owns it
 *   attach      the file, to the mail being written (Outlook)    } (`GET /api/sources/
 *   openInApp   the file, into a new chat of another app         }  :provider/content`)
 *   details     the provider's metadata                          }  and `/metadata`)
 *
 * The server keeps a `ref` only on sources whose provider can act on it, so
 * a ref is all the client needs to know. Preview, details and "Open in App"
 * are dialogs the sources panel owns; the rest run here, so the panel and
 * every host behave identically — and none of them falls back to a raw
 * `window.open()`, which is a silent no-op in the Outlook task pane and the
 * extension side panel (issue #2453).
 *
 * @typedef {{ ok: true }
 *   | { ok: false, reason: 'unavailable'|'blocked'|'failed'|'notComposing'|'tooLarge',
 *       error?: Error }} SourceActionResult
 *
 * @module features/chat/sources/sourceActions
 */

/** The actions, in the order the panel lists them. */
export const SOURCE_ACTIONS = Object.freeze([
  'open',
  'preview',
  'download',
  'attach',
  'openInApp',
  'details',
  'copyLink'
]);

/**
 * Whether the source has a link the panel may open, copy or render: http(s)
 * only. The server normalizes `url` that way already; checked again here
 * because a link reaches the browser (`openExternalUrl`, an anchor `href`).
 *
 * @param {Object} source
 * @returns {boolean}
 */
export function hasHttpUrl(source) {
  return typeof source?.url === 'string' && /^https?:\/\//i.test(source.url);
}

/**
 * The actions a source offers on this surface.
 *
 * @param {Object} source
 * @param {{attachSupported?: boolean, canOpenInApp?: boolean, canCopy?: boolean}} [host] -
 *   what the surface can do: attach only in the Outlook task pane, "Open in
 *   App" only where a router can open another app
 * @returns {string[]}
 */
export function sourceActionsOf(source, host = {}) {
  const hasUrl = hasHttpUrl(source);
  const hasRef = typeof source?.ref?.id === 'string' && !!source.ref.id;
  const available = {
    open: hasUrl,
    preview: hasRef,
    download: hasRef,
    attach: hasRef && host.attachSupported === true,
    openInApp: hasRef && host.canOpenInApp === true,
    details: hasRef,
    copyLink: hasUrl && host.canCopy !== false
  };
  return SOURCE_ACTIONS.filter(action => available[action]);
}

/**
 * Open the source's link in the user's browser.
 *
 * @param {Object} source
 * @returns {SourceActionResult}
 */
export function openSource(source) {
  if (!hasHttpUrl(source)) return { ok: false, reason: 'unavailable' };
  return openExternalUrl(source.url) ? { ok: true } : { ok: false, reason: 'blocked' };
}

/**
 * Copy the source's link.
 *
 * @param {Object} source
 * @returns {Promise<SourceActionResult>}
 */
export async function copySourceLink(source) {
  if (!hasHttpUrl(source)) return { ok: false, reason: 'unavailable' };
  try {
    await navigator.clipboard.writeText(source.url);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}

/** Extensions to fall back on when the name the provider sent carries none. */
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
 * then the source's own file name, then its title, then its id.
 *
 * The name is stripped of path separators and of the characters Windows
 * rejects, and gets an extension from the content type when it has none —
 * Outlook picks the attachment's icon, and Windows the application that opens
 * it, from the extension alone, so a bare title would arrive as a file nobody
 * can open.
 *
 * @param {Object} source
 * @param {import('axios').AxiosResponse} response
 * @returns {string}
 */
export function resolveSourceFilename(source, response) {
  const fallback = source?.ref?.id || 'document';
  const candidate =
    filenameFromContentDisposition(response?.headers?.['content-disposition']) ||
    source?.fileName ||
    source?.title ||
    fallback;

  const base =
    String(candidate)
      .replace(/[\\/]+/g, '_')
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .trim()
      .slice(0, 180) || fallback;

  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base;

  const contentType = String(response?.headers?.['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
  return extension ? `${base}.${extension}` : base;
}

/**
 * Download the source's file through its provider and save it.
 *
 * @param {Object} source
 * @returns {Promise<SourceActionResult>}
 */
export async function downloadSource(source) {
  if (!source?.ref) return { ok: false, reason: 'unavailable' };
  try {
    const response = await fetchSourceContent({ source });
    return saveBlobAs(response.data, resolveSourceFilename(source, response))
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
 * The source's file, for "Open in App" to attach to a new chat: the original,
 * named as the server sent it, else — for providers with no binary of it —
 * its text as a `.txt`.
 *
 * The text is fetched only when the server answered the binary request with
 * an error: a timeout or abort must not quietly turn into a `.txt`, and a
 * sign-in or permission failure applies to the text as well.
 *
 * @param {{provider: string, ref: {id: string, scope?: string}}} source
 * @param {string} fallbackName - the name when the server sends none
 * @returns {Promise<File>}
 */
export async function fetchSourceFile(source, fallbackName) {
  let response;
  try {
    response = await fetchSourceContent({ source });
  } catch (binaryError) {
    const status = binaryError?.response?.status;
    if (!status || status === 401 || status === 403) throw binaryError;
    const text = await fetchSourceContent({ source, format: 'text' });
    const txtName = fallbackName.endsWith('.txt') ? fallbackName : `${fallbackName}.txt`;
    return new File([text.data], txtName, { type: 'text/plain' });
  }
  const fileName =
    filenameFromContentDisposition(response.headers?.['content-disposition']) || fallbackName;
  const contentType = response.headers?.['content-type'] || 'application/octet-stream';
  return new File([response.data], fileName, { type: contentType });
}

/**
 * True where attaching a source to a mail exists as an action at all, i.e.
 * in the Outlook task pane. Everywhere else the entry is not rendered.
 *
 * @returns {boolean}
 */
export const isSourceAttachSupported = () => isOutlookAttachmentHost();

/**
 * True when the Outlook item open right now can take the attachment — the
 * user is writing a mail rather than reading one. Re-read on
 * `ihub:itemchanged`.
 *
 * @returns {boolean}
 */
export const canAttachSource = () => canAttachFileToOutlookItem();

/**
 * Attach the source's file to the mail being written: fetched with the user's
 * own permissions through its provider, then handed to Outlook as bytes.
 *
 * @param {Object} source
 * @returns {Promise<SourceActionResult & {filename?: string}>}
 */
export async function attachSourceToMail(source) {
  if (!source?.ref) return { ok: false, reason: 'unavailable' };
  if (!canAttachSource()) return { ok: false, reason: 'notComposing' };

  try {
    const response = await fetchSourceContent({ source });
    const blob = response.data;
    if (blob?.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: 'tooLarge' };
    }
    const filename = resolveSourceFilename(source, response);
    const result = await attachFileToOutlookItem({
      base64: await blobToBase64(blob),
      filename
    });
    return result.ok ? { ok: true, filename } : result;
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}
