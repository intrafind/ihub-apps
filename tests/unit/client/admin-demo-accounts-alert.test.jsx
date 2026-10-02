/**
 * Banner shown above every admin page while the login page lists the demo
 * accounts and one of them still has its shipped password: names the
 * accounts, links to Authentication and Users when those pages are enabled,
 * can be dismissed for the session, is checked again on page changes, and
 * stays quiet for content admins, who may not call the endpoint behind it.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));

import AdminDemoAccountsAlert from '../../../client/src/features/admin/components/AdminDemoAccountsAlert';

function respond(status) {
  mockMakeAdminApiCall.mockResolvedValue({ data: status });
}

let navigate;
function NavigateHandle() {
  navigate = useNavigate();
  return null;
}

function renderAlert(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <NavigateHandle />
      <AdminDemoAccountsAlert {...props} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
  sessionStorage.clear();
});

test('names the demo accounts that still have the shipped password and links to the fixes', async () => {
  respond({ showDemoAccounts: true, accounts: ['admin', 'user'], warn: true });
  renderAlert();

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The login page shows the demo accounts, and admin, user still use the password they ship with.'
  );
  expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/auth/demo-accounts');
  expect(screen.getByRole('link', { name: /Authentication settings/ })).toHaveAttribute(
    'href',
    '/admin/auth'
  );
  expect(screen.getByRole('link', { name: /Users/ })).toHaveAttribute('href', '/admin/users');
});

test('shows nothing when there is nothing to warn about', async () => {
  respond({ showDemoAccounts: false, accounts: ['admin'], warn: false });
  renderAlert();

  await waitFor(() => expect(mockMakeAdminApiCall).toHaveBeenCalled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('hides the links to pages that are turned off', async () => {
  respond({ showDemoAccounts: true, accounts: ['admin'], warn: true });
  renderAlert({ authLinkVisible: false, usersLinkVisible: false });

  await screen.findByRole('alert');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('can be dismissed for the session', async () => {
  respond({ showDemoAccounts: true, accounts: ['admin'], warn: true });
  const { unmount } = renderAlert();

  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();

  mockMakeAdminApiCall.mockClear();
  renderAlert();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(mockMakeAdminApiCall).not.toHaveBeenCalled();
});

test('is checked again on a page change and disappears once fixed', async () => {
  respond({ showDemoAccounts: true, accounts: ['admin'], warn: true });
  renderAlert();
  await screen.findByRole('alert');

  respond({ showDemoAccounts: false, accounts: ['admin'], warn: false });
  navigate('/admin/users');
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(mockMakeAdminApiCall).toHaveBeenCalledTimes(2);
});

test('hides the warning when the user is no longer a full admin', async () => {
  respond({ showDemoAccounts: true, accounts: ['admin'], warn: true });
  const { rerender } = renderAlert();
  await screen.findByRole('alert');

  rerender(
    <MemoryRouter initialEntries={['/admin']}>
      <NavigateHandle />
      <AdminDemoAccountsAlert enabled={false} />
    </MemoryRouter>
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('does not call the endpoint for content admins', () => {
  renderAlert({ enabled: false });
  expect(mockMakeAdminApiCall).not.toHaveBeenCalled();
});
