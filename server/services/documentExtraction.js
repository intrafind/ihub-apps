// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Server adapter of the shared document extraction (concepts/document-extraction/, release 2,
 * WP-E).
 *
 * The browser turns uploaded Office and PDF files into text before it sends them; an API caller
 * sends the file itself, so the server does the same — with the same code
 * (`shared/documentExtraction/`), so a file reads the same through the API as through the chat:
 * Markdown with headings, numbers and tables, `[Page N]` markers. The shared modules take their
 * libraries as arguments; this file supplies the Node ones (jszip, mammoth, turndown, domino and
 * xmldom for the DOM, pdf.js' legacy build) and loads them on first use, so the server starts without them.
 *
 * A file from a stranger is not a file from the user's own browser: an Office file is a zip, and a
 * zip that unpacks to gigabytes must never reach the code that unpacks it. {@link
 * assertSafePackage} measures every entry first, with a decompression that stops at the limit.
 *
 * @module services/documentExtraction
 */
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { extractDocxMarkdown } from '../../shared/documentExtraction/docx.js';
import { extractOdfText } from '../../shared/documentExtraction/odf.js';
import { extractPdfText } from '../../shared/documentExtraction/pdfText.js';
import { extractPptxText } from '../../shared/documentExtraction/pptx.js';
import { isFeatureEnabled } from '../featureRegistry.js';
import configCache from '../configCache.js';

const inflateRawAsync = promisify(inflateRaw);

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const ODT_MIME = 'application/vnd.oasis.opendocument.text';
export const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
export const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';

/** PDF pages read from one file. */
export const MAX_PDF_PAGES = 500;

/** Limits of an Office package (a zip): parts, one part unpacked, all parts unpacked. */
export const PACKAGE_LIMITS = {
  entries: 5000,
  partBytes: 30 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024
};

/** The file cannot be read as the document it claims to be (the caller reports it as invalid). */
export class DocumentExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

/** Whether the admin switch "Structured document extraction" is on (it is by default). */
export function structuredExtractionEnabled() {
  return isFeatureEnabled('structuredDocumentExtraction', configCache.getFeatures());
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * Checks the zip package of an Office document against {@link PACKAGE_LIMITS} before anything
 * unpacks it. Every entry is inflated once with an output limit equal to its declared size — a
 * header that understates the size is caught here, not after gigabytes were allocated — and the
 * result is thrown away. Reading is asynchronous (zlib's thread pool), so a large package does
 * not block the server.
 *
 * The entries checked are the ones the unpacking library will read. JSZip walks every
 * consecutive central-directory header (it does not stop at the count of the end record) and
 * shifts all offsets when data was put in front of the zip, so the directory must end exactly
 * where the end record starts and its headers must add up to the declared count: a package
 * where the two views could differ is refused.
 *
 * Not supported, hence refused: zip64, encrypted entries, compression other than stored and
 * deflate, data around the directory. Word, PowerPoint and LibreOffice write none of them.
 *
 * @param {Buffer} bytes
 * @param {typeof PACKAGE_LIMITS} [limits]
 * @throws {DocumentExtractionError}
 */
export async function assertSafePackage(bytes, limits = PACKAGE_LIMITS) {
  const fail = reason => {
    throw new DocumentExtractionError(`not a safe Office document (${reason})`);
  };
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end < 0) fail('no zip directory');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    fail('zip64 is not supported');
  }
  if (count > limits.entries) fail(`${count} parts`);
  if (directoryOffset + directorySize !== end) fail('unexpected data around the zip directory');

  let total = 0;
  let at = directoryOffset;
  let seen = 0;
  while (at < end) {
    // The walk is bounded by the directory, not by the count the file claims.
    seen += 1;
    if (seen > limits.entries) fail(`more than ${limits.entries} parts`);
    if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      fail('damaged zip directory');
    }
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const declared = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 1) fail('encrypted part');
    if (declared > limits.partBytes) fail('a part is too large');
    total += declared;
    if (total > limits.totalBytes) fail('the package is too large when unpacked');

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      fail('damaged zip entry');
    }
    const dataStart =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    if (dataStart + compressed > bytes.length) fail('truncated zip entry');
    const data = bytes.subarray(dataStart, dataStart + compressed);

    if (method === 0) {
      if (compressed !== declared) fail('inconsistent part size');
    } else if (method === 8) {
      let unpacked;
      try {
        unpacked = await inflateRawAsync(data, { maxOutputLength: Math.max(declared, 1) });
      } catch {
        fail('a part is damaged or larger than it says');
      }
      if (unpacked.length !== declared) fail('inconsistent part size');
    } else {
      fail('unsupported compression');
    }
  }
  if (at !== end || seen !== count) fail('damaged zip directory');
}

/**
 * Characters XML 1.0 forbids (C0 controls other than tab, LF, CR; U+FFFE, U+FFFF). xmldom reads
 * them silently; a strict parser (jsdom's, which this replaced) refuses the document.
 */

const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/**
 * `DOMParser` and `XMLSerializer` for the package parts (namespace-aware XML) of Word, PowerPoint
 * and OpenDocument files, from `@xmldom/xmldom`.
 *
 * xmldom is lenient where a conforming XML parser is not, so this wrapper restores the strictness
 * the extraction relied on: every non-warning parse error is thrown (a part with an undefined
 * entity, content after the root element, a tag mismatch is refused, as before), characters XML
 * forbids are refused, and a leading byte order mark is skipped. A refused part reaches the
 * caller as the same `Error('Malformed XML part')` `parseXml` raises for a `parsererror`
 * document. xmldom reads no external entity or DTD and makes no request; it does not expand
 * entities declared in a DOCTYPE either (that is reported as an error and refused).
 *
 * @param {{DOMParser: Function, XMLSerializer: Function}} xmldom
 */
export function strictXmlDom({ DOMParser: XmldomParser, XMLSerializer }) {
  const options = {
    onError(level, message) {
      if (level !== 'warning') throw new Error(message);
    }
  };
  class StrictDOMParser {
    parseFromString(text, type) {
      const source = String(text).replace(/^\uFEFF/, '');
      if (ILLEGAL_XML_CHARS.test(source)) throw new Error('Malformed XML part');
      try {
        return new XmldomParser(options).parseFromString(source, type);
      } catch {
        throw new Error('Malformed XML part');
      }
    }
  }
  return { DOMParser: StrictDOMParser, XMLSerializer };
}

/**
 * A `DOMParser` for the Word path that sends each kind of text to the parser built for it: HTML
 * (mammoth's output, only to be fed to Turndown) to domino, which Turndown itself ships; XML (the
 * package parts, namespace-aware) to {@link strictXmlDom}. Neither runs scripts, loads resources
 * or opens a connection, so user-supplied markup cannot cause an outbound request.
 *
 * @param {Function} XmlDOMParser
 * @param {{createDocument: Function}} domino
 */
function splitDomParser(XmlDOMParser, domino) {
  return class SplitDOMParser {
    parseFromString(text, type) {
      if (type === 'text/html') return domino.createDocument(String(text));
      return new XmlDOMParser().parseFromString(text, type);
    }
  };
}

let xmlDom;
async function loadXmlDom() {
  xmlDom ??= strictXmlDom(await import('@xmldom/xmldom'));
  return xmlDom;
}

/**
 * A Word document as Markdown.
 *
 * @param {Buffer} bytes
 * @param {{trackedChanges?: string, comments?: string}} [options] - Review marks; off by default
 * @returns {Promise<string>}
 * @throws {DocumentExtractionError} When the file is not a Word document or is not safe to read
 */
export async function extractDocxDocument(bytes, options = {}) {
  await assertSafePackage(bytes);
  const [{ default: JSZip }, { default: mammoth }, { default: TurndownService }, xml, domino] =
    await Promise.all([
      import('jszip'),
      import('mammoth'),
      import('turndown'),
      loadXmlDom(),
      import('@mixmark-io/domino')
    ]);
  // The shared code uses mammoth's browser interface (`{ arrayBuffer }`).
  const nodeMammoth = {
    images: mammoth.images,
    convertToHtml: (input, convertOptions) =>
      mammoth.convertToHtml({ buffer: Buffer.from(input.arrayBuffer) }, convertOptions)
  };
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    return await extractDocxMarkdown({
      arrayBuffer,
      JSZip,
      mammoth: nodeMammoth,
      TurndownService,
      DOMParser: splitDomParser(xml.DOMParser, domino.default ?? domino),
      XMLSerializer: xml.XMLSerializer,
      trackedChanges: options.trackedChanges,
      comments: options.comments
    });
  } catch (error) {
    throw new DocumentExtractionError(`not a readable Word document (${error.message})`);
  }
}

/**
 * A PowerPoint deck as text: slides in the order of the presentation, titles as headings, tables
 * as Markdown, hidden slides flagged. Speaker notes only when asked for.
 *
 * @param {Buffer} bytes
 * @param {{speakerNotes?: string}} [options]
 * @returns {Promise<string>}
 * @throws {DocumentExtractionError} When the file is not a deck or is not safe to read
 */
export async function extractPptxDocument(bytes, options = {}) {
  await assertSafePackage(bytes);
  const [{ default: JSZip }, xml] = await Promise.all([import('jszip'), loadXmlDom()]);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    return await extractPptxText({
      arrayBuffer,
      JSZip,
      DOMParser: xml.DOMParser,
      speakerNotes: options.speakerNotes
    });
  } catch (error) {
    throw new DocumentExtractionError(`not a readable PowerPoint document (${error.message})`);
  }
}

/**
 * An OpenDocument file (.odt, .ods, .odp) as text: Markdown for a text, tables for a
 * spreadsheet, slides for a presentation. The kind is read from the document, not from the type
 * the caller claimed. Speaker notes only when asked for.
 *
 * @param {Buffer} bytes
 * @param {{speakerNotes?: string, report?: {truncated?: boolean}}} [options] - `report.truncated`
 *   is set when a spreadsheet's rows or sheets were left out on the size limits
 * @returns {Promise<string>}
 * @throws {DocumentExtractionError} When the file is not an OpenDocument file or is not safe to read
 */
export async function extractOdfDocument(bytes, options = {}) {
  await assertSafePackage(bytes);
  const [{ default: JSZip }, xml] = await Promise.all([import('jszip'), loadXmlDom()]);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    return await extractOdfText({
      arrayBuffer,
      JSZip,
      DOMParser: xml.DOMParser,
      speakerNotes: options.speakerNotes,
      report: options.report
    });
  } catch (error) {
    throw new DocumentExtractionError(`not a readable OpenDocument file (${error.message})`);
  }
}

/**
 * The text of a PDF: `[Page N]` markers, lines, and headings and tables where the PDF marks
 * them. Empty when no page has a text layer (a scan).
 *
 * @param {Buffer} bytes
 * @param {{maxPages?: number, maxChars?: number, report?: {truncated?: boolean, title?: string}}} [limits]
 *   `report.truncated` is set when the PDF has more pages than `maxPages`; `report.title` to the
 *   document's metadata title, when it has one.
 * @returns {Promise<string>}
 */
export async function extractPdfDocument(
  bytes,
  { maxPages = MAX_PDF_PAGES, maxChars, report } = {}
) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  if (report && pdf.numPages > maxPages) report.truncated = true;
  try {
    if (report) {
      // The document's own title, when its author set one: what a project
      // lists the document as (#3539). A PDF without metadata has none.
      try {
        const title = (await pdf.getMetadata())?.info?.Title;
        if (typeof title === 'string' && title.trim()) report.title = title.trim();
      } catch {
        // Metadata is optional; the text is what matters.
      }
    }
    return await extractPdfText(pdf, { maxPages, maxChars });
  } finally {
    await pdf.destroy?.();
  }
}
