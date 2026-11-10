// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The artifact viewer under the shared pane header (concept §5): Preview | Code, the Copy
 * split button, Download, Share at 480px and up (in ⋯ below), the pane's own controls from
 * `chrome`, and the standalone page mode. HTML stays in a sandboxed frame.
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
const mockExports = {
  exportAsMarkdown: jest.fn(),
  exportAsHTML: jest.fn(),
  exportAsPDF: jest.fn().mockResolvedValue(undefined)
};
jest.mock('../../../client/src/shared/utils/markdownExports', () => mockExports);
jest.mock('../../../client/src/config/marked.config', () => ({
  highlightCode: code => code.replace(/</g, '&lt;'),
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({
  sanitizeMermaidSvg: svg => svg
}));

const { saveBlobAs } = require('../../../client/src/utils/externalNavigation');
const ArtifactViewer =
  require('../../../client/src/features/chat/components/ArtifactViewer').default;

if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = jest.fn(() => 'blob:mock');
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = jest.fn();

const HTML = { id: 'a1', name: 'dash.html', kind: 'code', mimeType: 'text/html', bytes: 40 };
const MD = { id: 'a2', name: 'notes.md', kind: 'document', mimeType: 'text/markdown', bytes: 10 };
const PNG = { id: 'a3', name: 'chart.png', kind: 'image', mimeType: 'image/png', bytes: 10 };
const ALL = [HTML, MD, PNG];

const TEXTS = { a1: '<h1>Hello</h1>', a2: '# Title', a3: 'png' };
// jsdom's Blob has no text(): give each blob the one the preview and copy read.
function blobOf(text) {
  const blob = new Blob([text]);
  blob.text = async () => text;
  return blob;
}
const getBlob = jest.fn(artifact => Promise.resolve(blobOf(TEXTS[artifact.id])));

function chromeOf(extra = {}) {
  return {
    headingId: 'h',
    headingRef: null,
    full: false,
    paneWidth: 800,
    announce: jest.fn(),
    back: { label: 'Files', onBack: jest.fn() },
    expand: { full: false, onToggle: jest.fn() },
    close: { label: 'Close workspace', onClose: jest.fn() },
    more: [],
    ...extra
  };
}

function renderPane(artifact = HTML, { chrome = chromeOf(), ...props } = {}) {
  render(<ArtifactViewer artifact={artifact} getBlob={getBlob} chrome={chrome} {...props} />);
  return chrome;
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
});

describe('ArtifactViewer in the pane', () => {
  it('has one header row: back, title with badge, view toggle, Copy, Download, Expand, Close', async () => {
    const chrome = renderPane();
    const header = screen.getByTestId('artifact-viewer-toolbar');
    expect(header.tagName).toBe('HEADER');
    expect(screen.getByRole('heading', { name: /dash\.html/ })).toHaveAttribute('id', 'h');
    expect(screen.getByTestId('pane-badge')).toHaveTextContent('HTML');
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download dash.html' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Files' }));
    expect(chrome.back.onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(chrome.expand.onToggle).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    expect(chrome.close.onClose).toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(document.querySelector('iframe').getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('toggles between preview and code, and starts each artifact in its preview', async () => {
    const { rerender } = render(
      <ArtifactViewer artifact={HTML} getBlob={getBlob} chrome={chromeOf()} />
    );
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(screen.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(document.querySelector('iframe')).toBeNull());
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
    rerender(<ArtifactViewer artifact={MD} getBlob={getBlob} chrome={chromeOf()} />);
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives Markdown a Code view of its source', async () => {
    renderPane(MD);
    await screen.findByText('# Title');
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    await waitFor(() => expect(document.querySelector('pre, code')).not.toBeNull());
  });

  it('copies text, and offers no Copy or view toggle for a picture', async () => {
    const chrome = renderPane(MD);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Title'));
    await waitFor(() => expect(chrome.announce).toHaveBeenCalledWith('Copied to the clipboard.'));
  });

  it('a picture has neither Copy nor a view toggle', () => {
    renderPane(PNG);
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Code' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download chart.png' })).toBeInTheDocument();
  });

  it('holds the export formats in the Copy dropdown', async () => {
    renderPane(MD);
    fireEvent.click(screen.getByRole('button', { name: 'More copy and download options' }));
    const menu = screen.getByRole('menu', { name: 'More copy and download options' });
    expect(menu).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PDF' }));
    await waitFor(() => expect(mockExports.exportAsPDF).toHaveBeenCalledWith('# Title', 'notes'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('downloads under the artifact name', async () => {
    renderPane(HTML);
    fireEvent.click(screen.getByRole('button', { name: 'Download dash.html' }));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'dash.html'));
  });

  it('shows Share with its label at 480px and more, in ⋯ below', () => {
    const onShare = jest.fn();
    const { unmount } = render(
      <ArtifactViewer artifact={HTML} getBlob={getBlob} chrome={chromeOf()} onShare={onShare} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledWith(HTML);
    unmount();

    render(
      <ArtifactViewer
        artifact={HTML}
        getBlob={getBlob}
        chrome={chromeOf({ paneWidth: 420 })}
        onShare={onShare}
      />
    );
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    // Narrow: Download moves into the Copy dropdown, the view toggle into ⋯.
    expect(screen.queryByRole('button', { name: 'Download dash.html' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Show code' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledTimes(2);
  });

  it('lists Open in new tab, Show in Files and browser full screen in ⋯', () => {
    const onOpenInNewTab = jest.fn();
    const onShowInFiles = jest.fn();
    renderPane(HTML, { onOpenInNewTab, onShowInFiles });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new tab' }));
    expect(onOpenInNewTab).toHaveBeenCalledWith(HTML);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in files' }));
    expect(onShowInFiles).toHaveBeenCalledWith(HTML);
  });

  it('closes a menu with Escape before anything else, and gives focus back to its button', () => {
    const onKeyDown = jest.fn();
    document.addEventListener('keydown', onKeyDown);
    renderPane(MD);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    const item = screen.getAllByRole('menuitem')[0];
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    // Consumed: the pane underneath never sees this Escape.
    expect(onKeyDown).not.toHaveBeenCalled();
    document.removeEventListener('keydown', onKeyDown);
  });

  it('requests browser full screen on its own container, not inside the frame', async () => {
    document.fullscreenEnabled = true;
    const request = jest.fn().mockResolvedValue(undefined);
    HTMLElement.prototype.requestFullscreen = request;
    renderPane(HTML);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Browser full screen' }));
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.contexts[0]).toBe(screen.getByTestId('artifact-viewer'));
    expect(document.querySelector('iframe')?.getAttribute('allow')).toBeFalsy();
  });

  it('switches files with the title menu', async () => {
    const onSelect = jest.fn();
    renderPane(HTML, {
      chrome: chromeOf({
        switcher: {
          groups: [
            {
              label: 'Generated',
              items: ALL.map(item => ({
                key: item.id,
                name: item.name,
                current: item.id === HTML.id,
                onSelect: () => onSelect(item)
              }))
            }
          ]
        }
      })
    });
    fireEvent.click(screen.getByRole('button', { name: /^dash.html.*switch file/ }));
    expect(screen.getByRole('menuitem', { name: 'dash.html' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'notes.md' }));
    expect(onSelect).toHaveBeenCalledWith(MD);
  });
});

describe('ArtifactViewer as a page', () => {
  it("has no close, expand or back button, and switches between the chat's artifacts", async () => {
    const onSelect = jest.fn();
    render(
      <ArtifactViewer
        mode="page"
        artifact={HTML}
        artifacts={ALL}
        onSelect={onSelect}
        getBlob={getBlob}
      />
    );
    expect(screen.queryByTestId('artifact-viewer-close')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pane-expand')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pane-back')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^dash.html.*switch file/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'chart.png' }));
    expect(onSelect).toHaveBeenCalledWith(PNG);
  });

  it('embed drops the header', () => {
    render(<ArtifactViewer mode="page" embed artifact={HTML} getBlob={getBlob} />);
    expect(screen.queryByTestId('artifact-viewer-toolbar')).not.toBeInTheDocument();
  });
});
