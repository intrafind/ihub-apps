/**
 * What an attachment chip says about the file and what it lets the user take out again.
 *
 * A document that came from a cloud storage or an integration (iFinder) is not on the user's disk,
 * so its chip offers the original and the extracted text as downloads, and every document, image
 * and audio chip says what the assistant gets from it: the text extracted, the page images of a
 * scan, the size an image is sent in. A local file is the user's own already: no downloads.
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
    }
  })
}));
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const AttachedFilesList =
  require('../../../client/src/features/upload/components/AttachedFilesList').default;
const {
  describeAttachment,
  downloadableFile,
  downloadableText
} = require('../../../client/src/features/upload/utils/attachmentContent');
const { ORIGINAL_FILE } = require('../../../client/src/features/chat/utils/chatFileUpload');

const pdf = () => new File(['%PDF original'], 'report.pdf', { type: 'application/pdf' });
const document_ = (overrides = {}) => ({
  type: 'document',
  source: 'ifinder',
  fileName: 'report.pdf',
  fileSize: 13,
  fileType: 'application/pdf',
  content: 'The extracted text',
  pageImages: [],
  [ORIGINAL_FILE]: pdf(),
  ...overrides
});

const readAsText = blob =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });

describe('attachmentContent', () => {
  test('a document: the original file and the extracted text, as <name>.txt', async () => {
    const entry = document_();
    expect(downloadableFile(entry)).toMatchObject({ name: 'report.pdf', kind: 'original' });
    const text = downloadableText(entry);
    expect(text.name).toBe('report.txt');
    expect(await readAsText(text.blob)).toBe('The extracted text');
  });

  test('a scan with no text has no text to download', () => {
    expect(downloadableText(document_({ content: '  ', pageImages: ['AA', 'BB'] }))).toBeNull();
  });

  test('an image without its original is offered as it is sent; with it, the original', () => {
    const base64 = `data:image/png;base64,${btoa('png-bytes')}`;
    expect(downloadableFile({ type: 'image', fileName: 'a.png', base64 })).toMatchObject({
      kind: 'sent'
    });
    const original = new File(['big'], 'a.png', { type: 'image/png' });
    expect(
      downloadableFile({ type: 'image', fileName: 'a.png', base64, [ORIGINAL_FILE]: original })
    ).toMatchObject({ kind: 'original' });
  });

  test('a file that is still loading offers nothing', () => {
    expect(downloadableFile({ ...document_(), loading: true })).toBeNull();
    expect(describeAttachment({ ...document_(), loading: true })).toBeNull();
  });

  test('describeAttachment: characters, page images, truncation, whether the original is kept', () => {
    expect(describeAttachment(document_({ pageImages: ['a', 'b'] }))).toMatchObject({
      kind: 'document',
      characters: 18,
      pageImages: 2,
      truncated: false,
      originalKept: null
    });
    expect(
      describeAttachment(document_({ serverStored: true, hasOriginal: false, truncated: true }))
    ).toMatchObject({ truncated: true, originalKept: false });
    expect(describeAttachment({ type: 'image', width: 800, height: 600 })).toEqual({
      kind: 'image',
      width: 800,
      height: 600
    });
  });
});

describe('the attachment chips', () => {
  let anchorClicks;
  beforeEach(() => {
    URL.createObjectURL = jest.fn(() => 'blob:mock');
    URL.revokeObjectURL = jest.fn();
    anchorClicks = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() {
      anchorClicks.push(this.download);
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  const renderList = files =>
    render(<AttachedFilesList files={files} onRemoveFile={jest.fn()} onRemoveAll={jest.fn()} />);

  test('a document from an integration says what the assistant gets and offers both downloads', () => {
    renderList([document_()]);
    expect(screen.getByTestId('attached-file-content')).toHaveTextContent(
      'Text extracted: 18 characters'
    );
    screen.getByRole('button', { name: 'Download report.pdf' }).click();
    screen.getByRole('button', { name: 'Download the extracted text of report.pdf' }).click();
    expect(anchorClicks).toEqual(['report.pdf', 'report.txt']);
  });

  test('a scan says that page images go instead of text', () => {
    renderList([document_({ content: '', pageImages: ['a', 'b', 'c'] })]);
    expect(screen.getByTestId('attached-file-content')).toHaveTextContent(
      'scan without text: 3 page image(s) sent instead'
    );
    expect(
      screen.queryByRole('button', { name: /Download the extracted text/ })
    ).not.toBeInTheDocument();
  });

  test('a stored file says when only its text is kept or the text was shortened', () => {
    renderList([document_({ serverStored: true, hasOriginal: false, truncated: true })]);
    expect(screen.getByTestId('attached-file-content')).toHaveTextContent(
      'Text extracted: 18 characters · shortened to fit · only the text is kept in this chat'
    );
  });

  test('an image from an integration: its size and the original', () => {
    renderList([
      {
        type: 'image',
        source: 'ifinder',
        fileName: 'site.png',
        fileSize: 5,
        width: 1024,
        height: 768,
        base64: `data:image/png;base64,${btoa('x')}`,
        [ORIGINAL_FILE]: new File(['big'], 'site.png', { type: 'image/png' })
      }
    ]);
    expect(screen.getByTestId('attached-file-content')).toHaveTextContent(
      'Image sent to the model as 1024×768'
    );
    expect(screen.getByRole('button', { name: 'Download site.png' })).toHaveAttribute(
      'title',
      'Download original file'
    );
  });

  test('a local file says what the assistant gets but has no download: the user has it', () => {
    renderList([document_({ source: 'local' })]);
    expect(screen.getByTestId('attached-file-content')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
  });
});
