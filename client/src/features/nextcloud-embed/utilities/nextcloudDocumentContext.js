import { apiClient } from '../../../api/client';
import { getCurrentSelection } from './nextcloudSelectionBridge';
import { contentTypeFromExtension, fileNameFromPath } from './nextcloudFileMeta';

/**
 * Build a `HostMailContext`-shaped object from the current Nextcloud
 * selection, using the existing per-user OAuth `/download` endpoint to
 * fetch each file. The downloaded blobs are passed through to the host
 * adapter as `attachments`; `useOfficeChatAdapter` then runs them
 * through `buildImageDataFromMailAttachments` /
 * `buildFileDataFromMailAttachments` exactly the way Outlook email
 * attachments are handled today, so the LLM gets extracted document
 * text without us re-implementing extraction here.
 *
 * Returns:
 *   { available: false }                       — no selection / not signed in
 *   { available: true, bodyText: null, attachments: [...] }
 *
 * Throws `NextcloudNotLinkedError` when the server replies 401 to a
 * download — the caller surfaces a "Connect Nextcloud" CTA.
 */
export class NextcloudNotLinkedError extends Error {
  constructor() {
    super('Nextcloud account is not linked to this iHub user');
    this.name = 'NextcloudNotLinkedError';
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      // result is `data:<mime>;base64,<payload>`. The downstream
      // `buildFileDataFromMailAttachments` / `buildImageDataFromMailAttachments`
      // helpers call `atob` directly, so we must strip the data-URL prefix.
      const commaIdx = result.indexOf(',');
      if (commaIdx === -1) {
        reject(new Error('Unexpected FileReader result format'));
        return;
      }
      resolve(result.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

async function downloadOne(path) {
  try {
    const response = await apiClient.get('/integrations/nextcloud/download', {
      params: { filePath: path },
      responseType: 'blob'
    });
    const blob = response.data;
    const name = fileNameFromPath(path);
    // Browsers report `application/octet-stream` for the response (the server
    // forces this for security), so fall back to extension sniffing.
    const contentType = contentTypeFromExtension(name);
    const base64 = await blobToBase64(blob);
    return {
      name,
      contentType,
      size: blob.size,
      content: { content: base64 }
    };
  } catch (err) {
    if (err?.response?.status === 401) {
      throw new NextcloudNotLinkedError();
    }
    // Re-throw with context so the caller can decide whether to surface
    // a per-file error or fail the whole batch.
    const wrapped = new Error(`Failed to download Nextcloud file '${path}': ${err.message}`);
    wrapped.cause = err;
    wrapped.path = path;
    throw wrapped;
  }
}

/**
 * Reads the current Nextcloud selection (set by the bridge) and downloads
 * each path through iHub's existing `/api/integrations/nextcloud/download`
 * endpoint. Returns the `HostMailContext` shape `useOfficeChatAdapter`
 * already consumes.
 *
 * @returns {Promise<{
 *   available: boolean,
 *   bodyText?: string|null,
 *   attachments?: Array<{name: string, contentType: string, size: number, content: {content: string}}>
 * }>}
 */
export async function fetchCurrentDocumentContext() {
  const selection = getCurrentSelection();
  if (!selection || !Array.isArray(selection.paths) || selection.paths.length === 0) {
    return { available: false, bodyText: null, attachments: [] };
  }

  // Sequential rather than parallel — Nextcloud's WebDAV server is often
  // single-threaded per user and a burst of parallel downloads from the
  // same session token can be rate-limited. Keep it simple and friendly.
  const attachments = [];
  for (const path of selection.paths) {
    try {
      attachments.push(await downloadOne(path));
    } catch (err) {
      if (err instanceof NextcloudNotLinkedError) throw err;
      // Skip individual failures (file deleted, permission denied) — the
      // chat hook will still send the successful ones. The UI surfaces a
      // notice through the connect hook's `lastError` channel.

      console.warn('Nextcloud document context: skipping failed download', err);
    }
  }

  return {
    available: attachments.length > 0,
    bodyText: null,
    attachments
  };
}
