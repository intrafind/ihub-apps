// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

/**
 * The viewer host (#3184): `openArtifact` for everything below it, and the
 * open artifact mirrored into the chat URL as `?artifact=<id>`.
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
const {
  useArtifactViewer
} = require('../../../client/src/features/chat/contexts/ArtifactViewerContext');

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

const stored = { id: 'f1', name: 'a.html', mimeType: 'text/html', stored: true };
const liveFile = {
  id: 'f9',
  name: 'live.html',
  mimeType: 'text/html',
  data: btoa('<p>live</p>')
};
const messages = [{ role: 'assistant', generatedFiles: [stored, liveFile] }];

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

function mount(entry = '/chat') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="*"
          element={
            <ArtifactViewerHost messages={messages} chatId="chat-1">
              <Where />
              <Opener file={stored} />
              <Opener file={liveFile} />
            </ArtifactViewerHost>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchChatArtifact.mockResolvedValue(blobOf('<p>stored</p>'));
});

describe('ArtifactViewerHost', () => {
  it('opens a stored artifact, records it in the URL and fetches it by id', async () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    expect(screen.getByRole('dialog', { name: 'Artifact: a.html' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/chat?artifact=f1');
    await waitFor(() => expect(mockFetchChatArtifact).toHaveBeenCalledWith('chat-1', 'f1'));
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(document.querySelector('iframe').getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('opens a live-turn file from its inline bytes, without a request or a URL entry', async () => {
    mount();
    fireEvent.click(screen.getByText('open live.html'));
    expect(screen.getByRole('dialog', { name: 'Artifact: live.html' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/chat$/);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(mockFetchChatArtifact).not.toHaveBeenCalled();
    // Live files cannot be shared or opened in a tab: no such actions.
    expect(screen.queryByTestId('artifact-viewer-share')).not.toBeInTheDocument();
  });

  it('closing a viewer it opened goes Back, and Back closes it', () => {
    mount();
    fireEvent.click(screen.getByText('open a.html'));
    fireEvent.click(screen.getByRole('button', { name: 'Close artifact' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/chat$/);

    fireEvent.click(screen.getByText('open a.html'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('back'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a deep link ?artifact=<id> opens the viewer, and closing drops the parameter', async () => {
    mount('/chat?artifact=f1&x=1');
    expect(await screen.findByRole('dialog', { name: 'Artifact: a.html' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close artifact' }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/chat?x=1');
  });

  it('a deep link to an artifact the chat does not have opens nothing', () => {
    mount('/chat?artifact=missing');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stepping to a live file drops ?artifact=, and closing clears it', async () => {
    mount('/chat?artifact=f1');
    expect(await screen.findByRole('dialog', { name: 'Artifact: a.html' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/chat$/));
    expect(screen.getByRole('dialog', { name: 'Artifact: live.html' })).toBeInTheDocument();
  });
});
