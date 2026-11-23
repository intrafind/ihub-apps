// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Nextcloud embed and Browser extension settings pages save through the shared bottom bar:
 * no bar until something changed, Discard puts every field back, Save sends the page's payload
 * and the bar goes away, a failed save keeps the bar and names the error in it. Real dirty
 * tracking and real load gate; the admin API and the language editor are stubbed.
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
// One text box per language editor: it edits the English text and hands back a new object.
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
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const en = require('../../../shared/i18n/en.json');
const AdminNextcloudEmbedPage =
  require('../../../client/src/features/admin/pages/AdminNextcloudEmbedPage').default;
const AdminBrowserExtensionPage =
  require('../../../client/src/features/admin/pages/AdminBrowserExtensionPage').default;

const NEXTCLOUD = {
  Page: AdminNextcloudEmbedPage,
  statusUrl: '/admin/nextcloud-embed/status',
  configUrl: '/admin/nextcloud-embed/config',
  status: {
    enabled: true,
    embedUrl: 'https://ihub.example/embed',
    displayName: { en: 'Cloud chat' },
    description: { en: 'Chat in Nextcloud' },
    starterPrompts: [{ title: { en: 'Summarize' }, message: { en: 'Summarize this' } }],
    allowedHostOrigins: ['https://cloud.example.com']
  },
  // Adds a list entry: the page's own "add" input and button.
  addListEntry: () => {
    fireEvent.change(screen.getByPlaceholderText('https://cloud.example.com'), {
      target: { value: 'https://files.example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  },
  listField: 'allowedHostOrigins',
  addedValue: 'https://files.example.com',
  saveError: 'Failed to save configuration'
};
const BROWSER = {
  Page: AdminBrowserExtensionPage,
  statusUrl: '/admin/browser-extension/status',
  configUrl: '/admin/browser-extension/config',
  status: {
    enabled: true,
    displayName: { en: 'Browser chat' },
    description: { en: 'Chat in the browser' },
    starterPrompts: [{ title: { en: 'Summarize' }, message: { en: 'Summarize this' } }],
    extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
    allowedGroups: ['browser-extension']
  },
  addListEntry: () => {
    fireEvent.change(screen.getByPlaceholderText('abcdefghijklmnopabcdefghijklmnop'), {
      target: { value: 'qrstuvwxyzabcdefqrstuvwxyzabcdef' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  },
  listField: 'extensionIds',
  addedValue: 'qrstuvwxyzabcdefqrstuvwxyzabcdef',
  saveError: 'Failed to save configuration'
};

let failSave;
const setUpApi = ({ statusUrl, configUrl, status }) => {
  mockApi.mockImplementation(async (url, options = {}) => {
    if (url === statusUrl) return { data: status };
    if (url === '/admin/groups') return { data: { groups: {} } };
    if (url === configUrl && options.method === 'PUT') {
      if (failSave) throw new Error('boom');
      return { data: {} };
    }
    throw new Error(`unexpected admin call: ${url}`);
  });
};

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const barButtons = () => within(bar()).getAllByRole('button');
const saveButton = () => barButtons().at(-1);
const discardButton = () => barButtons()[0];
const putBody = configUrl =>
  mockApi.mock.calls.find(([url, options]) => url === configUrl && options?.method === 'PUT')?.[1]
    .body;

const flush = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const renderPage = async setup => {
  setUpApi(setup);
  render(
    <MemoryRouter>
      <setup.Page />
    </MemoryRouter>
  );
  await screen.findByLabelText('Display Name');
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
});

describe.each([
  ['Nextcloud embed', NEXTCLOUD],
  ['Browser extension', BROWSER]
])('%s settings page', (_name, setup) => {
  test('no bar for a page that was just loaded, and no Save button of its own', async () => {
    await renderPage(setup);
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  test('a changed field shows the bar; Discard puts it back and takes the bar away', async () => {
    await renderPage(setup);

    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Renamed' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByLabelText('Display Name')).toHaveValue(setup.status.displayName.en);
    expect(bar()).not.toBeInTheDocument();
  });

  test('an edit of only a nested value (a starter prompt title) counts as a change', async () => {
    await renderPage(setup);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Summarise' } });
    expect(bar()).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.getByLabelText('Title')).toHaveValue('Summarize');
    expect(bar()).not.toBeInTheDocument();
  });

  test('a list entry that was added shows the bar; Discard removes it again', async () => {
    await renderPage(setup);

    setup.addListEntry();
    expect(bar()).toBeInTheDocument();
    expect(screen.getByText(setup.addedValue)).toBeInTheDocument();

    fireEvent.click(discardButton());
    expect(screen.queryByText(setup.addedValue)).not.toBeInTheDocument();
    expect(bar()).not.toBeInTheDocument();
  });

  test('Save sends the edited page and the bar goes away after the reload', async () => {
    await renderPage(setup);
    setup.addListEntry();
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Renamed' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    const body = putBody(setup.configUrl);
    expect(body.displayName).toEqual({ en: 'Renamed' });
    expect(body[setup.listField]).toContain(setup.addedValue);
    expect(bar()).not.toBeInTheDocument();
  });

  test('a failed save keeps the bar and names the error in it', async () => {
    failSave = true;
    await renderPage(setup);
    const original = screen.getByLabelText('Display Name').value;
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Renamed' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });
    await flush();

    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText(setup.saveError)).toBeInTheDocument();
    // The edit is still there, and Discard clears the error with it.
    expect(screen.getByLabelText('Display Name')).toHaveValue('Renamed');
    // Back at the loaded value the form is clean, but the write may have gone through and only
    // its answer been lost: the bar stays until a save succeeds or the admin discards.
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: original } });
    expect(bar()).toBeInTheDocument();
    fireEvent.click(discardButton());
    expect(bar()).not.toBeInTheDocument();
  });

  test('no bar while the settings could not be loaded', async () => {
    mockApi.mockImplementation(async () => {
      throw new Error('offline');
    });
    render(
      <MemoryRouter>
        <setup.Page />
      </MemoryRouter>
    );
    await flush();
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Display Name')).not.toBeInTheDocument();
  });
});
