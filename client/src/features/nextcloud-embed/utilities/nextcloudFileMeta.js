/**
 * Shared helpers for deriving display metadata from a Nextcloud file path.
 * Used by the full-app uploader adapter (`useNextcloudEmbedAttachments`).
 * Keep this file dependency-free so it can be imported anywhere.
 */

export function fileNameFromPath(path) {
  if (typeof path !== 'string' || path.length === 0) return 'document';
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed.length === 0) return 'document';
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Best-effort content-type lookup. The server forces
 * `application/octet-stream` on `/download` responses for safety, so the
 * extension is the most reliable signal we have client-side.
 */
export function contentTypeFromExtension(name) {
  const dot = typeof name === 'string' ? name.lastIndexOf('.') : -1;
  if (dot === -1) return 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
    case 'md':
      return 'text/plain';
    case 'csv':
      return 'text/csv';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    default:
      return 'application/octet-stream';
  }
}
