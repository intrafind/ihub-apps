import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import CitationPanel from '../../../client/src/features/chat/components/CitationPanel';
import { fetchIFinderDocument } from '../../../client/src/api/endpoints/documents';

/**
 * "Add to email": putting a document iAssistant found on the mail the user is
 * writing — the follow-up issue #2453 asked for once document access worked in
 * the task pane.
 *
 * Outlook takes attachments only on a compose item, and only as bytes: the
 * URL-based API has Exchange fetch the link itself, which cannot reach the
 * iFinder proxy behind the user's iHub session. So the pane downloads on the
 * authenticated path and hands Outlook base64 — covered here end to end
 * against the real panel and a mocked `Office`.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return options
        ? text.replace(/{{(\w+)}}/g, (_m, name) => options[name] ?? `{{${name}}}`)
        : text;
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/endpoints/documents', () => ({
  __esModule: true,
  fetchIFinderDocument: jest.fn(),
  fetchIFinderDocumentMetadata: jest.fn(() => Promise.resolve({}))
}));

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
  __esModule: true,
  default: () => null
}));

const DOC = {
  document_id: 'doc-1',
  title: 'Quarterly report',
  links: [{ type: 'ACCESS', documentId: 'ifinder-1', searchProfile: 'default' }],
  additional_document_metadata: {
    'accessInfo.deepLink': ['https://ifinder.example/doc/1'],
    'file.name': ['report.pdf']
  }
};

const citations = { references: [], resultItems: [DOC] };

/**
 * @param {Object} options
 * @param {'read'|'compose'|'none'} options.mode which Outlook surface is open.
 * @param {Function} [options.addFileAttachmentFromBase64Async]
 * @param {boolean} [options.mailbox1_8]
 */
function installOffice({ mode = 'compose', addFileAttachmentFromBase64Async, mailbox1_8 = true }) {
  if (mode === 'none') {
    delete global.Office;
    return null;
  }

  const attach =
    addFileAttachmentFromBase64Async ||
    jest.fn((base64, name, options, callback) => callback({ status: 'succeeded' }));

  const item =
    mode === 'compose'
      ? {
          addFileAttachmentFromBase64Async: attach,
          body: { setSelectedDataAsync: () => {}, prependAsync: () => {} }
        }
      : {
          addFileAttachmentFromBase64Async: attach,
          displayReplyFormAsync: () => {}
        };

  global.Office = {
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    context: {
      requirements: { isSetSupported: (set, v) => mailbox1_8 && set === 'Mailbox' && v === '1.8' },
      mailbox: { item }
    }
  };
  return attach;
}

const openMenu = () => fireEvent.click(screen.getByTitle('Menu'));

beforeEach(() => {
  jest.clearAllMocks();
  fetchIFinderDocument.mockResolvedValue({
    data: new Blob(['%PDF-1.7 report'], { type: 'application/pdf' }),
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="Quarterly report.pdf"'
    }
  });
});

afterEach(() => {
  delete global.Office;
});

test('hands Outlook the downloaded bytes and confirms what was attached', async () => {
  const attach = installOffice({ mode: 'compose' });

  render(<CitationPanel citations={citations} />);
  openMenu();
  fireEvent.click(screen.getByText('Add to email'));

  await waitFor(() => expect(attach).toHaveBeenCalled());
  expect(fetchIFinderDocument).toHaveBeenCalledWith({
    documentId: 'ifinder-1',
    searchProfile: 'default'
  });

  const [base64, filename, options] = attach.mock.calls[0];
  expect(Buffer.from(base64, 'base64').toString()).toBe('%PDF-1.7 report');
  expect(filename).toBe('Quarterly report.pdf');
  expect(options).toEqual({ isInline: false });

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Added to your email as Quarterly report.pdf.'
  );
});

test('is offered but disabled while a received mail is open', () => {
  installOffice({ mode: 'read' });

  render(<CitationPanel citations={citations} />);
  openMenu();

  const action = screen.getByText('Add to email').closest('button');
  expect(action).toBeDisabled();
  expect(action).toHaveAttribute('title', expect.stringContaining('Open a new email'));
});

test('switches on by itself when Outlook moves to a draft', async () => {
  installOffice({ mode: 'read' });

  render(<CitationPanel citations={citations} />);
  openMenu();
  expect(screen.getByText('Add to email').closest('button')).toBeDisabled();

  installOffice({ mode: 'compose' });
  fireEvent(document, new CustomEvent('ihub:itemchanged'));

  await waitFor(() => expect(screen.getByText('Add to email').closest('button')).toBeEnabled());
});

test('is not offered outside Outlook', () => {
  installOffice({ mode: 'none' });

  render(<CitationPanel citations={citations} />);
  openMenu();

  expect(screen.queryByText('Add to email')).toBeNull();
});

test('is not offered on clients without Mailbox 1.8', () => {
  installOffice({ mode: 'compose', mailbox1_8: false });

  render(<CitationPanel citations={citations} />);
  openMenu();

  expect(screen.queryByText('Add to email')).toBeNull();
});

test('a document too large for a mail is refused before Outlook sees it', async () => {
  const attach = installOffice({ mode: 'compose' });
  fetchIFinderDocument.mockResolvedValue({
    data: new Blob(['x'.repeat(26 * 1024 * 1024)], { type: 'application/pdf' }),
    headers: { 'content-type': 'application/pdf' }
  });

  render(<CitationPanel citations={citations} />);
  openMenu();
  fireEvent.click(screen.getByText('Add to email'));

  expect(await screen.findByRole('alert')).toHaveTextContent('too large to attach');
  expect(attach).not.toHaveBeenCalled();
});

test('reports what Outlook said when it refuses the attachment', async () => {
  installOffice({
    mode: 'compose',
    addFileAttachmentFromBase64Async: jest.fn((base64, name, options, callback) =>
      callback({ status: 'failed', error: { name: 'AttachmentError', code: 9000 } })
    )
  });

  render(<CitationPanel citations={citations} />);
  openMenu();
  fireEvent.click(screen.getByText('Add to email'));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The document could not be attached to your email.'
  );
});

test('a failed download never reaches Outlook', async () => {
  const attach = installOffice({ mode: 'compose' });
  fetchIFinderDocument.mockRejectedValue(new Error('403'));

  render(<CitationPanel citations={citations} />);
  openMenu();
  fireEvent.click(screen.getByText('Add to email'));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The document could not be attached to your email.'
  );
  expect(attach).not.toHaveBeenCalled();
});
