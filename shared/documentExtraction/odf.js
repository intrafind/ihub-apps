/**
 * OpenDocument files (.odt, .ods, .odp) → text with the structure of the document. The kind of
 * document is read from the body of content.xml, not from the file name: a text becomes
 * Markdown, a spreadsheet and a presentation the same text as their Microsoft counterparts.
 *
 * Pure orchestration over injected libraries (JSZip, DOMParser), like the Office extractors.
 *
 * @module shared/documentExtraction/odf
 */
import { parseXml } from './ooxml/xml.js';
import { renderSheets } from './sheets.js';
import { odsSheets } from './odf/sheet.js';
import { odpText } from './odf/slides.js';
import { createOdfReader } from './odf/writer.js';
import { kid } from './odf/xml.js';

/**
 * @param {Object} args
 * @param {ArrayBuffer} args.arrayBuffer - The OpenDocument file
 * @param {Function} args.JSZip - JSZip constructor
 * @param {typeof DOMParser} args.DOMParser
 * @param {'ignore'|'include'} [args.speakerNotes] - Presentations: `include` adds the notes of a
 *   slide as `[Notes]`
 * @param {{sheetRows?: number, workbookChars?: number}} [args.limits] - Spreadsheets
 * @returns {Promise<string>} The text; '' when the document has none
 * @throws When the package is not an OpenDocument file — the caller falls back to the plain text
 */
export async function extractOdfText({
  arrayBuffer,
  JSZip,
  DOMParser: DOMParserCtor,
  speakerNotes = 'ignore',
  limits
}) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const readPart = async name => {
    const file = zip.file(name);
    return file ? parseXml(DOMParserCtor, await file.async('string')) : null;
  };
  const contentDoc = await readPart('content.xml');
  if (!contentDoc) throw new Error('content.xml is missing');
  // styles.xml carries the named styles; the content is still readable without it.
  let stylesDoc = null;
  try {
    stylesDoc = await readPart('styles.xml');
  } catch {
    stylesDoc = null;
  }

  const body = kid(contentDoc.documentElement, 'office', 'body');
  const reader = createOdfReader({ contentDoc, stylesDoc });
  if (kid(body, 'office', 'text')) return reader.documentMarkdown();
  const spreadsheet = kid(body, 'office', 'spreadsheet');
  if (spreadsheet) {
    return renderSheets(odsSheets({ spreadsheet, reader, styles: reader.styles, limits }), limits);
  }
  const presentation = kid(body, 'office', 'presentation');
  if (presentation) {
    return odpText({ presentation, reader, styles: reader.styles, speakerNotes });
  }
  throw new Error('not an OpenDocument text, spreadsheet or presentation');
}
