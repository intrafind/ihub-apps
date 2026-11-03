// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers for the files uploaded to a chat (`/api/chats/:chatId/files`) as the
 * Files drawer shows them: a type badge, how to preview one, whether its
 * original is still there, and the readers of the structured ones (an e-mail,
 * a meeting, a web page).
 *
 * @module features/chat/utils/uploadedFiles
 */

const BADGES = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/msword': 'DOC',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.ms-powerpoint': 'PPT',
  'text/csv': 'CSV',
  'text/markdown': 'MD',
  'text/plain': 'TXT',
  'text/html': 'HTML',
  'application/json': 'JSON',
  'message/rfc822': 'EML',
  'application/vnd.ms-outlook': 'MSG',
  'text/calendar': 'ICS',
  'application/x-ipynb+json': 'IPYNB'
};

/**
 * The short type label of a file (`PDF`, `DOCX`, `EML`): from its media type,
 * else its extension.
 *
 * @param {{ mimeType?: string, name?: string }} file
 * @returns {string}
 */
export function uploadedFileBadge(file) {
  const mimeType = file?.mimeType || file?.type || '';
  if (BADGES[mimeType]) return BADGES[mimeType];
  if (mimeType.startsWith('image/')) return mimeType.slice(6).replace('jpeg', 'jpg').toUpperCase();
  const match = /\.([a-z0-9]{1,6})$/i.exec(String(file?.name || ''));
  return match ? match[1].toUpperCase() : 'FILE';
}

/**
 * How a file is shown.
 *
 * - `email`, `meeting`, `page`: the structured viewers (header table + body).
 * - `pdf`, `image`, `csv`, `ipynb`, `code`: the original file, when it is still stored.
 * - `text`: the extracted text (Office documents, anything whose original is gone).
 *
 * @param {Object} file - Descriptor.
 * @returns {'email'|'meeting'|'page'|'pdf'|'image'|'csv'|'ipynb'|'code'|'text'}
 */
export function uploadedViewKind(file) {
  const mimeType = file?.mimeType || '';
  const name = String(file?.name || '');
  if (file?.origin === 'email' || mimeType === 'message/rfc822' || /\.eml$/i.test(name)) {
    return 'email';
  }
  if (file?.origin === 'meeting' || mimeType === 'text/calendar' || /\.ics$/i.test(name)) {
    return 'meeting';
  }
  if (file?.origin === 'page') return 'page';
  if (!file?.hasOriginal) return 'text';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'text/csv' || /\.csv$/i.test(name)) return 'csv';
  if (/\.ipynb$/i.test(name)) return 'ipynb';
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    /\.(json|ya?ml|xml|js|jsx|ts|tsx|py|java|go|rs|sql|sh|css)$/i.test(name)
  ) {
    return 'code';
  }
  return 'text';
}

/**
 * What the drawer can say about the stored bytes of a file.
 *
 * - `original`: the file and its text are stored;
 * - `text_only`: only the extracted text (by the storage mode, or the original was removed);
 * - `expired`: the original was removed by the retention sweep or to make room.
 *
 * @param {Object} file - Descriptor.
 * @returns {'original'|'text_only'|'expired'}
 */
export function uploadedStorageState(file) {
  if (file?.hasOriginal) return 'original';
  const reason = file?.originalDeleteReason || file?.originalDeletedReason;
  if (file?.originalDeletedAt && reason !== 'storage_mode') return 'expired';
  return 'text_only';
}

/**
 * Split the extracted text of an e-mail, meeting or page into its header lines
 * and its body. Headers are the leading `Name: value` lines (with folded
 * continuation lines) up to the first blank line.
 *
 * @param {string} text
 * @returns {{ headers: Array<{name: string, value: string}>, body: string }}
 */
export function parseStructuredText(text) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const headers = [];
  const lines = source.split('\n');
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') break;
    const match = /^([A-Za-z][A-Za-z0-9-]{0,40}):\s?(.*)$/.exec(line);
    if (match) {
      headers.push({ name: match[1], value: match[2] });
    } else if (/^\s+\S/.test(line) && headers.length > 0) {
      headers[headers.length - 1].value += ` ${line.trim()}`;
    } else {
      // Not a header block after all: everything is body.
      return { headers: [], body: source };
    }
  }
  return {
    headers,
    body: lines
      .slice(index + 1)
      .join('\n')
      .trim()
  };
}

/**
 * A blob as base64 without the `data:` prefix (what Outlook takes).
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * The name to save the extracted text under: the file's own name with `.txt`
 * (`brief.docx` → `brief.docx.txt`, so it is not mistaken for the original).
 *
 * @param {{ name?: string }} file
 * @returns {string}
 */
export function extractedTextFileName(file) {
  const name =
    String(file?.name || 'file')
      .split('/')
      .pop() || 'file';
  return /\.(txt|md)$/i.test(name) ? name : `${name}.txt`;
}

/**
 * Whether a drawer file belongs to a message the user wrote (`uploaded`), by
 * the ids a message names.
 *
 * @param {Object[]} files - Descriptors.
 * @param {Object[]} messages - Chat messages with `attachments` / `fileData`.
 * @returns {Map<string, number>} File id → number of the question that carried it (1-based).
 */
export function questionOfFiles(files, messages) {
  const wanted = new Set((files || []).map(file => file.id));
  const out = new Map();
  let question = 0;
  for (const message of messages || []) {
    if (message?.role !== 'user' || message.isGreeting) continue;
    question += 1;
    const ids = [
      ...(Array.isArray(message.attachments) ? message.attachments : []),
      ...[message.fileData].flat().filter(Boolean)
    ].map(item => item?.id || item?.fileId);
    for (const id of ids) {
      if (id && wanted.has(id) && !out.has(id)) out.set(id, question);
    }
  }
  return out;
}
