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

/**
 * The most characters an item imported from a file on the server keeps. The
 * files are the administrator's own or ship with iHub (the consolidated
 * documentation is about 3 000 000 characters, its release notes at the very
 * end), so the cap that protects against an upload does not apply: text cut
 * here silently drops whatever comes last.
 */
export const MAX_IMPORT_TEXT_CHARS = 20_000_000;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_MIME = 'application/pdf';
export const HTML_MIME = 'text/html';
export const EML_MIME = 'message/rfc822';
/** An Outlook message (`.msg`): an OLE2 compound file read with msgreader. */
export const MSG_MIME = 'application/vnd.ms-outlook';

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

/**
 * Office packages: the declared type, the file extension and the extractor.
 * An extractor gets `(bytes, {report, sheetRows})` and sets `report.truncated`
 * when it left content out on a limit of its own.
 */
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
  [XLSX_MIME, { extension: '.xlsx', label: 'Excel', extract: extractXlsx }],
  [
    ODT_MIME,
    { extension: '.odt', label: 'OpenDocument text', extract: bytes => extractOdfDocument(bytes) }
  ],
  [
    ODS_MIME,
    {
      extension: '.ods',
      label: 'OpenDocument spreadsheet',
      extract: (bytes, { report }) => extractOdfDocument(bytes, { report })
    }
  ],
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
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint'
]);

/**
 * What the pipeline accepts, for the error message and the client's file
 * picker (`accept`).
 */
export const ACCEPTED_TYPES = Object.freeze({
  mimeTypes: Object.freeze([PDF_MIME, ...PACKAGES.keys(), MSG_MIME, 'text/*', ...TEXT_MIME_TYPES]),
  extensions: Object.freeze([
    '.pdf',
    ...PACKAGE_MIME_BY_EXTENSION.keys(),
    '.msg',
    ...TEXT_EXTENSIONS.keys()
  ]),
  summary:
    'PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), OpenDocument (.odt, .ods, .odp), HTML, e-mail (.eml, .msg), Markdown, CSV, JSON, XML and other text files'
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

/** The generic zip types a browser or a store may send for an Office file. */
const ZIP_MIMES = new Set(['application/zip', 'application/x-zip-compressed']);

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
  // A generic zip type on an Office extension is a browser's or a cloud
  // store's wording for the package, not an archive: the bytes decide below.
  const zipForPackage = ZIP_MIMES.has(declared) && PACKAGE_MIME_BY_EXTENSION.has(extension);
  if (declared && isRefusedMime(declared) && !zipForPackage) return null;
  // Browsers send `.msg` as the Outlook type, as a generic binary or as
  // nothing at all; the name is the witness, the OLE2 signature decides.
  if (declared === MSG_MIME || extension === '.msg') return MSG_MIME;
  if (declared === PDF_MIME || (!declared && extension === '.pdf')) return PDF_MIME;
  if (PACKAGES.has(declared)) return declared;
  if (PACKAGE_MIME_BY_EXTENSION.has(extension)) {
    // Browsers and cloud stores often send a generic or a sibling type for
    // an Office file; the extension is the better witness, the bytes decide.
    if (!declared || zipForPackage || PACKAGES.has(declared) || isTextMime(declared)) {
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
 * @returns {'pdf'|'zip'|'ole2'|'refused'|'unknown'} `ole2` is a compound
 *   file: an Outlook message, or a legacy Office document (`.doc`, `.xls`,
 *   `.ppt`) that `resolveContentType` refuses.
 */
export function sniffBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return 'unknown';
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1')
    return 'ole2';
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

/** A real `mimetype` entry is a few dozen bytes. */
const MAX_MIMETYPE_BYTES = 256;

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
  // The entry is inflated before `assertSafePackage` bounds the package, so
  // only a mimetype of the size a real one has is read at all.
  if (mimetype && Number(mimetype._data?.uncompressedSize) <= MAX_MIMETYPE_BYTES) {
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
  if (sniffed === 'ole2') {
    if (accepted === MSG_MIME) return MSG_MIME;
    throw new ExtractionError(
      'UNSUPPORTED_TYPE',
      `${name || 'The file'} is a legacy Office file (.doc, .xls, .ppt). Save it as .docx, .xlsx, .pptx or PDF and upload it again. Supported: ${ACCEPTED_TYPES.summary}.`
    );
  }
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
  if (accepted === MSG_MIME) {
    throw new ExtractionError(
      'UNSUPPORTED_TYPE',
      `${name || 'The file'} is not a readable Outlook message (.msg).`
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

const latin1 = new TextDecoder('latin1');

/**
 * Bytes as text in the charset a MIME part declares. An unknown label, or
 * none, reads UTF-8 and falls back to Latin-1 for bytes that are not UTF-8.
 *
 * @param {Buffer} bytes
 * @param {string} [charset]
 * @returns {string}
 */
function decodeCharset(bytes, charset) {
  const label = String(charset || '')
    .trim()
    .toLowerCase()
    .replace(/^utf8$/, 'utf-8');
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // A label TextDecoder does not know: guess below.
    }
  }
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

/** A string that holds one byte per character (`latin1`), as text in `charset`. */
function decodeOctets(octets, charset) {
  return decodeCharset(Buffer.from(octets, 'latin1'), charset);
}

/**
 * An e-mail file as text: the headers that matter, then the plain or HTML
 * body parts. Attachments are not followed (spec 3 §3.1).
 *
 * The message is parsed as one character per byte, so no byte is lost
 * before a part's own `charset` decides how its body reads.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function emailText(bytes) {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = (hasBom ? bytes.subarray(3) : bytes).toString('latin1');
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
      lines.push(
        `${key[0].toUpperCase()}${key.slice(1)}: ${decodeHeader(decodeOctets(headers[key]))}`
      );
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
      return decodeCharset(bytes, charset);
    } catch {
      return data;
    }
  });
}

/** A body part (one character per byte) as text: transfer encoding, then charset. */
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
  } else {
    // 7bit, 8bit, binary or none: the bytes as they are.
    bytes = Buffer.from(body, 'latin1');
  }
  return decodeCharset(bytes, charset);
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

// --- Outlook messages (.msg) -------------------------------------------------

/** Windows code pages Outlook records for a body, as TextDecoder labels. */
const CODEPAGE_TO_LABEL = Object.freeze({
  20127: 'us-ascii',
  28591: 'iso-8859-1',
  28592: 'iso-8859-2',
  28595: 'iso-8859-5',
  65001: 'utf-8',
  1200: 'utf-16le',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5'
});

/** Bytes as text in the first known of the code pages given, else UTF-8. */
function decodeCodepage(bytes, ...codepages) {
  const label = codepages.map(cp => CODEPAGE_TO_LABEL[cp]).find(Boolean) || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return decodeCharset(Buffer.from(bytes));
  }
}

/**
 * RTF as plain text, best effort: Outlook wraps HTML in RTF (MS-OXRTFEX),
 * whose markup is flattened like any HTML body; plain RTF keeps its
 * paragraphs. Never throws.
 */
/** Groups of an RTF header that hold no text: fonts, colours, styles, metadata. */
const RTF_SILENT_GROUP =
  /^\{\\(fonttbl|colortbl|stylesheet|info|listtable|listoverridetable|rsidtbl|generator|themedata|datastore|xmlnstbl|latentstyles|pntext)\b/;

/**
 * RTF without its silent groups and without the `{\*…}` destinations an
 * old reader may skip, keeping the `\*\htmltag` groups Outlook puts the
 * HTML markup of an encapsulated body in.
 */
function stripRtfGroups(rtf) {
  let out = '';
  let i = 0;
  while (i < rtf.length) {
    const head = rtf.slice(i, i + 24);
    if (rtf[i] === '{' && (RTF_SILENT_GROUP.test(head) || /^\{\\\*(?!\\htmltag)/.test(head))) {
      let depth = 0;
      for (; i < rtf.length; i += 1) {
        const ch = rtf[i];
        if (ch === '\\') {
          i += 1;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
      continue;
    }
    out += rtf[i];
    i += 1;
  }
  return out;
}

function rtfToText(rtf) {
  if (!rtf) return '';
  const text = stripRtfGroups(String(rtf))
    .replace(/\\htmlrtf\b[\s\S]*?\\htmlrtf0 ?/g, ' ')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n) => {
      let code = Number.parseInt(n, 10);
      if (code < 0) code += 65536;
      return String.fromCharCode(code);
    })
    .replace(/\\pard?\b ?/g, '\n')
    .replace(/\\line\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\\r?\n/g, '\n');
  const flat = /<\/?[a-z][\s\S]*>/i.test(text) ? htmlText(text) : text;
  return flat
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Outlook keeps internal addresses as X.500 names (`/O=…`): prefer SMTP. */
function pickEmail(...candidates) {
  return (
    candidates.find(value => typeof value === 'string' && value && !/^\/[oO]=/.test(value)) || ''
  );
}

function participant(name, email) {
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || '';
}

async function loadMsgReader() {
  // A CommonJS module whose default export is the class; the interop may
  // surface it at `default` or `default.default`.
  const mod = await import('@kenjiuno/msgreader');
  const MsgReader = [mod?.default?.default, mod?.default, mod].find(
    candidate => typeof candidate === 'function'
  );
  if (!MsgReader) throw new Error('msgreader is not available');
  return MsgReader;
}

async function loadDecompressRtf() {
  const mod = await import('@kenjiuno/decompressrtf');
  const fn = mod?.decompressRTF || mod?.default?.decompressRTF || mod?.default;
  if (typeof fn !== 'function') throw new Error('decompressrtf is not available');
  return fn;
}

/**
 * The text of a parsed Outlook message: the headers that matter, the
 * attachment names (their content is not followed, as with `.eml`), then the
 * body in the first form Outlook stored it in: plain text, HTML, or the
 * compressed RTF of an older client.
 *
 * @param {Object} data - What `MsgReader.getFileData()` returns.
 * @returns {Promise<string>}
 */
export async function msgContentOf(data) {
  if (!data || typeof data !== 'object') return '';
  const lines = [];
  const subject = typeof data.subject === 'string' ? data.subject.trim() : '';
  if (subject) lines.push(`Subject: ${subject}`);
  const from = participant(
    data.senderName,
    pickEmail(data.senderSmtpAddress, data.sentRepresentingSmtpAddress, data.senderEmail)
  );
  if (from) lines.push(`From: ${from}`);
  const recipients = Array.isArray(data.recipients) ? data.recipients : [];
  const group = type =>
    recipients
      .filter(entry => String(entry?.recipType || 'to').toLowerCase() === type)
      .map(entry => participant(entry.name, pickEmail(entry.smtpAddress, entry.email)))
      .filter(Boolean)
      .join(', ');
  const to = group('to');
  const cc = group('cc');
  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  const date = data.messageDeliveryTime || data.clientSubmitTime || data.creationTime;
  if (date) lines.push(`Date: ${date}`);
  const attachments = (Array.isArray(data.attachments) ? data.attachments : [])
    .map(entry => entry?.fileName || entry?.name)
    .filter(Boolean);
  if (attachments.length > 0) lines.push(`Attachments: ${attachments.join(', ')}`);

  let body = '';
  if (typeof data.body === 'string' && data.body.trim()) {
    body = data.body;
  } else if (typeof data.bodyHtml === 'string' && data.bodyHtml.trim()) {
    body = htmlText(data.bodyHtml);
  } else if (data.html) {
    const html =
      typeof data.html === 'string'
        ? data.html
        : decodeCodepage(data.html, data.internetCodepage, data.messageCodepage);
    body = htmlText(html);
  } else if (data.compressedRtf) {
    try {
      const decompressRTF = await loadDecompressRtf();
      const rtfBytes = Uint8Array.from(decompressRTF(Array.from(data.compressedRtf)));
      body = rtfToText(decodeCodepage(rtfBytes, data.messageCodepage));
    } catch {
      body = '';
    }
  }
  return [lines.join('\n'), body.trim()].filter(Boolean).join('\n\n').trim();
}

/** An Outlook message file as text. */
async function msgText(bytes) {
  const MsgReader = await loadMsgReader();
  const reader = new MsgReader(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  const data = reader.getFileData();
  if (!data || data.error) {
    throw new ExtractionError(
      'EXTRACTION_FAILED',
      `The file is not a readable Outlook message (${data?.error || 'no message data'})`
    );
  }
  return msgContentOf(data);
}

async function extractXlsx(bytes, { report, sheetRows } = {}) {
  await assertSafePackage(bytes);
  const XLSX = await import('xlsx');
  const lib = XLSX.default || XLSX;
  let workbook;
  try {
    workbook = lib.read(bytes, { type: 'buffer', cellDates: true });
  } catch (error) {
    throw new DocumentExtractionError(`not a readable Excel workbook (${error.message})`);
  }
  return extractXlsxText({
    XLSX: lib,
    workbook,
    limits: sheetRows ? { sheetRows } : {},
    report
  });
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
 * `truncated` is true when anything of the file is missing from the text:
 * cut at `maxChars` here, or left out by the extractor on a limit of its own
 * (PDF pages past `maxPages`, spreadsheet rows past `sheetRows` or past the
 * workbook's character budget).
 *
 * @param {{bytes: Buffer, contentType?: string, name?: string}} file
 * @param {{maxChars?: number, maxPages?: number, sheetRows?: number}} [options]
 *   The limits; `maxPages` and `sheetRows` default to the extractors' own.
 * @returns {Promise<{text: string, contentType: string, pages?: number, truncated: boolean}>}
 * @throws {ExtractionError} `UNSUPPORTED_TYPE`, `EXTRACTION_FAILED`, `NO_TEXT`
 */
export async function extractText(
  { bytes, contentType, name },
  { maxChars = MAX_TEXT_CHARS, maxPages = MAX_PDF_PAGES, sheetRows } = {}
) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ExtractionError('NO_TEXT', `${name || 'The file'} is empty`);
  }
  const type = await resolveContentType(bytes, { contentType, name });
  const report = { truncated: false };
  let raw;
  let pages;
  try {
    if (type === PDF_MIME) {
      // A PDF that stops at `maxChars + 1` is cut below, by `normalizeText`.
      raw = await extractPdfDocument(bytes, { maxPages, maxChars: maxChars + 1, report });
      pages = countPages(raw);
    } else if (PACKAGES.has(type)) {
      raw = await PACKAGES.get(type).extract(bytes, { report, sheetRows });
    } else if (type === HTML_MIME) {
      raw = htmlText(decodeText(bytes, name));
    } else if (type === EML_MIME) {
      raw = emailText(bytes);
    } else if (type === MSG_MIME) {
      raw = await msgText(bytes);
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
  const normalized = normalizeText(raw, { maxChars });
  const { text } = normalized;
  const truncated = normalized.truncated || report.truncated === true;
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
