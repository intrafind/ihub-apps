/**
 * DOCX → Markdown with the structure Word stores: headings (also custom styles and outline
 * levels), lists, tables, footnotes, links, page breaks.
 *
 * Pure orchestration over injected libraries so the module stays dependency-free and runs in
 * the browser, in jest and (release 2) in the server's inference API:
 * JSZip unpacks the package, an OOXML pass fixes what mammoth drops, mammoth converts to HTML,
 * Turndown to Markdown.
 *
 * @module shared/documentExtraction/docx
 */
import { createWordXml, parseXml, wordNamespaceOf } from './ooxml/xml.js';
import { readRelationships, relationshipTargets } from './ooxml/package.js';
import { readStyles } from './ooxml/styles.js';
import { createNumbering } from './ooxml/numbering.js';
import { addOutlineStyles, normalizeDocumentXml } from './ooxml/normalize.js';
import { readHeaderFooterText } from './ooxml/headerFooter.js';
import { normalizeReviewOptions, readComments } from './ooxml/review.js';
import { FOOTER_PREFIX, HEADER_PREFIX } from './markers.js';
import { createDocumentMarkdownConverter, htmlToMarkdown, normalizeMarkdown } from './markdown.js';

const DEFAULT_DOCUMENT_PART = 'word/document.xml';

/**
 * @param {Object} args
 * @param {ArrayBuffer} args.arrayBuffer - The .docx file
 * @param {Function} args.JSZip - JSZip constructor
 * @param {Object} args.mammoth - mammoth (browser build)
 * @param {Function} args.TurndownService - Turndown constructor
 * @param {typeof DOMParser} args.DOMParser
 * @param {typeof XMLSerializer} args.XMLSerializer
 * @param {'accepted'|'markup'} [args.trackedChanges] - `markup` writes insertions and deletions as
 *   `{++added++}` / `{--removed--}`; the default is the accepted view
 * @param {'ignore'|'inline'} [args.comments] - `inline` writes comments as `{>>Author: text<<}`
 *   after the text they belong to; the default leaves them out
 * @returns {Promise<string>} Markdown
 * @throws When the package cannot be read — the caller falls back to the legacy extraction
 */
export async function extractDocxMarkdown({
  arrayBuffer,
  JSZip,
  mammoth,
  TurndownService,
  DOMParser: DOMParserCtor,
  XMLSerializer: XMLSerializerCtor,
  trackedChanges,
  comments
}) {
  const reviewOptions = normalizeReviewOptions({ trackedChanges, comments });
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Part names come from the relationships; word/document.xml etc. are only the default.
  const [mainTarget] = Object.values(
    await relationshipTargets(zip, DOMParserCtor, '', ['/officeDocument'])
  );
  const documentPart = mainTarget || DEFAULT_DOCUMENT_PART;
  const documentRelationships = await readRelationships(zip, DOMParserCtor, documentPart);
  const related = {};
  for (const rel of documentRelationships) {
    for (const suffix of ['/styles', '/numbering', '/settings', '/comments']) {
      if (rel.type.endsWith(suffix)) related[suffix] = rel.target;
    }
  }
  const stylesPart = related['/styles'] || 'word/styles.xml';
  const numberingPart = related['/numbering'] || 'word/numbering.xml';

  const readPart = async name => {
    const file = zip.file(name);
    return file ? parseXml(DOMParserCtor, await file.async('string')) : null;
  };
  const documentDoc = await readPart(documentPart);
  if (!documentDoc) throw new Error(`${documentPart} is missing`);
  const stylesDoc = await readPart(stylesPart);
  const numberingDoc = await readPart(numberingPart);

  const xml = createWordXml(wordNamespaceOf(documentDoc));
  const styles = readStyles(stylesDoc, xml);
  const numbering = createNumbering(numberingDoc, styles, xml);

  // Headers and footers are read from the document as Word shows it — before the body pass
  // touches it — but a failure here only costs them, never the body.
  let headerFooter = { header: [], footer: [] };
  try {
    const settingsDoc = related['/settings'] ? await readPart(related['/settings']) : null;
    headerFooter = await readHeaderFooterText({
      documentDoc,
      xml,
      relationships: new Map(documentRelationships.map(rel => [rel.id, rel])),
      readPart,
      styles,
      evenAndOddHeaders:
        xml.toggle(xml.kid(settingsDoc?.documentElement, 'evenAndOddHeaders')) === true
    });
  } catch {
    // Malformed or unexpected header part: continue without headers and footers.
  }

  // Comments are opt-in; a comments part that cannot be read costs the comments only.
  let commentTexts = null;
  if (reviewOptions.comments === 'inline') {
    try {
      const commentsDoc = related['/comments'] ? await readPart(related['/comments']) : null;
      commentTexts = commentsDoc ? readComments(commentsDoc, xml) : new Map();
    } catch {
      commentTexts = new Map();
    }
  }

  const { outlineLevels } = normalizeDocumentXml(documentDoc, {
    xml,
    styles,
    numbering,
    canAddOutlineStyles: !!stylesDoc,
    review: { trackedChanges: reviewOptions.trackedChanges, comments: commentTexts }
  });
  if (stylesDoc && outlineLevels.size > 0) addOutlineStyles(stylesDoc, xml, outlineLevels);

  const serializer = new XMLSerializerCtor();
  zip.file(documentPart, serializer.serializeToString(documentDoc));
  if (stylesDoc && outlineLevels.size > 0) {
    zip.file(stylesPart, serializer.serializeToString(stylesDoc));
  }
  const normalized = await zip.generateAsync({ type: 'arraybuffer' });

  // Images become alt text only: skip decoding them and never embed base64 in the prompt.
  const images = mammoth.images || mammoth.default?.images;
  const convertToHtml = mammoth.convertToHtml || mammoth.default?.convertToHtml;
  const result = await convertToHtml(
    { arrayBuffer: normalized },
    images ? { convertImage: images.imgElement(async () => ({ src: '' })) } : {}
  );

  const converter = createDocumentMarkdownConverter(TurndownService);
  const body = htmlToMarkdown(converter, result.value, DOMParserCtor);
  const preamble = [
    ...headerFooter.header.map(line => `${HEADER_PREFIX} ${line}`),
    ...headerFooter.footer.map(line => `${FOOTER_PREFIX} ${line}`)
  ].join('\n');
  return normalizeMarkdown(preamble ? `${preamble}\n\n${body}` : body);
}
