// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The cards of generated files (#3184): a file with a preview opens in the
 * viewer when the card is clicked; Download stays a separate button; a file
 * without a preview (Office, ZIP) only downloads.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      String(typeof defaultValue === 'string' ? defaultValue : key).replace(
        /\{\{(\w+)\}\}/g,
        (_, name) => String(options?.[name] ?? '')
      )
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
  saveBlobAs: jest.fn(() => true)
}));

const { saveBlobAs } = require('../../../client/src/utils/externalNavigation');
const GeneratedFiles =
  require('../../../client/src/features/chat/components/GeneratedFiles').default;
const ArtifactViewerContext =
  require('../../../client/src/features/chat/contexts/ArtifactViewerContext').default;

const dashboard = {
  id: 'f1',
  name: 'dashboard.html',
  mimeType: 'text/plain',
  bytes: 2048,
  stored: true
};
const report = {
  id: 'f2',
  name: 'report.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  bytes: 5000,
  stored: true
};
const live = {
  id: 'f3',
  name: 'live.svg',
  mimeType: 'image/svg+xml',
  bytes: 10,
  data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')
};

const renderWith = (files, openArtifact = jest.fn()) => {
  render(
    <ArtifactViewerContext.Provider value={{ openArtifact }}>
      <GeneratedFiles files={files} chatId="chat-1" />
    </ArtifactViewerContext.Provider>
  );
  return openArtifact;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchChatArtifact.mockResolvedValue(new Blob(['x']));
});

describe('GeneratedFiles cards', () => {
  it('opens a previewable file in the viewer when the card is clicked', () => {
    const openArtifact = renderWith([dashboard]);
    const open = screen.getByTestId('generated-file-open');
    expect(open.className).toContain('cursor-pointer');
    expect(screen.getByText('Open')).toBeInTheDocument();
    fireEvent.click(open);
    expect(openArtifact).toHaveBeenCalledTimes(1);
    expect(openArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
    expect(mockFetchChatArtifact).not.toHaveBeenCalled();
  });

  it('keeps Download separate: it downloads and does not open the viewer', async () => {
    const openArtifact = renderWith([dashboard]);
    fireEvent.click(screen.getByRole('button', { name: 'Download dashboard.html' }));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledTimes(1));
    expect(mockFetchChatArtifact).toHaveBeenCalledWith('chat-1', 'f1');
    expect(openArtifact).not.toHaveBeenCalled();
  });

  it('gives a file without a preview no open action: it only downloads', async () => {
    const openArtifact = renderWith([report]);
    expect(screen.queryByTestId('generated-file-open')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download report.docx' }));
    await waitFor(() => expect(saveBlobAs).toHaveBeenCalledTimes(1));
    expect(openArtifact).not.toHaveBeenCalled();
  });

  it('opens a live-turn file with its bytes inline', () => {
    const openArtifact = renderWith([live]);
    fireEvent.click(screen.getByTestId('generated-file-open'));
    expect(openArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f3', data: live.data })
    );
  });

  it('stays a plain card where there is no viewer', () => {
    render(<GeneratedFiles files={[dashboard]} chatId="chat-1" />);
    expect(
      screen.queryByRole('button', { name: /^dashboard\.html.*Open/ })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download dashboard.html' })).toBeInTheDocument();
  });

  it('does not open a file the chat no longer has', () => {
    const openArtifact = renderWith([{ ...dashboard, stored: false, unavailable: 'expired' }]);
    expect(screen.queryByTestId('generated-file-open')).not.toBeInTheDocument();
    expect(openArtifact).not.toHaveBeenCalled();
  });
});
