// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * extractText — the one function that turns a file into the text a project
 * keeps (spec 3 §3).
 *
 * The type is decided by the file's magic bytes where they exist (PDF, the
 * zip of an Office package, images and executables, which are refused) and
 * by the declared type or extension for text. Each supported type goes to
 * the extractor the chat upload already uses (`services/documentExtraction.js`
 * and `shared/documentExtraction/`); XLSX gets a server adapter here over
 * the shared SheetJS renderer, which until now only the browser had.
 *
 * Output is one UTF-8 string, normalized (`\r\n` → `\n`, NUL stripped),
 * capped at {@link MAX_TEXT_CHARS} with `truncated: true`. Headings stay as
 * markdown where the extractor produces them, because the BM25 provider
 * splits on them.
 *
 * There is no OCR: a PDF without a text layer is `NO_TEXT` (§3.2).
 *
 * @module services/projects/extractText
 */
import path from 'node:path';
import { htmlToText } from 'html-to-text';
import {
  DOCX_MIME,
  DocumentExtractionError,
  MAX_PDF_PAGES,
  ODP_MIME,
  ODS_MIME,
  ODT_MIME,
  PPTX_MIME,
  assertSafePackage,
  extractDocxDocument,
  extractOdfDocument,
  extractPdfDocument,
  extractPptxDocument
} from '../documentExtraction.js';
import { extractXlsxText } from '../../../shared/documentExtraction/xlsx.js';
import { MIN_REAL_TEXT_CHARS, realTextLength } from '../../../shared/documentExtraction/markers.js';

/** The most characters one item keeps (about 500 000 tokens). */
export const MAX_TEXT_CHARS = 2_000_000;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_MIME = 'application/pdf';
export const HTML_MIME = 'text/html';
export const EML_MIME = 'message/rfc822';

/** An extraction failure the pipeline records on the item. */
export class ExtractionError extends Error {
  /**
   * @param {'UNSUPPORTED_TYPE'|'EXTRACTION_FAILED'|'NO_TEXT'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

/** Office packages: the declared type, the file extension and the extractor. */
const PACKAGES = new Map([
  [DOCX_MIME, { extension: '.docx', label: 'Word', extract: bytes => extractDocxDocument(bytes) }],
  [
    PPTX_MIME,
    {
      extension: '.pptx',
      label: 'PowerPoint',
      extract: bytes => extractPptxDocument(bytes, { speakerNotes: 'include' })
    }
  ],
  [XLSX_MIME, { extension: '.xlsx', label: 'Excel', extract: bytes => extractXlsx(bytes) }],
  [ODT_MIME, { extension: '.odt', label: 'OpenDocument text', extract: extractOdfDocument }],
  [ODS_MIME, { extension: '.ods', label: 'OpenDocument spreadsheet', extract: extractOdfDocument }],
  [
    ODP_MIME,
    {
      extension: '.odp',
      label: 'OpenDocument presentation',
      extract: bytes => extractOdfDocument(bytes, { speakerNotes: 'include' })
    }
  ]
]);
const PACKAGE_MIME_BY_EXTENSION = new Map(
  [...PACKAGES].map(([mime, { extension }]) => [extension, mime])
);

/** Non-`text/*` types read as UTF-8 text. */
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/csv',
  'application/x-ndjson',
  'application/javascript',
  'application/typescript',
  'application/sql',
  'application/x-sh',
  'application/toml',
  'application/x-latex',
  'application/rtf',
  EML_MIME
]);

/** Extensions read as text when no usable type came along. */
const TEXT_EXTENSIONS = new Map([
  ['.txt', 'text/plain'],
  ['.text', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.ndjson', 'application/x-ndjson'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.toml', 'application/toml'],
  ['.html', HTML_MIME],
  ['.htm', HTML_MIME],
  ['.xhtml', HTML_MIME],
  ['.eml', EML_MIME],
  ['.rst', 'text/x-rst'],
  ['.tex', 'application/x-latex'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'application/typescript'],
  ['.tsx', 'application/typescript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.java', 'text/x-java'],
  ['.kt', 'text/x-kotlin'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.rb', 'text/x-ruby'],
  ['.php', 'text/x-php'],
  ['.c', 'text/x-c'],
  ['.h', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.hpp', 'text/x-c++'],
  ['.cs', 'text/x-csharp'],
  ['.swift', 'text/x-swift'],
  ['.scala', 'text/x-scala'],
  ['.sh', 'application/x-sh'],
  ['.bash', 'application/x-sh'],
  ['.ps1', 'text/plain'],
  ['.sql', 'application/sql'],
  ['.css', 'text/css'],
  ['.scss', 'text/css'],
  ['.ini', 'text/plain'],
  ['.cfg', 'text/plain'],
  ['.conf', 'text/plain'],
  ['.properties', 'text/plain'],
  ['.env', 'text/plain'],
  ['.rtf', 'application/rtf']
]);

/** Types refused at receive whatever the extension says. */
const REFUSED_PREFIXES = ['image/', 'audio/', 'video/', 'font/'];
const REFUSED_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-msdownload',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-mach-binary',
  'application/java-archive',
  'application/vnd.ms-outlook',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint'
]);

/**
 * What the pipeline accepts, for the error message and the client's file
 * picker (`accept`).
 */
export const ACCEPTED_TYPES = Object.freeze({
  mimeTypes: Object.freeze([PDF_MIME, ...PACKAGES.keys(), 'text/*', ...TEXT_MIME_TYPES]),
  extensions: Object.freeze([
    '.pdf',
    ...PACKAGE_MIME_BY_EXTENSION.keys(),
    ...TEXT_EXTENSIONS.keys()
  ]),
  summary:
    'PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), OpenDocument (.odt, .ods, .odp), HTML, e-mail (.eml), Markdown, CSV, JSON, XML and other text files'
});

function normalizeMime(value) {
  const raw = String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return raw === 'application/octet-stream' || raw === 'binary/octet-stream' ? '' : raw;
}

function extensionOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function isTextMime(mime) {
  return mime.startsWith('text/') || TEXT_MIME_TYPES.has(mime);
}

function isRefusedMime(mime) {
  return REFUSED_TYPES.has(mime) || REFUSED_PREFIXES.some(prefix => mime.startsWith(prefix));
}

/**
 * The content type the pipeline will treat a file as, from its declared
 * type and name alone (the receive-side check of spec 3 §2, before a byte
 * is accepted). Null when the type is not supported.
 *
 * @param {{contentType?: string, name?: string}} file
 * @returns {string|null}
 */
export function acceptedTypeOf({ contentType, name } = {}) {
  const declared = normalizeMime(contentType);
  const extension = extensionOf(name);
  if (declared && isRefusedMime(declared)) return null;
  if (declared === PDF_MIME || (!declared && extension === '.pdf')) return PDF_MIME;
  if (PACKAGES.has(declared)) return declared;
  if (PACKAGE_MIME_BY_EXTENSION.has(extension)) {
    // Browsers and cloud stores often send a generic or a sibling type for
    // an Office file; the extension is the better witness, the bytes decide.
    if (
      !declared ||
      declared === 'application/zip' ||
      PACKAGES.has(declared) ||
      isTextMime(declared)
    ) {
      return PACKAGE_MIME_BY_EXTENSION.get(extension);
    }
    return null;
  }
  if (TEXT_EXTENSIONS.has(extension)) return TEXT_EXTENSIONS.get(extension);
  if (declared && isTextMime(declared)) return declared;
  return null;
}

/**
 * What the first bytes say the file is.
 *
 * @param {Buffer} bytes
 * @returns {'pdf'|'zip'|'refused'|'unknown'}
 */
export function sniffBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return 'unknown';
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  ) {
    return 'zip';
  }
  const head = bytes.subarray(0, 8);
  const hex = head.toString('hex');
  if (
    hex.startsWith('89504e47') || // PNG
    hex.startsWith('ffd8ff') || // JPEG
    hex.startsWith('47494638') || // GIF
    hex.startsWith('52494646') || // RIFF (webp, wav, avi)
    hex.startsWith('49492a00') || // TIFF
    hex.startsWith('4d4d002a') || // TIFF
    hex.startsWith('4d5a') || // MZ executables
    hex.startsWith('7f454c46') || // ELF
    hex.startsWith('1f8b') || // gzip
    hex.startsWith('425a68') || // bzip2
    hex.startsWith('377abcaf271c') || // 7z
    hex.startsWith('526172211a07') || // RAR
    hex.startsWith('d0cf11e0a1b11ae1') || // OLE2 (.doc, .xls, .msg)
    hex.startsWith('cafebabe') || // Java class / Mach-O fat
    hex.startsWith('fffb') ||
    hex.startsWith('494433') || // MP3
    hex.startsWith('000001ba') ||
    hex.startsWith('000001b3') || // MPEG
    (hex.startsWith('00000018') && head.subarray(4, 8).toString('latin1') === 'ftyp') || // MP4
    (hex.startsWith('00000020') && head.subarray(4, 8).toString('latin1') === 'ftyp')
  ) {
    return 'refused';
  }
  return 'unknown';
}

/** Which Office package a zip holds, read from its entry names. */
async function packageTypeOf(bytes) {
  const { default: JSZip } = await import('jszip');
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return false;
  }
  const names = Object.keys(zip.files);
  if (names.some(name => name.startsWith('word/'))) return DOCX_MIME;
  if (names.some(name => name.startsWith('ppt/'))) return PPTX_MIME;
  if (names.some(name => name.startsWith('xl/'))) return XLSX_MIME;
  const mimetype = zip.file('mimetype');
  if (mimetype) {
    const declared = (await mimetype.async('string')).trim();
    if (PACKAGES.has(declared)) return declared;
  }
  return null;
}

/**
 * Settle the type from bytes, declared type and name together.
 *
 * @param {Buffer} bytes
 * @param {{contentType?: string, name?: string}} file
 * @returns {Promise<string>} The content type to extract as.
 * @throws {ExtractionError} `UNSUPPORTED_TYPE`
 */
export async function resolveContentType(bytes, { contentType, name } = {}) {
  const accepted = acceptedTypeOf({ contentType, name });
  const sniffed = sniffBytes(bytes);
  if (sniffed === 'refused') {
    throw new ExtractionError(
      'UNSUPPORTED_TYPE',
      `${name || 'The file'} is an image, media, archive or binary file. Supported: ${ACCEPTED_TYPES.summary}.`
    );
  }
  if (sniffed === 'pdf') return PDF_MIME;
  if (sniffed === 'zip') {
    const inside = await packageTypeOf(bytes);
    if (inside) return inside;
    if (inside === false) {
      throw new ExtractionError(
        'UNSUPPORTED_TYPE',
        `${name || 'The file'} is not a readable document (the package is damaged).`
      );
    }
    if (accepted && PACKAGES.has(accepted)) return accepted;
    throw new ExtractionError(
      'UNSUPPORTED_TYPE',
      `${name || 'The file'} is an archive, not a document. Supported: ${ACCEPTED_TYPES.summary}.`
    );
  }
  if (!accepted) {
    throw new ExtractionError(
      'UNSUPPORTED_TYPE',
      `${name || 'The file'} has an unsupported type ${normalizeMime(contentType) || '(unknown)'}. Supported: ${ACCEPTED_TYPES.summary}.`
    );
  }
  if (PACKAGES.has(accepted) || accepted === PDF_MIME) {
    // Declared as a document, but the bytes are neither a PDF nor a zip.
    throw new ExtractionError(
      'UNSUPPORTED_TYPE',
      `${name || 'The file'} is not a readable ${accepted === PDF_MIME ? 'PDF' : PACKAGES.get(accepted).label} document.`
    );
  }
  return accepted;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf16le = new TextDecoder('utf-16le', { fatal: true });
const utf16be = new TextDecoder('utf-16be', { fatal: true });

function decodeText(bytes, name) {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
      return utf16le.decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
      return utf16be.decode(bytes.subarray(2));
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return utf8.decode(bytes.subarray(3));
    }
    return utf8.decode(bytes);
  } catch {
    throw new ExtractionError(
      'UNSUPPORTED_TYPE',
      `${name || 'The file'} is not UTF-8 text. Convert it to UTF-8 and upload it again.`
    );
  }
}

/** Headings as markdown, so the BM25 provider can split on them. */
function markdownHeading(elem, walk, builder, formatOptions) {
  builder.openBlock({ leadingLineBreaks: 2 });
  builder.addInline(`${'#'.repeat(formatOptions.level || 1)} `);
  walk(elem.children, builder);
  builder.closeBlock({ trailingLineBreaks: 2 });
}

function htmlText(html) {
  return htmlToText(html, {
    wordwrap: false,
    formatters: { markdownHeading },
    selectors: [
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'noscript', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'footer', format: 'skip' },
      { selector: 'aside', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h1', format: 'markdownHeading', options: { level: 1 } },
      { selector: 'h2', format: 'markdownHeading', options: { level: 2 } },
      { selector: 'h3', format: 'markdownHeading', options: { level: 3 } },
      { selector: 'h4', format: 'markdownHeading', options: { level: 4 } },
      { selector: 'h5', format: 'markdownHeading', options: { level: 5 } },
      { selector: 'h6', format: 'markdownHeading', options: { level: 6 } },
      { selector: 'table', format: 'dataTable' }
    ]
  });
}

/**
 * An e-mail file as text: the headers that matter, then the plain or HTML
 * body parts. Attachments are not followed (spec 3 §3.1).
 */
function emailText(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? '' : normalized.slice(split + 2);
  const headers = {};
  let last = null;
  for (const line of headerBlock.split('\n')) {
    if (/^\s/.test(line) && last) headers[last] += ` ${line.trim()}`;
    else {
      const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (match) {
        last = match[1].toLowerCase();
        headers[last] = match[2];
      }
    }
  }
  const lines = [];
  for (const key of ['subject', 'from', 'to', 'cc', 'date']) {
    if (headers[key])
      lines.push(`${key[0].toUpperCase()}${key.slice(1)}: ${decodeHeader(headers[key])}`);
  }
  const parts = emailParts(
    body,
    headers['content-type'] || '',
    headers['content-transfer-encoding'] || ''
  );
  const text = parts
    .map(part => part.text)
    .filter(Boolean)
    .join('\n\n');
  return `${lines.join('\n')}\n\n${text}`.trim();
}

function decodeHeader(value) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, data) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : Buffer.from(
              data
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))),
              'latin1'
            );
      return new TextDecoder(charset.toLowerCase().replace(/^utf8$/, 'utf-8')).decode(bytes);
    } catch {
      return data;
    }
  });
}

function decodeBody(body, encoding, charset) {
  const enc = encoding.trim().toLowerCase();
  let bytes;
  if (enc === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') {
    bytes = Buffer.from(
      body
        .replace(/=\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))),
      'latin1'
    );
  } else return body;
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase().replace(/^utf8$/, 'utf-8')).decode(
      bytes
    );
  } catch {
    return bytes.toString('utf8');
  }
}

function emailParts(body, contentType, encoding, depth = 0) {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const charset = /charset="?([^";\s]+)"?/i.exec(contentType)?.[1];
  const boundary = /boundary="?([^";\n]+)"?/i.exec(contentType)?.[1];
  if (type.startsWith('multipart/') && boundary && depth < 8) {
    const pieces = body.split(`--${boundary}`).slice(1);
    const parts = [];
    let alternativeText = null;
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      const trimmed = piece.replace(/^\n/, '');
      const split = trimmed.indexOf('\n\n');
      const head = split === -1 ? trimmed : trimmed.slice(0, split);
      const partBody = split === -1 ? '' : trimmed.slice(split + 2);
      const partType =
        /content-type:\s*([^\n]+(?:\n\s+[^\n]+)*)/i.exec(head)?.[1]?.replace(/\n\s+/g, ' ') ||
        'text/plain';
      const partEncoding = /content-transfer-encoding:\s*([^\n]+)/i.exec(head)?.[1] || '';
      const disposition = /content-disposition:\s*attachment/i.test(head);
      if (disposition) continue;
      const sub = emailParts(partBody, partType, partEncoding, depth + 1);
      if (type === 'multipart/alternative') {
        // Prefer the plain part; keep HTML only when there is no text part.
        const plain = sub.find(part => part.kind === 'text');
        if (plain) alternativeText = plain;
        else if (!alternativeText) alternativeText = sub.find(part => part.kind === 'html') || null;
      } else parts.push(...sub);
    }
    if (alternativeText) parts.push(alternativeText);
    return parts;
  }
  if (type === 'text/html')
    return [{ kind: 'html', text: htmlText(decodeBody(body, encoding, charset)) }];
  if (type.startsWith('text/') || !type)
    return [{ kind: 'text', text: decodeBody(body, encoding, charset).trim() }];
  return [];
}

async function extractXlsx(bytes) {
  await assertSafePackage(bytes);
  const XLSX = await import('xlsx');
  const lib = XLSX.default || XLSX;
  let workbook;
  try {
    workbook = lib.read(bytes, { type: 'buffer', cellDates: true });
  } catch (error) {
    throw new DocumentExtractionError(`not a readable Excel workbook (${error.message})`);
  }
  return extractXlsxText({ XLSX: lib, workbook });
}

function countPages(text) {
  let pages = 0;
  for (const line of text.split('\n')) {
    const match = /^\[Page (\d+)/.exec(line.trim());
    if (match) pages = Math.max(pages, Number(match[1]));
  }
  return pages;
}

/**
 * Normalize and cap extracted text.
 *
 * @param {string} text
 * @param {{maxChars?: number}} [options]
 * @returns {{text: string, truncated: boolean}}
 */
export function normalizeText(text, { maxChars = MAX_TEXT_CHARS } = {}) {
  let out = String(text ?? '')
    .replaceAll('\u0000', '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  let truncated = false;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return { text: out, truncated };
}

/**
 * Extract the text of a file.
 *
 * @param {{bytes: Buffer, contentType?: string, name?: string}} file
 * @param {{maxChars?: number}} [options]
 * @returns {Promise<{text: string, contentType: string, pages?: number, truncated: boolean}>}
 * @throws {ExtractionError} `UNSUPPORTED_TYPE`, `EXTRACTION_FAILED`, `NO_TEXT`
 */
export async function extractText(
  { bytes, contentType, name },
  { maxChars = MAX_TEXT_CHARS } = {}
) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ExtractionError('NO_TEXT', `${name || 'The file'} is empty`);
  }
  const type = await resolveContentType(bytes, { contentType, name });
  let raw;
  let pages;
  try {
    if (type === PDF_MIME) {
      raw = await extractPdfDocument(bytes, { maxPages: MAX_PDF_PAGES, maxChars: maxChars + 1 });
      pages = countPages(raw);
    } else if (PACKAGES.has(type)) {
      raw = await PACKAGES.get(type).extract(bytes);
    } else if (type === HTML_MIME) {
      raw = htmlText(decodeText(bytes, name));
    } else if (type === EML_MIME) {
      raw = emailText(decodeText(bytes, name));
    } else {
      raw = decodeText(bytes, name);
    }
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError(
      'EXTRACTION_FAILED',
      `${name || 'The file'} could not be read: ${error?.message || 'extraction failed'}`
    );
  }
  const { text, truncated } = normalizeText(raw, { maxChars });
  if (type === PDF_MIME) {
    const real = realTextLength(text);
    if ((pages > 1 && real < MIN_REAL_TEXT_CHARS) || real === 0) {
      throw new ExtractionError(
        'NO_TEXT',
        'This PDF has no text layer (scanned). Run it through OCR and upload the result.'
      );
    }
  } else if (!text) {
    throw new ExtractionError('NO_TEXT', `${name || 'The file'} holds no text`);
  }
  return { text, contentType: type, ...(pages ? { pages } : {}), truncated };
}

export default extractText;
