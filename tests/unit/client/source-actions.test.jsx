import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnswerSources from '../../../client/src/features/chat/components/AnswerSources';
import { _resetSourcesStore } from '../../../client/src/features/chat/sources/sourcesStore';
import {
  resolveSourceFilename,
  sourceActionsOf
} from '../../../client/src/features/chat/sources/sourceActions';
import { fetchSourceContent } from '../../../client/src/api/endpoints/sources';
import { resolveCitations } from '../../../shared/sources/index.js';

/**
 * What the user can do with a source (features/chat/sources/sourceActions.js),
 * run from the sources panel (AnswerSources):
 *
 *  - which actions a source offers follows from its data — a link opens and
 *    copies, a `ref` previews, downloads, attaches, opens in an app and shows
 *    details — never from the integration that found it;
 *  - in an embedded host the actions use the host's APIs and report a failure
 *    instead of doing nothing (issue #2453): the Outlook task pane opens links
 *    through Office, and a popup blocker's refusal is shown;
 *  - "Add to email" in the Outlook task pane: the document is downloaded on
 *    the authenticated path and handed to Outlook as bytes, only while a mail
 *    is being written;
 *  - "Open in App" only where the host can open another app.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const opts = typeof fallback === 'object' ? fallback : options || {};
      const text = typeof fallback === 'string' ? fallback : key;
      return text.replace(/{{(\w+)}}/g, (_m, name) => opts[name] ?? `{{${name}}}`);
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/endpoints/sources', () => ({
  __esModule: true,
  fetchSourceContent: jest.fn(),
  fetchSourceMetadata: jest.fn(() => Promise.resolve({}))
}));

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
  __esModule: true,
  default: ({ isOpen, onSelect }) =>
    isOpen ? (
      <button type="button" onClick={() => onSelect({ id: 'research' })}>
        Pick Research
      </button>
    ) : null
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const DEEP_LINK = 'https://ifinder.example/doc/1';

const DOC = {
  id: 'ifinder:doc-1',
  provider: 'ifinder',
  kind: 'document',
  title: 'Quarterly report',
  url: DEEP_LINK,
  fileName: 'report.pdf',
  ref: { id: 'doc-1', scope: 'default' },
  private: true
};

function renderSources({ items = [DOC], onOpenInApp } = {}) {
  const sources = { items, queries: [] };
  const citations = resolveCitations('An answer.', sources);
  render(
    <AnswerSources
      messageKey="m1"
      sources={sources}
      citations={citations}
      onOpenInApp={onOpenInApp}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /sources/i }));
  return screen.getByRole('dialog', { name: 'Sources' });
}

const openMenu = () => fireEvent.click(screen.getByTitle('Actions'));

/**
 * @param {Object} options
 * @param {'read'|'compose'|'none'} options.mode which Outlook surface is open.
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
      : { addFileAttachmentFromBase64Async: attach, displayReplyFormAsync: () => {} };
  global.Office = {
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    context: {
      requirements: { isSetSupported: (set, v) => mailbox1_8 && set === 'Mailbox' && v === '1.8' },
      mailbox: { item }
    }
  };
  return attach;
}

let windowOpen;

beforeEach(() => {
  jest.clearAllMocks();
  act(() => _resetSourcesStore());
  windowOpen = jest.spyOn(window, 'open').mockReturnValue({});
  URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = jest.fn();
  fetchSourceContent.mockResolvedValue({
    data: new Blob(['%PDF-1.7 report'], { type: 'application/pdf' }),
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="Quarterly report.pdf"'
    }
  });
});

afterEach(() => {
  windowOpen.mockRestore();
  delete global.Office;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

describe('which actions a source offers', () => {
  test('follow from its data, not from who found it', () => {
    expect(sourceActionsOf(DOC)).toEqual(['open', 'preview', 'download', 'details', 'copyLink']);
    expect(sourceActionsOf(DOC, { attachSupported: true, canOpenInApp: true })).toEqual([
      'open',
      'preview',
      'download',
      'attach',
      'openInApp',
      'details',
      'copyLink'
    ]);
    // A web page: open and copy its link.
    expect(sourceActionsOf({ url: 'https://example.com/', kind: 'page' })).toEqual([
      'open',
      'copyLink'
    ]);
    // A record a tool declared, without link or ref: nothing to act on.
    expect(sourceActionsOf({ id: 'jira:X-1', kind: 'item' })).toEqual([]);
    expect(sourceActionsOf({ url: 'javascript:alert(1)' })).toEqual([]);
  });

  test('a web page has no document menu beyond copying its link', () => {
    const dialog = renderSources({
      items: [
        {
          id: 'url:example.com',
          provider: 'web',
          kind: 'page',
          url: 'https://example.com/',
          title: 'Example',
          private: false
        }
      ]
    });
    fireEvent.click(within(dialog).getByTitle('Actions'));
    expect(screen.getByText('Copy link')).toBeInTheDocument();
    expect(screen.queryByText('Download')).toBeNull();
    expect(screen.queryByText('Preview (PDF)')).toBeNull();
  });
});

describe('opening and downloading', () => {
  test('opens the link through the Outlook API when running in the task pane', () => {
    const openBrowserWindow = jest.fn();
    global.Office = { context: { ui: { openBrowserWindow } } };
    renderSources();
    fireEvent.click(screen.getByTitle('Open in browser'));
    expect(openBrowserWindow).toHaveBeenCalledWith(DEEP_LINK);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  test('tells the user when the host blocked the open, and clears it once one works', async () => {
    windowOpen.mockReturnValue(null);
    renderSources();
    fireEvent.click(screen.getByTitle('Open in browser'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened/i);
    windowOpen.mockReturnValue({});
    fireEvent.click(screen.getByTitle('Open in browser'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  test('a modified click on the title is left to the browser, like any link', () => {
    renderSources();
    const title = screen.getByTitle('Open in browser');
    expect(title).toHaveAttribute('href', DEEP_LINK);
    expect(fireEvent.click(title, { ctrlKey: true })).toBe(true);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  test('downloads through the provider route and saves the blob, not a popup', async () => {
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderSources();
    openMenu();
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(anchorClick).toHaveBeenCalled());
    expect(fetchSourceContent).toHaveBeenCalledWith({ source: DOC });
    expect(windowOpen).not.toHaveBeenCalled();
    anchorClick.mockRestore();
  });

  test('reports a failed download', async () => {
    fetchSourceContent.mockRejectedValue(new Error('HTTP 401'));
    renderSources();
    openMenu();
    fireEvent.click(screen.getByText('Download'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be downloaded/i);
  });
});

describe('"Open in App"', () => {
  test('is hidden when the host cannot open another app', () => {
    renderSources();
    openMenu();
    expect(screen.queryByText('Open in App')).toBeNull();
  });

  test('hands the source and the chosen app to the host', () => {
    const onOpenInApp = jest.fn();
    renderSources({ onOpenInApp });
    openMenu();
    fireEvent.click(screen.getByText('Open in App'));
    fireEvent.click(screen.getByText('Pick Research'));
    expect(onOpenInApp).toHaveBeenCalledWith(DOC, 'research');
  });
});

describe('"Add to email" in the Outlook task pane', () => {
  test('hands Outlook the downloaded bytes and confirms what was attached', async () => {
    const attach = installOffice({ mode: 'compose' });
    renderSources();
    openMenu();
    fireEvent.click(screen.getByText('Add to email'));

    await waitFor(() => expect(attach).toHaveBeenCalled());
    expect(fetchSourceContent).toHaveBeenCalledWith({ source: DOC });
    const [base64, filename, options] = attach.mock.calls[0];
    expect(Buffer.from(base64, 'base64').toString()).toBe('%PDF-1.7 report');
    expect(filename).toBe('Quarterly report.pdf');
    expect(options).toEqual({ isInline: false });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Added to your email as Quarterly report.pdf.'
    );
  });

  test('is offered but disabled while a received mail is open, and switches on for a draft', async () => {
    installOffice({ mode: 'read' });
    renderSources();
    openMenu();
    const action = screen.getByText('Add to email').closest('button');
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('title', expect.stringContaining('Open a new email'));

    installOffice({ mode: 'compose' });
    fireEvent(document, new CustomEvent('ihub:itemchanged'));
    await waitFor(() => expect(screen.getByText('Add to email').closest('button')).toBeEnabled());
  });

  test('is not offered outside Outlook', () => {
    installOffice({ mode: 'none' });
    renderSources();
    openMenu();
    expect(screen.queryByText('Add to email')).toBeNull();
  });

  test('is not offered on clients without Mailbox 1.8', () => {
    installOffice({ mode: 'compose', mailbox1_8: false });
    renderSources();
    openMenu();
    expect(screen.queryByText('Add to email')).toBeNull();
  });

  test('a document too large for a mail is refused before Outlook sees it', async () => {
    const attach = installOffice({ mode: 'compose' });
    fetchSourceContent.mockResolvedValue({
      data: new Blob(['x'.repeat(26 * 1024 * 1024)], { type: 'application/pdf' }),
      headers: { 'content-type': 'application/pdf' }
    });
    renderSources();
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
    renderSources();
    openMenu();
    fireEvent.click(screen.getByText('Add to email'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The document could not be attached to your email.'
    );
  });

  test('a failed download never reaches Outlook', async () => {
    const attach = installOffice({ mode: 'compose' });
    fetchSourceContent.mockRejectedValue(new Error('403'));
    renderSources();
    openMenu();
    fireEvent.click(screen.getByText('Add to email'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The document could not be attached to your email.'
    );
    expect(attach).not.toHaveBeenCalled();
  });
});

describe('resolveSourceFilename', () => {
  const response = (headers = {}) => ({ headers });

  test('prefers the name the server sent, then the file name, the title, then the id', () => {
    expect(
      resolveSourceFilename(
        DOC,
        response({ 'content-disposition': 'attachment; filename="Server name.pdf"' })
      )
    ).toBe('Server name.pdf');
    expect(resolveSourceFilename(DOC, response())).toBe('report.pdf');
    expect(resolveSourceFilename({ ...DOC, fileName: undefined }, response())).toBe(
      'Quarterly report'
    );
    expect(resolveSourceFilename({ ref: { id: 'doc-9' } }, response())).toBe('doc-9');
  });

  test('adds the extension for the content type when the name has none', () => {
    expect(
      resolveSourceFilename(
        { ...DOC, fileName: undefined },
        response({ 'content-type': 'application/pdf; charset=binary' })
      )
    ).toBe('Quarterly report.pdf');
    expect(
      resolveSourceFilename(
        { ref: { id: 'x' }, title: 'Notes' },
        response({ 'content-type': 'application/x-unknown' })
      )
    ).toBe('Notes');
  });

  test('strips path separators and the characters Windows rejects', () => {
    expect(
      resolveSourceFilename({ ref: { id: 'x' }, fileName: '../a/b\\c:d*e?.pdf' }, response())
    ).toBe('.._a_b_c_d_e_.pdf');
  });
});
