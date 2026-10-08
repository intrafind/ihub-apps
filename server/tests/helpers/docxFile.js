/**
 * Minimal DOCX packages from raw WordprocessingML for the document extraction tests (the jest
 * helper `tests/utils/officeFixtures.js` is the same idea for the browser side). No binaries
 * are committed: every part that matters is written by the test.
 */
import JSZip from 'jszip';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A paragraph; `ppr` is raw inner XML of w:pPr. */
export const p = (text, ppr = '') =>
  `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

export const lvl = (ilvl, numFmt, lvlText) =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/><w:lvlText w:val="${lvlText}"/></w:lvl>`;

/** Heading 1 numbered `1.` through a numbering definition (style id `Heading1`). */
export const NUMBERED_HEADINGS = {
  styles:
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
    '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>',
  numbering:
    `<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}</w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
};

/**
 * @param {Object} spec
 * @param {string} spec.body - w:body content
 * @param {string} [spec.styles] - w:style elements
 * @param {string} [spec.numbering] - w:abstractNum / w:num elements
 * @param {Object<string,string>} [spec.parts] - further parts, `{ 'word/header1.xml': '<…>' }`
 * @param {string} [spec.rels] - relationship entries of word/_rels/document.xml.rels
 * @param {string} [spec.contentTypes] - content type entries for the extra parts
 * @returns {Promise<Buffer>}
 */
export async function buildDocx({
  body,
  styles = '',
  numbering = '',
  parts = {},
  rels = '',
  contentTypes = ''
}) {
  const ns = `xmlns:w="${W}" xmlns:r="${R}"`;
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      `${contentTypes}</Types>`
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rIdN" Type="${R}/numbering" Target="numbering.xml"/>${rels}</Relationships>`
  );
  zip.file('word/styles.xml', `${XML}<w:styles ${ns}>${styles}</w:styles>`);
  zip.file('word/numbering.xml', `${XML}<w:numbering ${ns}>${numbering}</w:numbering>`);
  zip.file('word/document.xml', `${XML}<w:document ${ns}><w:body>${body}</w:body></w:document>`);
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A request `file_data` value for a document. */
export const dataUrl = (bytes, mime = DOCX_MIME) =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
