// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

/**
 * The workspace pane host: `openArtifact` / `openFiles` for everything below it, the open
 * item mirrored into the chat URL (`?artifact=`, `?files=`, `&view=full`), one history
 * entry per level so Back steps out one level at a time, Esc innermost-first, focus moves,
 * and the docked split versus the full-screen sheet below 1024px.
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
const mockFetchChatArtifact = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchChatArtifact: (...args) => mockFetchChatArtifact(...args)
}));
jest.mock('../../../client/src/utils/externalNavigation', () => ({
  saveBlobAs: jest.fn(() => true),
  openExternalUrl: jest.fn()
}));
jest.mock('../../../client/src/config/marked.config', () => ({
  highlightCode: code => code,
  renderMarkdown: text => `<p>${text}</p>`
}));
jest.mock('../../../client/src/utils/mermaidSecurity', () => ({ sanitizeMermaidSvg: s => s }));

const ArtifactViewerHost =
  require('../../../client/src/features/chat/components/ArtifactViewerHost').default;
const WorkspaceLayout =
  require('../../../client/src/features/workspace/components/WorkspaceLayout').default;
const {
  useArtifactViewer
} = require('../../../client/src/features/chat/contexts/ArtifactViewerContext');
const {
  WORKSPACE_PANE_EVENT
} = require('../../../client/src/features/workspace/utils/workspaceState');

// jsdom's Blob has no text(); the bytes of a live file are read through one.
if (!Blob.prototype.text) {
  Blob.prototype.text = function text() {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(this);
    });
  };
}

/** The viewport the pane sees: wide (split) or narrow (sheet). */
function setViewport(wide) {
  window.matchMedia = query => ({
    matches: /min-width/.test(query) ? wide : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
}

const stored = { id: 'f1', name: 'a.html', mimeType: 'text/html', stored: true };
const second = { id: 'f2', name: 'b.html', mimeType: 'text/html', stored: true };
const liveFile = {
  id: 'f9',
  name: 'live.html',
  mimeType: 'text/html',
  data: btoa('<p>live</p>')
};
const messages = [{ role: 'assistant', generatedFiles: [stored, second, liveFile] }];

function Opener({ file }) {
  const viewer = useArtifactViewer();
  return (
    <button type="button" onClick={() => viewer.openArtifact(file)}>
      open {file.name}
    </button>
  );
}
function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">{location.pathname + location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        back
      </button>
    </>
  );
}

const blobOf = text => {
  const blob = new Blob([text]);
  blob.text = async () => text;
  return blob;
};

function mount(entry = '/chat', { onShare = null } = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="*"
          element={
            <ArtifactViewerHost messages={messages} chatId="chat-1" inline onShare={onShare}>
              <WorkspaceLayout>
                <Where />
                <Opener file={stored} />
                <Opener file={liveFile} />
                <form data-f6-region="composer">
                  <textarea aria-label="Message" />
                </form>
              </WorkspaceLayout>
            </ArtifactViewerHost>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const where = () => screen.getByTestId('where').textContent;
const pane = () => screen.queryByTestId('workspace-pane');
const nextFrame = () => act(() => new Promise(resolve => requestAnimationFrame(() => resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  setViewport(true);
  mockFetchChatArtifact.mockResolvedValue(blobOf('<p>stored</p>'));
});

describe('ArtifactViewerHost: docked pane', () => {
  it('opens a stored artifact docked next to the chat, in the URL, fetched by id', async () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    const region = screen.getByRole('region', { name: 'Workspace: a.html' });
    expect(region).toHaveAttribute('data-state', 'docked');
    // Not modal: no dialog, no aria-modal.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize workspace' })).toBeInTheDocument();
    expect(where()).toBe('/chat?artifact=f1');
    await waitFor(() => expect(mockFetchChatArtifact).toHaveBeenCalledWith('chat-1', 'f1'));
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    // The sandbox is exactly what it was.
    expect(document.querySelector('iframe').getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('moves focus to the pane heading, and back to the opener on close', async () => {
    mount();
    const opener = screen.getByText('open a.html');
    opener.focus();
    fireEvent.click(opener);
    await nextFrame();
    expect(document.activeElement).toHaveAttribute('id', 'workspace-pane-heading');
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    await nextFrame();
    expect(pane()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('opens a live-turn file from its inline bytes, without a request or a URL entry', async () => {
    mount();
    fireEvent.click(screen.getByText('open live.html'));
    expect(screen.getByRole('region', { name: 'Workspace: live.html' })).toBeInTheDocument();
    expect(where()).toBe('/chat');
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(mockFetchChatArtifact).not.toHaveBeenCalled();
    expect(screen.queryByTestId('artifact-viewer-share')).not.toBeInTheDocument();
  });

  it('closing a pane it opened goes Back, and Back closes it', () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    expect(pane()).not.toBeInTheDocument();
    expect(where()).toBe('/chat');

    fireEvent.click(screen.getByText('open a.html'));
    expect(pane()).toBeInTheDocument();
    fireEvent.click(screen.getByText('back'));
    expect(pane()).not.toBeInTheDocument();
  });

  it('full screen is one more history entry: Back steps full → docked → closed', () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    const viewer = screen.getByTestId('artifact-viewer');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(where()).toBe('/chat?artifact=f1&view=full');
    expect(pane()).toHaveAttribute('data-state', 'full');
    // The chat column hides, the viewer is the same element: not remounted.
    expect(screen.getByTestId('workspace-chat-column')).not.toBeVisible();
    expect(screen.getByTestId('artifact-viewer')).toBe(viewer);

    fireEvent.click(screen.getByText('back'));
    expect(pane()).toHaveAttribute('data-state', 'docked');
    expect(screen.getByTestId('artifact-viewer')).toBe(viewer);
    fireEvent.click(screen.getByText('back'));
    expect(pane()).not.toBeInTheDocument();
  });

  it('closing from full screen undoes both entries', () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    expect(pane()).not.toBeInTheDocument();
    expect(where()).toBe('/chat');
  });

  it('switching items replaces the entry: one Back still closes', async () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.click(screen.getByRole('button', { name: 'a.html, switch file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'b.html' }));
    expect(where()).toBe('/chat?artifact=f2');
    expect(screen.getByRole('region', { name: 'Workspace: b.html' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('back'));
    expect(pane()).not.toBeInTheDocument();
  });

  it('the back link of a detail goes to the Files index, in place', () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Files' }));
    expect(where()).toBe('/chat?files=generated');
    expect(screen.getByRole('region', { name: 'Workspace: Files' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Generated/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByText('back'));
    expect(pane()).not.toBeInTheDocument();
  });

  it('a deep link opens the pane, and closing drops only its parameters', async () => {
    mount('/chat?artifact=f1&view=full&x=1');
    expect(await screen.findByRole('region', { name: 'Workspace: a.html' })).toHaveAttribute(
      'data-state',
      'full'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    expect(pane()).not.toBeInTheDocument();
    expect(where()).toBe('/chat?x=1');
  });

  it('a link to an artifact the chat does not have shows that it is gone, not an error', () => {
    mount('/chat?artifact=missing');
    expect(screen.getByTestId('workspace-item-gone')).toHaveTextContent(
      'This file is no longer available in this chat.'
    );
  });

  it('Esc leaves full screen first, then closes; Esc in the composer does nothing', async () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    const composer = screen.getByRole('textbox', { name: 'Message', hidden: true });
    // The composer is in the (hidden) chat column: Esc there is the composer's.
    composer.focus();
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(pane()).toHaveAttribute('data-state', 'full');

    const heading = document.getElementById('workspace-pane-heading');
    heading.focus();
    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(pane()).toHaveAttribute('data-state', 'docked');
    fireEvent.keyDown(document.getElementById('workspace-pane-heading'), { key: 'Escape' });
    expect(pane()).not.toBeInTheDocument();
  });

  it('Esc outside the pane is left to the page', () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    const opener = screen.getByText('open live.html');
    opener.focus();
    fireEvent.keyDown(opener, { key: 'Escape' });
    expect(pane()).toBeInTheDocument();
  });

  it('Ctrl+. opens the Files index and closes the pane again', () => {
    mount();
    fireEvent.keyDown(document.body, { key: '.', ctrlKey: true });
    expect(screen.getByRole('region', { name: 'Workspace: Files' })).toBeInTheDocument();
    expect(where()).toBe('/chat?files=');
    fireEvent.keyDown(document.body, { key: '.', metaKey: true });
    expect(pane()).not.toBeInTheDocument();
  });

  it('Ctrl+Shift+E toggles full screen', () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.keyDown(document.body, { key: 'E', ctrlKey: true, shiftKey: true });
    expect(pane()).toHaveAttribute('data-state', 'full');
    fireEvent.keyDown(document.body, { key: 'E', ctrlKey: true, shiftKey: true });
    expect(pane()).toHaveAttribute('data-state', 'docked');
  });

  it('F6 moves between the composer and the pane', async () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    await nextFrame();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    // jsdom has no layout: every region counts as visible.
    composer.focus();
    fireEvent.keyDown(composer, { key: 'F6' });
    expect(document.activeElement).toHaveAttribute('id', 'workspace-pane-heading');
    fireEvent.keyDown(document.activeElement, { key: 'F6', shiftKey: true });
    expect(document.activeElement).toBe(composer);
  });

  it('tells the sidebar when a docked pane opens and closes', () => {
    const events = [];
    const listener = event => events.push(event.detail.open);
    window.addEventListener(WORKSPACE_PANE_EVENT, listener);
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }));
    window.removeEventListener(WORKSPACE_PANE_EVENT, listener);
    expect(events).toEqual([true, false]);
  });

  it('offers Share for a stored artifact where the page allows it', () => {
    const onShare = jest.fn();
    mount('/chat', { onShare });
    fireEvent.click(screen.getByText('open a.html'));
    // The jsdom row has no width: Share sits in ⋯.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });
});

describe('ArtifactViewerHost: narrow viewport', () => {
  it('opens a full-screen sheet with a focus trap and "Back to chat"', async () => {
    setViewport(false);
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    const sheet = screen.getByRole('dialog', { name: 'Workspace: a.html' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Full screen' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(where()).toBe('/chat');
  });
});
