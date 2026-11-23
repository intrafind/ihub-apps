// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Security has several sections that load and save on their own. They share ONE bottom
 * bar: none until a section holds an unsaved edit, Discard resets every dirty section, Save
 * saves the dirty sections in the order of the page and stops at the first one that fails, and
 * the failing section's error shows next to the bar. The frame draws no bar of its own.
 *
 * Real sections (SSL, Cookies) and real dirty tracking; the sections that are not under test are
 * stubbed.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || '',
  makeAdminApiCall: (...args) => mockApi(...args)
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UnsavedChangesDialog', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
for (const name of [
  'CorsConfig',
  'ProxyConfig',
  'SsrfConfig',
  'RateLimitConfig',
  'ToolApprovalConfig'
]) {
  jest.mock(`../../../client/src/features/admin/components/${name}`, () => ({
    __esModule: true,
    default: () => null
  }));
}

const en = require('../../../shared/i18n/en.json');
const AdminSecurityPage =
  require('../../../client/src/features/admin/pages/AdminSecurityPage').default;

const SSL_URL = '/admin/ssl/config';
const PLATFORM_URL = '/admin/configs/platform';

let writes;
let failSsl;

function answerApi() {
  writes = [];
  mockApi.mockImplementation(async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') {
      writes.push({ url, method, body: options.body });
      if (url === SSL_URL && failSsl) throw new Error('SSL write refused');
      return { data: {} };
    }
    if (url === SSL_URL) return { data: { ignoreInvalidCertificates: false, domainWhitelist: [] } };
    if (url === PLATFORM_URL) return { data: { cookieSettings: { disableSecure: false } } };
    return { data: {} };
  });
}

const bars = () => screen.queryAllByRole('region', { name: en.admin.ui.saveBar.label });
const bar = () => bars()[0];
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const discardButton = () =>
  within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard });

const cookieBox = () => screen.getByRole('checkbox');
const sslSwitch = () => screen.getByRole('switch');

async function renderPage() {
  render(
    <MemoryRouter>
      <AdminSecurityPage />
    </MemoryRouter>
  );
  // Both real sections are loaded once their controls are there.
  await screen.findByRole('checkbox');
  await screen.findByRole('switch');
}

beforeAll(() => {
  // The frame's section nav watches which section is in view; jsdom has no observer.
  global.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  failSsl = false;
  answerApi();
});

describe('Security page save bar', () => {
  test('shows no bar until a section has an unsaved edit', async () => {
    await renderPage();

    expect(bars()).toHaveLength(0);

    fireEvent.click(cookieBox());

    expect(bars()).toHaveLength(1);
    expect(screen.getByText(en.admin.ui.saveBar.unsaved)).toBeInTheDocument();
  });

  test('is one bar for the whole page, however many sections changed', async () => {
    await renderPage();

    fireEvent.click(cookieBox());
    fireEvent.click(sslSwitch());

    expect(bars()).toHaveLength(1);
  });

  test('the bar goes when the edit is put back', async () => {
    await renderPage();

    fireEvent.click(cookieBox());
    expect(bars()).toHaveLength(1);
    fireEvent.click(cookieBox());

    expect(bars()).toHaveLength(0);
  });

  test('Discard resets every changed section and removes the bar', async () => {
    await renderPage();

    fireEvent.click(cookieBox());
    fireEvent.click(sslSwitch());
    fireEvent.click(discardButton());

    expect(bars()).toHaveLength(0);
    expect(cookieBox()).not.toBeChecked();
    expect(writes).toEqual([]);
  });

  test('Save writes the changed sections in page order and leaves the others alone', async () => {
    await renderPage();

    fireEvent.click(cookieBox());
    fireEvent.click(sslSwitch());
    fireEvent.click(saveButton());

    await waitFor(() => expect(bars()).toHaveLength(0));
    expect(writes.map(write => [write.method, write.url])).toEqual([
      ['PUT', SSL_URL],
      ['PATCH', PLATFORM_URL]
    ]);
    expect(writes[0].body).toEqual(expect.objectContaining({ ignoreInvalidCertificates: true }));
  });

  test('Save writes only the section that changed', async () => {
    await renderPage();

    fireEvent.click(cookieBox());
    fireEvent.click(saveButton());

    await waitFor(() => expect(bars()).toHaveLength(0));
    expect(writes.map(write => write.url)).toEqual([PLATFORM_URL]);
  });

  test('a section that fails to save stops the run, keeps the bar and shows its error', async () => {
    failSsl = true;
    await renderPage();

    fireEvent.click(cookieBox());
    fireEvent.click(sslSwitch());
    fireEvent.click(saveButton());

    expect(await within(bar()).findByText('SSL write refused')).toBeInTheDocument();
    // The section after the failing one was not written, and both are still pending.
    expect(writes.map(write => write.url)).toEqual([SSL_URL]);
    expect(bars()).toHaveLength(1);

    // Once the cause is gone, a second Save finishes the job.
    failSsl = false;
    fireEvent.click(saveButton());

    await waitFor(() => expect(bars()).toHaveLength(0));
    expect(writes.map(write => write.url)).toEqual([SSL_URL, SSL_URL, PLATFORM_URL]);
  });
});
