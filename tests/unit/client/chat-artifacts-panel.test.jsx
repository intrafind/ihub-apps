// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The Artifacts panel of a chat (#3055): lists what the chat produced,
 * previews it, downloads one file, and downloads a selection or everything
 * as one ZIP — through whichever source the page hands it (the owner's chat
 * routes or a share's).
 */
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
jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  saveBlobAs: jest.fn(() => true)
}));

const { saveBlobAs } = require('../../../client/src/utils/externalNavigation');
const ArtifactViewerContext =
  require('../../../client/src/features/chat/contexts/ArtifactViewerContext').default;
const ArtifactsPanel =
  require('../../../client/src/features/chat/components/ArtifactsPanel').default;
const {
  artifactDisplayName,
  codeLanguageOf,
  fileLookOf,
  previewTypeOf,
  saveName,
  withPreviewCsp,
  zipErrorCode
} = require('../../../client/src/features/chat/utils/artifactFiles');

if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = jest.fn(() => 'blob:mock');
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = jest.fn();
}

const ITEMS = [
  {
    id: 'a1',
    kind: 'code',
    mimeType: 'text/javascript',
    name: 'src/index.js',
    bytes: 20,
    createdAt: '2026-10-30T10:00:00Z'
  },
  { id: 'a2', kind: 'code', mimeType: 'application/json', name: 'data.json', bytes: 12 },
  { id: 'a3', kind: 'document', mimeType: 'application/pdf', name: 'report.pdf', bytes: 2048 }
];

/** A Blob with `text()`, which jsdom's Blob does not always implement. */
function textBlob(text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  blob.text = async () => text;
  blob.slice = () => textBlob(text, type);
  return blob;
}

function makeSource(overrides = {}) {
  return {
    list: jest.fn(async () => ({ items: ITEMS })),
    fetchBlob: jest.fn(async id =>
      id === 'a2' ? textBlob('{"a":1,"b":[2]}', 'application/json') : textBlob('console.log(1);')
    ),
    zip: jest.fn(async () => new Blob(['zip'])),
    ...overrides
  };
}

describe('artifact helpers', () => {
  it('names, looks and previews by type', () => {
    expect(artifactDisplayName({ id: 'abcdef123456', kind: 'image', mimeType: 'image/png' })).toBe(
      'image-abcdef12.png'
    );
    expect(saveName('src/utils/date.ts')).toBe('date.ts');
    expect(previewTypeOf({ kind: 'image', mimeType: 'image/png' })).toBe('image');
    expect(previewTypeOf({ mimeType: 'text/markdown' })).toBe('markdown');
    expect(previewTypeOf({ mimeType: 'text/tab-separated-values' })).toBe('csv');
    expect(previewTypeOf({ name: 'table.tsv' })).toBe('csv');
    expect(previewTypeOf({ mimeType: 'application/json' })).toBe('json');
    expect(previewTypeOf({ mimeType: 'text/x-python' })).toBe('code');
    expect(previewTypeOf({ mimeType: 'application/zip' })).toBe('none');
    expect(codeLanguageOf('src/app.tsx')).toBe('typescript');
    expect(codeLanguageOf('Dockerfile')).toBe('dockerfile');
    expect(codeLanguageOf('notes.unknown')).toBe('');
    expect(fileLookOf({ mimeType: 'application/zip' }).icon).toBe('archive-box');
    expect(fileLookOf({ mimeType: 'text/x-python' }).icon).toBe('code-bracket');
  });

  it('reads the code of a refused ZIP from a blob body', async () => {
    const data = textBlob(JSON.stringify({ code: 'too-large' }), 'application/json');
    Object.setPrototypeOf(data, Blob.prototype);
    expect(await zipErrorCode({ response: { data } })).toBe('too-large');
    expect(await zipErrorCode({ response: { data: { code: 'too-many-files' } } })).toBe(
      'too-many-files'
    );
    expect(await zipErrorCode(new Error('network'))).toBeNull();
  });

  it('prepends a Content Security Policy to HTML previews without breaking doctype', () => {
    expect(withPreviewCsp('<h1>Hello</h1>')).toMatch(
      /<meta http-equiv="Content-Security-Policy"[^>]*><h1>Hello<\/h1>/
    );
    expect(withPreviewCsp('<!DOCTYPE html><html><body>Hi</body></html>')).toMatch(
      /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"[^>]*><html>/i
    );
  });
});

describe('ArtifactsPanel', () => {
  beforeEach(() => {
    saveBlobAs.mockClear();
  });

  it('is a labelled dialog that lists every file and previews the first', async () => {
    const source = makeSource();
    render(<ArtifactsPanel isOpen onClose={() => {}} source={source} />);

    const dialog = screen.getByRole('dialog', { name: /Artifacts/ });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const list = await screen.findByRole('list', { name: 'Files of this chat' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(await screen.findByLabelText('Content of src/index.js')).toHaveTextContent(
      'console.log(1);'
    );
    expect(screen.getByRole('button', { name: /^src\/index\.js/ })).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('pretty-prints JSON and previews a PDF in a frame', async () => {
    jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report-pdf');
    render(<ArtifactsPanel isOpen onClose={() => {}} source={makeSource()} />);
    fireEvent.click(await screen.findByRole('button', { name: /data\.json/ }));
    const code = await screen.findByLabelText('Content of data.json');
    expect(code.textContent).toContain('"a": 1');

    fireEvent.click(screen.getByRole('button', { name: /report\.pdf/ }));
    await waitFor(() => {
      const frame = document.querySelector('iframe');
      expect(frame).toBeInTheDocument();
      expect(frame).toHaveAttribute('src', 'blob:report-pdf');
    });
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('previews CSV tables even when headers contain quoted delimiters', async () => {
    const csvContent = '"Last, First";Amount\n"Smith, John";100';
    const source = makeSource({
      list: jest.fn(async () => ({
        items: [{ id: 'c1', kind: 'code', mimeType: 'text/csv', name: 'data.csv', bytes: 40 }]
      })),
      fetchBlob: jest.fn(async () => textBlob(csvContent, 'text/csv'))
    });
    render(<ArtifactsPanel isOpen onClose={() => {}} source={source} />);
    expect(await screen.findByRole('columnheader', { name: 'Last, First' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Smith, John' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '100' })).toBeInTheDocument();
  });

  it('offers no preview for an archive', async () => {
    const source = makeSource({
      list: jest.fn(async () => ({
        items: [
          { id: 'z1', kind: 'archive', mimeType: 'application/zip', name: 'bundle.zip', bytes: 64 }
        ]
      }))
    });
    render(<ArtifactsPanel isOpen onClose={() => {}} source={source} />);
    expect(await screen.findByText(/There is no preview for this file type/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('downloads one file under its own name', async () => {
    const source = makeSource();
    render(<ArtifactsPanel isOpen onClose={() => {}} source={source} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download src/index.js' }));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalled());
    expect(saveBlobAs.mock.calls[0][1]).toBe('index.js');
  });

  it('copies a text file to the clipboard', async () => {
    const writeText = jest.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ArtifactsPanel isOpen onClose={() => {}} source={makeSource()} />);
    await screen.findByLabelText('Content of src/index.js');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('console.log(1);'));
    expect(await screen.findByText('Copied to the clipboard.')).toBeInTheDocument();
  });

  it('downloads the selection, then everything, as a ZIP', async () => {
    const source = makeSource();
    render(<ArtifactsPanel isOpen onClose={() => {}} source={source} zipName="My chat" />);
    const selected = await screen.findByRole('button', { name: /Download selected/ });
    expect(selected).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select data.json' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select report.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: /Download selected/ }));
    await waitFor(() => expect(source.zip).toHaveBeenCalledWith(['a2', 'a3']));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'My chat.zip'));

    fireEvent.click(screen.getByRole('button', { name: /Download all/ }));
    await waitFor(() => expect(source.zip).toHaveBeenLastCalledWith(undefined));
  });

  it('selects all with one checkbox', async () => {
    render(<ArtifactsPanel isOpen onClose={() => {}} source={makeSource()} />);
    const all = await screen.findByRole('checkbox', { name: 'Select all' });
    fireEvent.click(all);
    expect(screen.getByRole('checkbox', { name: 'Select data.json' })).toBeChecked();
    fireEvent.click(all);
    expect(screen.getByRole('checkbox', { name: 'Select data.json' })).not.toBeChecked();
  });

  it('says why a ZIP was refused', async () => {
    const source = makeSource({
      zip: jest.fn(async () => {
        throw { response: { status: 413, data: { code: 'too-many-files' } } };
      })
    });
    render(<ArtifactsPanel isOpen onClose={() => {}} source={source} />);
    fireEvent.click(await screen.findByRole('button', { name: /Download all/ }));
    expect(await screen.findByText(/Too many files for one ZIP archive/)).toBeInTheDocument();
  });

  it('shows an empty chat and a failed load', async () => {
    const { unmount } = render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource({ list: async () => ({ items: [] }) })}
      />
    );
    expect(await screen.findByText(/This chat has no files yet/)).toBeInTheDocument();
    unmount();
    render(
      <ArtifactsPanel
        isOpen
        onClose={() => {}}
        source={makeSource({
          list: async () => {
            throw new Error('down');
          }
        })}
      />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });

  it('says which answer made a file', async () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', artifacts: [{ id: 'a3' }] },
      { role: 'assistant', content: 'b', artifacts: [{ id: 'a1' }] }
    ];
    render(<ArtifactsPanel isOpen onClose={() => {}} source={makeSource()} messages={messages} />);
    expect(
      await screen.findByRole('button', { name: /src\/index\.js.*Answer 2/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /report\.pdf.*Answer 1/ })).toBeInTheDocument();
  });

  it('numbers a live answer by its run, whose files had other ids before they were stored', async () => {
    const source = makeSource({
      list: jest.fn(async () => ({
        items: [
          { ...ITEMS[0], runId: 'run-2' },
          { ...ITEMS[2], runId: 'run-1' }
        ]
      }))
    });
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', runId: 'run-1', artifacts: [{ id: 'other' }] },
      // As a live turn leaves it: files by their pre-storage ids, no `artifacts`.
      { role: 'assistant', content: 'b', runId: 'run-2', generatedFiles: [{ id: 'held' }] }
    ];
    render(<ArtifactsPanel isOpen onClose={() => {}} source={source} messages={messages} />);
    expect(
      await screen.findByRole('button', { name: /src\/index\.js.*Answer 2/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /report\.pdf.*Answer 1/ })).toBeInTheDocument();
  });

  it('lists again when an answer with a file finishes while it is open', async () => {
    const source = makeSource({
      list: jest.fn(async () => ({ items: [{ ...ITEMS[0], runId: 'run-1' }] }))
    });
    const first = [{ role: 'assistant', content: 'a', runId: 'run-1', generatedFiles: [{}] }];
    const { rerender } = render(
      <ArtifactsPanel isOpen onClose={() => {}} source={source} messages={first} />
    );
    await screen.findByRole('list');
    expect(source.list).toHaveBeenCalledTimes(1);

    // Still streaming: nothing to list yet.
    const streaming = [
      ...first,
      { role: 'assistant', content: '', runId: 'run-2', loading: true, generatedFiles: [{}] }
    ];
    rerender(<ArtifactsPanel isOpen onClose={() => {}} source={source} messages={streaming} />);
    expect(source.list).toHaveBeenCalledTimes(1);

    source.list.mockResolvedValue({
      items: [
        { ...ITEMS[1], runId: 'run-2' },
        { ...ITEMS[0], runId: 'run-1' }
      ]
    });
    const finished = [first[0], { ...streaming[1], loading: false }];
    rerender(<ArtifactsPanel isOpen onClose={() => {}} source={source} messages={finished} />);
    expect(await screen.findByRole('button', { name: /^data\.json/ })).toBeInTheDocument();
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it('asks once more when a finished answer is not stored yet', async () => {
    jest.useFakeTimers();
    try {
      const list = jest
        .fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValue({ items: [{ ...ITEMS[0], runId: 'run-1' }] });
      const messages = [{ role: 'assistant', content: 'a', runId: 'run-1', generatedFiles: [{}] }];
      render(
        <ArtifactsPanel
          isOpen
          onClose={() => {}}
          source={makeSource({ list })}
          messages={messages}
        />
      );
      expect(await screen.findByText(/This chat has no files yet/)).toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(1600);
      });
      expect(await screen.findByRole('button', { name: /^src\/index\.js/ })).toBeInTheDocument();
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes with Escape and with the close button', async () => {
    const onClose = jest.fn();
    render(<ArtifactsPanel isOpen onClose={onClose} source={makeSource()} />);
    await screen.findByRole('list');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('has no full screen toggle: it offers Open, which hands the file to the viewer', async () => {
    const openArtifact = jest.fn();
    render(
      <ArtifactViewerContext.Provider value={{ openArtifact }}>
        <ArtifactsPanel isOpen onClose={() => {}} source={makeSource()} />
      </ArtifactViewerContext.Provider>
    );
    await screen.findByRole('list');
    expect(screen.queryByRole('button', { name: 'Full screen' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifacts-fullscreen')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog').className).toContain('sm:max-w-4xl');

    fireEvent.click(screen.getByTestId('artifact-open'));
    expect(openArtifact).toHaveBeenCalledTimes(1);
    expect(openArtifact.mock.calls[0][0].id).toBeTruthy();

    // A double-click on a list entry opens it as well.
    fireEvent.doubleClick(screen.getAllByRole('button', { name: /index\.js/ })[0]);
    expect(openArtifact).toHaveBeenCalledTimes(2);
  });
});
