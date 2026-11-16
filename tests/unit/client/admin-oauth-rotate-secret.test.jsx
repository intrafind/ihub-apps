// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → OAuth → Clients → Rotate secret (ID-B15): the confirmation names
 * the client, and the new secret is shown once in the SecretRevealDialog
 * with Copy — never in window.alert().
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/OAuthTabsHeader', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useFilterState', () => ({
  useFilterState: (_key, initial) => [initial === 'standard' ? 'all' : initial, jest.fn()]
}));
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const AdminOAuthClientsPage =
  require('../../../client/src/features/admin/pages/AdminOAuthClientsPage').default;

const SECRET = 'new-secret-0123456789';

test('rotating a secret asks with the client named and reveals the secret in a dialog', async () => {
  mockMakeAdminApiCall.mockImplementation(async (url, options) => {
    if (url === '/admin/configs/platform')
      return { data: { oauth: { enabled: { clients: true } } } };
    if (url === '/admin/oauth/clients')
      return {
        data: {
          clients: [{ clientId: 'svc-1', name: 'Reporting bot', active: true }],
          cimdClients: []
        }
      };
    if (url === '/admin/oauth/clients/svc-1/rotate-secret' && options?.method === 'POST')
      return { data: { clientSecret: SECRET } };
    return { data: {} };
  });
  const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});

  render(<AdminOAuthClientsPage />);
  const rotate = await screen.findByTitle('Rotate Secret');
  fireEvent.click(rotate);

  const ask = screen.getByRole('alertdialog', { name: 'Rotate the secret of "Reporting bot"?' });
  expect(mockMakeAdminApiCall.mock.calls.some(([url]) => url.endsWith('/rotate-secret'))).toBe(
    false
  );
  await act(async () => {
    fireEvent.click(within(ask).getByRole('button', { name: 'Rotate secret' }));
  });

  const reveal = await waitFor(() =>
    screen.getByRole('dialog', { name: 'New secret for "Reporting bot"' })
  );
  expect(within(reveal).getByRole('textbox', { name: 'Client Secret' })).toHaveValue(SECRET);
  expect(alertSpy).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});
