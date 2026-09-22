import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

/**
 * Citation document actions in an embedded host.
 *
 * In the Outlook task pane the open/download buttons used to be a complete
 * no-op: `window.open()` is popup-blocked there and returns `null` without
 * throwing, and the download URL carries no session anyway because the pane
 * authenticates with a Bearer header rather than a cookie (issue #2453).
 * These cover both halves — the right host API is used, and a failure is
 * shown to the user instead of vanishing.
 */

const mockT = (key, def) => (typeof def === 'string' ? def : key);
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

// `api/client.js` reads `import.meta.env`, which the Jest transform cannot
// compile, so the api layer is stubbed the way the other client suites do it.
const mockFetchIFinderDocument = jest.fn();
jest.mock('../../../client/src/api/endpoints/documents', () => ({
  __esModule: true,
  fetchIFinderDocument: (...args) => mockFetchIFinderDocument(...args),
  fetchIFinderDocumentMetadata: jest.fn().mockResolvedValue({})
}));

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
  __esModule: true,
  default: () => null
}));

const CitationPanel = require('../../../client/src/features/chat/components/CitationPanel').default;

const DEEP_LINK = 'https://intranet.test/documents/doc-1';

const documentItem = {
  document_id: 'doc-1',
  title: 'Quarterly report',
  additional_document_metadata: {
    'accessInfo.deepLink': [DEEP_LINK],
    'file.name': ['quarterly-report.pdf']
  },
  links: [{ type: 'ACCESS', documentId: 'doc-1', searchProfile: 'default' }]
};

const citations = { references: [], resultItems: [documentItem] };

const renderPanel = (props = {}) => render(<CitationPanel citations={citations} {...props} />);

const openOverflowMenu = async user => {
  await user.click(screen.getByRole('button', { name: 'Menu' }));
};

describe('citation document actions', () => {
  let windowOpen;

  beforeEach(() => {
    mockFetchIFinderDocument.mockReset();
    windowOpen = jest.spyOn(window, 'open').mockReturnValue({});
    URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    windowOpen.mockRestore();
    delete global.Office;
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  it('opens the deep link through the Outlook API when running in the task pane', async () => {
    const user = userEvent.setup();
    const openBrowserWindow = jest.fn();
    global.Office = { context: { ui: { openBrowserWindow } } };

    renderPanel();
    await user.click(screen.getByTitle('Open in browser'));

    expect(openBrowserWindow).toHaveBeenCalledWith(DEEP_LINK);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('tells the user when the host blocked the open instead of doing nothing', async () => {
    const user = userEvent.setup();
    windowOpen.mockReturnValue(null);

    renderPanel();
    await user.click(screen.getByTitle('Open in browser'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened/i);
  });

  it('clears the error once the next action succeeds', async () => {
    const user = userEvent.setup();
    windowOpen.mockReturnValue(null);

    renderPanel();
    await user.click(screen.getByTitle('Open in browser'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    windowOpen.mockReturnValue({});
    await user.click(screen.getByTitle('Open in browser'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('downloads through the authenticated proxy and saves the blob, not a popup', async () => {
    const user = userEvent.setup();
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    mockFetchIFinderDocument.mockResolvedValue({
      data: new Blob(['pdf']),
      headers: { 'content-disposition': 'attachment; filename="q3.pdf"' }
    });

    renderPanel();
    await openOverflowMenu(user);
    await user.click(screen.getByText('Download'));

    await waitFor(() =>
      expect(mockFetchIFinderDocument).toHaveBeenCalledWith({
        documentId: 'doc-1',
        searchProfile: 'default'
      })
    );
    expect(windowOpen).not.toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalled();

    anchorClick.mockRestore();
  });

  it('reports a failed download', async () => {
    const user = userEvent.setup();
    mockFetchIFinderDocument.mockRejectedValue(new Error('HTTP 401'));

    renderPanel();
    await openOverflowMenu(user);
    await user.click(screen.getByText('Download'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be downloaded/i);
  });

  it('hides "Open in App" when no handler can navigate there', async () => {
    const user = userEvent.setup();

    renderPanel();
    await openOverflowMenu(user);

    expect(screen.queryByText('Open in App')).not.toBeInTheDocument();
  });

  it('keeps "Open in App" when a host handler is mounted', async () => {
    const user = userEvent.setup();

    renderPanel({ onDocumentAction: jest.fn() });
    await openOverflowMenu(user);

    expect(screen.getByText('Open in App')).toBeInTheDocument();
  });

  it('surfaces a failure reported by a host handler', async () => {
    const user = userEvent.setup();
    const onDocumentAction = jest.fn().mockResolvedValue({ ok: false, reason: 'blocked' });

    renderPanel({ onDocumentAction });
    await user.click(screen.getByTitle('Open in browser'));

    expect(onDocumentAction).toHaveBeenCalledWith('openExternal', documentItem, undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened/i);
  });

  it('stays quiet for a legacy handler that reports nothing', async () => {
    const user = userEvent.setup();
    const onDocumentAction = jest.fn();

    renderPanel({ onDocumentAction });
    await user.click(screen.getByTitle('Open in browser'));

    await waitFor(() => expect(onDocumentAction).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
