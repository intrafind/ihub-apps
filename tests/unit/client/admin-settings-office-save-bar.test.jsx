// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Office integration settings page saves through the shared bottom bar. Its form holds
 * plain fields, nested objects (the start page, the allowed apps) and the allowed apps, which
 * the save sends only when they were edited. No bar until something changed, Discard puts every
 * one of them back, Save sends the page and the bar goes away, a failed save keeps the bar and
 * names the error in it. Real dirty tracking; the admin API and the app list are stubbed.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockApi = jest.fn();
const mockFetchAdminApps = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockApi(...args),
  fetchAdminApps: (...args) => mockFetchAdminApps(...args),
  getAdminApiErrorMessage: err => err?.message || ''
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api/${path}`,
  buildAssetUrl: path => path,
  getBasePath: () => '',
  buildPath: path => path,
  KNOWN_ROUTES: []
}));
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: ({ label, value, onChange }) => (
    <input
      aria-label={label}
      value={value?.en ?? ''}
      onChange={e => onChange({ ...value, en: e.target.value })}
    />
  )
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
const AdminOfficeIntegrationPage =
  require('../../../client/src/features/admin/pages/AdminOfficeIntegrationPage').default;

const STATUS = {
  enabled: true,
  oauthClientId: 'office-add-in-1',
  displayName: { en: 'iHub Apps' },
  description: { en: 'Assistant for Outlook' },
  starterPrompts: [{ title: { en: 'Reply' }, message: { en: 'Draft a reply' } }],
  startPage: { defaultPage: 'start', defaultAppId: '', featuredAppIds: [] },
  defaultMailAction: 'auto',
  officeJsMode: 'cdn',
  officeJsCdnUrl: 'https://officeapis.example/1/office.js',
  officeJsCustomUrl: '',
  officeJsCdnPresets: [],
  officeJsResolvedUrl: '',
  officeJsResolvedMode: 'cdn',
  manifestUrl: 'https://ihub.example/manifest.xml',
  addinId: 'addin-id',
  addinIdIsShared: false,
  appAccess: { mode: 'all', appIds: [] }
};
const APPS = [{ id: 'summarizer', name: { en: 'Summarizer' } }];

let failSave;
// What the server holds: a successful PUT changes it, a refused one does not.
let status;
const configCalls = () =>
  mockApi.mock.calls.filter(
    ([url, options]) => url === '/admin/office-integration/config' && options?.method === 'PUT'
  );

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const barButtons = () => within(bar()).getAllByRole('button');
const saveButton = () => barButtons().at(-1);
const discardButton = () => barButtons()[0];
const flush = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const renderPage = async () => {
  mockApi.mockImplementation(async (url, options = {}) => {
    if (url === '/admin/office-integration/status') return { data: structuredClone(status) };
    if (url === '/admin/office-integration/config' && options.method === 'PUT') {
      if (failSave) throw new Error('boom');
      status = {
        ...status,
        ...options.body,
        startPage: { ...status.startPage, ...options.body.startPage }
      };
      return { data: {} };
    }
    throw new Error(`unexpected admin call: ${url}`);
  });
  mockFetchAdminApps.mockResolvedValue(APPS);
  render(
    <MemoryRouter>
      <AdminOfficeIntegrationPage />
    </MemoryRouter>
  );
  await screen.findByText('Available Apps');
  await waitFor(() => expect(mockFetchAdminApps).toHaveBeenCalled());
  await flush();
};

beforeAll(() => {
  if (!global.crypto?.randomUUID) {
    global.crypto = { ...(global.crypto || {}), randomUUID: () => `id-${Math.random()}` };
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  failSave = false;
  status = structuredClone(STATUS);
});

describe('Office integration settings page', () => {
  test('no bar for a page that was just loaded, and no Save button at the end of the form', async () => {
    await renderPage();
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  test('a plain field shows the bar; Discard puts it back', async () => {
    await renderPage();

    fireEvent.change(screen.getByLabelText('Default action'), { target: { value: 'answer' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByLabelText('Default action')).toHaveValue('auto');
    expect(bar()).not.toBeInTheDocument();
  });

  test('an edit of only a nested value (the start page) counts as a change', async () => {
    await renderPage();

    fireEvent.change(screen.getByLabelText('Landing view'), { target: { value: 'apps' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByLabelText('Landing view')).toHaveValue('start');
    expect(bar()).not.toBeInTheDocument();
  });

  test('the allowed apps count as a change and Discard takes the limit back', async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText('Only selected apps'));
    expect(bar()).toBeInTheDocument();
    expect(screen.getByText(/Unsaved change/)).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByLabelText('All apps the user can access')).toBeChecked();
    expect(screen.queryByText(/Unsaved change/)).not.toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
  });

  test('a limit with no app is refused on Save, and the refusal is named in the bar', async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText('Only selected apps'));

    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(configCalls()).toHaveLength(0);
    expect(within(bar()).getByText(/Select at least one app, or choose/)).toBeInTheDocument();
  });

  test('Save sends the edited page, and the bar goes away after the reload', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Default action'), { target: { value: 'answer' } });
    fireEvent.change(screen.getByLabelText('Landing view'), { target: { value: 'apps' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(configCalls()).toHaveLength(1);
    const body = configCalls()[0][1].body;
    expect(body.defaultMailAction).toBe('answer');
    expect(body.startPage.defaultPage).toBe('apps');
    // The allowed apps were not touched, so the save does not send them.
    expect(body).not.toHaveProperty('allowedApps');
    expect(bar()).not.toBeInTheDocument();
    // The page reloaded from what the server now holds: the saved values are shown, not the
    // loaded ones.
    expect(screen.getByLabelText('Default action')).toHaveValue('answer');
    expect(screen.getByLabelText('Landing view')).toHaveValue('apps');
  });

  test('a failed save keeps the bar and names the error in it', async () => {
    failSave = true;
    await renderPage();
    const original = screen.getByLabelText('Default action').value;
    fireEvent.change(screen.getByLabelText('Default action'), { target: { value: 'answer' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText('boom')).toBeInTheDocument();
    expect(screen.getByLabelText('Default action')).toHaveValue('answer');
    // Back at the loaded value, the bar stays: the write may have gone through unanswered.
    fireEvent.change(screen.getByLabelText('Default action'), { target: { value: original } });
    expect(bar()).toBeInTheDocument();
    fireEvent.click(discardButton());
    expect(bar()).not.toBeInTheDocument();
  });
});
