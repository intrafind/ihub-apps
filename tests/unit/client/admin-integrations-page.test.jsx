// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Integrations is one page (`/admin/integrations`):
 *
 *   - Installed (default) groups the installations, each a tile with its key
 *     facts (no secret), linking to the installation's page;
 *   - Catalog groups the definitions the same way, and lists the marketplace's
 *     integrations: Install fetches the definition from its registry first;
 *   - Inbound lists what connects to iHub, with the status from platform.json;
 *   - `?install=<folder>` with `v.<key>=` and `label` opens the install dialog
 *     prefilled;
 *   - the route `/admin/integrations/installed` and its sidebar item are gone;
 *     an installation has its own route.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchInstalledIntegrations: jest.fn(),
  fetchIntegrationCatalog: jest.fn(),
  fetchAdminApps: jest.fn(),
  fetchAdminPlatformConfig: jest.fn(),
  installMarketplaceItem: jest.fn(),
  refreshMarketplaceRegistry: jest.fn(),
  dialogProps: null
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchIntegrationRequests: () => Promise.resolve({ requests: [], hidden: [], openCount: 0 }),
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  fetchIntegrationCatalog: (...args) => mockApi.fetchIntegrationCatalog(...args),
  deleteInstalledIntegration: jest.fn(),
  setInstalledIntegrationEnabled: jest.fn(),
  reloadIntegrationCatalog: jest.fn(),
  testInstalledIntegration: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAdminGroups: jest.fn().mockResolvedValue({ groups: {} }),
  fetchAdminPlatformConfig: (...args) => mockApi.fetchAdminPlatformConfig(...args),
  getAdminApiErrorMessage: err => err?.message || 'error',
  installMarketplaceItem: (...args) => mockApi.installMarketplaceItem(...args),
  refreshMarketplaceRegistry: (...args) => mockApi.refreshMarketplaceRegistry(...args),
  makeAdminApiCall: jest.fn()
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: () => true })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/IntegrationTestResults', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock(
  '../../../client/src/features/admin/components/integrations/IntegrationInstallDialog',
  () => ({
    __esModule: true,
    default: props => {
      mockApi.dialogProps = props;
      return <div data-testid="install-dialog">{props.definitionId}</div>;
    }
  })
);

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminIntegrationsPage =
  require('../../../client/src/features/admin/pages/AdminIntegrationsPage').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    parseMissingKeyHandler: key => `MISSING:${key}`
  });
});

const INSTALLED = [
  {
    id: 'govdata',
    label: 'GovData',
    definition: 'org.ckan/open-data-portal',
    definitionName: 'CKAN open data portal',
    protocol: 'openapi',
    enabled: true,
    values: { baseUrl: 'https://www.govdata.de/ckan', apiToken: 'TOKEN-123' },
    auth: { mode: 'service-account', credentialRef: 'integration:govdata' }
  },
  {
    id: 'ifinder',
    label: 'iFinder',
    definition: 'com.intrafind/ifinder',
    definitionName: 'iFinder',
    protocol: 'native',
    builtIn: true,
    enabled: true,
    values: { baseUrl: 'https://ifinder.example.com', privateKeyRef: 'ifinder-key' },
    auth: { mode: 'none' }
  },
  {
    id: 'brave',
    label: 'Brave Search',
    definition: 'com.intrafind/brave-search',
    definitionName: 'Brave Search',
    protocol: 'native',
    type: 'web-search',
    builtIn: true,
    enabled: true,
    values: { apiKeyRef: 'brave-key' },
    auth: { mode: 'none' }
  },
  {
    id: 'staan',
    label: 'Staan',
    definition: 'com.intrafind/staan-search',
    definitionName: 'Staan',
    protocol: 'native',
    type: 'web-search',
    builtIn: true,
    enabled: true,
    values: {},
    auth: { mode: 'none' }
  },
  {
    id: 'x500bund',
    label: 'X.500 Bund',
    definition: 'com.intrafind/ldap-directory',
    definitionName: 'LDAP people directory',
    protocol: 'native',
    type: 'people-directory',
    builtIn: true,
    enabled: false,
    values: { url: 'ldaps://x500.bund.de', baseDn: 'o=Bund,c=DE' },
    auth: { mode: 'none' }
  },
  {
    id: 'drawio',
    label: 'draw.io',
    definition: 'mcp/drawio',
    definitionName: 'draw.io',
    protocol: 'mcp',
    builtIn: true,
    enabled: true,
    perUser: false,
    values: { url: 'https://mcp.draw.io/mcp' },
    auth: { mode: 'none' },
    liveStatus: { connected: true, toolCount: 3 }
  }
];

const CATALOG = [
  {
    id: 'com.intrafind/jira',
    name: 'Jira',
    version: '1.0.0',
    protocol: 'native',
    builtIn: true,
    supported: true,
    authModes: ['oauth-user'],
    actionCount: 5
  },
  {
    id: 'com.intrafind/office365',
    name: 'Office 365',
    version: '1.0.0',
    protocol: 'native',
    type: 'storage',
    builtIn: true,
    supported: true,
    authModes: ['oauth-user'],
    actionCount: 0
  },
  ...['Brave Search', 'Staan', 'Qwant'].map(name => ({
    id: `com.intrafind/${name.split(' ')[0].toLowerCase()}-search`,
    name,
    version: '1.0.0',
    protocol: 'native',
    type: 'web-search',
    builtIn: true,
    supported: true,
    authModes: ['none'],
    actionCount: 1
  })),
  {
    id: 'org.ckan/open-data-portal',
    name: 'CKAN open data portal',
    version: '1.2.0',
    protocol: 'openapi',
    supported: true,
    authModes: ['none'],
    actionCount: 12
  }
];

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.dialogProps = null;
  mockApi.fetchInstalledIntegrations.mockResolvedValue({ items: INSTALLED });
  mockApi.fetchIntegrationCatalog.mockResolvedValue({ items: CATALOG });
  mockApi.fetchAdminApps.mockResolvedValue([]);
  mockApi.fetchAdminPlatformConfig.mockResolvedValue({
    features: { browserExtension: true },
    mcpServer: { enabled: true }
  });
});

const renderPage = (entry = '/admin/integrations') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AdminIntegrationsPage />
    </MemoryRouter>
  );

describe('Installed tab', () => {
  test('groups the installations in order with heading, count and description', async () => {
    renderPage();
    await screen.findByText('GovData');

    const groups = screen.getAllByTestId('integration-group');
    expect(groups.map(g => g.getAttribute('data-group'))).toEqual([
      'people-directories',
      'web-search',
      'mcp',
      'built-in',
      'catalog'
    ]);
    expect(within(groups[0]).getByRole('heading', { level: 2 })).toHaveTextContent(
      'People directories(1)'
    );
    expect(
      within(groups[0]).getByText('LDAP and Entra ID directories the model looks people up in.')
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/MISSING:/);
  });

  test('a tile links to the installation page and shows facts, never a secret', async () => {
    renderPage();
    await screen.findByText('GovData');

    const tile = screen
      .getAllByTestId('installation-tile')
      .find(el => el.getAttribute('data-installation') === 'govdata');
    expect(within(tile).getByRole('link', { name: 'GovData' })).toHaveAttribute(
      'href',
      '/admin/integrations/govdata'
    );
    expect(within(tile).getByText('https://www.govdata.de/ckan')).toBeInTheDocument();
    // The service account's token: whether it is set, nothing else.
    expect(within(tile).getByText('Credential')).toBeInTheDocument();
    expect(within(tile).getByText('set')).toBeInTheDocument();
    expect(screen.queryByText(/TOKEN-123/)).not.toBeInTheDocument();
    expect(screen.queryByText(/integration:govdata/)).not.toBeInTheDocument();
    expect(screen.queryByText('ifinder-key')).not.toBeInTheDocument();
    expect(screen.queryByText('brave-key')).not.toBeInTheDocument();
    // Quick actions are separate, labelled buttons.
    expect(within(tile).getByRole('button', { name: 'Test govdata' })).toBeEnabled();
    expect(within(tile).getByRole('button', { name: 'Edit govdata' })).toBeEnabled();
    expect(within(tile).getByRole('button', { name: 'Remove govdata' })).toBeEnabled();

    // One tile per web search engine: whether its key is set, never the credential id.
    const tileOf = id =>
      screen
        .getAllByTestId('installation-tile')
        .find(el => el.getAttribute('data-installation') === id);
    expect(within(tileOf('brave')).getByText('set')).toBeInTheDocument();
    expect(within(tileOf('staan')).getByText('not set')).toBeInTheDocument();
    expect(within(tileOf('staan')).getByText('STAAN_API_KEY')).toBeInTheDocument();

    const drawio = screen
      .getAllByTestId('installation-tile')
      .find(el => el.getAttribute('data-installation') === 'drawio');
    expect(within(drawio).getByTestId('live-status')).toHaveTextContent('Connected · 3 tools');
  });

  test('search filters the tiles', async () => {
    renderPage();
    await screen.findByText('GovData');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'x.500' } });
    expect(screen.getAllByTestId('installation-tile')).toHaveLength(1);
    expect(screen.getByText('X.500 Bund')).toBeInTheDocument();
  });
});

describe('Catalog and Inbound tabs', () => {
  test('the catalog uses the same groups', async () => {
    renderPage('/admin/integrations?tab=catalog');
    await screen.findByText('Jira');
    const groups = screen.getAllByTestId('integration-group');
    expect(groups.map(g => g.getAttribute('data-group'))).toEqual([
      'web-search',
      'storage',
      'built-in',
      'catalog'
    ]);
    // The three engines are grouped under Web search.
    expect(within(groups[0]).getByText('Brave Search')).toBeInTheDocument();
    expect(within(groups[0]).getByText('Staan')).toBeInTheDocument();
    expect(within(groups[0]).getByText('Qwant')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Install Jira' }));
    expect(screen.getByTestId('install-dialog')).toHaveTextContent('com.intrafind/jira');
  });

  test('installs a marketplace integration from its registry, then opens the setup dialog', async () => {
    const github = {
      id: 'mcp/github',
      name: 'GitHub',
      version: '1.0.0',
      protocol: 'mcp',
      supported: true,
      compatible: true,
      authModes: ['service-account'],
      actionCount: null,
      dynamicActions: true,
      source: 'marketplace',
      marketplace: { registryId: 'ihub-official', registryName: 'Official', name: 'mcp__github' },
      installedInstances: []
    };
    const marketplace = {
      enabled: true,
      registries: [{ id: 'ihub-official', name: 'Official', fetchedAt: '2026-11-03T00:00:00Z' }]
    };
    mockApi.fetchIntegrationCatalog.mockResolvedValue({ items: [...CATALOG, github], marketplace });
    mockApi.installMarketplaceItem.mockResolvedValue({});
    renderPage('/admin/integrations?tab=catalog');
    await screen.findByText('GitHub');
    expect(screen.getByText('Marketplace')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install GitHub' }));
    expect(await screen.findByTestId('install-dialog')).toHaveTextContent('mcp/github');
    expect(mockApi.installMarketplaceItem).toHaveBeenCalledWith(
      'ihub-official',
      'integration',
      'mcp__github'
    );
    // The catalog is read again, so the dialog finds the installed definition.
    expect(mockApi.fetchIntegrationCatalog.mock.calls.length).toBeGreaterThanOrEqual(2);
    // A registry with a cached catalog is not refreshed on the way in.
    expect(mockApi.refreshMarketplaceRegistry).not.toHaveBeenCalled();
  });

  test('refreshes a registry that was never fetched, and says when the marketplace is off', async () => {
    mockApi.fetchIntegrationCatalog.mockResolvedValue({
      items: CATALOG,
      marketplace: { enabled: true, registries: [{ id: 'r1', name: 'R1', fetchedAt: null }] }
    });
    mockApi.refreshMarketplaceRegistry.mockResolvedValue({});
    const { unmount } = renderPage('/admin/integrations?tab=catalog');
    await screen.findByText('Jira');
    expect(mockApi.refreshMarketplaceRegistry).toHaveBeenCalledWith('r1');
    unmount();

    mockApi.fetchIntegrationCatalog.mockResolvedValue({
      items: CATALOG,
      marketplace: { enabled: false, registries: [] }
    });
    renderPage('/admin/integrations?tab=catalog');
    expect(await screen.findByTestId('catalog-marketplace-off')).toBeInTheDocument();
  });

  test('inbound lists what connects to iHub with its status', async () => {
    renderPage('/admin/integrations?tab=inbound');
    const cards = await screen.findAllByTestId('inbound-card');
    expect(cards.map(c => c.getAttribute('data-inbound'))).toEqual([
      'outlook',
      'browser-extension',
      'copilot-agent',
      'nextcloud-embed',
      'mcp-gateway'
    ]);
    const gateway = cards.find(c => c.getAttribute('data-inbound') === 'mcp-gateway');
    expect(within(gateway).getByRole('link')).toHaveAttribute('href', '/admin/mcp/gateway');
    expect(await within(gateway).findByText('On')).toBeInTheDocument();
    const outlook = cards.find(c => c.getAttribute('data-inbound') === 'outlook');
    expect(within(outlook).getByText('Available')).toBeInTheDocument();
    // The storage and people directory hub cards are installations now.
    expect(screen.queryByText('People directories')).not.toBeInTheDocument();
  });
});

describe('deep link and routes', () => {
  test('?install= opens the install dialog with the prefilled values and label', async () => {
    renderPage(
      '/admin/integrations?install=com.intrafind__ldap-directory&v.authProvider=corp-ad&label=Corporate+AD'
    );
    expect(await screen.findByTestId('install-dialog')).toHaveTextContent(
      'com.intrafind/ldap-directory'
    );
    expect(mockApi.dialogProps.prefill).toEqual({
      values: { authProvider: 'corp-ad' },
      label: 'Corporate AD'
    });
  });

  test('/admin/integrations/installed is gone; an installation has its own route', () => {
    const root = path.resolve(__dirname, '../../..');
    const app = fs.readFileSync(path.join(root, 'client/src/App.jsx'), 'utf8');
    expect(app).not.toMatch(/integrations\/installed/);
    expect(app).not.toMatch(/AdminInstalledIntegrationsPage/);
    expect(app).toMatch(/path="integrations\/:instanceId"/);
    expect(
      fs.existsSync(
        path.join(root, 'client/src/features/admin/pages/AdminInstalledIntegrationsPage.jsx')
      )
    ).toBe(false);

    const nav = fs.readFileSync(
      path.join(root, 'client/src/features/admin/components/AdminSidebarNavData.js'),
      'utf8'
    );
    expect(nav).not.toMatch(/integrations\/installed/);
  });
});
