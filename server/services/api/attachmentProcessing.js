/**
 * Turn an uploaded file into the attachment shape the chat pipeline already
 * understands.
 *
 * The web client processes uploads in the browser (text out of PDFs, images as
 * data URLs) and sends the result on the message as `fileData` / `imageData`.
 * The App API receives raw bytes instead, so this module does the same work
 * on the server: images become `imageData`, text-bearing documents become
 * `fileData` with their extracted `content`, and both keep the original bytes
 * as a data URL so tools that take files (MCP file inputs) receive the real
 * document.
 *
 * @module services/api/attachmentProcessing
 */
import { createHash } from 'crypto';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Largest document text kept, in characters — beyond this the rest is dropped. */
export const MAX_DOCUMENT_CHARS = 2_000_000;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Extensions → media type, for uploads whose client sent none or `application/octet-stream`. */
const EXTENSION_TYPES = Object.freeze({
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  ts: 'text/plain',
  py: 'text/x-python',
  java: 'text/x-java-source',
  log: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
});

/** Non-`text/*` media types whose bytes are UTF-8 text. */
const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/ld+json',
  'application/javascript',
  'application/x-ndjson'
]);

/**
 * An error that names why an attachment cannot be used, with the HTTP status
 * the API answers with.
 */
export class AttachmentError extends Error {
  constructor(code, message, status = 415) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolve the media type of an upload: the declared type unless it is missing
 * or generic, then the file extension.
 *
 * @param {string|undefined} declared - Content type the client sent
 * @param {string|undefined} fileName
 * @returns {string} A media type, `application/octet-stream` when unknown
 */
export function resolveMimeType(declared, fileName) {
  const clean = String(declared || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (clean && clean !== 'application/octet-stream') return clean;
  const ext = String(fileName || '')
    .split('.')
    .pop()
    .toLowerCase();
  return EXTENSION_TYPES[ext] || clean || 'application/octet-stream';
}

function isTextType(mimeType) {
  return (
    mimeType.startsWith('text/') ||
    TEXT_APPLICATION_TYPES.has(mimeType) ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml')
  );
}

/** Whether this module can turn a media type into something the model can read. */
export function isSupportedMimeType(mimeType) {
  return IMAGE_TYPES.has(mimeType) || mimeType === 'application/pdf' || isTextType(mimeType);
}

/**
 * Text of a PDF, page by page.
 * @param {Buffer} buffer
 * @returns {Promise<{text: string, pages: number}>}
 */
export async function extractPdfText(buffer) {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  const doc = await loadingTask.promise;
  try {
    const pages = [];
    let total = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map(item => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (text) {
        pages.push(text);
        total += text.length;
        if (total >= MAX_DOCUMENT_CHARS) break;
      }
    }
    return { text: pages.join('\n\n').slice(0, MAX_DOCUMENT_CHARS), pages: doc.numPages };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

function dataUrl(mimeType, buffer) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function displayTypeOf(mimeType, fileName) {
  const ext = String(fileName || '')
    .split('.')
    .pop();
  if (ext && ext !== fileName) return ext.toUpperCase();
  return mimeType.split('/').pop().toUpperCase();
}

/**
 * Process one upload into a chat attachment.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - The file's bytes
 * @param {string} [params.mimeType] - Declared media type
 * @param {string} [params.fileName]
 * @returns {Promise<{kind: 'image', imageData: Object}|{kind: 'document', fileData: Object}>}
 * @throws {AttachmentError} For media types the model cannot read, or a PDF without a text layer
 */
export async function processAttachment({ buffer, mimeType, fileName }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AttachmentError('EMPTY_FILE', 'The file is empty', 400);
  }
  const type = resolveMimeType(mimeType, fileName);
  const name = fileName || `attachment.${type.split('/').pop()}`;
  const size = buffer.length;

  if (IMAGE_TYPES.has(type)) {
    return {
      kind: 'image',
      imageData: {
        type: 'image',
        base64: dataUrl(type, buffer),
        fileName: name,
        fileSize: size,
        fileType: type
      }
    };
  }

  let content;
  if (type === 'application/pdf') {
    let extracted;
    try {
      extracted = await extractPdfText(buffer);
    } catch (error) {
      throw new AttachmentError(
        'INVALID_PDF',
        `The PDF could not be read: ${error.message || 'unknown error'}`,
        400
      );
    }
    if (!extracted.text) {
      throw new AttachmentError(
        'PDF_WITHOUT_TEXT',
        'The PDF has no text layer (a scanned document); upload a text PDF or an image of the page instead'
      );
    }
    content = extracted.text;
  } else if (isTextType(type)) {
    content = buffer.toString('utf8').slice(0, MAX_DOCUMENT_CHARS);
  } else {
    throw new AttachmentError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Unsupported file type ${type}: send PDF, plain-text formats (txt, md, csv, json, xml, html, code) or images (png, jpeg, gif, webp)`
    );
  }

  return {
    kind: 'document',
    fileData: {
      type: 'document',
      source: 'api',
      fileName: name,
      fileSize: size,
      fileType: type,
      displayType: displayTypeOf(type, name),
      content,
      // The bytes themselves, so tools that take files receive the document
      // and not just its text.
      base64: dataUrl(type, buffer)
    }
  };
}

/**
 * Decode an OpenAI-style data URL (`data:<type>;base64,<payload>`).
 * @param {string} url
 * @returns {{mimeType: string, buffer: Buffer}|null} null when it is not a data URL
 */
export function decodeDataUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(url.trim());
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

/** Hex SHA-256 of a payload. */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
