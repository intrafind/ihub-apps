import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import CitationPanel from '../../../client/src/features/chat/components/CitationPanel';
import { EmbeddedHostProvider } from '../../../client/src/features/office/contexts/EmbeddedHostContext';
import { fetchIFinderDocument } from '../../../client/src/api/endpoints/ifinder';

/**
 * The document actions on an iAssistant citation, across the hosts the chat UI
 * renders in (issue #2453).
 *
 * In the Outlook task pane and the extension side panel popups are blocked:
 * `window.open()` returns null and the click does nothing at all. Those hosts
 * pass their own opener through the embedded-host adapter, and Outlook also
 * offers attaching the document to the mail being written. All of it is
 * exercised against the real CitationPanel, because the bug was precisely that
 * the panel's own fallback path — the one used wherever no chat page supplies
 * `onDocumentAction` — went straight to `window.open`.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => fallback || key, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/api/endpoints/ifinder', () => ({
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
    'file.name': ['report.pdf'],
    application: ['pdf']
  }
};

const citations = { references: [], resultItems: [DOC] };

const renderPanel = (host = null, props = {}) =>
  render(
    host ? (
      <EmbeddedHostProvider value={host}>
        <CitationPanel citations={citations} {...props} />
      </EmbeddedHostProvider>
    ) : (
      <CitationPanel citations={citations} {...props} />
    )
  );

const openMenu = () => fireEvent.click(screen.getByTitle('Menu'));

let anchorClicks;

beforeEach(() => {
  jest.clearAllMocks();
  anchorClicks = [];
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    anchorClicks.push({ href: this.href, download: this.download });
  });
  window.URL.createObjectURL = jest.fn(() => 'blob:mock');
  window.URL.revokeObjectURL = jest.fn();
  fetchIFinderDocument.mockResolvedValue({
    data: new Blob(['%PDF-1.7 report'], { type: 'application/pdf' }),
    contentType: 'application/pdf',
    filename: 'Quarterly report.pdf'
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('opening the source document', () => {
  test('embedded hosts open the link themselves instead of calling window.open', async () => {
    const openExternalUrl = jest.fn(() => true);
    const windowOpen = jest.spyOn(window, 'open').mockReturnValue(null);

    renderPanel({ kind: 'office', openExternalUrl });
    fireEvent.click(screen.getByTitle('Open in browser'));

    await waitFor(() =>
      expect(openExternalUrl).toHaveBeenCalledWith('https://ifinder.example/doc/1')
    );
    expect(windowOpen).not.toHaveBeenCalled();
  });

  test('the web app keeps using window.open', async () => {
    const windowOpen = jest.spyOn(window, 'open').mockReturnValue({});

    renderPanel();
    fireEvent.click(screen.getByTitle('Open in browser'));

    await waitFor(() =>
      expect(windowOpen).toHaveBeenCalledWith(
        'https://ifinder.example/doc/1',
        '_blank',
        'noopener,noreferrer'
      )
    );
  });

  test('a blocked link says so instead of doing nothing', async () => {
    jest.spyOn(window, 'open').mockReturnValue(null);

    renderPanel();
    fireEvent.click(screen.getByTitle('Open in browser'));

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot open links');
  });
});

describe('downloading', () => {
  test('fetches on the authenticated API path and saves the file', async () => {
    renderPanel({ kind: 'office', openExternalUrl: jest.fn(() => true) });
    openMenu();
    fireEvent.click(screen.getByText('Download'));

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(fetchIFinderDocument).toHaveBeenCalledWith({
      documentId: 'ifinder-1',
      searchProfile: 'default'
    });
    expect(anchorClicks[0].download).toBe('Quarterly report.pdf');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a failed download is reported on the document', async () => {
    fetchIFinderDocument.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }));

    renderPanel();
    openMenu();
    fireEvent.click(screen.getByText('Download'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not download this document');
    expect(anchorClicks).toHaveLength(0);
  });
});

describe('adding a document to the email being written', () => {
  const outlookHost = (overrides = {}) => ({
    kind: 'office',
    openExternalUrl: jest.fn(() => true),
    fileAttachment: {
      isAvailable: () => true,
      attach: jest.fn(() => Promise.resolve()),
      maxBytes: 25 * 1024 * 1024,
      labelKey: 'citations.attachToEmail',
      unavailableHintKey: 'citations.errors.attachNeedsDraft',
      ...overrides
    }
  });

  test('hands Outlook the downloaded bytes and confirms', async () => {
    const host = outlookHost();

    renderPanel(host);
    openMenu();
    fireEvent.click(screen.getByText('Add to email'));

    await waitFor(() => expect(host.fileAttachment.attach).toHaveBeenCalled());
    const { base64, filename } = host.fileAttachment.attach.mock.calls[0][0];
    expect(filename).toBe('Quarterly report.pdf');
    expect(Buffer.from(base64, 'base64').toString()).toBe('%PDF-1.7 report');
    expect(await screen.findByText(/Added to your email/)).toBeInTheDocument();
  });

  test('is offered but disabled while a received mail is open', () => {
    renderPanel(outlookHost({ isAvailable: () => false }));
    openMenu();

    const action = screen.getByText('Add to email').closest('button');
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('title', expect.stringContaining('Open a new email'));
  });

  test('re-checks the host when Outlook switches to another item', async () => {
    let composing = false;
    renderPanel(outlookHost({ isAvailable: () => composing }));
    openMenu();
    expect(screen.getByText('Add to email').closest('button')).toBeDisabled();

    composing = true;
    fireEvent(document, new CustomEvent('ihub:itemchanged'));

    await waitFor(() =>
      expect(screen.getByText('Add to email').closest('button')).not.toBeDisabled()
    );
  });

  test('a document too large for a mail is not attached', async () => {
    const host = outlookHost({ maxBytes: 4 });

    renderPanel(host);
    openMenu();
    fireEvent.click(screen.getByText('Add to email'));

    expect(await screen.findByRole('alert')).toHaveTextContent('too large to attach');
    expect(host.fileAttachment.attach).not.toHaveBeenCalled();
  });

  test('hosts that cannot attach do not offer the action', () => {
    renderPanel({ kind: 'extension', openExternalUrl: jest.fn(() => true) });
    openMenu();

    expect(screen.queryByText('Add to email')).toBeNull();
  });
});

describe('opening a document in another app', () => {
  test('is offered only where the surrounding page can route there', () => {
    const { unmount } = renderPanel({ kind: 'office' });
    openMenu();
    expect(screen.queryByText('Open in App')).toBeNull();
    unmount();

    renderPanel(null, { onDocumentAction: jest.fn() });
    openMenu();
    expect(screen.getByText('Open in App')).toBeInTheDocument();
  });
});
