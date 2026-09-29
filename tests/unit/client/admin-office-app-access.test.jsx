/**
 * Admin → Office Integration → Available Apps: which apps the Outlook add-in offers.
 *
 * The limit lives on the add-in's OAuth client (`allowedApps`), where it used to be reachable
 * only through Admin → OAuth Clients — an admin looking at the Outlook add-in had no way to find
 * it. The page now shows it, lets the admin change it in place, and links to the client for the
 * rest.
 *
 * These specs pin what the admin sees for each state of the client, and what a save sends:
 * `allowedApps` only when it was edited (so saving an unrelated field cannot overwrite a change
 * made on the OAuth client), and never an empty list (which the server would read as "no limit").
 *
 * The page and the resource picker are real; the admin API, the app list and the translation hook
 * are stubbed.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.message || ''
}));

const mockFetchAdminApps = jest.fn();
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAdminApps: (...args) => mockFetchAdminApps(...args)
}));

// `runtimeBasePath` reads `import.meta.env`, which the CJS test transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: path => `/api/${path}`,
  buildAssetUrl: path => path,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

// The language editors are not what is under test, and they pull in the translation API.
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-icon={name} />
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

import AdminOfficeIntegrationPage from '../../../client/src/features/admin/pages/AdminOfficeIntegrationPage';

const APPS = [
  { id: 'summarizer', name: { en: 'Summarizer' } },
  { id: 'translator', name: { en: 'Translator' } },
  { id: 'hr-bot', name: { en: 'HR Bot' } }
];

const statusWith = (overrides = {}) => ({
  enabled: true,
  oauthClientId: 'office-add-in-1',
  displayName: { en: 'iHub Apps' },
  description: { en: 'Assistant for Outlook' },
  starterPrompts: [],
  startPage: { defaultPage: 'start', featuredAppIds: [] },
  defaultMailAction: 'auto',
  officeJsMode: 'cdn',
  officeJsCdnUrl: 'https://officeapis.example/1/office.js',
  officeJsCustomUrl: '',
  officeJsCdnPresets: [],
  officeJsResolvedUrl: '',
  officeJsResolvedMode: 'cdn',
  manifestUrl: 'https://ihub.example/api/integrations/office-addin/manifest.xml',
  addinId: 'addin-id',
  addinIdIsShared: false,
  appAccess: { mode: 'all', appIds: [] },
  ...overrides
});

const renderPage = async status => {
  mockMakeAdminApiCall.mockImplementation(async (path, options = {}) => {
    if (path === '/admin/office-integration/status') return { data: status };
    if (path === '/admin/office-integration/config' && options.method === 'PUT') {
      return { data: {} };
    }
    throw new Error(`unexpected admin call: ${path}`);
  });
  mockFetchAdminApps.mockResolvedValue(APPS);
  render(
    <MemoryRouter>
      <AdminOfficeIntegrationPage />
    </MemoryRouter>
  );
  await screen.findByText('Available Apps');
  await waitFor(() => expect(mockFetchAdminApps).toHaveBeenCalled());
};

/** The body of the config save the page sent, or undefined when it sent none. */
const savedBody = () =>
  mockMakeAdminApiCall.mock.calls.find(
    ([path, options]) => path === '/admin/office-integration/config' && options?.method === 'PUT'
  )?.[1].body;

/** The card itself: app names also appear in the start page's pickers further down. */
const availableAppsCard = () => screen.getByText('Available Apps').closest('div.rounded-xl');

const allAppsRadio = () => screen.getByLabelText('All apps the user can access');
const limitedRadio = () => screen.getByLabelText('Only selected apps');

beforeAll(() => {
  // The page keys starter prompts with `crypto.randomUUID()`; older jsdom lacks it.
  if (!global.crypto?.randomUUID) {
    global.crypto = { ...(global.crypto || {}), randomUUID: () => `id-${Math.random()}` };
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Available Apps card', () => {
  test('an unrestricted client reads as "all apps", with no picker and a link to the client', async () => {
    await renderPage(statusWith());

    expect(screen.getByText('Currently: all apps')).toBeInTheDocument();
    expect(allAppsRadio()).toBeChecked();
    expect(limitedRadio()).not.toBeChecked();
    expect(screen.queryByPlaceholderText('Search apps to add...')).not.toBeInTheDocument();

    // The way to the OAuth client is on the card, next to the setting.
    const link = within(availableAppsCard()).getByRole('link', { name: 'View OAuth Client' });
    expect(link).toHaveAttribute('href', '/admin/oauth/clients/office-add-in-1');
  });

  test('a limited client shows how many apps and which ones', async () => {
    await renderPage(
      statusWith({ appAccess: { mode: 'limited', appIds: ['summarizer', 'translator'] } })
    );

    expect(screen.getByText('Currently: limited (2 selected)')).toBeInTheDocument();
    expect(limitedRadio()).toBeChecked();
    // Names, not ids — in the admin's language.
    const card = within(availableAppsCard());
    expect(card.getByText('Summarizer')).toBeInTheDocument();
    expect(card.getByText('Translator')).toBeInTheDocument();
    expect(card.queryByText('HR Bot')).not.toBeInTheDocument();
  });

  test('an id whose app is gone stays visible so it can be removed', async () => {
    await renderPage(statusWith({ appAccess: { mode: 'limited', appIds: ['deleted-app'] } }));

    expect(await screen.findByText(/deleted-app \(not found\)/)).toBeInTheDocument();
  });

  test('a deleted OAuth client is explained instead of shown as "all apps"', async () => {
    await renderPage(statusWith({ appAccess: null }));

    expect(screen.getByText(/OAuth client could not be found/)).toBeInTheDocument();
    expect(screen.queryByText('Currently: all apps')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('All apps the user can access')).not.toBeInTheDocument();
  });

  test('there is no card before the integration is enabled', async () => {
    mockMakeAdminApiCall.mockResolvedValue({
      data: statusWith({ enabled: false, oauthClientId: '', appAccess: null })
    });
    mockFetchAdminApps.mockResolvedValue(APPS);
    render(
      <MemoryRouter>
        <AdminOfficeIntegrationPage />
      </MemoryRouter>
    );
    await screen.findByText('Integration Status');

    expect(screen.queryByText('Available Apps')).not.toBeInTheDocument();
  });
});

describe('saving app access', () => {
  test('a save that did not touch the apps does not send them', async () => {
    // The list also lives on the OAuth client, where it may have changed since the page loaded.
    await renderPage(statusWith({ appAccess: { mode: 'limited', appIds: ['summarizer'] } }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(savedBody()).toBeDefined());
    expect(savedBody()).not.toHaveProperty('allowedApps');
  });

  test('going back and forth between the modes is not an edit', async () => {
    await renderPage(statusWith());

    fireEvent.click(limitedRadio());
    fireEvent.click(allAppsRadio());
    expect(screen.queryByText(/Unsaved change/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedBody()).toBeDefined());
    expect(savedBody()).not.toHaveProperty('allowedApps');
  });

  test('limiting the add-in to a picked app sends exactly that app', async () => {
    await renderPage(statusWith());

    fireEvent.click(limitedRadio());
    const search = await screen.findByPlaceholderText('Search apps to add...');
    fireEvent.focus(search);
    fireEvent.click(await within(availableAppsCard()).findByRole('button', { name: /HR Bot/ }));

    expect(screen.getByText(/Unsaved change/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(savedBody()).toBeDefined());
    expect(savedBody().allowedApps).toEqual(['hr-bot']);
  });

  test('lifting the limit sends the wildcard, not an empty list', async () => {
    await renderPage(statusWith({ appAccess: { mode: 'limited', appIds: ['summarizer'] } }));

    fireEvent.click(allAppsRadio());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(savedBody()).toBeDefined());
    expect(savedBody().allowedApps).toEqual(['*']);
  });

  test('"only selected apps" with nothing selected is refused instead of saved', async () => {
    // An empty list would be stored as "no limit" — the opposite of what was just chosen.
    await renderPage(statusWith());

    fireEvent.click(limitedRadio());
    expect(screen.getByText(/Select at least one app before saving/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Select at least one app, or choose/)).toBeInTheDocument();
    expect(savedBody()).toBeUndefined();
  });

  test('a limited list with nothing usable does not block saving other settings', async () => {
    // Untouched, so it is not this save's business — only an edit is validated.
    await renderPage(statusWith({ appAccess: { mode: 'limited', appIds: [] } }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(savedBody()).toBeDefined());
    expect(savedBody()).not.toHaveProperty('allowedApps');
  });
});

describe('start page apps the limit would hide', () => {
  const startPageCard = () => screen.getByText('Start Page').closest('div.rounded-xl');

  test('names the default apps the list leaves out', async () => {
    await renderPage(
      statusWith({
        appAccess: { mode: 'limited', appIds: ['summarizer'] },
        startPage: {
          defaultPage: 'start',
          defaultAppId: 'hr-bot',
          featuredAppIds: ['summarizer', 'translator']
        }
      })
    );

    const notice = within(startPageCard()).getByText(/Not in the available apps above/);
    expect(notice).toHaveTextContent('HR Bot, Translator');
    expect(notice).not.toHaveTextContent('Summarizer');
  });

  test('says nothing when the add-in offers all apps, or the list covers them', async () => {
    await renderPage(
      statusWith({
        startPage: { defaultPage: 'start', defaultAppId: 'hr-bot', featuredAppIds: ['translator'] }
      })
    );
    expect(screen.queryByText(/Not in the available apps above/)).not.toBeInTheDocument();

    fireEvent.click(limitedRadio());
    const search = await screen.findByPlaceholderText('Search apps to add...');
    for (const name of [/HR Bot/, /Translator/]) {
      fireEvent.focus(search);
      fireEvent.click(await within(availableAppsCard()).findByRole('button', { name }));
    }
    expect(screen.queryByText(/Not in the available apps above/)).not.toBeInTheDocument();
  });
});
