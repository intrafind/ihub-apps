// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration versioning in the admin UI:
 *
 *   - Admin → Integrations → Installed shows each installation's version, an
 *     "Update available" badge when the marketplace catalog has a newer
 *     compatible definition, and an "Incompatible" pill with the reason when
 *     the definition cannot run on this server;
 *   - a catalog card of an incompatible definition is greyed with Install
 *     disabled;
 *   - a marketplace card of an incompatible item is greyed with its button
 *     disabled, and an installed item with a newer version offers Update.
 */
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  fetchInstalledIntegrations: jest.fn(),
  fetchIntegrationCatalog: jest.fn(),
  fetchAdminApps: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  fetchIntegrationCatalog: (...args) => mockApi.fetchIntegrationCatalog(...args),
  fetchInstalledIntegration: jest.fn(),
  deleteInstalledIntegration: jest.fn(),
  setInstalledIntegrationEnabled: jest.fn(),
  reloadIntegrationCatalog: jest.fn(),
  testInstalledIntegration: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn(),
  installMarketplaceItem: jest.fn()
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
  () => ({ __esModule: true, default: () => null })
);
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text =
    typeof defaultOrOptions === 'string' ? defaultOrOptions : options.defaultValue || key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const AdminInstalledIntegrationsPage =
  require('../../../client/src/features/admin/pages/AdminInstalledIntegrationsPage').default;
const MarketplaceItemCard =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemCard').default;

const INSTALLED = [
  {
    id: 'govdata',
    label: 'GovData',
    definition: 'org.ckan/open-data-portal',
    definitionName: 'CKAN',
    definitionVersion: '1.2.0',
    currentVersion: '1.2.0',
    enabled: true,
    updateAvailable: true,
    latestVersion: '1.4.0'
  },
  {
    id: 'legacy',
    label: 'Legacy portal',
    definition: 'org.example/legacy',
    definitionName: 'Legacy',
    definitionVersion: '0.9.0',
    currentVersion: '0.9.0',
    enabled: true,
    incompatible: true,
    incompatibleReason: 'needs iHub >=9.0.0, this server runs 5.7.2',
    updateAvailable: false
  },
  {
    id: 'ifinder',
    label: 'Our iFinder',
    definition: 'com.intrafind/ifinder',
    definitionName: 'iFinder',
    definitionVersion: '1.0.0',
    currentVersion: '1.0.0',
    enabled: true,
    updateAvailable: false
  }
];

const CATALOG = [
  {
    id: 'org.example/legacy',
    name: 'Legacy',
    version: '0.9.0',
    protocol: 'openapi',
    supported: true,
    compatible: false,
    requires: '>=9.0.0',
    statusReason: 'needs iHub >=9.0.0, this server runs 5.7.2',
    authModes: ['none'],
    actionCount: 2,
    source: 'installed',
    installedInstances: ['legacy']
  },
  {
    id: 'org.ckan/open-data-portal',
    name: 'CKAN',
    version: '1.2.0',
    protocol: 'openapi',
    supported: true,
    compatible: true,
    requires: '>=5.6.0',
    authModes: ['none'],
    actionCount: 12,
    source: 'installed',
    installedInstances: ['govdata'],
    update: { latestVersion: '1.4.0', compatible: true }
  }
];

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchInstalledIntegrations.mockResolvedValue({ items: INSTALLED });
  mockApi.fetchIntegrationCatalog.mockResolvedValue({ items: CATALOG });
  mockApi.fetchAdminApps.mockResolvedValue([]);
});

const renderPage = (path = '/admin/integrations/installed') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AdminInstalledIntegrationsPage />
    </MemoryRouter>
  );

describe('installed integrations: versions, updates and compatibility', () => {
  test('the installed list shows the version, an update badge and the incompatible reason', async () => {
    renderPage();
    const govdata = (await screen.findByText('GovData')).closest('li');
    expect(within(govdata).getByTestId('installed-version')).toHaveTextContent('v1.2.0');
    expect(within(govdata).getByTestId('update-badge')).toHaveTextContent(
      'Update to v1.4.0 available'
    );
    expect(within(govdata).getByTestId('update-badge')).toHaveAttribute(
      'href',
      '/admin/marketplace?type=integration&q=org.ckan__open-data-portal'
    );

    const legacy = screen.getByText('Legacy portal').closest('li');
    expect(within(legacy).getByText('Incompatible')).toBeInTheDocument();
    expect(within(legacy).getByTestId('incompatible-reason')).toHaveTextContent(
      'needs iHub >=9.0.0, this server runs 5.7.2'
    );
    expect(within(legacy).queryByTestId('update-badge')).not.toBeInTheDocument();
    expect(within(legacy).getByRole('button', { name: 'Edit legacy' })).toBeDisabled();
    expect(within(legacy).getByRole('button', { name: 'Test legacy' })).toBeDisabled();

    // A built-in shows its version only.
    const ifinder = screen.getByText('Our iFinder').closest('li');
    expect(within(ifinder).getByTestId('installed-version')).toHaveTextContent('v1.0.0');
    expect(within(ifinder).queryByTestId('update-badge')).not.toBeInTheDocument();
    expect(within(ifinder).queryByText('Incompatible')).not.toBeInTheDocument();
  });

  test('the catalog greys an incompatible definition and disables Install', async () => {
    renderPage('/admin/integrations/installed?tab=catalog');
    const cards = await screen.findAllByTestId('catalog-card');
    const legacy = cards.find(card => card.getAttribute('data-compatible') === 'false');
    expect(legacy).toHaveClass('opacity-60');
    expect(within(legacy).getByRole('button', { name: 'Install' })).toBeDisabled();
    expect(within(legacy).getByTestId('incompatible-reason')).toHaveTextContent(
      'Cannot be installed: needs iHub >=9.0.0, this server runs 5.7.2.'
    );
    const ckan = cards.find(card => card.getAttribute('data-compatible') === 'true');
    expect(ckan).not.toHaveClass('opacity-60');
    expect(within(ckan).getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(within(ckan).getByText('Update to v1.4.0 available')).toBeInTheDocument();
  });
});

describe('marketplace card: compatibility and updates', () => {
  const item = {
    registryId: 'official',
    type: 'integration',
    name: 'org.example__legacy',
    displayName: { en: 'Legacy' },
    description: { en: 'An old one' },
    version: '2.0.0',
    installationStatus: 'available'
  };

  test('an incompatible item is greyed with its button disabled and the reason shown', () => {
    render(
      <MemoryRouter>
        <MarketplaceItemCard
          item={{ ...item, compatible: false, requires: '>=9.0.0', serverVersion: '5.7.2' }}
        />
      </MemoryRouter>
    );
    const card = screen.getByTestId('marketplace-item-card');
    expect(card).toHaveClass('opacity-60');
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    expect(screen.getByTestId('incompatible-reason')).toHaveTextContent(
      'Needs iHub >=9.0.0; this server runs 5.7.2.'
    );
  });

  test('an installed item with a newer catalog version offers Update and shows both versions', () => {
    render(
      <MemoryRouter>
        <MarketplaceItemCard
          item={{
            ...item,
            compatible: true,
            installationStatus: 'update-available',
            installation: { version: '1.0.0' }
          }}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('Update available')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0 → v2.0.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();
    expect(screen.getByText('✓ Installed')).toBeInTheDocument();
  });
});
