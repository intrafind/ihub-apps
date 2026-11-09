// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The unified Files drawer (#3159): the Uploaded and Generated tabs, the
 * preview of uploaded files (extracted text, e-mail viewer), Download original
 * (aware of a discarded original), Delete, "Attach to email", and the read-only
 * variant of a shared chat. Plus the helpers behind them.
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
const ArtifactsPanel =
  require('../../../client/src/features/chat/components/ArtifactsPanel').default;
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

describe('the Files drawer', () => {
  beforeEach(() => saveBlobAs.mockClear());

  it('is the plain Artifacts panel without a source of uploaded files', async () => {
    render(<ArtifactsPanel isOpen onClose={() => {}} source={makeSource()} />);
    expect(await screen.findByRole('dialog', { name: /Artifacts/ })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('has Uploaded (N) and Generated (M) tabs and opens on Generated when there are some', async () => {
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={makeUploaded()}
      />
    );
    const uploadedTab = await screen.findByRole('tab', { name: 'Uploaded (3)' });
    const generatedTab = screen.getByRole('tab', { name: 'Generated (1)' });
    expect(generatedTab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText('Files of this chat')).toBeInTheDocument();

    fireEvent.click(uploadedTab);
    expect(uploadedTab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('uploaded-files-tab')).toBeInTheDocument();
  });

  it('opens on Uploaded when nothing was generated, or the clicked chip names a file', async () => {
    const source = { ...makeSource(), list: jest.fn(async () => ({ items: [] })) };
    const { unmount } = render(
      <ArtifactsPanel isOpen onClose={() => {}} source={source} uploadedSource={makeUploaded()} />
    );
    expect(await screen.findByTestId('uploaded-files-tab')).toBeInTheDocument();
    unmount();

    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={makeUploaded()}
        initialTab="uploaded"
        initialFileId="file_docx"
      />
    );
    expect(await screen.findByRole('heading', { name: 'plan.docx' })).toBeInTheDocument();
  });

  it('says so when the file a card named is gone, instead of opening another one', async () => {
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={makeUploaded()}
        initialTab="uploaded"
        initialFileId="file_deleted"
      />
    );
    expect(await screen.findByTestId('uploaded-file-gone')).toHaveTextContent(
      'This file is no longer in the chat.'
    );
    // Not the first file in its place: no preview heading until the user picks one
    expect(screen.queryByRole('heading', { name: 'plan.docx' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'contract.pdf' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /plan\.docx/ }));
    expect(await screen.findByRole('heading', { name: 'plan.docx' })).toBeInTheDocument();
    expect(screen.queryByTestId('uploaded-file-gone')).not.toBeInTheDocument();
  });

  it('says the file is gone, not that nothing was uploaded, when none is left', async () => {
    const empty = { ...makeUploaded(), list: jest.fn(async () => ({ items: [] })) };
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={empty}
        initialTab="uploaded"
        initialFileId="file_deleted"
      />
    );
    expect(await screen.findByTestId('uploaded-file-gone')).toHaveTextContent(
      'This file is no longer in the chat.'
    );
    expect(screen.queryByTestId('uploaded-empty')).not.toBeInTheDocument();
  });

  it('shows type badge, size, pages and what is stored per uploaded file', async () => {
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={makeUploaded()}
        initialTab="uploaded"
      />
    );
    const list = await screen.findByRole('list', { name: 'Files uploaded to this chat' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('PDF')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('4 KB');
    expect(rows[0]).toHaveTextContent('3 pages');
    expect(rows[0]).toHaveTextContent('Original saved');
    expect(rows[1]).toHaveTextContent('Original removed');
    expect(rows[2]).toHaveTextContent('Text only');
  });

  it('previews an Office file as its extracted text and an e-mail in the mail viewer', async () => {
    const uploaded = makeUploaded();
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={uploaded}
        initialTab="uploaded"
        initialFileId="file_docx"
      />
    );
    expect(await screen.findByText('Launch in March.')).toBeInTheDocument();
    expect(uploaded.fetchText).toHaveBeenCalledWith('file_docx');
    expect(screen.queryByTestId('uploaded-download-original')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /Offer\.eml/ }));
    const viewer = await screen.findByTestId('uploaded-email-viewer');
    expect(viewer).toHaveTextContent('ada@example.com');
    expect(viewer).toHaveTextContent('Subject');
    expect(viewer).toHaveTextContent('Please find the offer.');
  });

  it('downloads the original, and says so when only the text is left', async () => {
    const uploaded = makeUploaded();
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={uploaded}
        initialTab="uploaded"
        initialFileId="file_pdf"
      />
    );
    fireEvent.click(await screen.findByTestId('uploaded-download-original'));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalled());
    expect(saveBlobAs.mock.calls[0][1]).toBe('contract.pdf');
  });

  it('reports a discarded original (410) instead of failing silently', async () => {
    const uploaded = makeUploaded({
      fetchBlob: jest.fn(async () => {
        throw Object.assign(new Error('gone'), { response: { status: 410 } });
      })
    });
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={uploaded}
        initialTab="uploaded"
        initialFileId="file_pdf"
      />
    );
    fireEvent.click(await screen.findByTestId('uploaded-download-original'));
    expect(await screen.findByText(/no longer stored; only its text is kept/)).toBeInTheDocument();
    expect(saveBlobAs).not.toHaveBeenCalled();
  });

  it('downloads the extracted text as a .txt file', async () => {
    const uploaded = makeUploaded();
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={uploaded}
        initialTab="uploaded"
        initialFileId="file_docx"
      />
    );
    fireEvent.click(await screen.findByTestId('uploaded-download-text'));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalled());
    expect(saveBlobAs.mock.calls[0][1]).toBe('plan.docx.txt');
  });

  it('lists a picture the user attached, previews it and downloads it, with no text to download', async () => {
    const picture = {
      id: 'file_img',
      name: 'whiteboard.png',
      mimeType: 'image/png',
      origin: 'image',
      bytes: 5000,
      hasOriginal: true,
      createdAt: '2026-11-01T11:00:00Z'
    };
    const uploaded = makeUploaded({
      list: jest.fn(async () => ({ items: [picture, ...FILES] })),
      fetchBlob: jest.fn(async () => new Blob(['png'], { type: 'image/png' }))
    });
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={uploaded}
        initialTab="uploaded"
        initialFileId="file_img"
      />
    );
    fireEvent.click(await screen.findByTestId('uploaded-download-original'));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalled());
    expect(saveBlobAs.mock.calls[0][1]).toBe('whiteboard.png');
    // A picture has no extracted text, and the drawer does not offer one
    expect(screen.queryByTestId('uploaded-download-text')).not.toBeInTheDocument();
    expect(uploaded.fetchText).not.toHaveBeenCalled();
  });

  it('deletes a file after a confirmation and refreshes the list', async () => {
    const uploaded = makeUploaded();
    const onChanged = jest.fn();
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={uploaded}
        initialTab="uploaded"
        initialFileId="file_docx"
        onUploadedChanged={onChanged}
      />
    );
    fireEvent.click(await screen.findByTestId('uploaded-delete'));
    expect(uploaded.remove).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('uploaded-delete-confirm'));
    await waitFor(() => expect(uploaded.remove).toHaveBeenCalledWith('file_docx'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // The list is read again.
    await waitFor(() => expect(uploaded.list.mock.calls.length).toBeGreaterThan(1));
  });

  it('offers "Attach to email" only while composing, for files with an original', async () => {
    const attach = jest.fn(async () => ({ ok: true, filename: 'contract.pdf' }));
    const { rerender } = render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={makeUploaded()}
        initialTab="uploaded"
        initialFileId="file_pdf"
        mailAttach={{ available: false, attach }}
      />
    );
    await screen.findByTestId('uploaded-download-original');
    expect(screen.queryByTestId('uploaded-attach-to-email')).not.toBeInTheDocument();

    rerender(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={makeUploaded()}
        initialTab="uploaded"
        initialFileId="file_pdf"
        mailAttach={{ available: true, attach }}
      />
    );
    fireEvent.click(await screen.findByTestId('uploaded-attach-to-email'));
    await waitFor(() => expect(attach).toHaveBeenCalled());
    expect(attach.mock.calls[0][0].file.name).toBe('contract.pdf');
    expect(await screen.findByText('Attached contract.pdf to your email.')).toBeInTheDocument();
  });

  it('is read-only on a shared chat: no delete, and text-only access hides the original', async () => {
    const shared = makeUploaded({ remove: undefined });
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={shared}
        uploadedAccess="extracted_text"
        initialTab="uploaded"
        initialFileId="file_pdf"
      />
    );
    await screen.findByTestId('uploaded-download-text');
    expect(screen.queryByTestId('uploaded-delete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('uploaded-download-original')).not.toBeInTheDocument();
  });

  it('tells a viewer that the owner did not share the files', async () => {
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={makeUploaded({
          list: jest.fn(async () => ({ items: [] })),
          remove: undefined
        })}
        uploadedAccess="none"
        initialTab="uploaded"
      />
    );
    expect(
      await screen.findByText('The owner did not share the files attached to this chat.')
    ).toBeInTheDocument();
  });

  it('shows an error when the uploaded files cannot be listed, and none for a missing chat', async () => {
    const failing = makeUploaded({
      list: jest.fn(async () => {
        throw Object.assign(new Error('boom'), { response: { status: 500 } });
      })
    });
    const { unmount } = render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={failing}
        initialTab="uploaded"
      />
    );
    expect(await screen.findByText('The uploaded files could not be loaded.')).toBeInTheDocument();
    unmount();

    const missing = makeUploaded({
      list: jest.fn(async () => {
        throw Object.assign(new Error('nf'), { response: { status: 404 } });
      })
    });
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource()}
        uploadedSource={missing}
        initialTab="uploaded"
      />
    );
    expect(await screen.findByTestId('uploaded-empty')).toBeInTheDocument();
  });

  it('reads the uploaded files again when the conversation names other files', async () => {
    const uploaded = makeUploaded();
    const props = {
      isOpen: true,
      onClose: () => {},
      source: makeSource(),
      uploadedSource: uploaded,
      initialTab: 'uploaded'
    };
    const { rerender } = render(<ArtifactsPanel {...props} messages={[]} />);
    await screen.findByTestId('uploaded-files-tab');
    const calls = uploaded.list.mock.calls.length;
    await act(async () => {
      rerender(
        <ArtifactsPanel
          {...props}
          messages={[{ role: 'user', content: 'q', attachments: [{ id: 'file_new' }] }]}
        />
      );
    });
    await waitFor(() => expect(uploaded.list.mock.calls.length).toBeGreaterThan(calls));
  });
});
