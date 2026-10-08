/**
 * Minimal OpenDocument packages from raw XML for the document extraction tests (the jest helper
 * `tests/utils/officeFixtures.js` is the same idea for the browser side). No binaries are
 * committed.
 */
import JSZip from 'jszip';

export const ODF_MIME = {
  text: 'application/vnd.oasis.opendocument.text',
  spreadsheet: 'application/vnd.oasis.opendocument.spreadsheet',
  presentation: 'application/vnd.oasis.opendocument.presentation'
};

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink"';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';

/** A paragraph. */
export const p = text => `<text:p>${text}</text:p>`;

/**
 * @param {'text'|'spreadsheet'|'presentation'} type
 * @param {string} body - Content of `office:text` / `office:spreadsheet` / `office:presentation`
 * @param {string} [automatic] - Automatic styles of content.xml
 * @returns {Promise<Buffer>}
 */
export async function buildOdf(type, body, automatic = '') {
  const zip = new JSZip();
  zip.file('mimetype', ODF_MIME[type], { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"/>`
  );
  zip.file(
    'content.xml',
    `${XML}<office:document-content ${NS} office:version="1.2">` +
      `<office:automatic-styles>${automatic}</office:automatic-styles>` +
      `<office:body><office:${type}>${body}</office:${type}></office:body></office:document-content>`
  );
  zip.file(
    'styles.xml',
    `${XML}<office:document-styles ${NS} office:version="1.2"><office:styles/></office:document-styles>`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
