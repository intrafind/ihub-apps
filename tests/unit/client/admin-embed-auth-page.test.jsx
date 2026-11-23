// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Integrations → iHub in another site (`AdminEmbedAuthPage`).
 *
 * Locked in here:
 * - no form and no Save until the settings loaded (a failed load must never save an empty list),
 * - an origin is checked like the server does, added once, and a half-typed one is saved too,
 * - Save sends `{ enabled, allowedHostOrigins }`, shows the answer, and the bar goes away,
 * - a failed save keeps the bar and names the error,
 * - the notices: switch on without a site, switch off with a list, an `http:` site.
 *
 * Real dirty tracking and load gate; the admin API is stubbed.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockApi(...args),
  getAdminApiErrorMessage: err => err?.message || ''
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path,
  buildApiUrl: path => `/api/${path}`,
  KNOWN_ROUTES: []
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const en = require('../../../shared/i18n/en.json');
const AdminEmbedAuthPage =
  require('../../../client/src/features/admin/pages/AdminEmbedAuthPage').default;
const {
  canonicalizeOrigin
} = require('../../../client/src/features/admin/pages/AdminEmbedAuthPage');

const CONFIG_URL = '/admin/embed-auth/config';
const HOST = 'https://ifinder.example.com';

let stored;
let failLoad;
let failSave;

const setUpApi = () => {
  mockApi.mockImplementation(async (url, options = {}) => {
    if (url !== CONFIG_URL) throw new Error(`unexpected admin call: ${url}`);
    if (options.method === 'PUT') {
      if (failSave) throw new Error('boom');
      stored = { ...options.body };
      return {
        data: { ...stored, active: stored.enabled && stored.allowedHostOrigins.length > 0 }
      };
    }
    if (failLoad) throw new Error('offline');
    return { data: { ...stored, active: false } };
  });
};

const flush = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const renderPage = async () => {
  render(
    <MemoryRouter>
      <AdminEmbedAuthPage />
    </MemoryRouter>
  );
  if (!failLoad) await screen.findByLabelText('Site address');
  await flush();
};

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const saveButton = () => within(bar()).getAllByRole('button').at(-1);
const discardButton = () => within(bar()).getAllByRole('button')[0];
const putBody = () =>
  mockApi.mock.calls.find(([url, options]) => url === CONFIG_URL && options?.method === 'PUT')?.[1]
    .body;
const input = () => screen.getByLabelText('Site address');
const typeOrigin = value => fireEvent.change(input(), { target: { value } });
const clickAdd = () => fireEvent.click(screen.getByRole('button', { name: 'Add' }));
const save = async () => {
  await act(async () => {
    fireEvent.click(saveButton());
  });
  await flush();
};

beforeEach(() => {
  jest.clearAllMocks();
  stored = { enabled: true, allowedHostOrigins: [HOST] };
  failLoad = false;
  failSave = false;
  setUpApi();
});

describe('canonicalizeOrigin (the check of the page, the same as the server)', () => {
  test.each([
    ['https://IFinder.example.com/', HOST],
    ['  https://ifinder.example.com  ', HOST],
    ['http://localhost:3000', 'http://localhost:3000']
  ])('accepts %s', (raw, expected) => {
    expect(canonicalizeOrigin(raw)).toBe(expected);
  });

  test.each([
    'https://ifinder.example.com/app',
    'https://ifinder.example.com/?x=1',
    'https://ifinder.example.com/#top',
    'https://user:pass@ifinder.example.com',
    'ftp://ifinder.example.com',
    'javascript:alert(1)',
    'ifinder',
    '  ',
    '',
    42,
    null
  ])('refuses %p', raw => {
    expect(canonicalizeOrigin(raw)).toBeNull();
  });
});

describe('AdminEmbedAuthPage', () => {
  test('shows the stored switch and sites, with no bar for a page that was just loaded', async () => {
    await renderPage();

    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByText(HOST)).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/admin\.embedAuth/);
  });

  test('links back to the integrations', async () => {
    await renderPage();

    expect(screen.getByRole('link', { name: /Back to Integrations/ })).toHaveAttribute(
      'href',
      '/admin/integrations'
    );
  });

  test('a site is added in its canonical form, once, and the bar shows', async () => {
    await renderPage();

    typeOrigin('https://Portal.example.com/');
    clickAdd();
    expect(screen.getByText('https://portal.example.com')).toBeInTheDocument();
    expect(input()).toHaveValue('');
    expect(bar()).toBeInTheDocument();

    typeOrigin('https://portal.example.com');
    clickAdd();
    expect(screen.getAllByText('https://portal.example.com')).toHaveLength(1);
  });

  test('Enter adds the site without sending the form', async () => {
    await renderPage();

    typeOrigin('https://portal.example.com');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(screen.getByText('https://portal.example.com')).toBeInTheDocument();
  });

  test('an invalid site is refused with a message that names the field, and nothing is added', async () => {
    await renderPage();

    typeOrigin('https://ifinder.example.com/app');
    clickAdd();

    expect(screen.getByRole('alert')).toHaveTextContent(/Enter an origin such as/);
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('https://ifinder.example.com/app')).not.toBeInTheDocument();
    // Typing again clears the message.
    typeOrigin('https://ifinder.example.com/ap');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a site is removed; Discard brings it back and takes the bar away', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: `Remove ${HOST}` }));
    expect(screen.queryByText(HOST)).not.toBeInTheDocument();
    expect(screen.getByText('No site added yet.')).toBeInTheDocument();
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByText(HOST)).toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
  });

  test('the switch counts as a change; Discard puts it back', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByRole('switch')).toBeChecked();
    expect(bar()).not.toBeInTheDocument();
  });

  test('a half-typed site counts as a change and is discarded with it', async () => {
    await renderPage();

    typeOrigin('https://half.example.com');
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(input()).toHaveValue('');
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save sends the switch and the list, shows the answer and the bar goes away', async () => {
    await renderPage();
    typeOrigin('https://portal.example.com');
    clickAdd();
    fireEvent.click(screen.getByRole('switch'));

    await save();

    expect(putBody()).toEqual({
      enabled: false,
      allowedHostOrigins: [HOST, 'https://portal.example.com']
    });
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved. They apply at once.');
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByText('https://portal.example.com')).toBeInTheDocument();
  });

  test('Save takes a site that was typed but not added', async () => {
    await renderPage();
    typeOrigin('https://Typed.example.com');

    await save();

    expect(putBody().allowedHostOrigins).toEqual([HOST, 'https://typed.example.com']);
    expect(input()).toHaveValue('');
  });

  test('Save does not send while the typed site is invalid', async () => {
    await renderPage();
    typeOrigin('not a site');

    await save();

    expect(putBody()).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter an origin such as/);
    expect(bar()).toBeInTheDocument();
  });

  test('a failed save keeps the bar and names the error in it', async () => {
    failSave = true;
    await renderPage();
    fireEvent.click(screen.getByRole('switch'));

    await save();

    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText(/The settings could not be saved\. boom/)).toBeInTheDocument();
    // The edit is still there.
    expect(screen.getByRole('switch')).not.toBeChecked();

    // Back at the loaded value the bar stays: the write may have gone through and only its answer been lost.
    fireEvent.click(screen.getByRole('switch'));
    expect(bar()).toBeInTheDocument();
    fireEvent.click(discardButton());
    expect(bar()).not.toBeInTheDocument();
  });

  test('no form and no Save while the settings could not be loaded', async () => {
    failLoad = true;
    await renderPage();

    expect(screen.queryByLabelText('Site address')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
    expect(mockApi.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });

  describe('notices', () => {
    test('the switch is on and no site is allowed', async () => {
      stored = { enabled: true, allowedHostOrigins: [] };
      await renderPage();

      expect(screen.getByText(/no site is allowed yet/)).toBeInTheDocument();
    });

    test('no notice for a switch that is on with a site', async () => {
      await renderPage();

      expect(screen.queryByText(/no site is allowed yet/)).not.toBeInTheDocument();
      expect(screen.queryByText(/The switch is off/)).not.toBeInTheDocument();
    });

    test('the switch is off while a list is kept', async () => {
      stored = { enabled: false, allowedHostOrigins: [HOST] };
      await renderPage();

      expect(screen.getByText(/The switch is off\. The list is kept/)).toBeInTheDocument();
    });

    test('a site that is not served over HTTPS, but not localhost', async () => {
      stored = { enabled: true, allowedHostOrigins: ['http://portal.example.com'] };
      await renderPage();

      expect(
        screen.getByText(/http:\/\/portal\.example\.com is not served over HTTPS/)
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Remove http://portal.example.com' }));
      typeOrigin('http://localhost:3000');
      expect(screen.queryByText(/is not served over HTTPS/)).not.toBeInTheDocument();
    });
  });
});
