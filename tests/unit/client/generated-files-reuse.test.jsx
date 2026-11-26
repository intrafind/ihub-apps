// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The ⋯ menu of a generated file's card: "Use in app…" for stored documents (never ZIP archives,
 * pictures only where the server recognizes their text), "Copy to project…" for every stored file
 * but a picture (a project unpacks a ZIP; a picture only while projects recognize its text), and
 * nothing where the page does not offer them.
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
jest.mock('../../../client/src/api', () => ({ fetchChatArtifact: jest.fn() }));
jest.mock('../../../client/src/utils/externalNavigation', () => ({ saveBlobAs: jest.fn() }));

const GeneratedFiles =
  require('../../../client/src/features/chat/components/GeneratedFiles').default;
const ArtifactViewerContext =
  require('../../../client/src/features/chat/contexts/ArtifactViewerContext').default;

const report = { id: 'f1', name: 'report.md', mimeType: 'text/markdown', stored: true };
const archive = { id: 'f2', name: 'bundle.zip', mimeType: 'application/zip', stored: true };
const picture = { id: 'f3', name: 'chart.png', mimeType: 'image/png', stored: true };
const live = { id: 'f4', name: 'live.md', mimeType: 'text/markdown', data: btoa('x') };

const renderCard = (file, viewer) =>
  render(
    <ArtifactViewerContext.Provider value={{ openArtifact: jest.fn(), ...viewer }}>
      <GeneratedFiles files={[file]} chatId="chat-1" />
    </ArtifactViewerContext.Provider>
  );

const both = () => ({ openArtifactInApp: jest.fn(), copyArtifactToProject: jest.fn() });

const openMenu = () => fireEvent.click(screen.getByTestId('generated-file-more'));

describe('GeneratedFiles reuse menu', () => {
  it('offers both actions for a stored document and hands over the file', () => {
    const viewer = both();
    renderCard(report, viewer);
    openMenu();
    fireEvent.click(screen.getByTestId('generated-file-use-in-app'));
    expect(viewer.openArtifactInApp).toHaveBeenCalledWith(report);
    openMenu();
    fireEvent.click(screen.getByTestId('generated-file-copy-to-project'));
    expect(viewer.copyArtifactToProject).toHaveBeenCalledWith(report);
  });

  it('copies a ZIP archive into a project but does not use it in an app', () => {
    renderCard(archive, both());
    openMenu();
    expect(screen.queryByTestId('generated-file-use-in-app')).not.toBeInTheDocument();
    expect(screen.getByTestId('generated-file-copy-to-project')).toBeInTheDocument();
  });

  it('offers neither for a picture', () => {
    renderCard(picture, both());
    expect(screen.queryByTestId('generated-file-more')).not.toBeInTheDocument();
  });

  it('offers each for a picture where the server recognizes its text there (#3986)', () => {
    renderCard(picture, { ...both(), imageTextRecognition: { apps: true, projects: false } });
    openMenu();
    expect(screen.getByTestId('generated-file-use-in-app')).toBeInTheDocument();
    expect(screen.queryByTestId('generated-file-copy-to-project')).not.toBeInTheDocument();
  });

  it('offers Copy to project for a picture while projects recognize its text', () => {
    renderCard(picture, { ...both(), imageTextRecognition: { apps: false, projects: true } });
    openMenu();
    expect(screen.queryByTestId('generated-file-use-in-app')).not.toBeInTheDocument();
    expect(screen.getByTestId('generated-file-copy-to-project')).toBeInTheDocument();
  });

  it('offers nothing for a live file or where the page does not offer the actions', () => {
    renderCard(live, both());
    expect(screen.queryByTestId('generated-file-more')).not.toBeInTheDocument();
  });

  it('offers nothing without the handlers', () => {
    renderCard(report, {});
    expect(screen.queryByTestId('generated-file-more')).not.toBeInTheDocument();
  });

  it('offers only Copy to project where only that handler is given', () => {
    renderCard(report, { copyArtifactToProject: jest.fn() });
    openMenu();
    expect(screen.queryByTestId('generated-file-use-in-app')).not.toBeInTheDocument();
    expect(screen.getByTestId('generated-file-copy-to-project')).toBeInTheDocument();
  });
});
