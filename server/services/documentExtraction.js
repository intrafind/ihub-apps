/**
 * Server adapter of the shared document extraction (concepts/document-extraction/, release 2,
 * WP-E).
 *
 * The browser turns uploaded Word and PDF files into text before it sends them; an API caller
 * sends the file itself, so the server does the same — with the same code
 * (`shared/documentExtraction/`), so a file reads the same through the API as through the chat:
 * Markdown with headings, numbers and tables, `[Page N]` markers. The shared modules take their
 * libraries as arguments; this file supplies the Node ones (jszip, mammoth, turndown, jsdom's
 * DOM, pdf.js' legacy build) and loads them on first use, so the server starts without them.
 *
 * A file from a stranger is not a file from the user's own browser: a Word file is a zip, and a
 * zip that unpacks to gigabytes must never reach the code that unpacks it. {@link
 * assertSafePackage} measures every entry first, with a decompression that stops at the limit.
 *
 * @module services/documentExtraction
 */
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { extractDocxMarkdown } from '../../shared/documentExtraction/docx.js';
import { extractPdfText } from '../../shared/documentExtraction/pdfText.js';
import { extractPptxText } from '../../shared/documentExtraction/pptx.js';
import { isFeatureEnabled } from '../featureRegistry.js';
import configCache from '../configCache.js';

const inflateRawAsync = promisify(inflateRaw);

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** PDF pages read from one file. */
export const MAX_PDF_PAGES = 500;

/** Limits of a Word package (a zip): parts, one part unpacked, all parts unpacked. */
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

let domWindow;
async function loadDom() {
  if (!domWindow) {
    const { JSDOM } = await import('jsdom');
    // Only DOMParser and XMLSerializer are used, statelessly: one window serves every request.
    domWindow = new JSDOM('').window;
  }
  return domWindow;
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
  const [{ default: JSZip }, { default: mammoth }, { default: TurndownService }, window] =
    await Promise.all([import('jszip'), import('mammoth'), import('turndown'), loadDom()]);
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
      DOMParser: window.DOMParser,
      XMLSerializer: window.XMLSerializer,
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
  const [{ default: JSZip }, window] = await Promise.all([import('jszip'), loadDom()]);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    return await extractPptxText({
      arrayBuffer,
      JSZip,
      DOMParser: window.DOMParser,
      speakerNotes: options.speakerNotes
    });
  } catch (error) {
    throw new DocumentExtractionError(`not a readable PowerPoint document (${error.message})`);
  }
}

/**
 * The text of a PDF: `[Page N]` markers, lines, and headings and tables where the PDF marks
 * them. Empty when no page has a text layer (a scan).
 *
 * @param {Buffer} bytes
 * @param {{maxPages?: number, maxChars?: number}} [limits]
 * @returns {Promise<string>}
 */
export async function extractPdfDocument(bytes, { maxPages = MAX_PDF_PAGES, maxChars } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  try {
    return await extractPdfText(pdf, { maxPages, maxChars });
  } finally {
    await pdf.destroy?.();
  }
}
