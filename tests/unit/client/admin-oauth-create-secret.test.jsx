// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → OAuth → Clients → New client: the secret of a newly created client
 * is shown once in the SecretRevealDialog (named dialog, read-only field,
 * warning before closing without a copy), like a rotated secret — not in a
 * hand-rolled overlay without dialog semantics.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockMakeAdminApiCall = jest.fn();
const mockNavigate = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ResourceSelector', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ blocker: { state: 'unblocked' }, markSaved: jest.fn() })
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ clientId: 'new' })
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const AdminOAuthClientEditPage =
  require('../../../client/src/features/admin/pages/AdminOAuthClientEditPage').default;

const SECRET = 'example-created-client-secret';

test('creating a client reveals the secret in the SecretRevealDialog and closes after a warning', async () => {
  mockMakeAdminApiCall.mockImplementation(async (url, options) => {
    if (url === '/admin/oauth/clients' && options?.method === 'POST')
      return { data: { client: { clientId: 'client_abc', clientSecret: SECRET } } };
    return { data: [] };
  });

  render(<AdminOAuthClientEditPage />);
  fireEvent.change(screen.getByLabelText(/Client Name/), { target: { value: 'Reporting bot' } });
  await act(async () => {
    fireEvent.submit(screen.getByLabelText(/Client Name/).closest('form'));
  });

  const reveal = await waitFor(() =>
    screen.getByRole('dialog', { name: 'Client "Reporting bot" created' })
  );
  expect(reveal).toHaveAttribute('aria-modal', 'true');
  expect(within(reveal).getByRole('textbox', { name: 'Client Secret' })).toHaveValue(SECRET);
  expect(within(reveal).getByText('client_abc')).toBeInTheDocument();

  // Closing without copying warns once; the second Done leaves the page.
  fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
  expect(within(reveal).getByRole('alert')).toBeInTheDocument();
  expect(mockNavigate).not.toHaveBeenCalled();
  fireEvent.click(within(reveal).getByRole('button', { name: 'Close anyway' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mockNavigate).toHaveBeenCalledWith('/admin/oauth/clients');
});
