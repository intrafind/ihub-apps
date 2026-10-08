import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { buildDocument, MAX_PAGES } from './buildDocument.js';
import { loadFontBytes, pdfmakeFontDescriptors } from './fonts.js';
import { svgImageCallback } from './validators.js';

/**
 * Render a document spec to PDF bytes, in the current thread.
 *
 * Callers normally go through `PdfService.createPdf`, which runs this in a
 * worker thread with a timeout. This module is what the worker executes, and
 * what tests call directly.
 *
 * Each render gets its own pdfmake printer and virtual file system holding
 * the font bytes. The access policies deny every local path and every URL:
 * a document can only use what it carries inline.
 */

const require = createRequire(import.meta.url);
const Printer = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const PdfmakeDocument = require('pdfmake/js/PDFDocument.js').default;
const sharedVirtualFs = require('pdfmake/js/virtual-fs.js').default;

const denyAll = () => false;

// SVG text asks pdfmake for a font and hands the *file name* it gets back to
// pdfkit's `font()`, which would open it from disk. The fonts only exist in
// the virtual file system, so a name found there is registered from it
// first; SVG text then uses the document's fonts and never touches the disk.
if (!PdfmakeDocument.prototype.ihubVirtualFonts) {
  const openFont = PdfmakeDocument.prototype.font;
  PdfmakeDocument.prototype.font = function font(src, family, size) {
    if (
      typeof src === 'string' &&
      !this._registeredFonts?.[src] &&
      this.virtualfs?.existsSync(src)
    ) {
      this.registerFont(src, this.virtualfs.readFileSync(src));
    }
    return openFont.call(this, src, family, size);
  };
  PdfmakeDocument.prototype.ihubVirtualFonts = true;
}

function createVirtualFs() {
  // pdfmake exports its virtual file system as a shared instance; a fresh
  // one per render keeps documents from seeing each other's files.
  const vfs = new sharedVirtualFs.constructor();
  for (const [name, bytes] of loadFontBytes()) vfs.writeFileSync(name, bytes);
  return vfs;
}

function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * Render a pdfmake document definition.
 *
 * @param {Object} docDefinition
 * @param {Object} [tableLayouts] - Named table layouts.
 * @returns {Promise<Buffer>}
 */
export async function renderDocDefinition(docDefinition, tableLayouts = {}) {
  const vfs = createVirtualFs();
  const urlResolver = new URLResolver(vfs);
  urlResolver.setUrlAccessPolicy(denyAll);
  const printer = new Printer(pdfmakeFontDescriptors(), vfs, urlResolver, denyAll);
  // The definition must not reach files through its own keys either.
  delete docDefinition.attachments;
  delete docDefinition.files;
  delete docDefinition.patterns;
  const doc = await printer.createPdfKitDocument(docDefinition, { tableLayouts });
  return streamToBuffer(doc);
}

/**
 * Build and render a document spec.
 *
 * @param {import('./buildDocument.js').PdfSpec} spec
 * @returns {Promise<{ buffer: Buffer, pages: number, warnings: string[] }>}
 */
export async function renderPdfSpec(spec) {
  const { docDefinition, tableLayouts, warnings, pageInfo } = buildDocument(spec, {
    svgImageCallback
  });
  const buffer = await renderDocDefinition(docDefinition, tableLayouts);
  // Read the result back: a file that does not parse is an error, not a
  // download (the equivalent of the Python skill's "parser load" gate).
  const parsed = await PDFDocument.load(buffer, { updateMetadata: false });
  const pages = parsed.getPageCount();
  if (pageInfo.total > MAX_PAGES) {
    warnings.push(
      `The document had ${pageInfo.total} pages; only the first ${MAX_PAGES} were kept. Split it into several documents.`
    );
  }
  return { buffer, pages, warnings };
}
