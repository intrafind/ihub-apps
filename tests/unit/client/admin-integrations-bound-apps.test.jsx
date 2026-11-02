// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An installation that apps bind:
 *
 *   - Admin → Integrations (Installed tab) names those apps when an
 *     installation is removed or disabled from its tile, and says they will be
 *     hidden — whether an app binds it by id, by definition or by type;
 *   - disabling one nobody binds asks nothing;
 *   - the app editor lists a binding whose installation is gone as "not
 *     installed", and its Unbind control drops the key from `app.integrations`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  fetchInstalledIntegrations: jest.fn(),
  fetchIntegrationCatalog: jest.fn(),
  fetchInstalledIntegration: jest.fn(),
  deleteInstalledIntegration: jest.fn(),
  setInstalledIntegrationEnabled: jest.fn(),
  fetchAdminApps: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  fetchIntegrationCatalog: (...args) => mockApi.fetchIntegrationCatalog(...args),
  fetchInstalledIntegration: (...args) => mockApi.fetchInstalledIntegration(...args),
  deleteInstalledIntegration: (...args) => mockApi.deleteInstalledIntegration(...args),
  setInstalledIntegrationEnabled: (...args) => mockApi.setInstalledIntegrationEnabled(...args),
  reloadIntegrationCatalog: jest.fn(),
  testInstalledIntegration: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAdminGroups: jest.fn().mockResolvedValue({ groups: {} }),
  fetchAdminPlatformConfig: jest.fn().mockResolvedValue(null),
  getAdminApiErrorMessage: err => err?.message || 'error',
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

const AdminIntegrationsPage =
  require('../../../client/src/features/admin/pages/AdminIntegrationsPage').default;
const IntegrationsConfigSection =
  require('../../../client/src/features/admin/components/app-form/IntegrationsConfigSection').default;

const INSTALLED = [
  { id: 'ckan-demo', label: 'Demo portal', definitionName: 'CKAN', enabled: true },
  { id: 'lonely', label: 'Lonely', definitionName: 'CKAN', enabled: true },
  {
    id: 'x500bund',
    label: 'X.500 Bund',
    definition: 'com.intrafind/ldap-directory',
    definitionName: 'LDAP people directory',
    type: 'people-directory',
    enabled: true
  }
];
const APPS = [
  {
    id: 'open-data',
    name: { en: 'Open Data', de: 'Offene Daten' },
    integrations: { 'ckan-demo': {} }
  },
  { id: 'chat', name: { en: 'Chat' } },
  { id: 'research', name: { en: 'Research' }, integrations: { 'ckan-demo': { actions: ['x'] } } },
  { id: 'people', name: { en: 'People search' }, integrations: { 'type:people-directory': {} } }
];

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchInstalledIntegrations.mockResolvedValue({ items: INSTALLED });
  mockApi.fetchIntegrationCatalog.mockResolvedValue({ items: [] });
  mockApi.fetchAdminApps.mockResolvedValue(APPS);
  mockApi.deleteInstalledIntegration.mockResolvedValue({});
  mockApi.setInstalledIntegrationEnabled.mockResolvedValue({});
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/integrations']}>
      <AdminIntegrationsPage />
    </MemoryRouter>
  );

describe('AdminIntegrationsPage: bound apps', () => {
  test('the remove dialog names the apps that bind the installation', async () => {
    renderPage();
    await screen.findByText('Demo portal');

    fireEvent.click(screen.getByRole('button', { name: 'Remove ckan-demo' }));

    expect(screen.getByText('Remove integration?')).toBeInTheDocument();
    expect(
      screen.getByText(
        /An app that requires it is hidden from users until its configuration changes/
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('bound-apps')).toHaveTextContent('Used by: Open Data, Research');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(mockApi.deleteInstalledIntegration).toHaveBeenCalledWith('ckan-demo')
    );
  });

  test('disabling a bound installation asks first and names the apps', async () => {
    renderPage();
    await screen.findByText('Demo portal');

    fireEvent.click(screen.getByRole('button', { name: 'Disable ckan-demo' }));

    expect(mockApi.setInstalledIntegrationEnabled).not.toHaveBeenCalled();
    expect(screen.getByText('Disable integration?')).toBeInTheDocument();
    expect(
      screen.getByText(/go without it while it is disabled. An app that requires it is hidden/)
    ).toBeInTheDocument();
    expect(screen.getByTestId('bound-apps')).toHaveTextContent('Open Data, Research');

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(mockApi.setInstalledIntegrationEnabled).toHaveBeenCalledWith('ckan-demo', false)
    );
  });

  test('an app binding the type of an installation counts as binding it', async () => {
    renderPage();
    await screen.findByText('X.500 Bund');

    fireEvent.click(screen.getByRole('button', { name: 'Disable x500bund' }));

    expect(mockApi.setInstalledIntegrationEnabled).not.toHaveBeenCalled();
    expect(screen.getByTestId('bound-apps')).toHaveTextContent('Used by: People search');
  });

  test('disabling an installation no app binds asks nothing', async () => {
    renderPage();
    await screen.findByText('Lonely');

    fireEvent.click(screen.getByRole('button', { name: 'Disable lonely' }));

    await waitFor(() =>
      expect(mockApi.setInstalledIntegrationEnabled).toHaveBeenCalledWith('lonely', false)
    );
    expect(screen.queryByText('Disable integration?')).not.toBeInTheDocument();
  });
});

describe('IntegrationsConfigSection: bindings to installations that are gone', () => {
  test('lists the stale binding and unbinds it', async () => {
    // The built-ins are installations like any other: `ifinder` is installed
    // here, `iassistant` is not, so only the latter is stale.
    mockApi.fetchInstalledIntegrations.mockResolvedValue({
      items: [
        ...INSTALLED,
        { id: 'ifinder', label: 'iFinder', definitionName: 'iFinder', enabled: true }
      ]
    });
    mockApi.fetchInstalledIntegration.mockResolvedValue({ actions: [], definition: null });
    const onChange = jest.fn();
    render(
      <MemoryRouter>
        <IntegrationsConfigSection
          app={{
            id: 'x',
            integrations: {
              'ckan-demo': { actions: ['search_datasets'] },
              gone: {},
              ifinder: {},
              iassistant: {}
            }
          }}
          onChange={onChange}
        />
      </MemoryRouter>
    );

    const stale = await screen.findByTestId('stale-integration-gone');
    expect(stale).toHaveTextContent('gone');
    expect(stale).toHaveTextContent('Not installed');
    expect(screen.getByTestId('stale-integration-iassistant')).toHaveTextContent('Not installed');
    expect(screen.queryByTestId('stale-integration-ifinder')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stale-integration-ckan-demo')).not.toBeInTheDocument();
    // The actions of the installed built-in are loaded like those of any installation.
    expect(mockApi.fetchInstalledIntegration).toHaveBeenCalledWith('ifinder');

    fireEvent.click(within(stale).getByRole('button', { name: 'Unbind' }));

    expect(onChange).toHaveBeenCalledWith({
      id: 'x',
      integrations: {
        'ckan-demo': { actions: ['search_datasets'] },
        ifinder: {},
        iassistant: {}
      }
    });
  });

  test('a binding is required unless its Required switch is off', async () => {
    mockApi.fetchInstalledIntegrations.mockResolvedValue({ items: INSTALLED });
    mockApi.fetchInstalledIntegration.mockResolvedValue({ actions: [], definition: null });
    const onChange = jest.fn();
    render(
      <MemoryRouter>
        <IntegrationsConfigSection
          app={{
            id: 'x',
            integrations: {
              'ckan-demo': { actions: ['search_datasets'] },
              lonely: { required: false }
            }
          }}
          onChange={onChange}
        />
      </MemoryRouter>
    );
    const required = await screen.findAllByRole('checkbox', { name: /^Required/ });
    expect(required).toHaveLength(2);
    // Absent `required` renders as on; an explicit `false` as off.
    expect(required[0]).toBeChecked();
    expect(required[1]).not.toBeChecked();

    fireEvent.click(required[0]);
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'x',
      integrations: {
        'ckan-demo': { actions: ['search_datasets'], required: false },
        lonely: { required: false }
      }
    });

    fireEvent.click(required[1]);
    // Switching it back on drops the key instead of writing `true`.
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'x',
      integrations: {
        'ckan-demo': { actions: ['search_datasets'] },
        lonely: {}
      }
    });
  });
});
