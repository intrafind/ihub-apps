// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Files index of the workspace pane and the detail of an uploaded file (concept §7):
 * the Generated / Uploaded tabs, list → detail with a back link, the preview of uploaded
 * files (extracted text, e-mail viewer), Download original (aware of a discarded original),
 * Delete, "Attach to email" (⋯, or a visible button in Outlook), and the read-only variant
 * of a shared chat. Plus the helpers behind them.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      String(typeof defaultValue === 'string' ? defaultValue : key).replace(
        /\{\{(\w+)\}\}/g,
        (_, name) => String(options?.[name] ?? '')
      ),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid={`icon-${name}`} />
}));
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  saveBlobAs: jest.fn(() => true)
}));

const { saveBlobAs } = require('../../../client/src/utils/externalNavigation');
jest.mock('../../../client/src/api', () => ({ fetchChatArtifact: jest.fn() }));
jest.mock('../../../client/src/config/marked.config', () => ({
  highlightCode: code => code,
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({ sanitizeMermaidSvg: s => s }));
let mockHostKind = null;
jest.mock('../../../client/src/features/office/contexts/EmbeddedHostContext', () => ({
  useEmbeddedHostKind: () => mockHostKind
}));

const { MemoryRouter, Route, Routes, useLocation } = require('react-router-dom');
const ArtifactViewerHost =
  require('../../../client/src/features/chat/components/ArtifactViewerHost').default;
const {
  useArtifactViewer
} = require('../../../client/src/features/chat/contexts/ArtifactViewerContext');
const helpers = require('../../../client/src/features/chat/utils/uploadedFiles');
const { isOriginalDiscarded } = require('../../../client/src/api/utils/fileErrors');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const FILES = [
  {
    id: 'file_pdf',
    name: 'contract.pdf',
    mimeType: 'application/pdf',
    bytes: 4096,
    pages: 3,
    hasOriginal: true,
    canUseAsTemplate: true,
    createdAt: '2026-11-01T10:00:00Z'
  },
  {
    id: 'file_docx',
    name: 'plan.docx',
    mimeType: DOCX,
    bytes: 2048,
    hasOriginal: false,
    originalDeletedAt: '2026-11-02T00:00:00Z',
    originalDeleteReason: 'ttl_expired',
    createdAt: '2026-11-01T09:00:00Z'
  },
  {
    id: 'file_mail',
    name: 'Offer.eml',
    mimeType: 'message/rfc822',
    origin: 'email',
    bytes: 900,
    hasOriginal: false,
    originalDeleteReason: 'storage_mode',
    createdAt: '2026-11-01T08:00:00Z'
  }
];

const ARTIFACTS = [
  { id: 'a1', kind: 'code', mimeType: 'text/javascript', name: 'index.js', bytes: 20 }
];

/** A Blob with `text()` and `slice()`, which jsdom's Blob does not always implement. */
function textBlob(text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  blob.text = async () => text;
  blob.slice = () => textBlob(text, type);
  return blob;
}

function makeUploaded(overrides = {}) {
  return {
    list: jest.fn(async () => ({ items: FILES })),
    fetchText: jest.fn(async id => ({
      id,
      text:
        id === 'file_mail'
          ? 'From: ada@example.com\nTo: grace@example.com\nSubject: Offer\n\nPlease find the offer.'
          : '# Plan\n\nLaunch in March.'
    })),
    fetchBlob: jest.fn(async () => textBlob('%PDF-1.4')),
    remove: jest.fn(async () => ({ deleted: true })),
    ...overrides
  };
}

function makeSource() {
  return {
    list: jest.fn(async () => ({ items: ARTIFACTS })),
    fetchBlob: jest.fn(async () => textBlob('console.log(1);')),
    zip: jest.fn(async () => new Blob(['zip']))
  };
}

// jsdom's Blob has no text(); browsers do.
beforeAll(() => {
  if (!Blob.prototype.text) {
    Blob.prototype.text = function text() {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsText(this);
      });
    };
  }
});

describe('uploaded file helpers', () => {
  it('labels files by type', () => {
    expect(helpers.uploadedFileBadge({ mimeType: 'application/pdf' })).toBe('PDF');
    expect(helpers.uploadedFileBadge({ mimeType: DOCX })).toBe('DOCX');
    expect(helpers.uploadedFileBadge({ mimeType: 'message/rfc822' })).toBe('EML');
    expect(helpers.uploadedFileBadge({ mimeType: 'text/calendar' })).toBe('ICS');
    expect(helpers.uploadedFileBadge({ mimeType: 'image/jpeg' })).toBe('JPG');
    expect(helpers.uploadedFileBadge({ mimeType: 'application/x-foo', name: 'a.dat' })).toBe('DAT');
    expect(helpers.uploadedFileBadge({})).toBe('FILE');
  });

  it('picks the viewer: structured items, the original, or the text', () => {
    expect(helpers.uploadedViewKind({ origin: 'email' })).toBe('email');
    expect(helpers.uploadedViewKind({ mimeType: 'text/calendar', name: 'x.ics' })).toBe('meeting');
    expect(helpers.uploadedViewKind({ origin: 'page', name: 'Docs.md' })).toBe('page');
    expect(helpers.uploadedViewKind({ mimeType: 'application/pdf', hasOriginal: true })).toBe(
      'pdf'
    );
    expect(helpers.uploadedViewKind({ mimeType: 'application/pdf', hasOriginal: false })).toBe(
      'text'
    );
    expect(helpers.uploadedViewKind({ mimeType: 'image/png', hasOriginal: true })).toBe('image');
    expect(helpers.uploadedViewKind({ mimeType: 'text/csv', hasOriginal: true })).toBe('csv');
    expect(helpers.uploadedViewKind({ name: 'a.ipynb', hasOriginal: true })).toBe('ipynb');
    expect(
      helpers.uploadedViewKind({ name: 'app.js', mimeType: 'text/javascript', hasOriginal: true })
    ).toBe('code');
    expect(helpers.uploadedViewKind({ mimeType: DOCX, hasOriginal: true })).toBe('text');
  });

  it('tells what is stored: original, text only, or an original that expired', () => {
    expect(helpers.uploadedStorageState({ hasOriginal: true })).toBe('original');
    expect(helpers.uploadedStorageState({ hasOriginal: false })).toBe('text_only');
    expect(
      helpers.uploadedStorageState({
        hasOriginal: false,
        originalDeletedAt: 'x',
        originalDeleteReason: 'ttl_expired'
      })
    ).toBe('expired');
    expect(
      helpers.uploadedStorageState({
        hasOriginal: false,
        originalDeletedAt: 'x',
        originalDeleteReason: 'storage_mode'
      })
    ).toBe('text_only');
  });

  it('splits an e-mail into header lines and body', () => {
    const parsed = helpers.parseStructuredText(
      'From: Ada <ada@example.com>\nSubject: A very long\n  subject line\n\nBody line 1\nBody line 2'
    );
    expect(parsed.headers).toEqual([
      { name: 'From', value: 'Ada <ada@example.com>' },
      { name: 'Subject', value: 'A very long subject line' }
    ]);
    expect(parsed.body).toBe('Body line 1\nBody line 2');
    // Text that does not start with headers is all body.
    expect(helpers.parseStructuredText('Just a paragraph\nSecond line')).toEqual({
      headers: [],
      body: 'Just a paragraph\nSecond line'
    });
  });

  it('names the extracted text file, and the question a file came with', () => {
    expect(helpers.extractedTextFileName({ name: 'plan.docx' })).toBe('plan.docx.txt');
    expect(helpers.extractedTextFileName({ name: 'notes.md' })).toBe('notes.md');
    const questions = helpers.questionOfFiles(FILES, [
      { role: 'assistant', content: 'hi', isGreeting: true },
      { role: 'user', content: 'q1', attachments: [{ id: 'file_pdf' }] },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2', attachments: [{ id: 'file_docx' }] }
    ]);
    expect(questions.get('file_pdf')).toBe(1);
    expect(questions.get('file_docx')).toBe(2);
    expect(questions.has('file_mail')).toBe(false);
  });

  it('recognizes a discarded original from the status or the error code', () => {
    expect(isOriginalDiscarded({ status: 410 })).toBe(true);
    expect(isOriginalDiscarded({ response: { status: 410 } })).toBe(true);
    expect(
      isOriginalDiscarded({ response: { data: { details: { code: 'ORIGINAL_DISCARDED' } } } })
    ).toBe(true);
    expect(isOriginalDiscarded({ response: { status: 500 } })).toBe(false);
    expect(isOriginalDiscarded(null)).toBe(false);
  });
});

function Openers() {
  const viewer = useArtifactViewer();
  const location = useLocation();
  return (
    <>
      <output data-testid="where">{location.search}</output>
      <button type="button" onClick={() => viewer.openFiles()}>
        files
      </button>
      <button type="button" onClick={() => viewer.openFiles('uploaded')}>
        uploaded files
      </button>
      <button type="button" onClick={() => viewer.openFile('file_pdf')}>
        card contract.pdf
      </button>
      <button type="button" onClick={() => viewer.openFile('file_gone')}>
        card gone
      </button>
    </>
  );
}

function mount({
  uploaded = makeUploaded(),
  artifacts = makeSource(),
  messages = [],
  mailAttach = null,
  uploadedAccess = null,
  entry = '/c'
} = {}) {
  const files = { artifacts, uploaded, mailAttach, uploadedAccess, zipName: 'chat' };
  const utils = render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="*"
          element={
            <ArtifactViewerHost messages={messages} chatId="c1" files={files}>
              <Openers />
            </ArtifactViewerHost>
          }
        />
      </Routes>
    </MemoryRouter>
  );
  return { ...utils, files, uploaded, artifacts };
}

const tab = name => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

describe('the Files index of the pane', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHostKind = null;
  });

  it('has Generated, Uploaded tabs with counts and opens on the first with files', async () => {
    mount();
    fireEvent.click(screen.getByText('files'));
    expect(screen.getByRole('dialog', { name: 'Workspace: Files' })).toBeInTheDocument();
    await waitFor(() => expect(tab('Generated')).toHaveTextContent('1'));
    expect(tab('Uploaded')).toHaveTextContent('3');
    expect(tab('Generated')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('index.js')).toBeInTheDocument();
  });

  it('opens on Uploaded when nothing was generated, and tabs move with the arrow keys', async () => {
    mount({ artifacts: { ...makeSource(), list: jest.fn(async () => ({ items: [] })) } });
    fireEvent.click(screen.getByText('files'));
    await waitFor(() => expect(tab('Uploaded')).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(tab('Uploaded'), { key: 'ArrowLeft' });
    expect(tab('Generated')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('generated-empty')).toHaveTextContent(
      'No files yet. Files the assistant creates or you upload appear here.'
    );
  });

  it('a row opens the detail, whose back link returns to the list', async () => {
    mount();
    fireEvent.click(screen.getByText('uploaded files'));
    fireEvent.click(await screen.findByRole('button', { name: /plan\.docx/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('?file=file_docx');
    expect(await screen.findByRole('heading', { name: /plan\.docx/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Files' }));
    expect(screen.getByTestId('where')).toHaveTextContent('?files=uploaded');
    expect(tab('Uploaded')).toHaveAttribute('aria-selected', 'true');
  });

  it('selects without navigating and downloads the selection, then everything, as a ZIP', async () => {
    const { artifacts } = mount();
    fireEvent.click(screen.getByText('files'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select index.js' }));
    expect(screen.getByTestId('where')).toHaveTextContent('?files=');
    const bar = screen.getByTestId('files-selection-bar');
    expect(bar).toHaveTextContent('1 selected');
    fireEvent.click(within(bar).getByRole('button', { name: /Download \.zip/ }));
    await waitFor(() => expect(artifacts.zip).toHaveBeenCalledWith(['a1']));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'chat.zip'));
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('files-selection-bar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('files-download-all'));
    await waitFor(() => expect(artifacts.zip).toHaveBeenLastCalledWith(undefined));
  });

  it('says why a ZIP was refused', async () => {
    const artifacts = makeSource();
    artifacts.zip.mockRejectedValueOnce(
      Object.assign(new Error('x'), { response: { data: { code: 'ZIP_TOO_MANY_FILES' } } })
    );
    mount({ artifacts });
    fireEvent.click(screen.getByText('files'));
    fireEvent.click(await screen.findByTestId('files-download-all'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows a failed load', async () => {
    mount({
      artifacts: { ...makeSource(), list: jest.fn(async () => Promise.reject(new Error('x'))) }
    });
    fireEvent.click(screen.getByText('files'));
    fireEvent.click(await screen.findByRole('tab', { name: /^Generated/ }));
    expect(
      await screen.findByText('The files of this chat could not be loaded.')
    ).toBeInTheDocument();
  });

  it('says which answer made a file', async () => {
    const artifacts = makeSource();
    artifacts.list.mockResolvedValue({ items: [{ ...ARTIFACTS[0], runId: 'r2' }] });
    mount({
      artifacts,
      messages: [
        { id: 'q1', role: 'user', content: 'a' },
        { id: 'm1', role: 'assistant', runId: 'r1', content: 'x' },
        { id: 'm2', role: 'assistant', runId: 'r2', content: 'y', generatedFiles: [ARTIFACTS[0]] }
      ]
    });
    fireEvent.click(screen.getByText('files'));
    expect(
      await screen.findByRole('button', { name: 'Show answer 2 in the chat' })
    ).toHaveTextContent('Answer 2');
  });
});

describe('an uploaded file in the pane', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHostKind = null;
  });

  it('a card opens its file straight in the detail, with a back link to Files', async () => {
    mount();
    fireEvent.click(screen.getByText('card contract.pdf'));
    expect(await screen.findByRole('heading', { name: /contract\.pdf/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Files' })).toBeInTheDocument();
    expect(screen.getByTestId('uploaded-template-hint')).toBeInTheDocument();
  });

  it('says so when the file a card named is gone', async () => {
    mount();
    fireEvent.click(screen.getByText('card gone'));
    expect(await screen.findByTestId('uploaded-file-gone')).toHaveTextContent(
      'This file is no longer in the chat.'
    );
  });

  it('previews an Office file as its extracted text', async () => {
    mount({ entry: '/c?file=file_docx' });
    expect(
      await screen.findByText('Showing the text the assistant reads from this file.')
    ).toBeInTheDocument();
  });

  it('previews an e-mail in the mail viewer', async () => {
    mount({ entry: '/c?file=file_mail' });
    await waitFor(() =>
      expect(screen.getByTestId('uploaded-email-viewer')).toHaveTextContent('ada@example.com')
    );
  });

  it('downloads the original, and the text from ⋯', async () => {
    const { uploaded } = mount({ entry: '/c?file=file_pdf' });
    fireEvent.click(await screen.findByTestId('uploaded-download-original'));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'contract.pdf'));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download text' }));
    await waitFor(() => expect(uploaded.fetchText).toHaveBeenCalledWith('file_pdf'));
    await waitFor(() =>
      expect(saveBlobAs).toHaveBeenLastCalledWith(expect.any(Blob), expect.stringMatching(/\.txt$/))
    );
  });

  it('has no Download original once only the text is kept', async () => {
    mount({ entry: '/c?file=file_docx' });
    await screen.findByRole('heading', { name: /plan\.docx/ });
    expect(screen.queryByTestId('uploaded-download-original')).not.toBeInTheDocument();
  });

  it('reports a discarded original (410) instead of failing silently', async () => {
    const uploaded = makeUploaded({
      fetchBlob: jest.fn(async () =>
        Promise.reject(
          Object.assign(new Error('gone'), { status: 410, code: 'ORIGINAL_DISCARDED' })
        )
      )
    });
    mount({ uploaded, entry: '/c?file=file_pdf' });
    fireEvent.click(await screen.findByTestId('uploaded-download-original'));
    expect(await screen.findByText(/only its text is kept/)).toBeInTheDocument();
  });

  it('deletes a file after a confirmation and goes back to the list', async () => {
    const { uploaded } = mount({ entry: '/c?file=file_docx' });
    await screen.findByRole('heading', { name: /plan\.docx/ });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete file' }));
    expect(screen.getByText('Delete plan.docx?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('uploaded-delete-confirm'));
    await waitFor(() => expect(uploaded.remove).toHaveBeenCalledWith('file_docx'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('?files=uploaded'));
    expect(uploaded.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('puts "Attach to email" in ⋯, and makes it a visible button in Outlook', async () => {
    const attach = jest.fn(async () => ({ ok: true, filename: 'contract.pdf' }));
    const mailAttach = { supported: true, available: true, attach };
    const first = mount({ mailAttach, entry: '/c?file=file_pdf' });
    await screen.findByRole('heading', { name: /contract\.pdf/ });
    expect(screen.queryByRole('button', { name: 'Attach to email' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach to email' }));
    await waitFor(() => expect(attach).toHaveBeenCalled());
    first.unmount();

    mockHostKind = 'office';
    mount({ mailAttach, entry: '/c?file=file_pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to email' }));
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Attached contract.pdf to your email.')).toBeInTheDocument();
  });

  it('offers no "Attach to email" for a file without its original', async () => {
    const mailAttach = { supported: true, available: true, attach: jest.fn() };
    mockHostKind = 'office';
    mount({ mailAttach, entry: '/c?file=file_docx' });
    await screen.findByRole('heading', { name: /plan\.docx/ });
    expect(screen.queryByRole('button', { name: 'Attach to email' })).not.toBeInTheDocument();
  });

  it('is read-only on a shared chat: no delete, and text-only access hides the original', async () => {
    const uploaded = makeUploaded();
    delete uploaded.remove;
    mount({ uploaded, uploadedAccess: 'extracted_text', entry: '/c?file=file_pdf' });
    await screen.findByRole('heading', { name: /contract\.pdf/ });
    expect(screen.queryByTestId('uploaded-download-original')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete file' })).not.toBeInTheDocument();
  });

  it('tells a viewer that the owner did not share the files', async () => {
    mount({
      uploaded: makeUploaded({ list: jest.fn(async () => ({ items: [] })) }),
      artifacts: { ...makeSource(), list: jest.fn(async () => ({ items: [] })) },
      uploadedAccess: 'none'
    });
    fireEvent.click(screen.getByText('uploaded files'));
    expect(await screen.findByTestId('uploaded-empty')).toHaveTextContent(
      'The owner did not share the files attached to this chat.'
    );
  });

  it('shows an error when the uploaded files cannot be listed, and none for a missing chat', async () => {
    const first = mount({
      uploaded: makeUploaded({ list: jest.fn(async () => Promise.reject(new Error('boom'))) })
    });
    fireEvent.click(screen.getByText('uploaded files'));
    expect(await screen.findByText('The uploaded files could not be loaded.')).toBeInTheDocument();
    first.unmount();
    mount({
      uploaded: makeUploaded({
        list: jest.fn(async () => Promise.reject(Object.assign(new Error('nf'), { status: 404 })))
      })
    });
    fireEvent.click(screen.getByText('uploaded files'));
    expect(await screen.findByTestId('uploaded-empty')).toBeInTheDocument();
  });
});
