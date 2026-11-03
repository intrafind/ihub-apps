// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/** A generated image (#3184): clicking it opens the viewer, which then works as a lightbox. */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) =>
      String(typeof defaultValue === 'string' ? defaultValue : key).replace(
        /\{\{(\w+)\}\}/g,
        (_, name) => String(options?.[name] ?? '')
      )
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-icon={name} />
}));
jest.mock('../../../client/src/api', () => ({ fetchChatArtifact: jest.fn() }));

const GeneratedImage =
  require('../../../client/src/features/chat/components/GeneratedImage').default;
const ArtifactViewerContext =
  require('../../../client/src/features/chat/contexts/ArtifactViewerContext').default;

describe('GeneratedImage click', () => {
  it('opens a live image in the viewer with its inline bytes', () => {
    const openArtifact = jest.fn();
    const image = { mimeType: 'image/png', data: 'AAAA' };
    render(
      <ArtifactViewerContext.Provider value={{ openArtifact }}>
        <GeneratedImage image={image} chatId="c1" index={0} />
      </ArtifactViewerContext.Provider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open image 1' }));
    expect(openArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', mimeType: 'image/png', data: 'AAAA' })
    );
  });

  it('keeps a plain image where there is no viewer, and Download still works separately', () => {
    render(
      <GeneratedImage image={{ mimeType: 'image/png', data: 'AAAA' }} chatId="c1" index={0} />
    );
    expect(screen.queryByRole('button', { name: 'Open image 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download image' })).toBeInTheDocument();
  });
});
