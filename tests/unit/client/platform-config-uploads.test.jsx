// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The composer pre-uploads documents to the chat's file store only when
 * `platformConfig.uploads.enabled` is true (`preUploadAvailable`). The real
 * `PlatformConfigProvider` assembles that object by hand from
 * `/api/configs/platform`; when it dropped `uploads`, every document went
 * inline with the message, the server kept its text only ("Text only", no
 * original) and the Files drawer had no uploaded file to list. This goes
 * through the real provider.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPlatform = { current: {} };
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAuthStatus: () => Promise.resolve({ authMode: 'local', authMethods: {} }),
  fetchUIConfig: () => Promise.resolve({}),
  fetchPlatformConfig: () => Promise.resolve(mockPlatform.current),
  invalidateAuthStatusCache: () => {},
  invalidatePlatformConfigCache: () => {},
  invalidateUIConfigCache: () => {}
}));

const {
  PlatformConfigProvider,
  usePlatformConfig
} = require('../../../client/src/shared/contexts/PlatformConfigContext');
const {
  preUploadAvailable,
  resolveUploadMode
} = require('../../../client/src/features/chat/utils/chatFileUpload');

function Probe() {
  const { platformConfig, isLoading } = usePlatformConfig();
  if (isLoading || !platformConfig) return <div data-testid="probe">loading</div>;
  const uploads = platformConfig.uploads;
  return (
    <div data-testid="probe">
      {String(preUploadAvailable({ uploads, chatId: 'chat-1' }))}/{resolveUploadMode(uploads)}
    </div>
  );
}

const renderProbe = () =>
  render(
    <PlatformConfigProvider>
      <Probe />
    </PlatformConfigProvider>
  );

test('hands the uploads block of the server to the composer', async () => {
  mockPlatform.current = { uploads: { enabled: true, storageMode: 'original_and_text' } };
  renderProbe();
  await waitFor(() =>
    expect(screen.getByTestId('probe')).toHaveTextContent('true/original_and_text')
  );
});

test('does not pre-upload when the server keeps no chat files', async () => {
  mockPlatform.current = { uploads: { enabled: false, storageMode: 'original_and_text' } };
  renderProbe();
  await waitFor(() =>
    expect(screen.getByTestId('probe')).toHaveTextContent('false/original_and_text')
  );
});
