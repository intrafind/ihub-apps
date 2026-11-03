// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The immersive artifact viewer (#3184): a slim toolbar and the artifact
 * filling the rest of the window. HTML stays in a sandboxed frame.
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

function Harness({ start = HTML, onClose = () => {}, extra = {} }) {
  const [current, setCurrent] = require('react').useState(start);
  return (
    <ArtifactViewer
      artifact={current}
      artifacts={ALL}
      onSelect={setCurrent}
      onClose={onClose}
      getBlob={getBlob}
      {...extra}
    />
  );
}

const frameOf = () =>
  waitFor(() => {
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    return frame;
  });

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) }
  });
});

describe('ArtifactViewer', () => {
  it('is a labelled modal dialog with a single slim toolbar row', async () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Artifact: dash.html' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.className).toContain('fixed inset-0');
    const toolbar = screen.getByTestId('artifact-viewer-toolbar');
    // h-12 = 48px, within the 56px budget of the issue.
    expect(toolbar.className).toContain('h-12');
    expect(toolbar.tagName).toBe('HEADER');
    await frameOf();
  });

  it('keeps the HTML frame sandboxed to exactly allow-scripts, under the preview CSP', async () => {
    render(<Harness />);
    const frame = await frameOf();
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame).not.toHaveAttribute('allow');
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Hello</h1>');
    // The frame fills the body: no frame chrome.
    expect(frame.className).toContain('flex-1');
    expect(frame.className).toContain('border-0');
  });

  it('closes with the × button and with Escape, and gives focus back to the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = jest.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close artifact' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('puts initial focus on the close button', async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close artifact' })).toHaveFocus()
    );
  });

  it('steps to the next and previous artifact, wrapping around', async () => {
    render(<Harness />);
    expect(screen.getByTestId('artifact-viewer-position')).toHaveTextContent('1 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }));
    expect(screen.getByTestId('artifact-viewer-name')).toHaveTextContent('notes.md');
    expect(screen.getByTestId('artifact-viewer-position')).toHaveTextContent('2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous artifact' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous artifact' }));
    expect(screen.getByTestId('artifact-viewer-name')).toHaveTextContent('chart.png');
    expect(screen.getByTestId('artifact-viewer-position')).toHaveTextContent('3 of 3');
  });

  it('steps with the arrow keys while focus is in the toolbar', () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close artifact' }), {
      key: 'ArrowRight'
    });
    expect(screen.getByTestId('artifact-viewer-name')).toHaveTextContent('notes.md');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close artifact' }), {
      key: 'ArrowLeft'
    });
    expect(screen.getByTestId('artifact-viewer-name')).toHaveTextContent('dash.html');
  });

  it('toggles between preview and code, and starts each artifact in its preview', async () => {
    render(<Harness />);
    await frameOf();
    const toggle = screen.getByTestId('artifact-viewer-code-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAccessibleName('Show code');

    fireEvent.click(toggle);
    expect(document.querySelector('iframe')).toBeNull();
    expect(await screen.findByLabelText('Content of dash.html')).toHaveTextContent(
      '<h1>Hello</h1>'
    );
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAccessibleName('Show preview');

    // A markdown artifact has no code view: no toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }));
    expect(screen.queryByTestId('artifact-viewer-code-toggle')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous artifact' }));
    await frameOf();
  });

  it('copies text artifacts and offers no copy for a picture', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('artifact-viewer-copy'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<h1>Hello</h1>')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }));
    expect(screen.queryByTestId('artifact-viewer-copy')).not.toBeInTheDocument();
  });

  it('downloads under the file name', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('artifact-viewer-download'));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'dash.html'));
  });

  it('shows Share only when sharing is on offer', () => {
    const onShare = jest.fn();
    const { unmount } = render(<Harness />);
    expect(screen.queryByTestId('artifact-viewer-share')).not.toBeInTheDocument();
    unmount();
    render(<Harness extra={{ onShare }} />);
    fireEvent.click(screen.getByTestId('artifact-viewer-share'));
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  it('has a file menu with the actions of the artifact, closed first by Escape', () => {
    const onClose = jest.fn();
    const onShowInFiles = jest.fn();
    render(<Harness onClose={onClose} extra={{ onShowInFiles }} />);
    const trigger = screen.getByTestId('artifact-viewer-name');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'File actions' });
    expect(menu).toBeInTheDocument();

    // Escape closes the menu, not the viewer.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in files' }));
    expect(onShowInFiles).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  it('leaves Escape to a dialog opened above it (the share dialog)', () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    const above = document.createElement('div');
    above.setAttribute('role', 'dialog');
    const inner = document.createElement('button');
    above.appendChild(inner);
    document.body.appendChild(above);
    inner.focus();
    fireEvent.keyDown(inner, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    above.remove();
  });

  it('exports Markdown as Markdown, HTML and PDF through the shared exporters', async () => {
    render(<Harness start={MD} />);
    fireEvent.click(screen.getByTestId('artifact-viewer-export'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as Markdown' }));
    await waitFor(() =>
      expect(mockExports.exportAsMarkdown).toHaveBeenCalledWith('# Title', 'notes.md')
    );
    fireEvent.click(screen.getByTestId('artifact-viewer-export'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as HTML' }));
    await waitFor(() => expect(mockExports.exportAsHTML).toHaveBeenCalledWith('# Title', 'notes'));
    fireEvent.click(screen.getByTestId('artifact-viewer-export'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PDF' }));
    await waitFor(() => expect(mockExports.exportAsPDF).toHaveBeenCalledWith('# Title', 'notes'));
  });

  it('exports an HTML artifact as its own file, and a picture has no export', async () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByTestId('artifact-viewer-export'));
    expect(screen.queryByRole('menuitem', { name: 'Export as PDF' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as HTML' }));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'dash.html'));
    unmount();
    render(<Harness start={PNG} />);
    expect(screen.queryByTestId('artifact-viewer-export')).not.toBeInTheDocument();
  });

  it('requests browser full screen on its own container, not inside the frame', async () => {
    const requestFullscreen = jest.fn().mockResolvedValue(undefined);
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    dialog.requestFullscreen = requestFullscreen;
    fireEvent.click(screen.getByTestId('artifact-viewer-fullscreen'));
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
    const frame = await frameOf();
    expect(frame).not.toHaveAttribute('allowfullscreen');
  });

  it('offers the Chat toggle only where a chat sits behind it, and splits the window', () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByTestId('artifact-viewer-chat-toggle')).not.toBeInTheDocument();
    unmount();
    render(<Harness extra={{ splitAvailable: true }} />);
    const toggle = screen.getByTestId('artifact-viewer-chat-toggle');
    const dialog = screen.getByRole('dialog');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(dialog.className).toContain('fixed inset-0');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(dialog.className).not.toContain('inset-0');
    expect(dialog.className).toContain('md:w-[60%]');
    // Beside a usable chat it is no longer modal.
    expect(dialog).toHaveAttribute('aria-modal', 'false');

    fireEvent.click(toggle);
    expect(dialog.className).toContain('fixed inset-0');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('page mode has no dialog semantics and no close button; embed drops the toolbar', async () => {
    const { unmount } = render(
      <ArtifactViewer mode="page" artifact={HTML} getBlob={getBlob} toolbarExtra={<b>extra</b>} />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-viewer-close')).not.toBeInTheDocument();
    expect(screen.getByText('extra')).toBeInTheDocument();
    const frame = await frameOf();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    unmount();

    render(<ArtifactViewer mode="page" embed artifact={HTML} getBlob={getBlob} />);
    expect(screen.queryByTestId('artifact-viewer-toolbar')).not.toBeInTheDocument();
    const embedded = await frameOf();
    expect(embedded.getAttribute('sandbox')).toBe('allow-scripts');
  });
});
