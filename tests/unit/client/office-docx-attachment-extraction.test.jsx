/**
 * An Outlook attachment goes through the same extraction as an upload
 * (concepts/document-extraction/, T-DOWN-03): the add-in must not be left with the
 * unstructured text of before.
 */
import '@testing-library/jest-dom';

jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} })),
  fetchPlatformConfig: jest.fn(async () => ({ features: [] }))
}));

const { processDocumentFile } = require('../../../client/src/features/upload/utils/fileProcessing');
const {
  buildFileDataFromMailAttachments
} = require('../../../client/src/features/office/utilities/buildChatApiMessages');
const { DOCX_MIME, buildDocxFile, p } = require('../../utils/officeFixtures');

// jsdom's File has no arrayBuffer(), and the buffer a FileReader hands out belongs to another
// realm, which JSZip does not recognize: copy it into a buffer of this realm.
beforeAll(() => {
  if (typeof File.prototype.arrayBuffer !== 'function') {
    File.prototype.arrayBuffer = function arrayBuffer() {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const copy = new ArrayBuffer(reader.result.byteLength);
          new Uint8Array(copy).set(new Uint8Array(reader.result));
          resolve(copy);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(this);
      });
    };
  }
});

describe('Outlook add-in attachments', () => {
  it('T-DOWN-03: a Word attachment is extracted like the same file uploaded in the chat', async () => {
    const spec = {
      styles:
        '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style>',
      body:
        p('Vertrag', '<w:pStyle w:val="berschrift1"/>') + p('Erster Absatz') + p('Zweiter Absatz')
    };
    const file = await buildDocxFile(spec, 'vertrag.docx');
    const uploaded = (await processDocumentFile(file)).content;
    expect(uploaded).toBe('# Vertrag\n\nErster Absatz\n\nZweiter Absatz');

    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
    const entries = await buildFileDataFromMailAttachments([
      {
        name: 'vertrag.docx',
        contentType: DOCX_MIME,
        size: 1,
        isInline: false,
        content: { format: 'base64', content: base64 }
      }
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ origin: 'attachment', fileName: 'vertrag.docx' });
    expect(entries[0].content).toBe(uploaded);
  });
});
