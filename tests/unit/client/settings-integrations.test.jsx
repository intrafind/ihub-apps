// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Settings → Integrations (#2922): every integration the user's groups allow,
 * with its true identity state.
 *
 *   - SSO (iFinder), a service account (Entra, named by the group that shares
 *     it), a shared-key MCP server and an integration that needs no sign-in
 *     are listed although the user never connects them;
 *   - an unavailable integration (a shared key the server refused) says so,
 *     with what an admin must do, and offers no action;
 *   - Connect and Reconnect start the one connect flow; Disconnect asks, then
 *     reloads that one entry, so the row changes without a page reload;
 *   - search, category and "Needs attention" filter the list;
 *   - a row opens its detail: actions with effect badges, the apps that use
 *     it, last used, the permissions granted in plain words;
 *   - the texts exist in English and German.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import {
  filterIntegrations,
  needsAttention,
  primaryActionOf,
  statusText
} from '../../../client/src/features/settings/integrationStatus';

const i18n = i18next.createInstance();
i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  initImmediate: false,
  resources: { en: { translation: en }, de: { translation: de } },
  interpolation: { escapeValue: false }
});
const mockI18n = { t: i18n.t.bind(i18n), i18n };
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildApiUrl: endpoint => `/api/${String(endpoint).replace(/^\//, '')}`
}));
const mockUser = { id: 'alice' };
const mockPlatform = { platformConfig: {} };
jest.mock('../../../client/src/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => mockPlatform
}));

const mockFetchUserIntegrations = jest.fn();
const mockFetchUserIntegration = jest.fn();
const mockDisconnect = jest.fn();
const mockRequestConnectUrl = jest.fn();
jest.mock('../../../client/src/api/userIntegrationsApi', () => ({
  fetchUserIntegrations: (...args) => mockFetchUserIntegrations(...args),
  fetchUserIntegration: (...args) => mockFetchUserIntegration(...args),
  disconnectUserIntegration: (...args) => mockDisconnect(...args),
  requestConnectUrl: (...args) => mockRequestConnectUrl(...args)
}));

// The real connect flow, leaving through a seam instead of `window.location.assign`.
const mockNavigate = jest.fn();
jest.mock('../../../client/src/features/integrations/connect/integrationInfo', () => {
  const actual = jest.requireActual(
    '../../../client/src/features/integrations/connect/integrationInfo'
  );
  return {
    ...actual,
    startIntegrationConnect: (id, options) =>
      actual.startIntegrationConnect(id, { ...options, navigate: url => mockNavigate(url) })
  };
});

const IntegrationsPage =
  require('../../../client/src/features/settings/pages/IntegrationsPage').default;
const {
  resetConnectResultForTests
} = require('../../../client/src/features/integrations/connect/connectResult');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const inDays = days => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();

const connection = overrides => ({
  reason: null,
  account: null,
  scopes: [],
  connectedAt: null,
  expiresAt: null,
  lastUsedAt: null,
  signInHost: null,
  connectable: false,
  renewable: null,
  sharedWith: [],
  ...overrides
});

const ENTRIES = [
  {
    id: 'jira',
    name: 'Atlassian Jira',
    description: 'Tickets',
    protocol: 'native',
    categories: ['ticketing', 'productivity'],
    capabilities: ['tools'],
    actions: [
      {
        name: 'searchTickets',
        title: 'Search issues',
        description: 'Find issues',
        sideEffect: 'read'
      },
      { name: 'addComment', title: 'Add comment', description: 'Comment', sideEffect: 'write' }
    ],
    effects: ['read', 'write'],
    apps: [{ id: 'tickets', name: 'Ticket helper' }],
    connection: connection({
      mode: 'personal',
      status: 'connected',
      account: 'ada@example.com',
      scopes: ['read:jira-work', 'write:jira-work'],
      connectedAt: '2026-10-01T08:00:00Z',
      expiresAt: inDays(29),
      lastUsedAt: '2026-11-01T09:30:00Z',
      signInHost: 'auth.atlassian.com',
      connectable: true,
      renewable: false
    })
  },
  {
    id: 'ifinder',
    name: 'iFinder',
    categories: ['search'],
    capabilities: ['tools', 'search'],
    actions: [{ name: 'search', title: 'Search documents', sideEffect: 'read' }],
    effects: ['read'],
    apps: [],
    connection: connection({ mode: 'sso', status: 'sso' })
  },
  {
    id: 'entra',
    name: 'Entra ID directory',
    categories: ['people', 'directory'],
    capabilities: ['tools'],
    actions: [{ name: 'search_people', title: 'Search people', sideEffect: 'read' }],
    effects: ['read'],
    apps: [],
    connection: connection({
      mode: 'service_account',
      status: 'service_account',
      sharedWith: [{ id: 'legal', name: 'Legal team' }]
    })
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    protocol: 'mcp',
    categories: ['documentation'],
    capabilities: ['tools'],
    actions: [],
    effects: [],
    apps: [],
    connection: connection({ mode: 'shared_key', status: 'shared_key' })
  },
  {
    id: 'deepl',
    name: 'DeepL',
    categories: ['productivity'],
    capabilities: ['tools'],
    actions: [{ name: 'translate', title: 'Translate', sideEffect: 'read' }],
    effects: ['read'],
    apps: [],
    connection: connection({
      mode: 'shared_key',
      status: 'unavailable',
      reason: 'credential_rejected'
    })
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    categories: ['customer'],
    capabilities: ['tools'],
    actions: [],
    effects: [],
    apps: [],
    connection: connection({
      mode: 'personal',
      status: 'not_connected',
      reason: 'not_connected',
      connectable: true
    })
  },
  {
    id: 'm365',
    name: 'Microsoft 365',
    categories: ['files'],
    capabilities: ['files'],
    actions: [],
    effects: [],
    apps: [],
    connection: connection({
      mode: 'personal',
      status: 'needs_reconnect',
      reason: 'insufficient_scope',
      connectable: true
    })
  }
];

const t = i18n.t.bind(i18n);
const byId = id => ENTRIES.find(entry => entry.id === id);

describe('the status line (pure)', () => {
  test.each([
    ['jira', 'Connected as ada@example.com · expires in 29 days'],
    ['ifinder', 'Signed in via SSO'],
    ['entra', 'Runs as service account (Legal team)'],
    ['deepwiki', 'Shared key'],
    [
      'deepl',
      'Unavailable · the shared key was refused or has expired; an administrator must renew it'
    ],
    ['hubspot', 'Not connected'],
    ['m365', 'Reconnect needed · a new permission is needed']
  ])('%s: %s', (id, text) => {
    expect(statusText(byId(id), t, { language: 'en', now: NOW })).toBe(text);
  });

  test('an access that renews itself shows no expiry, and is not "needs attention"', () => {
    const renewing = {
      ...byId('jira'),
      connection: { ...byId('jira').connection, renewable: true, expiresAt: inDays(0.05) }
    };
    expect(statusText(renewing, t, { language: 'en', now: NOW })).toBe(
      'Connected as ada@example.com'
    );
    expect(needsAttention(renewing, NOW)).toBe(false);
    const ending = {
      ...byId('jira'),
      connection: { ...byId('jira').connection, renewable: false, expiresAt: inDays(2) }
    };
    expect(needsAttention(ending, NOW)).toBe(true);
  });

  test('offers an action only for a personal sign-in', () => {
    expect(ENTRIES.map(entry => [entry.id, primaryActionOf(entry)])).toEqual([
      ['jira', 'disconnect'],
      ['ifinder', null],
      ['entra', null],
      ['deepwiki', null],
      ['deepl', null],
      ['hubspot', 'connect'],
      ['m365', 'reconnect']
    ]);
  });

  test('filters by text, category and "needs attention"', () => {
    const ids = filters => filterIntegrations(ENTRIES, filters, t, { now: NOW }).map(e => e.id);
    expect(ids({ query: 'comment' })).toEqual(['jira']);
    expect(ids({ query: 'sso' })).toEqual(['ifinder']);
    expect(ids({ category: 'productivity' })).toEqual(['jira', 'deepl']);
    expect(ids({ status: 'attention' })).toEqual(['deepl', 'm365']);
  });

  test('every text exists in German too', () => {
    const german = i18next.createInstance();
    german.init({
      lng: 'de',
      initImmediate: false,
      resources: { de: { translation: de } },
      interpolation: { escapeValue: false }
    });
    const tDe = german.t.bind(german);
    expect(statusText(byId('entra'), tDe, { language: 'de' })).toBe(
      'Läuft als Dienstkonto (Legal team)'
    );
    expect(statusText(byId('jira'), tDe, { language: 'de', now: NOW })).toBe(
      'Verbunden als ada@example.com · läuft in 29 Tagen ab'
    );
    const keys = obj =>
      Object.entries(obj).flatMap(([key, value]) =>
        value && typeof value === 'object' ? keys(value).map(k => `${key}.${k}`) : [key]
      );
    expect(keys(de.integrations.page).sort()).toEqual(keys(en.integrations.page).sort());
  });
});

describe('Settings → Integrations', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    resetConnectResultForTests();
    mockFetchUserIntegrations.mockReset().mockResolvedValue(ENTRIES);
    mockFetchUserIntegration.mockReset();
    mockDisconnect.mockReset().mockResolvedValue({ success: true, removed: true, revoked: true });
    mockRequestConnectUrl.mockReset().mockResolvedValue('https://auth.example.com/authorize?x=1');
    // The other sections answer "not enabled".
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    mockNavigate.mockReset();
    window.history.replaceState(null, '', '/settings/integrations');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/settings/integrations']}>
        <IntegrationsPage />
      </MemoryRouter>
    );
  const row = id => document.querySelector(`[data-integration="${id}"]`);

  test('lists everything the groups allow with its identity state', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Available to you (7)' })
    ).toBeInTheDocument();
    expect(within(row('ifinder')).getByText('Signed in via SSO')).toBeInTheDocument();
    expect(
      within(row('entra')).getByText('Runs as service account (Legal team)')
    ).toBeInTheDocument();
    expect(within(row('deepwiki')).getByText('Shared key')).toBeInTheDocument();
    expect(within(row('deepl')).getByText(/^Unavailable · /)).toBeInTheDocument();
    // Nothing for the user to do on SSO, service account, shared key or unavailable.
    for (const id of ['ifinder', 'entra', 'deepwiki', 'deepl']) {
      expect(within(row(id)).queryByRole('button', { name: /connect|disconnect/i })).toBeNull();
    }
    expect(
      within(row('jira')).getByText('Connected as ada@example.com · expires in 29 days')
    ).toBeInTheDocument();
  });

  test('Connect and Reconnect use the one connect flow with this page as return URL', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect HubSpot' }));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('https://auth.example.com/authorize?x=1')
    );
    expect(mockRequestConnectUrl).toHaveBeenCalledWith('hubspot', {
      reconnect: false,
      scopes: undefined,
      returnUrl: 'http://localhost/settings/integrations'
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Microsoft 365' }));
    await waitFor(() =>
      expect(mockRequestConnectUrl).toHaveBeenLastCalledWith(
        'm365',
        expect.objectContaining({ reconnect: true })
      )
    );
  });

  test('Disconnect asks, then refreshes the row without a reload', async () => {
    mockFetchUserIntegration.mockResolvedValue({
      ...byId('jira'),
      connection: connection({
        mode: 'personal',
        status: 'not_connected',
        reason: 'not_connected',
        connectable: true
      })
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Atlassian Jira' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith('jira'));
    expect(await within(row('jira')).findByText('Not connected')).toBeInTheDocument();
    expect(
      within(row('jira')).getByRole('button', { name: 'Connect Atlassian Jira' })
    ).toBeVisible();
    expect(screen.getByTestId('integrations-message')).toHaveTextContent(
      'Atlassian Jira disconnected.'
    );
    expect(mockFetchUserIntegrations).toHaveBeenCalledTimes(1);
  });

  test('search and "Needs attention" filter the rows', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Available to you (7)' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'attention' } });
    expect(screen.getAllByTestId('integration-row').map(el => el.dataset.integration)).toEqual([
      'deepl',
      'm365'
    ]);
    expect(screen.getByText('Showing 2 of 7')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Search integrations'), { target: { value: 'nope' } });
    expect(screen.getByText('No integration matches the filters.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search integrations'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'people' } });
    expect(screen.getAllByTestId('integration-row').map(el => el.dataset.integration)).toEqual([
      'entra'
    ]);
  });

  test('a row opens its detail: actions with effects, apps, last used, permissions', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Atlassian Jira/ }));
    const detail = await screen.findByTestId('integration-detail');
    expect(within(detail).getByRole('heading', { name: 'Atlassian Jira' })).toBeInTheDocument();
    expect(within(detail).getByText('Add comment')).toBeInTheDocument();
    expect(within(detail).getAllByText('Write').length).toBeGreaterThan(0);
    expect(within(detail).getByRole('link', { name: 'Ticket helper' })).toHaveAttribute(
      'href',
      '/apps/tickets'
    );
    expect(within(detail).getByText('Last used')).toBeInTheDocument();
    expect(within(detail).getByText('Read: Search issues')).toBeInTheDocument();
    expect(within(detail).getByText('auth.atlassian.com')).toBeInTheDocument();
    expect(within(detail).getByText('Technical permissions (2)')).toBeInTheDocument();
  });

  test('a sign-in result names the integration in a live region', async () => {
    window.history.replaceState(null, '', '/settings/integrations?integration_connected=hubspot');
    renderPage();
    const banner = await screen.findByTestId('integrations-message');
    await waitFor(() => expect(banner).toHaveTextContent('HubSpot connected successfully.'));
    expect(banner.closest('[role="status"]')).not.toBeNull();
  });
});
