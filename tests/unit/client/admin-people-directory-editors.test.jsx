// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The dedicated editors of the people directories (concept "Unified
 * Integrations" 07 §3/§6):
 *
 *   - People directory (LDAP): the restored directory editor on the
 *     installation values — source with the sign-in providers of the editor
 *     context, access, network, visibility with the granting groups,
 *     model-facing texts in English and German, limits, mapping, actions,
 *     the test with a sample search;
 *   - LDAP browser: the directory picker with what the browser reuses, the
 *     browse settings, its own checks;
 *   - Microsoft Entra ID directory: the app registration with the AZURE_*
 *     fallbacks;
 *   - the pure form model, the tile facts of a browser, the payload with a
 *     full label map;
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
  fetchPeopleDirectoryEditorContext: jest.fn(),
  fetchAdminApps: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegration: (...args) => mockApi.fetchInstalledIntegration(...args),
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  updateInstalledIntegration: (...args) => mockApi.updateInstalledIntegration(...args),
  testInstalledIntegration: (...args) => mockApi.testInstalledIntegration(...args),
  fetchPeopleDirectoryEditorContext: (...args) =>
    mockApi.fetchPeopleDirectoryEditorContext(...args),
  deleteInstalledIntegration: jest.fn(),
  setInstalledIntegrationEnabled: jest.fn(),
  fetchIntegrationDefinitionFile: jest.fn(),
  fetchIntegrationDefinition: jest.fn(),
  installIntegration: jest.fn(),
  testIntegrationDraft: jest.fn(),
  fetchIntegrationConnections: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAdminPlatformConfig: jest.fn().mockResolvedValue({}),
  fetchAdminGroups: jest.fn().mockResolvedValue({
    groups: {
      staff: { name: 'Staff', permissions: { integrations: ['type:people-directory'] } },
      admins: { name: 'Admins', permissions: { integrations: ['corp-browser'] } }
    }
  }),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn(),
  listCredentials: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({ getBasePath: () => '' }));
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
  CredentialRefSelect: ({ id, label, value, onChange }) => (
    <label>
      {label}
      <input
        data-testid={`credential-${id}`}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  )
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminInstallationPage =
  require('../../../client/src/features/admin/pages/AdminInstallationPage').default;
const {
  getInstallationEditor,
  hasDedicatedEditor
} = require('../../../client/src/features/admin/components/integrations/editors/index.js');
const model = require('../../../client/src/features/admin/components/integrations/editors/peopleDirectoryEditorModel.js');
const {
  installationFacts
} = require('../../../client/src/features/admin/components/integrations/integrationFacts.js');
const {
  buildInstallationPayload
} = require('../../../client/src/features/admin/components/integrations/installationPayload.js');
const {
  fallbackState
} = require('../../../client/src/features/admin/components/integrations/editors/EntraDirectoryEditor.jsx');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

const CONTEXT = {
  presets: [
    {
      id: 'openldap',
      label: 'OpenLDAP / generic LDAP',
      personFilter: '(objectClass=inetOrgPerson)',
      searchAttributes: ['cn', 'sn'],
      attributeMapping: { name: ['displayName'], email: ['mail'] }
    },
    {
      id: 'activeDirectory',
      label: 'Active Directory',
      personFilter: '(&(objectCategory=person)(objectClass=user))',
      searchAttributes: ['cn', 'sAMAccountName'],
      attributeMapping: { name: ['displayName'], email: ['mail'], managerId: ['manager'] }
    }
  ],
  defaultPreset: 'openldap',
  fields: ['name', 'email', 'managerId'],
  defaults: { maxResults: 10, timeoutMs: 8000, concurrency: 2, requestDelayMs: 0 },
  limits: { maxResults: 50, timeoutMs: 30000, concurrency: 10, requestDelayMs: 60000 },
  browse: { defaults: { maxResults: 50 }, limits: { maxResults: 200 } },
  ldapProviders: [
    {
      name: 'corp-ad',
      displayName: 'Corporate AD',
      url: 'ldaps://dc.corp.example:636',
      baseDn: 'dc=corp,dc=example',
      preset: 'activeDirectory',
      starttls: false,
      hasBindAccount: true
    }
  ],
  entraEnvironment: {
    tenantId: { variable: 'AZURE_TENANT_ID', set: true },
    clientId: { variable: 'AZURE_CLIENT_ID', set: false },
    clientSecret: { variable: 'AZURE_CLIENT_SECRET', set: true }
  }
};

const DIRECTORY_DEFINITION = {
  id: 'com.intrafind/ldap-directory',
  name: 'People directory (LDAP)',
  version: '1.0.0',
  protocol: 'native',
  type: 'people-directory',
  builtIn: true,
  authModes: ['none'],
  releases: [{ version: '1.0.0', summary: 'First' }],
  install: [],
  actions: [
    { name: 'search_people', title: 'Search people', sideEffect: 'read' },
    { name: 'get_person', title: 'Get a person', sideEffect: 'read' },
    { name: 'list_units', title: 'List units', sideEffect: 'read' }
  ]
};

const CORP = {
  instance: {
    id: 'corp',
    definition: 'com.intrafind/ldap-directory',
    definitionName: 'People directory (LDAP)',
    label: 'Company directory',
    labelLocalized: { en: 'Company directory', de: 'Firmenverzeichnis' },
    description: { en: 'Employees of our company.' },
    enabled: true,
    protocol: 'native',
    type: 'people-directory',
    builtIn: true,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    status: { connected: true, transport: 'ldaps', problems: [], warnings: [] }
  },
  values: {
    authProvider: 'corp-ad',
    maxResults: 10,
    timeoutMs: 8000,
    concurrency: 2,
    requestDelayMs: 0,
    dataFlow: 'internal',
    mapping_managerId: ['manager']
  },
  actions: [
    { name: 'search_people', title: 'Search people', sideEffect: 'read', available: true },
    { name: 'get_person', title: 'Get a person', sideEffect: 'read', available: true },
    { name: 'list_units', title: 'List units', sideEffect: 'read', available: false }
  ],
  definition: DIRECTORY_DEFINITION
};

const BROWSER = {
  instance: {
    id: 'corp-browser',
    definition: 'com.intrafind/ldap-browser',
    definitionName: 'LDAP browser',
    label: 'Company directory – LDAP browser',
    labelLocalized: { en: 'Company directory – LDAP browser' },
    enabled: true,
    protocol: 'native',
    type: null,
    builtIn: true,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  },
  values: { directory: 'corp', maxResults: 50 },
  actions: [
    { name: 'browse_search', title: 'Search entries', sideEffect: 'read', available: true },
    { name: 'browse_read', title: 'Read an entry', sideEffect: 'read', available: true },
    { name: 'browse_children', title: 'List children', sideEffect: 'read', available: true }
  ],
  definition: {
    id: 'com.intrafind/ldap-browser',
    name: 'LDAP browser',
    version: '1.0.0',
    protocol: 'native',
    builtIn: true,
    authModes: ['none'],
    releases: [],
    install: [],
    actions: [
      { name: 'browse_search', title: 'Search entries', sideEffect: 'read' },
      { name: 'browse_read', title: 'Read an entry', sideEffect: 'read' },
      { name: 'browse_children', title: 'List children', sideEffect: 'read' }
    ]
  }
};

const ENTRA = {
  instance: {
    id: 'entra',
    definition: 'com.intrafind/entra-directory',
    definitionName: 'Microsoft Entra ID directory',
    label: 'Microsoft Entra ID directory',
    labelLocalized: null,
    enabled: true,
    protocol: 'native',
    type: 'people-directory',
    builtIn: true,
    auth: { mode: 'none' },
    actions: { enabled: ['*'], disabled: [], overrides: {} }
  },
  values: { clientId: '', clientSecretRef: 'entra-secret' },
  actions: [{ name: 'findUser', title: 'Find a person', sideEffect: 'read', available: true }],
  definition: {
    id: 'com.intrafind/entra-directory',
    name: 'Microsoft Entra ID directory',
    version: '1.0.0',
    protocol: 'native',
    type: 'people-directory',
    builtIn: true,
    authModes: ['none'],
    releases: [],
    install: [],
    actions: [{ name: 'findUser', title: 'Find a person', sideEffect: 'read' }]
  }
};

const DETAILS = { corp: CORP, 'corp-browser': BROWSER, entra: ENTRA };

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchInstalledIntegrations.mockResolvedValue({
    items: [
      {
        ...CORP.instance,
        values: {
          url: 'ldaps://dc.corp.example:636',
          baseDn: 'dc=corp,dc=example',
          bindMode: 'service',
          bindDn: 'cn=svc'
        }
      },
      BROWSER.instance,
      ENTRA.instance
    ]
  });
  mockApi.fetchAdminApps.mockResolvedValue([]);
  mockApi.fetchInstalledIntegration.mockImplementation(async id => DETAILS[id]);
  mockApi.fetchPeopleDirectoryEditorContext.mockResolvedValue(CONTEXT);
  mockApi.updateInstalledIntegration.mockImplementation(async (id, body) => ({ ...body }));
  mockApi.testInstalledIntegration.mockResolvedValue({ success: true, steps: [] });
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

describe('editor registry', () => {
  test('the people directories and the LDAP browser have dedicated editors', () => {
    for (const id of [
      'com.intrafind/ldap-directory',
      'com.intrafind/ldap-browser',
      'com.intrafind/entra-directory'
    ]) {
      expect(hasDedicatedEditor(id)).toBe(true);
      expect(getInstallationEditor(id)).toBeTruthy();
    }
    expect(hasDedicatedEditor('org.ckan/open-data-portal')).toBe(false);
  });
});

describe('people directory form model', () => {
  test('round-trips the installation values, empty fields left out', () => {
    const values = {
      authProvider: 'corp-ad',
      starttls: false,
      bindMode: 'service',
      bindDn: 'cn=svc',
      bindPasswordRef: 'svc-pw',
      searchAttributes: ['cn', 'mail'],
      mapping_jobTitle: ['title', 'dn:ou'],
      tlsCa: ['corp-ca'],
      allowedHosts: ['dc.corp.local'],
      tlsMinVersion: 'TLSv1.2',
      units: true,
      maxResults: 25,
      dataFlow: 'external'
    };
    const form = model.directoryValuesToForm(values, { label: { en: 'Corp' } });
    expect(form.sourceMode).toBe('provider');
    expect(form.starttls).toBe('off');
    expect(form.attributeMapping.jobTitle).toBe('title, dn:ou');
    expect(form.name).toEqual({ en: 'Corp', de: '' });
    expect(model.directoryFormToValues(form)).toEqual(values);
  });

  test('a direct connection without a bind is anonymous; switching source drops the provider', () => {
    const form = model.directoryValuesToForm({ authProvider: 'corp-ad', url: 'ldaps://a' });
    expect(model.directoryFormToValues({ ...form, sourceMode: 'direct', baseDn: 'o=a' })).toEqual({
      url: 'ldaps://a',
      baseDn: 'o=a',
      bindMode: 'anonymous',
      dataFlow: 'internal'
    });
  });

  test('checks what the server would refuse, by install field', () => {
    const form = {
      ...model.directoryValuesToForm({}),
      url: 'http://wrong',
      bindMode: 'service',
      tlsCa: 'Bad.pem',
      personFilter: 'objectClass=person',
      searchAttributes: 'cn, 1bad',
      maxResults: '99'
    };
    const fields = model.validateDirectoryForm(form, { limits: CONTEXT.limits }).map(e => e.field);
    expect(fields).toEqual([
      'baseDn',
      'url',
      'bindDn',
      'bindPasswordRef',
      'tlsCa',
      'personFilter',
      'searchAttributes',
      'maxResults'
    ]);
    expect(model.inputIdForField('mapping_email')).toBe('pd-mapping-email');
    expect(model.inputIdForField('url')).toBe('pd-url');
  });

  test('derives transport and preset from the form and the reused provider', () => {
    const provider = CONTEXT.ldapProviders[0];
    const form = model.directoryValuesToForm({ authProvider: 'corp-ad' });
    expect(model.transportOf(form, provider)).toBe('ldaps');
    expect(model.effectivePresetId(form, provider)).toBe('activeDirectory');
    expect(model.transportOf({ ...form, sourceMode: 'direct', url: 'ldap://x' })).toBe('plaintext');
    expect(
      model.transportOf({ ...form, sourceMode: 'direct', url: 'ldap://x', starttls: 'on' })
    ).toBe('starttls');
    expect(model.toolIdsFor('corp', true)).toEqual([
      'corp__search_people',
      'corp__get_person',
      'corp__list_units'
    ]);
  });

  test('the LDAP browser form maps its values and checks its own fields', () => {
    const form = model.browserValuesToForm({
      directory: 'corp',
      bindMode: 'service',
      bindDn: 'cn=reader',
      bindPasswordRef: 'reader',
      denyAttributes: ['info']
    });
    expect(form.denyAttributes).toBe('info');
    expect(model.browserFormToValues({ ...form, baseDn: ' ou=groups ', maxResults: '20' })).toEqual(
      {
        directory: 'corp',
        baseDn: 'ou=groups',
        maxResults: 20,
        bindMode: 'service',
        bindDn: 'cn=reader',
        bindPasswordRef: 'reader',
        denyAttributes: ['info']
      }
    );
    // The directory's own account: no bind values at all.
    expect(model.browserFormToValues({ ...form, bindMode: 'directory' })).toEqual({
      directory: 'corp',
      denyAttributes: ['info']
    });
    const problems = model.validateBrowserForm({
      ...form,
      directory: '',
      maxResults: '500',
      bindPasswordRef: '',
      denyAttributes: '1bad'
    });
    expect(problems.map(p => p.field)).toEqual([
      'directory',
      'maxResults',
      'bindPasswordRef',
      'denyAttributes'
    ]);
    expect(problems[0].message.key).toBe(
      'admin.integrations.editors.ldapBrowser.errors.directoryRequired'
    );
    expect(model.browseToolIdsFor('corp-browser')).toEqual([
      'corp-browser__browse_search',
      'corp-browser__browse_read',
      'corp-browser__browse_children'
    ]);
  });
});

describe('payload, facts and Entra fallbacks', () => {
  test('a label map replaces the stored label in every language', () => {
    const body = buildInstallationPayload(CORP.instance, {
      values: {},
      lang: 'en',
      label: 'ignored',
      labelMap: { en: ' Corp ', de: '' },
      descriptionMap: { en: '', de: '' }
    });
    expect(body.label).toEqual({ en: 'Corp' });
    expect(body.description).toBeUndefined();
  });

  test('an LDAP browser tile names its directory, base and account', () => {
    const installations = [{ id: 'corp', label: 'Company directory' }];
    const facts = installationFacts(
      { definition: 'com.intrafind/ldap-browser', values: { directory: 'corp' } },
      { installations }
    );
    expect(facts.map(fact => [fact.id, fact.text ?? fact.valueDefault])).toEqual([
      ['directory', 'Company directory (corp)'],
      ['baseDn', "the directory's base DN"],
      ['account', "the directory's account"],
      ['maxResults', '50']
    ]);
    const own = installationFacts({
      definition: 'com.intrafind/ldap-browser',
      values: { directory: 'corp', baseDn: 'ou=g', bindMode: 'service', bindPasswordRef: 'x' }
    });
    expect(own.find(fact => fact.id === 'baseDn').text).toBe('ou=g');
    expect(own.find(fact => fact.id === 'bindPassword').secret).toBe('set');
    expect(JSON.stringify(own)).not.toContain('"x"');
  });

  test('a directory tile shows the preset instead of the retired browser switch', () => {
    const facts = installationFacts({
      definition: 'com.intrafind/ldap-directory',
      values: { url: 'ldaps://x', baseDn: 'o=x', preset: 'ivbb', browse: true }
    });
    expect(facts.map(fact => fact.id)).toEqual(['url', 'baseDn', 'preset']);
  });

  test('says where an empty Entra field comes from', () => {
    expect(fallbackState('abc', { set: false })).toBe('value');
    expect(fallbackState('', { set: true })).toBe('env');
    expect(fallbackState('', { set: false })).toBe('missing');
    expect(fallbackState('', undefined)).toBe('unknown');
  });
});

describe('People directory (LDAP) editor', () => {
  test('restores the directory editor on the installation values', async () => {
    renderAt('/admin/integrations/corp?tab=settings');
    const editor = await screen.findByTestId('people-directory-editor');

    // Source: the reused provider from the editor context, with its facts.
    expect(await within(editor).findByLabelText('Sign-in provider')).toHaveValue('corp-ad');
    expect(within(editor).getByText('ldaps://dc.corp.example:636')).toBeInTheDocument();
    // Access: the provider's bind account by default.
    expect(within(editor).getByLabelText("The sign-in provider's bind account")).toBeChecked();
    // Model-facing texts in both languages and the tool ids.
    expect(within(editor).getByTestId('pd-tool-ids')).toHaveTextContent('corp__search_people');
    // Visibility: who grants it, no group list on the directory.
    expect(await within(editor).findByTestId('granted-groups')).toHaveTextContent('staff');
    // Mapping: the effective preset (the provider's Active Directory).
    expect(within(editor).getByText(/directory type "Active Directory"/)).toBeInTheDocument();
    expect(within(editor).getByLabelText('Manager')).toHaveValue('manager');
    // No LDAP browser section any more.
    expect(within(editor).queryByText('LDAP browser')).not.toBeInTheDocument();
    expectNoMissingKeys();
  });

  test('checks the form, then saves the values and the texts in every language', async () => {
    renderAt('/admin/integrations/corp?tab=settings');
    const editor = await screen.findByTestId('people-directory-editor');
    await within(editor).findByLabelText('Sign-in provider');

    fireEvent.click(within(editor).getByLabelText('Connect directly'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Please check these fields')).toBeInTheDocument();
    expect(mockApi.updateInstalledIntegration).not.toHaveBeenCalled();

    fireEvent.change(within(editor).getByLabelText(/^URL/), {
      target: { value: 'ldaps://ldap.example.org:636' }
    });
    fireEvent.change(within(editor).getByLabelText(/^Base DN/), {
      target: { value: 'dc=example,dc=org' }
    });
    fireEvent.click(within(editor).getByLabelText('External'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1));
    const [id, body] = mockApi.updateInstalledIntegration.mock.calls[0];
    expect(id).toBe('corp');
    expect(body.values).toEqual({
      url: 'ldaps://ldap.example.org:636',
      baseDn: 'dc=example,dc=org',
      bindMode: 'anonymous',
      mapping_managerId: ['manager'],
      maxResults: 10,
      timeoutMs: 8000,
      concurrency: 2,
      requestDelayMs: 0,
      dataFlow: 'external'
    });
    expect(body.label).toEqual({ en: 'Company directory', de: 'Firmenverzeichnis' });
    expect(body.description).toEqual({ en: 'Employees of our company.' });
    expect(body).not.toHaveProperty('allowedGroups');
  });

  test('the test sends the sample search', async () => {
    renderAt('/admin/integrations/corp?tab=settings');
    const editor = await screen.findByTestId('people-directory-editor');
    await within(editor).findByLabelText('Sign-in provider');
    fireEvent.change(screen.getByLabelText('Sample search (a surname)'), {
      target: { value: ' Mustermann ' }
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mockApi.testInstalledIntegration).toHaveBeenCalledTimes(1));
    const [, body] = mockApi.testInstalledIntegration.mock.calls[0];
    expect(body.testInput).toEqual({ query: 'Mustermann' });
    expect(body.values.authProvider).toBe('corp-ad');
  });
});

describe('LDAP browser editor', () => {
  test('picks the directory, shows what it reuses and saves the browse settings', async () => {
    renderAt('/admin/integrations/corp-browser?tab=settings');
    const editor = await screen.findByTestId('ldap-browser-editor');
    const facts = await within(editor).findByTestId('lb-directory-facts');
    expect(within(editor).getByLabelText(/^Directory/)).toHaveValue('corp');
    expect(facts).toHaveTextContent('ldaps://dc.corp.example:636');
    expect(facts).toHaveTextContent('Service account cn=svc');
    expect(within(editor).getByTestId('lb-tool-ids')).toHaveTextContent(
      'corp-browser__browse_search'
    );
    expect(await within(editor).findByTestId('granted-groups')).toHaveTextContent('admins');
    expectNoMissingKeys();

    fireEvent.change(within(editor).getByLabelText('Browse base'), {
      target: { value: 'ou=groups,dc=corp,dc=example' }
    });
    fireEvent.click(within(editor).getByLabelText('An account of its own'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Please check these fields')).toBeInTheDocument();
    expect(mockApi.updateInstalledIntegration).not.toHaveBeenCalled();

    fireEvent.change(within(editor).getByLabelText('Bind DN'), {
      target: { value: 'cn=reader,dc=corp,dc=example' }
    });
    fireEvent.change(within(editor).getByTestId('credential-lb-bind-password-ref'), {
      target: { value: 'ldap-reader' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1));
    const [id, body] = mockApi.updateInstalledIntegration.mock.calls[0];
    expect(id).toBe('corp-browser');
    expect(body.values).toEqual({
      directory: 'corp',
      baseDn: 'ou=groups,dc=corp,dc=example',
      maxResults: 50,
      bindMode: 'service',
      bindDn: 'cn=reader,dc=corp,dc=example',
      bindPasswordRef: 'ldap-reader'
    });
  });
});

describe('Entra ID directory editor', () => {
  test('shows the app registration with the AZURE_* fallbacks and saves', async () => {
    renderAt('/admin/integrations/entra?tab=settings');
    const editor = await screen.findByTestId('entra-directory-editor');
    expect(await within(editor).findByTestId('env-tenantId')).toHaveTextContent(
      'AZURE_TENANT_ID is used (set on the server)'
    );
    expect(within(editor).getByTestId('env-clientId')).toHaveTextContent(
      'AZURE_CLIENT_ID is not set on the server'
    );
    expect(within(editor).getByTestId('entra-missing')).toHaveTextContent('AZURE_CLIENT_ID');
    expectNoMissingKeys();

    fireEvent.change(within(editor).getByLabelText('Application (client) ID'), {
      target: { value: ' 11111111-2222-3333-4444-555555555555 ' }
    });
    expect(within(editor).queryByTestId('entra-missing')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalledTimes(1));
    const [id, body] = mockApi.updateInstalledIntegration.mock.calls[0];
    expect(id).toBe('entra');
    expect(body.values).toEqual({
      clientId: '11111111-2222-3333-4444-555555555555',
      clientSecretRef: 'entra-secret'
    });
  });
});
