// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminShortLinkEditPage from '../../../client/src/features/admin/pages/AdminShortLinkEditPage';
import { fetchAdminApps, makeAdminApiCall } from '../../../client/src/api/adminApi';

/**
 * The short link editor picks the app from a search box, like the other admin
 * pages, and says that links to other websites need the SSRF allowlist.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  fetchAdminApps: jest.fn()
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => <nav data-testid="breadcrumb" />
}));

jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ blocker: { state: 'unblocked' }, markSaved: jest.fn() })
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage(path = '/admin/shortlinks/new') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/shortlinks/:code" element={<AdminShortLinkEditPage />} />
        <Route path="/admin/shortlinks" element={<p>list</p>} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchAdminApps.mockResolvedValue([
    { id: 'chat', name: { en: 'Chat' } },
    { id: 'email-composer', name: { en: 'Email Composer' } }
  ]);
  makeAdminApiCall.mockResolvedValue({ data: {} });
});

test('the app is picked from a search box and saved by its id', async () => {
  await renderPage();
  const search = screen.getByPlaceholderText('Search apps...');
  expect(screen.getByText('No app selected')).toBeInTheDocument();

  fireEvent.focus(search);
  fireEvent.change(search, { target: { value: 'mail' } });
  expect(screen.queryByRole('button', { name: /^Chat$/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Email Composer/ }));
  expect(screen.getByText('Email Composer')).toBeInTheDocument();

  // Picking another app replaces the first: a link opens one app.
  fireEvent.focus(search);
  fireEvent.click(screen.getByRole('button', { name: /^Chat$/ }));
  expect(screen.queryByText('Email Composer')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await flush();
  expect(makeAdminApiCall).toHaveBeenCalledWith(
    '/shortlinks',
    expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ appId: 'chat' })
    })
  );
});

test('an app id that is no longer configured stays visible', async () => {
  makeAdminApiCall.mockResolvedValueOnce({
    data: { code: 'abc', appId: 'retired-app', url: '/apps/retired-app' }
  });
  await renderPage('/admin/shortlinks/abc');
  expect(screen.getByText('retired-app')).toBeInTheDocument();
});

test('the redirect URL says that other websites need the SSRF allowlist', async () => {
  await renderPage();
  expect(screen.getByText(/only when its host is on the SSRF allowlist/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Admin → Security → SSRF Allowlist' })).toHaveAttribute(
    'href',
    '/admin/security#settings-section-ssrf'
  );
});
