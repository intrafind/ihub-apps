// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * After a confirmed delete the row whose button opened the confirmation is
 * gone, so focus must land on a stable element instead of <body>:
 *   - Connected users (a modal): the modal's Close button;
 *   - TTS voices: the "Available voices" heading.
 * Cancel still returns focus to the trigger.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockIntegrationsApi = {
  fetchIntegrationConnections: jest.fn(),
  disconnectIntegrationUser: jest.fn(),
  resetIntegrationRegistration: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchIntegrationConnections: (...a) => mockIntegrationsApi.fetchIntegrationConnections(...a),
  disconnectIntegrationUser: (...a) => mockIntegrationsApi.disconnectIntegrationUser(...a),
  resetIntegrationRegistration: (...a) => mockIntegrationsApi.resetIntegrationRegistration(...a)
}));
const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...a) => mockMakeAdminApiCall(...a),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// The recorder and the speech service pull in browser-only modules.
jest.mock('../../../client/src/utils/audioRecorder', () => ({ AudioBufferRecorder: jest.fn() }));
jest.mock('../../../client/src/utils/wav', () => ({ audioBufferToWav: jest.fn() }));
jest.mock('../../../client/src/features/voice/utils/speechService', () => ({
  getMicrophoneErrorMessage: () => ''
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const IntegrationConnectionsDialog =
  require('../../../client/src/features/admin/components/integrations/IntegrationConnectionsDialog').default;
const TtsVoicesPanel =
  require('../../../client/src/features/admin/components/tts/TtsVoicesPanel').default;
const { enT } = require('./helpers/i18nMock');

/** Lets the focus trap's queued focus restoration run. */
const flush = () => act(async () => {});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Connected users: disconnect', () => {
  const INSTANCE = { id: 'jira', label: 'Jira' };

  async function renderDialog() {
    mockIntegrationsApi.fetchIntegrationConnections.mockResolvedValueOnce([
      { userId: 'alice' },
      { userId: 'bob' }
    ]);
    const utils = render(<IntegrationConnectionsDialog instance={INSTANCE} onClose={jest.fn()} />);
    await screen.findByText('alice');
    const trigger = within(screen.getByText('alice').closest('li')).getByRole('button', {
      name: 'Disconnect'
    });
    trigger.focus();
    fireEvent.click(trigger);
    return { ...utils, trigger };
  }

  const closeButtons = () =>
    within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' });

  it("focuses the modal's Close button once the user is disconnected", async () => {
    const { unmount } = await renderDialog();
    mockIntegrationsApi.disconnectIntegrationUser.mockResolvedValue({});
    mockIntegrationsApi.fetchIntegrationConnections.mockResolvedValueOnce([{ userId: 'bob' }]);
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' })
      );
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await flush();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    // The footer Close button (the last one), not the ✕ in the header.
    const footerClose = closeButtons().at(-1);
    expect(footerClose).toHaveTextContent('Close');
    expect(footerClose).toHaveFocus();
    unmount();
    await flush();
  });

  it('Cancel returns focus to the Disconnect button', async () => {
    const { trigger, unmount } = await renderDialog();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' })
    );
    await flush();
    expect(trigger).toHaveFocus();
    unmount();
    await flush();
  });
});

describe('TTS voices: delete', () => {
  it('focuses the voices heading once the voice is deleted', async () => {
    mockMakeAdminApiCall.mockImplementation(async (url, options) => {
      if (options?.method === 'DELETE') return { data: {} };
      return {
        data: { items: [{ id: 'v1', name: 'My voice', type: 'custom', languages: ['en'] }] }
      };
    });
    const { unmount } = render(
      <TtsVoicesPanel modelId="voxtral" onUseVoice={jest.fn()} t={enT} uiLanguage="en" />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show voices' }));
    });
    const row = screen.getByText('My voice').closest('li');
    const trigger = within(row).getByRole('button', { name: 'Delete' });
    trigger.focus();
    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
      );
    });
    await flush();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText('My voice')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Available voices' })).toHaveFocus();
    unmount();
  });
});

describe('focus target after a delete is visibly focused', () => {
  const fs = require('fs');
  const path = require('path');
  const files = [
    'client/src/features/admin/components/tts/TtsVoicesPanel.jsx',
    'client/src/features/admin/components/AssetManager.jsx',
    'client/src/features/admin/pages/AdminCredentialsPage.jsx',
    'client/src/features/admin/pages/AdminSkillsPage.jsx',
    'client/src/features/admin/pages/AdminMarketplaceRegistriesPage.jsx'
  ];
  it.each(files)('%s gives its focus-target heading a focus-visible ring', file => {
    const source = fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
    // The heading that receives focus after a successful delete (tabIndex -1)
    // hides the default outline, so it must show a keyboard focus ring instead.
    const heading = source.match(
      /ref=\{(?:voices)?[hH]eadingRef\}[\s\S]{0,300}?className="([^"]*)"/
    );
    expect(heading).not.toBeNull();
    expect(heading[1]).toContain('focus-visible:ring-2');
  });
});
