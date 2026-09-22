// The module reaches the Axios client through the document API; the filename
// helper itself touches neither.
jest.mock('../../../client/src/api/endpoints/documents', () => ({
  __esModule: true,
  fetchIFinderDocument: jest.fn()
}));

const {
  resolveCitationFilename
} = require('../../../client/src/features/chat/utils/citationDocuments');

/**
 * What a downloaded or attached citation document is called.
 *
 * The name matters more since documents can be attached to a mail: Outlook
 * picks the attachment's icon — and Windows the application that opens it —
 * from the extension alone, so a name iFinder sent without one would arrive as
 * a file the recipient cannot open.
 */

const response = (headers = {}) => ({ headers });
const item = meta => ({ additional_document_metadata: meta });
const access = { documentId: 'ifinder-1' };

describe('resolveCitationFilename', () => {
  test('prefers the name the server sent, then the document name, then the id', () => {
    expect(
      resolveCitationFilename(
        item({ 'file.name': ['doc.pdf'] }),
        response({ 'content-disposition': 'attachment; filename="server.pdf"' }),
        access
      )
    ).toBe('server.pdf');

    expect(resolveCitationFilename(item({ 'file.name': ['doc.pdf'] }), response(), access)).toBe(
      'doc.pdf'
    );

    expect(resolveCitationFilename(item({}), response(), access)).toBe('ifinder-1');
  });

  test('adds the extension for the content type when the name has none', () => {
    expect(
      resolveCitationFilename(
        item({ 'file.name': ['Quarterly report'] }),
        response({ 'content-type': 'application/pdf' }),
        access
      )
    ).toBe('Quarterly report.pdf');

    expect(
      resolveCitationFilename(
        item({ 'file.name': ['Notes'] }),
        response({ 'content-type': 'text/plain; charset=utf-8' }),
        access
      )
    ).toBe('Notes.txt');
  });

  test('leaves a name alone when it already has one, and when the type is unknown', () => {
    expect(
      resolveCitationFilename(
        item({ 'file.name': ['report.docx'] }),
        response({ 'content-type': 'application/pdf' }),
        access
      )
    ).toBe('report.docx');

    expect(
      resolveCitationFilename(
        item({ 'file.name': ['Mystery'] }),
        response({ 'content-type': 'application/x-weird' }),
        access
      )
    ).toBe('Mystery');
  });

  test('strips path separators and the characters Windows rejects', () => {
    expect(
      resolveCitationFilename(
        item({}),
        response({ 'content-disposition': 'attachment; filename="../../etc/passwd"' }),
        access
      )
    ).toBe('.._.._etc_passwd');

    expect(
      resolveCitationFilename(
        item({}),
        response({ 'content-disposition': 'attachment; filename="a:b*c?.txt"' }),
        access
      )
    ).toBe('a_b_c_.txt');
  });
});
