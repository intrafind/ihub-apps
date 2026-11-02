// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page of one installation (`/admin/integrations/:instanceId`):
 *
 *   - Overview lists the key facts (never a secret), the actions with their
 *     side effects and the apps that bind the installation;
 *   - Settings renders the dedicated iFinder editor for the iFinder
 *     installation and the generic form for a CKAN portal;
 *   - the iFinder editor checks its cross-field rules, then saves its values
 *     with the label's other languages and the groups kept;
 *   - Test, Remove (with confirmation) work from the header;
 *   - every string comes from shared/i18n/en.json.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchInstalledIntegration: jest.fn(),
  fetchInstalledIntegrations: jest.fn(),
  updateInstalledIntegration: jest.fn(),
  testInstalledIntegration: jest.fn(),
  deleteInstalledIntegration: jest.fn(),
  setInstalledIntegrationEnabled: jest.fn(),
  fetchAdminApps: jest.fn(),
  fetchAdminPlatformConfig: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegration: (...args) => mockApi.fetchInstalledIntegration(...args),
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  updateInstalledIntegration: (...args) => mockApi.updateInstalledIntegration(...args),
  testInstalledIntegration: (...args) => mockApi.testInstalledIntegration(...args),
  deleteInstalledIntegration: (...args) => mockApi.deleteInstalledIntegration(...args),
  setInstalledIntegrationEnabled: (...args) => mockApi.setInstalledIntegrationEnabled(...args),
  fetchIntegrationDefinitionFile: jest.fn(),
  fetchIntegrationDefinition: jest.fn(),
  installIntegration: jest.fn(),
  testIntegrationDraft: jest.fn(),
  fetchIntegrationConnections: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAdminPlatformConfig: (...args) => mockApi.fetchAdminPlatformConfig(...args),
  fetchAdminGroups: jest.fn().mockResolvedValue({
    groups: {
      staff: { name: 'Staff', permissions: { integrations: ['ifinder'] } },
      guests: { name: 'Guests', permissions: { integrations: ['type:storage'] } }
    }
  }),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn(),
  listCredentials: jest.fn().mockResolvedValue([])
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => ''
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/IntegrationTestResults', () => ({
  __esModule: true,
  default: ({ title }) => <div data-testid="test-results">{title}</div>
}));
jest.mock(
  '../../../client/src/features/admin/components/integrations/IntegrationReleaseNotes',
  () => ({ __esModule: true, default: () => <div data-testid="release-notes" /> })
);
jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: ({ id, label, value }) => (
    <div data-testid={`credential-${id}`}>
      {label}: {value}
    </div>
  )
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminInstallationPage =
  require('../../../client/src/features/admin/pages/AdminInstallationPage').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    // A key missing from en.json shows as the key, so the assertions below
    // catch it instead of passing on the code's English default.
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

const IFINDER_DEFINITION = {
  id: 'com.intrafind/ifinder',
  name: 'iFinder',
  version: '1.0.0',
  protocol: 'native',
  builtIn: true,
  description: 'Enterprise search over iFinder.',
  docsUrl: 'https://example.com/docs/ifinder',
  authModes: ['none'],
  releases: [],
  install: [
    { key: 'baseUrl', type: 'url', scope: 'admin', title: { en: 'iFinder base URL' } },
    {
      key: 'privateKeyRef',
      type: 'credential',
      scope: 'admin',
      credentialTypes: ['privateKey', 'secret'],
      title: { en: 'Private key' }
    },
    { key: 'timeout', type: 'number', scope: 'admin', advanced: true, title: { en: 'Timeout' } }
  ],
  actions: [
    { name: 'search', title: 'Search', sideEffect: 'read' },
    { name: 'getContent', title: 'Get content', sideEffect: 'read' }
  ]
};

const IFINDER_DETAIL = {
  instance: {
    id: 'ifinder',
    definition: 'com.intrafind/ifinder',
    definitionName: 'iFinder',
    definitionVersion: '1.0.0',
    label: 'Our iFinder',
    labelLocalized: { en: 'Our iFinder', de: 'Unser iFinder' },
    enabled: true,
    protocol: 'native',
    builtIn: true,
    type: null,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  },
  values: {
    baseUrl: 'https://ifinder.example.com',
    authMode: 'ihubSigned',
    privateKeyRef: 'ifinder-signing-key',
    defaultSearchProfile: 'searchprofile-standard',
    allowedSearchProfiles: ['a', 'b'],
    timeout: 30000
  },
  actions: [
    { name: 'search', toolId: 'iFinder_search', title: 'Search', sideEffect: 'read' },
    {
      name: 'getContent',
      toolId: 'iFinder_getContent',
      title: 'Get content',
      sideEffect: 'read',
      enabled: false
    }
  ],
  definition: IFINDER_DEFINITION
};

const CKAN_DETAIL = {
  instance: {
    id: 'govdata',
    definition: 'org.ckan/open-data-portal',
    definitionName: 'CKAN open data portal',
    label: 'GovData',
    labelLocalized: { en: 'GovData' },
    enabled: true,
    protocol: 'openapi',
    builtIn: false,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  },
  values: { baseUrl: 'https://www.govdata.de/ckan', maxRows: 10 },
  actions: [{ name: 'search_datasets', title: 'Search datasets', sideEffect: 'read' }],
  definition: {
    id: 'org.ckan/open-data-portal',
    name: 'CKAN open data portal',
    version: '1.2.0',
    protocol: 'openapi',
    supported: true,
    authModes: ['none', 'service-account'],
    supportedAuthModes: ['none', 'service-account'],
    releases: [{ version: '1.2.0', summary: 'Current' }],
    install: [
      { key: 'baseUrl', type: 'url', scope: 'admin', title: { en: 'Portal URL' } },
      { key: 'maxRows', type: 'number', scope: 'admin', title: { en: 'Rows' } }
    ],
    actions: [{ name: 'search_datasets', title: 'Search datasets', sideEffect: 'read' }]
  }
};

const APPS = [
  { id: 'ifinder-search', name: { en: 'iFinder search' }, integrations: { ifinder: {} } },
  { id: 'chat', name: { en: 'Chat' } }
];

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchInstalledIntegrations.mockResolvedValue({
    items: [IFINDER_DETAIL.instance, CKAN_DETAIL.instance]
  });
  mockApi.fetchAdminApps.mockResolvedValue(APPS);
  mockApi.fetchAdminPlatformConfig.mockResolvedValue({
    oidcAuth: { providers: [] },
    oauth: { issuer: 'https://ihub.example.com' }
  });
  mockApi.fetchInstalledIntegration.mockImplementation(async id =>
    id === 'ifinder' ? IFINDER_DETAIL : CKAN_DETAIL
  );
  mockApi.updateInstalledIntegration.mockImplementation(async (id, body) => ({ ...body }));
  mockApi.testInstalledIntegration.mockResolvedValue({ success: true, steps: [] });
  mockApi.deleteInstalledIntegration.mockResolvedValue(undefined);
});

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/integrations" element={<div data-testid="list-page" />} />
        <Route path="/admin/integrations/:instanceId" element={<AdminInstallationPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function expectNoMissingKeys() {
  expect(document.body.textContent).not.toMatch(/MISSING:/);
}

describe('installation page: overview', () => {
  test('shows the header, the facts, the actions and the binding apps', async () => {
    renderAt('/admin/integrations/ifinder');

    expect(await screen.findByRole('heading', { level: 1, name: 'Our iFinder' })).toBeVisible();
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');

    const facts = screen.getByTestId('installation-facts');
    expect(within(facts).getByText('https://ifinder.example.com')).toBeInTheDocument();
    expect(within(facts).getByText('JWT signed by iHub')).toBeInTheDocument();
    // The private key is a credential: only whether it is set, never its id.
    expect(within(facts).getByText('set')).toBeInTheDocument();
    expect(screen.queryByText('ifinder-signing-key')).not.toBeInTheDocument();

    const actions = screen.getByTestId('installation-actions');
    expect(within(actions).getByText('iFinder_search')).toBeInTheDocument();
    expect(within(actions).getAllByText('read')).toHaveLength(2);
    expect(within(actions).getByText('Off')).toBeInTheDocument();

    const apps = screen.getByTestId('installation-bound-apps');
    expect(within(apps).getByRole('link', { name: 'iFinder search' })).toHaveAttribute(
      'href',
      '/admin/apps/ifinder-search'
    );
    expect(screen.getByRole('link', { name: /Documentation/ })).toHaveAttribute(
      'href',
      'https://example.com/docs/ifinder'
    );
    expectNoMissingKeys();
  });

  test('Test runs the saved installation and shows the results', async () => {
    renderAt('/admin/integrations/ifinder');
    await screen.findByRole('heading', { level: 1, name: 'Our iFinder' });

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockApi.testInstalledIntegration).toHaveBeenCalledWith('ifinder'));
    expect(await screen.findByTestId('test-results')).toHaveTextContent(
      'Test results: Our iFinder'
    );
  });

  test('Remove asks, names the binding apps and returns to the list', async () => {
    renderAt('/admin/integrations/ifinder');
    await screen.findByRole('heading', { level: 1, name: 'Our iFinder' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByTestId('bound-apps')).toHaveTextContent('iFinder search');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockApi.deleteInstalledIntegration).toHaveBeenCalledWith('ifinder'));
    expect(await screen.findByTestId('list-page')).toBeInTheDocument();
  });
});

describe('installation page: settings', () => {
  test('the iFinder installation gets its dedicated editor', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');

    const editor = await screen.findByTestId('ifinder-editor');
    expect(screen.queryByTestId('generic-installation-editor')).not.toBeInTheDocument();
    expect(within(editor).getByLabelText(/iFinder base URL/)).toHaveValue(
      'https://ifinder.example.com'
    );
    expect(within(editor).getByLabelText('Token issuer')).toHaveValue('ihubSigned');
    expect(within(editor).getByTestId('credential-ifinder-private-key')).toHaveTextContent(
      'ifinder-signing-key'
    );
    expect(within(editor).getByLabelText('Search profiles users may pick')).toHaveValue('a\nb');
    // The OIDC key pair shows the issuer iFinder has to trust.
    fireEvent.click(within(editor).getByLabelText('Sign with the iHub OIDC key pair'));
    expect(within(editor).getByTestId('ifinder-keypair-status')).toHaveTextContent(
      'https://ihub.example.com'
    );
    // Token exchange swaps the signing settings for the exchange settings.
    fireEvent.change(within(editor).getByLabelText('Token issuer'), {
      target: { value: 'oidcTokenExchange' }
    });
    expect(within(editor).getByTestId('ifinder-token-exchange')).toBeInTheDocument();
    expectNoMissingKeys();
  });

  test('the iFinder editor checks the base URL, then saves values and label, and shows the granting groups', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    const editor = await screen.findByTestId('ifinder-editor');
    const baseUrl = within(editor).getByLabelText(/iFinder base URL/);

    fireEvent.change(baseUrl, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the iFinder base URL.');
    expect(mockApi.updateInstalledIntegration).not.toHaveBeenCalled();

    fireEvent.change(baseUrl, { target: { value: 'https://search.example.com' } });
    fireEvent.change(within(editor).getByLabelText('Search profiles users may pick'), {
      target: { value: 'a\n\nc, a' }
    });
    fireEvent.change(within(editor).getByLabelText('Label'), { target: { value: 'Search' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1));
    const [id, body] = mockApi.updateInstalledIntegration.mock.calls[0];
    expect(id).toBe('ifinder');
    expect(body.values).toMatchObject({
      baseUrl: 'https://search.example.com',
      authMode: 'ihubSigned',
      privateKeyRef: 'ifinder-signing-key',
      allowedSearchProfiles: ['a', 'c'],
      timeout: 30000
    });
    expect(body.label).toEqual({ en: 'Search', de: 'Unser iFinder' });
    expect(body).not.toHaveProperty('allowedGroups');
    // Who may use it comes from the groups that grant the installation.
    expect(within(editor).getByTestId('granted-groups')).toHaveTextContent('Granted to: staff');
    expect(body.actions).toEqual({ enabled: ['*'], disabled: [], overrides: {} });
    expect(await screen.findByText('Integration "ifinder" saved.')).toBeInTheDocument();
  });

  test('a CKAN installation gets the generic form; its definition has releases', async () => {
    renderAt('/admin/integrations/govdata?tab=settings');

    const form = await screen.findByTestId('generic-installation-editor');
    expect(screen.queryByTestId('ifinder-editor')).not.toBeInTheDocument();
    expect(within(form).getByLabelText(/Portal URL/)).toHaveValue('https://www.govdata.de/ckan');

    fireEvent.click(screen.getByRole('tab', { name: /Releases/ }));
    expect(await screen.findByTestId('release-notes')).toBeInTheDocument();
  });

  test('an installation without a release history has no Releases tab', async () => {
    renderAt('/admin/integrations/ifinder?tab=releases');
    await screen.findByRole('heading', { level: 1, name: 'Our iFinder' });
    expect(screen.queryByRole('tab', { name: /Releases/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
  });
});
