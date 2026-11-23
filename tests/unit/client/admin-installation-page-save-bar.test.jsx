// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page of one installation has ONE save bar (`SaveSectionsBar`) for everything it edits:
 * the Settings editor (a dedicated editor or the generic form) and the tool approval of the
 * Overview.
 *
 *   - no bar until something changed; it stays while another tab is open;
 *   - one Save runs the Settings first, then the approval; a failure stops there, names the
 *     error and keeps what did not save (retry saves only that);
 *   - Discard resets both;
 *   - the editors and the approval card draw no Save or Cancel of their own;
 *   - the install DIALOG (not on this page) keeps its own Install button.
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
  fetchAdminPlatformConfig: jest.fn(),
  markInstalledIntegrationActionsReviewed: jest.fn(),
  fetchIntegrationDefinition: jest.fn(),
  installIntegration: jest.fn(),
  fetchIntegrationAction: jest.fn(),
  saveIntegrationInstructions: jest.fn(),
  setInstalledIntegrationApproval: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegration: (...args) => mockApi.fetchInstalledIntegration(...args),
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  updateInstalledIntegration: (...args) => mockApi.updateInstalledIntegration(...args),
  testInstalledIntegration: (...args) => mockApi.testInstalledIntegration(...args),
  deleteInstalledIntegration: (...args) => mockApi.deleteInstalledIntegration(...args),
  setInstalledIntegrationEnabled: (...args) => mockApi.setInstalledIntegrationEnabled(...args),
  fetchIntegrationDefinitionFile: jest.fn(),
  markInstalledIntegrationActionsReviewed: (...args) =>
    mockApi.markInstalledIntegrationActionsReviewed(...args),
  fetchIntegrationDefinition: (...args) => mockApi.fetchIntegrationDefinition(...args),
  installIntegration: (...args) => mockApi.installIntegration(...args),
  testIntegrationDraft: jest.fn(),
  fetchIntegrationConnections: jest.fn().mockResolvedValue([]),
  fetchIntegrationAction: (...args) => mockApi.fetchIntegrationAction(...args),
  saveIntegrationInstructions: (...args) => mockApi.saveIntegrationInstructions(...args),
  setInstalledIntegrationApproval: (...args) => mockApi.setInstalledIntegrationApproval(...args)
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
const IntegrationInstallForm =
  require('../../../client/src/features/admin/components/integrations/IntegrationInstallForm').default;

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

/** A web search engine's detail, as `GET …/installed/:id` returns it. */
function engineDetail(id, name, values, install) {
  const definition = {
    id: `com.intrafind/${id}-search`,
    name,
    version: '1.0.0',
    protocol: 'native',
    type: 'web-search',
    builtIn: true,
    authModes: ['none'],
    releases: [{ version: '1.0.0', summary: 'First version' }],
    install,
    actions: [{ name: 'search', title: 'Search the web', sideEffect: 'read' }]
  };
  return {
    instance: {
      id,
      definition: definition.id,
      definitionName: name,
      label: name,
      labelLocalized: null,
      enabled: true,
      protocol: 'native',
      builtIn: true,
      type: 'web-search',
      auth: { mode: 'none' },
      actions: { enabled: ['*'], disabled: [], overrides: {} }
    },
    values,
    actions: [
      { name: 'search', toolId: `${id}Search`, title: 'Search the web', sideEffect: 'read' }
    ],
    definition
  };
}

const BRAVE_DETAIL = engineDetail('brave', 'Brave Search', { apiKeyRef: 'brave-key' }, [
  {
    key: 'apiKeyRef',
    type: 'credential',
    scope: 'admin',
    credentialTypes: ['secret'],
    title: { en: 'API key' }
  }
]);
const QWANT_DETAIL = engineDetail('qwant', 'Qwant', {}, []);

const DETAILS = {
  ifinder: IFINDER_DETAIL,
  govdata: CKAN_DETAIL,
  brave: BRAVE_DETAIL,
  qwant: QWANT_DETAIL
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
  mockApi.fetchInstalledIntegration.mockImplementation(async id => DETAILS[id] || CKAN_DETAIL);
  mockApi.updateInstalledIntegration.mockImplementation(async (id, body) => ({ ...body }));
  mockApi.testInstalledIntegration.mockResolvedValue({ success: true, steps: [] });
  mockApi.deleteInstalledIntegration.mockResolvedValue(undefined);
  mockApi.setInstalledIntegrationApproval.mockResolvedValue({});
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

const SAVE = { name: 'Save Changes' };
const baseUrlOf = () => screen.getByLabelText(/iFinder base URL/);
const approvalSelect = () => screen.getByLabelText('Ask before an action runs');

let stored;

beforeEach(() => {
  stored = IFINDER_DETAIL;
  mockApi.fetchInstalledIntegration.mockImplementation(async id =>
    id === 'ifinder' ? structuredClone(stored) : DETAILS[id]
  );
  mockApi.updateInstalledIntegration.mockImplementation(async (id, body) => {
    stored = { ...stored, values: { ...stored.values, ...body.values } };
    return { id, ...body };
  });
  mockApi.setInstalledIntegrationApproval.mockImplementation(async (id, approval) => {
    stored = { ...stored, instance: { ...stored.instance, approval } };
    return {};
  });
});

describe('installation page: one save bar', () => {
  test('no bar while nothing is edited, on any tab', async () => {
    renderAt('/admin/integrations/ifinder');
    await screen.findByRole('heading', { level: 1, name: 'Our iFinder' });
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Settings/ }));
    await screen.findByTestId('ifinder-editor');
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
  });

  test('a Settings edit shows the bar; the editor has no Save or Cancel of its own', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    const editor = await screen.findByTestId('ifinder-editor');
    expect(within(editor).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    // A submit button that is not seen keeps Enter in a field saving.
    expect(within(editor).getByTestId('implicit-submit')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });

    expect(await screen.findByRole('button', SAVE)).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  test('an edit that only changes a nested part counts (an action switch, the label)', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    const editor = await screen.findByTestId('ifinder-editor');

    fireEvent.change(within(editor).getByLabelText('Label'), { target: { value: 'Search' } });
    expect(await screen.findByRole('button', SAVE)).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('Label'), { target: { value: 'Our iFinder' } });
    // Back to the stored value: nothing left to save.
    await waitFor(() => expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument());
  });

  test('Discard puts the editor back and hides the bar', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(baseUrlOf()).toHaveValue('https://ifinder.example.com'));
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
    expect(mockApi.updateInstalledIntegration).not.toHaveBeenCalled();
  });

  test('an approval change shows the bar and has no Save approval button; Discard resets it', async () => {
    renderAt('/admin/integrations/ifinder');
    await screen.findByRole('heading', { level: 1, name: 'Our iFinder' });
    expect(screen.queryByRole('button', { name: 'Save approval' })).not.toBeInTheDocument();

    fireEvent.change(approvalSelect(), { target: { value: 'always' } });

    expect(await screen.findByRole('button', SAVE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save approval' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(approvalSelect()).toHaveValue(''));
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();
    expect(mockApi.setInstalledIntegrationApproval).not.toHaveBeenCalled();
  });

  test('a Settings edit survives a tab switch and so does the bar', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });
    await screen.findByRole('button', SAVE);

    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    expect(screen.getByTestId('installation-facts')).toBeVisible();
    // The bar belongs to the page, not to the tab.
    expect(screen.getByRole('button', SAVE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Settings/ }));
    expect(baseUrlOf()).toHaveValue('https://edited.example.com');
  });

  test('one Save stores the Settings, then the approval, and keeps the approval edit across the reload', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });
    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    fireEvent.change(approvalSelect(), { target: { value: 'always' } });

    fireEvent.click(await screen.findByRole('button', SAVE));

    await waitFor(() => expect(mockApi.setInstalledIntegrationApproval).toHaveBeenCalledTimes(1));
    expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1);
    expect(mockApi.updateInstalledIntegration.mock.calls[0][1].values.baseUrl).toBe(
      'https://edited.example.com'
    );
    // Settings first: the Settings save reloads the installation, which must not drop the
    // approval edit that is still waiting.
    expect(mockApi.updateInstalledIntegration.mock.invocationCallOrder[0]).toBeLessThan(
      mockApi.setInstalledIntegrationApproval.mock.invocationCallOrder[0]
    );
    expect(mockApi.setInstalledIntegrationApproval).toHaveBeenCalledWith(
      'ifinder',
      expect.objectContaining({ default: 'always' })
    );
    await waitFor(() => expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument());
    expectNoMissingKeys();
  });

  test('a failed Settings save stops there: the approval is not sent, the bar stays and names the error', async () => {
    mockApi.updateInstalledIntegration.mockRejectedValueOnce(new Error('Portal is down'));
    renderAt('/admin/integrations/ifinder?tab=settings');
    await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });
    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    fireEvent.change(approvalSelect(), { target: { value: 'always' } });

    fireEvent.click(await screen.findByRole('button', SAVE));

    expect(await screen.findAllByText('Portal is down')).not.toHaveLength(0);
    expect(mockApi.setInstalledIntegrationApproval).not.toHaveBeenCalled();
    expect(screen.getByRole('button', SAVE)).toBeInTheDocument();
    // Nothing was thrown away, and a second Save goes through.
    expect(approvalSelect()).toHaveValue('always');
    fireEvent.click(screen.getByRole('button', SAVE));
    await waitFor(() => expect(mockApi.setInstalledIntegrationApproval).toHaveBeenCalledTimes(1));
    expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(2);
  });

  test('a failed approval save keeps the bar with its error; the retry saves only the approval', async () => {
    mockApi.setInstalledIntegrationApproval.mockRejectedValueOnce(new Error('Approval refused'));
    renderAt('/admin/integrations/ifinder?tab=settings');
    await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });
    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    fireEvent.change(approvalSelect(), { target: { value: 'never' } });

    fireEvent.click(await screen.findByRole('button', SAVE));

    expect(await screen.findByText('Approval refused')).toBeInTheDocument();
    expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', SAVE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', SAVE));
    await waitFor(() => expect(mockApi.setInstalledIntegrationApproval).toHaveBeenCalledTimes(2));
    // The Settings were stored the first time: they are not sent again.
    expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument());
  });

  test("the editor's own check fails: nothing is sent, the bar stays and says why", async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: '' } });

    fireEvent.click(await screen.findByRole('button', SAVE));

    expect(await screen.findAllByText('Enter the iFinder base URL.')).not.toHaveLength(0);
    expect(mockApi.updateInstalledIntegration).not.toHaveBeenCalled();
    expect(screen.getByRole('button', SAVE)).toBeInTheDocument();
  });

  test('Enter in a field saves the editor like the bar does', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    const editor = await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });

    fireEvent.submit(editor.querySelector('form'));

    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1));
  });

  test('saving the Settings with Enter does not drop an approval edit that is still waiting', async () => {
    renderAt('/admin/integrations/ifinder?tab=settings');
    const editor = await screen.findByTestId('ifinder-editor');
    fireEvent.change(baseUrlOf(), { target: { value: 'https://edited.example.com' } });
    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    fireEvent.change(approvalSelect(), { target: { value: 'always' } });

    fireEvent.submit(editor.querySelector('form'));

    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1));
    // The page reloaded the installation after the save; the approval edit is still there.
    await waitFor(() =>
      expect(mockApi.fetchInstalledIntegration.mock.calls.length).toBeGreaterThan(1)
    );
    await waitFor(() => expect(screen.getByRole('button', SAVE)).toBeInTheDocument());
    expect(approvalSelect()).toHaveValue('always');
    expect(mockApi.setInstalledIntegrationApproval).not.toHaveBeenCalled();
  });

  test('the generic form is saved by the bar too, and keeps no Save of its own on the page', async () => {
    renderAt('/admin/integrations/govdata?tab=settings');
    const form = await screen.findByTestId('generic-installation-editor');
    expect(within(form).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', SAVE)).not.toBeInTheDocument();

    fireEvent.change(await within(form).findByLabelText(/Portal URL/), {
      target: { value: 'https://data.example.org/ckan' }
    });
    fireEvent.click(await screen.findByRole('button', SAVE));

    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1));
    expect(mockApi.updateInstalledIntegration.mock.calls[0][1].values.baseUrl).toBe(
      'https://data.example.org/ckan'
    );
  });

  test('the install form keeps its own button where no page hosts it (dialog and standalone)', async () => {
    mockApi.fetchIntegrationDefinition.mockResolvedValue(CKAN_DETAIL.definition);
    const { unmount } = render(
      <MemoryRouter>
        <IntegrationInstallForm
          definitionId={CKAN_DETAIL.definition.id}
          variant="dialog"
          onCancel={() => {}}
          onSaved={() => {}}
        />
      </MemoryRouter>
    );
    await screen.findByLabelText(/Portal URL/);
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter>
        <IntegrationInstallForm
          definitionId={CKAN_DETAIL.definition.id}
          instanceId="govdata"
          variant="page"
          onCancel={() => {}}
          onSaved={() => {}}
        />
      </MemoryRouter>
    );
    await screen.findByLabelText(/Portal URL/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
