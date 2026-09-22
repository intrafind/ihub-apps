/**
 * Saving a fetched file to disk, and turning one into base64.
 *
 * `window.open(downloadUrl)` is not an option in the hosts that embed the chat
 * UI: popups are blocked in the Outlook task pane and in the extension side
 * panel, `window.open()` returns `null` there and the click does nothing at
 * all. A same-document anchor carrying `download` works in every host, and it
 * also keeps the request on the authenticated `apiClient` path — the URL the
 * popup would have opened carries no Bearer token.
 */

/**
 * Save a Blob under `filename` by clicking a generated anchor.
 *
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'document';
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  // Firefox only follows the click for anchors that are in the document.
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Revoking straight away cancels the download in some engines; the object
    // URL is dropped on unload anyway, so a short grace period is enough.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/**
 * Read a Blob as base64 (no `data:` prefix).
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Pull the filename out of a `Content-Disposition` header.
 * Handles both `filename="…"` and RFC 5987 `filename*=UTF-8''…`.
 *
 * @param {string} [header]
 * @returns {string|null} the decoded filename, or null when there is none.
 */
export function filenameFromContentDisposition(header) {
  if (!header) return null;
  const extended = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  const raw = (extended?.[1] || plain?.[1] || '').trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const EXTENSION_BY_TYPE = {
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
  'application/json': 'json',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg'
};

/**
 * Build a filename that is safe to write to disk and to hand to Outlook.
 *
 * Prefers what the server sent in `Content-Disposition`, then the document's
 * own file name, then its title. An extension is appended from the content
 * type when the resulting name has none — Outlook picks the attachment icon
 * (and Windows the application) from the extension, so a bare title would
 * attach as an unopenable file.
 *
 * @param {Object} options
 * @param {string} [options.headerFilename] filename from `Content-Disposition`.
 * @param {string} [options.fileName] the document's own file name, if known.
 * @param {string} [options.title] document title, used as a last resort.
 * @param {string} [options.contentType]
 * @param {string} [options.fallback] name to use when nothing else is known.
 * @returns {string}
 */
export function resolveDownloadFilename({
  headerFilename,
  fileName,
  title,
  contentType,
  fallback = 'document'
} = {}) {
  const candidate = [headerFilename, fileName, title].map(v => (v || '').trim()).find(Boolean);

  // Strip any path segments and characters that filesystems (or Outlook) reject.
  const base = (candidate || fallback)
    .replace(/[\\/]+/g, '_')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);

  const safeBase = base || fallback;
  if (/\.[A-Za-z0-9]{1,8}$/.test(safeBase)) return safeBase;

  const extension =
    EXTENSION_BY_TYPE[
      String(contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase()
    ];
  return extension ? `${safeBase}.${extension}` : safeBase;
}
