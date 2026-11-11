// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The Generated and Sources tabs of the workspace pane's Files index (#3055, concept §7):
 * what the chat produced, read again when an answer with a file finishes, numbered by the
 * answer that made it; a row opens the file in the pane; cited sources list in their own tab
 * and open read-only. Through whichever source the page hands it (the owner's chat routes or
 * a share's).
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
jest.mock('../../../client/src/api', () => ({ fetchChatArtifact: jest.fn() }));
jest.mock('../../../client/src/config/marked.config', () => ({
  highlightCode: code => code,
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({ sanitizeMermaidSvg: s => s }));
const mockFetchContent = jest.fn();
jest.mock('../../../client/src/api/endpoints/integrationFiles', () => ({
  fetchIntegrationFileContent: (...args) => mockFetchContent(...args)
}));
jest.mock('../../../client/src/features/documentPreview/components/TextPassageViewer', () => ({
  __esModule: true,
  default: ({ text, passages }) => (
    <div data-testid="text-viewer">
      {text} | {passages.join(' / ')}
    </div>
  )
}));

jest.mock('../../../client/src/features/documentPreview/components/PdfPassageViewer', () => ({
  __esModule: true,
  default: ({ passages }) => <div data-testid="pdf-viewer">{passages.join(' / ')}</div>
}));

const { MemoryRouter, Route, Routes } = require('react-router-dom');
const ArtifactViewerHost =
  require('../../../client/src/features/chat/components/ArtifactViewerHost').default;
const WorkspaceLayout =
  require('../../../client/src/features/workspace/components/WorkspaceLayout').default;
const {
  useArtifactViewer
} = require('../../../client/src/features/chat/contexts/ArtifactViewerContext');
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

  it('opens the preview CSP to the allowed CDN hosts and passes the theme on', () => {
    const html = withPreviewCsp('<!DOCTYPE html><html><body>Hi</body></html>', {
      scriptHosts: ['cdn.jsdelivr.net'],
      theme: 'dark'
    });
    expect(html).toMatch(/script-src 'unsafe-inline' 'unsafe-eval' https:\/\/cdn\.jsdelivr\.net;/);
    expect(html).toMatch(/setAttribute\('data-theme','dark'\)<\/script><html>/);
    // Without hosts the preview stays offline.
    expect(withPreviewCsp('<p>x</p>')).not.toMatch(/https:/);
  });
});

function setViewport(wide) {
  window.matchMedia = query => ({
    matches: /min-width/.test(query) ? wide : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
}

function OpenFiles({ tab }) {
  const viewer = useArtifactViewer();
  return (
    <button type="button" onClick={() => viewer.openFiles(tab)}>
      open files
    </button>
  );
}

function Page({ source, messages = [], tab = null }) {
  return (
    <MemoryRouter initialEntries={['/c']}>
      <Routes>
        <Route
          path="*"
          element={
            <ArtifactViewerHost
              messages={messages}
              chatId="c1"
              inline
              files={{ artifacts: source, uploaded: null, zipName: 'chat' }}
            >
              <WorkspaceLayout>
                <OpenFiles tab={tab} />
              </WorkspaceLayout>
            </ArtifactViewerHost>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const openFiles = () => fireEvent.click(screen.getByText('open files'));

describe('the Generated tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setViewport(true);
  });

  it('lists every file and a row opens it in the pane, with the back link to Files', async () => {
    const source = makeSource();
    render(<Page source={source} />);
    openFiles();
    const list = await screen.findByRole('list', { name: 'Files of this chat' });
    expect(within(list).getAllByTestId('files-row')).toHaveLength(3);
    fireEvent.click(within(list).getByRole('button', { name: /data\.json/ }));
    expect(screen.getByRole('region', { name: 'Workspace: data.json' })).toBeInTheDocument();
    // Pretty-printed by the viewer, fetched through the page's source.
    await waitFor(() => expect(source.fetchBlob).toHaveBeenCalledWith('a2'));
    expect(await screen.findByText(/"b": \[/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Files' }));
    expect(await screen.findByRole('list', { name: 'Files of this chat' })).toBeInTheDocument();
  });

  it('offers no preview for an archive, only its download', async () => {
    const source = makeSource({
      list: jest.fn(async () => ({
        items: [{ id: 'z1', kind: 'archive', mimeType: 'application/zip', name: 'all.zip' }]
      }))
    });
    render(<Page source={source} />);
    openFiles();
    fireEvent.click(await screen.findByRole('button', { name: /all\.zip/ }));
    expect(await screen.findByText(/There is no preview for this file type/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download all.zip' }));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'all.zip'));
  });

  it('selects all with one checkbox, which turns indeterminate for some', async () => {
    render(<Page source={makeSource()} />);
    openFiles();
    const all = await screen.findByRole('checkbox', { name: 'Select all' });
    fireEvent.click(all);
    expect(screen.getByTestId('files-selection-bar')).toHaveTextContent('3 selected');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select data.json' }));
    expect(all.indeterminate).toBe(true);
  });

  it('numbers a live answer by its run, whose files had other ids before they were stored', async () => {
    const source = makeSource({
      list: jest.fn(async () => ({ items: [{ ...ITEMS[0], id: 'stored-id', runId: 'run-1' }] }))
    });
    const messages = [
      { id: 'u1', role: 'user', content: 'q' },
      {
        id: 'm1',
        role: 'assistant',
        content: 'a',
        runId: 'run-1',
        generatedFiles: [{ id: 'live-id' }]
      }
    ];
    render(<Page source={source} messages={messages} />);
    openFiles();
    expect(
      await screen.findByRole('button', { name: 'Show answer 1 in the chat' })
    ).toBeInTheDocument();
  });

  it('lists again when an answer with a file finishes while it is open', async () => {
    const source = makeSource({
      list: jest.fn(async () => ({ items: [{ ...ITEMS[0], runId: 'run-1' }] }))
    });
    const first = [{ role: 'assistant', content: 'a', runId: 'run-1', generatedFiles: [{}] }];
    const { rerender } = render(<Page source={source} messages={first} />);
    openFiles();
    await screen.findByRole('list', { name: 'Files of this chat' });
    expect(source.list).toHaveBeenCalledTimes(1);

    // Still streaming: nothing to list yet.
    const streaming = [
      ...first,
      { role: 'assistant', content: '', runId: 'run-2', loading: true, generatedFiles: [{}] }
    ];
    rerender(<Page source={source} messages={streaming} />);
    expect(source.list).toHaveBeenCalledTimes(1);

    source.list.mockResolvedValue({
      items: [
        { ...ITEMS[1], runId: 'run-2' },
        { ...ITEMS[0], runId: 'run-1' }
      ]
    });
    rerender(<Page source={source} messages={[first[0], { ...streaming[1], loading: false }]} />);
    expect(await screen.findByRole('button', { name: /data\.json/ })).toBeInTheDocument();
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
      render(<Page source={makeSource({ list })} messages={messages} />);
      openFiles();
      expect(await screen.findByTestId('generated-empty')).toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(1600);
      });
      expect(await screen.findByRole('button', { name: /src\/index\.js/ })).toBeInTheDocument();
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the Sources tab', () => {
  const SOURCE = {
    id: 'src-1',
    provider: 'ifinder',
    kind: 'document',
    title: 'Rahmenvertrag 2026',
    site: 'iFinder',
    ref: { id: 'doc-1' },
    passages: [{ text: 'drei Monate' }],
    cited: true
  };
  const messages = [
    { id: 'u1', role: 'user', content: 'Wie lang ist die Frist?' },
    {
      id: 'm1',
      role: 'assistant',
      content: 'Drei Monate.',
      sources: { items: [SOURCE] }
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    setViewport(true);
    mockFetchContent.mockResolvedValue({ data: 'Die Frist beträgt drei Monate.' });
  });

  it('lists the cited sources and opens one read-only, with its passages', async () => {
    render(
      <Page
        source={makeSource({ list: jest.fn(async () => ({ items: [] })) })}
        messages={messages}
        tab="sources"
      />
    );
    openFiles();
    const row = await screen.findByRole('button', { name: /Rahmenvertrag 2026/ });
    fireEvent.click(row);
    const region = await screen.findByRole('region', { name: 'Workspace: Rahmenvertrag 2026' });
    expect(await within(region).findByTestId('source-detail')).toBeInTheDocument();
    await waitFor(() =>
      expect(mockFetchContent).toHaveBeenCalledWith(
        expect.objectContaining({ integration: 'ifinder', ref: { id: 'doc-1' } })
      )
    );
    expect(await screen.findByTestId('pdf-viewer')).toHaveTextContent('drei Monate');
    // Read-only: a back link to Files, nothing that edits.
    expect(within(region).getByRole('button', { name: 'Back to Files' })).toBeInTheDocument();
  });

  it('is not offered where the pane cannot split', async () => {
    setViewport(false);
    render(<Page source={makeSource()} messages={messages} />);
    openFiles();
    await screen.findByRole('tab', { name: /Generated/ });
    expect(screen.queryByRole('tab', { name: /Sources/ })).not.toBeInTheDocument();
  });
});
