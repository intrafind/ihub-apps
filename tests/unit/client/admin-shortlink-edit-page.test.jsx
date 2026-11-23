// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

// `runtimeBasePath.js` reads `import.meta`, which jest cannot load; the base
// path is set per test instead.
let mockBasePath = '';
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => mockBasePath
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
  // Always dirty: the page's save bar is shown only for unsaved changes.
  useUnsavedChanges: () => ({
    blocker: { state: 'unblocked' },
    markSaved: jest.fn(),
    isDirty: true
  })
}));

/** The save bar's primary button (the last one; Discard comes first) submits the form. */
function clickBarSave() {
  const bar = screen.getByRole('region', { name: /save changes/i });
  const buttons = within(bar).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]);
}

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
  mockBasePath = '';
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

  clickBarSave();
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

const savedBody = () => makeAdminApiCall.mock.calls.at(-1)[1].body;
const preview = () => screen.getByTestId('shortlink-target-preview').textContent;

test('a new link adds its params (a prefilled prompt) and shows where it leads (CU-B2)', async () => {
  await renderPage();
  fireEvent.focus(screen.getByPlaceholderText('Search apps...'));
  fireEvent.click(screen.getByRole('button', { name: /^Chat$/ }));
  fireEvent.change(screen.getByLabelText('Params (JSON)'), {
    target: { value: '{"prefill":"Hello there"}' }
  });
  expect(preview()).toBe('/apps/chat?prefill=Hello+there');

  clickBarSave();
  await flush();
  expect(savedBody()).toMatchObject({
    appId: 'chat',
    includeParams: true,
    params: { prefill: 'Hello there' }
  });
});

test('params left out by "Include Params" are called out', async () => {
  await renderPage();
  fireEvent.change(screen.getByLabelText('Params (JSON)'), {
    target: { value: '{"prefill":"Hi"}' }
  });
  expect(screen.queryByText(/not added to the link/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Include Params'));
  expect(screen.getByText(/not added to the link/)).toBeInTheDocument();
  expect(preview()).toBe('/');
});

test('the params warning is announced and describes the fields it is about (R7)', async () => {
  await renderPage();
  fireEvent.change(screen.getByLabelText('Params (JSON)'), {
    target: { value: '{"prefill":"Hi"}' }
  });
  // The warning's own live region (the save bar has a status line of its own).
  const status = document.getElementById('shortlink-params-left-out');
  expect(status).toBeEmptyDOMElement();
  expect(screen.getByLabelText('Params (JSON)')).not.toHaveAttribute('aria-describedby');

  fireEvent.click(screen.getByLabelText('Include Params'));
  expect(status).toHaveTextContent(/not added to the link/);
  expect(screen.getByLabelText('Params (JSON)')).toHaveAccessibleDescription(
    /not added to the link/
  );
  expect(screen.getByLabelText('Include Params')).toHaveAccessibleDescription(
    /not added to the link/
  );
});

test('under a base path, "Opens:" shows where the visitor really lands (R7)', async () => {
  mockBasePath = '/ihub';
  makeAdminApiCall.mockResolvedValueOnce({
    data: { code: 'abc', appId: 'chat', url: '/apps/chat', includeParams: false, params: {} }
  });
  await renderPage('/admin/shortlinks/abc');
  expect(preview()).toBe('/ihub/apps/chat');

  // A target that already has the base path, or names another host, is shown as stored.
  fireEvent.change(screen.getByLabelText('Redirect URL'), {
    target: { value: '/ihub/pages/faq' }
  });
  expect(preview()).toBe('/ihub/pages/faq');
  fireEvent.change(screen.getByLabelText('Redirect URL'), {
    target: { value: 'https://docs.example.com/x' }
  });
  expect(preview()).toBe('https://docs.example.com/x');
});

test('editing a link built from its app sends no stale target, so a new app takes effect (CU-B1)', async () => {
  makeAdminApiCall.mockResolvedValueOnce({
    data: { code: 'abc', appId: 'chat', url: '/apps/chat', includeParams: false, params: {} }
  });
  await renderPage('/admin/shortlinks/abc');
  // The built target is not a custom Redirect URL.
  expect(screen.getByLabelText('Redirect URL')).toHaveValue('');
  expect(preview()).toBe('/apps/chat');

  fireEvent.focus(screen.getByPlaceholderText('Search apps...'));
  fireEvent.click(screen.getByRole('button', { name: /Email Composer/ }));
  expect(preview()).toBe('/apps/email-composer');

  clickBarSave();
  await flush();
  expect(makeAdminApiCall).toHaveBeenLastCalledWith(
    '/shortlinks/abc',
    expect.objectContaining({ method: 'PUT' })
  );
  expect(savedBody()).toMatchObject({ appId: 'email-composer', url: '' });
});

test('a custom redirect URL stays in its field and wins', async () => {
  makeAdminApiCall.mockResolvedValueOnce({
    data: { code: 'abc', appId: 'chat', url: '/pages/faq', includeParams: false, params: {} }
  });
  await renderPage('/admin/shortlinks/abc');
  expect(screen.getByLabelText('Redirect URL')).toHaveValue('/pages/faq');
  expect(preview()).toBe('/pages/faq');
});
