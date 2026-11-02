// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The dedicated editor of the storage providers (Office 365, Google Drive,
 * Nextcloud; `StorageProviderEditor`):
 *
 *   - the registry hands the three definitions to it;
 *   - it shows the redirect URI to register — derived with the base path from
 *     the installation id, or the configured one — and copies it;
 *   - it checks the required settings before a save, and saves only the
 *     definition's values (no `providerId`), keeping the label's other
 *     languages;
 *   - Office 365 shows the sources and the advanced restrictions, Nextcloud
 *     the server URL;
 *   - it counts the connected users and tests the unsaved values;
 *   - every string comes from shared/i18n/en.json.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  updateInstalledIntegration: jest.fn(),
  testInstalledIntegration: jest.fn(),
  fetchIntegrationConnections: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  updateInstalledIntegration: (...args) => mockApi.updateInstalledIntegration(...args),
  testInstalledIntegration: (...args) => mockApi.testInstalledIntegration(...args),
  fetchIntegrationConnections: (...args) => mockApi.fetchIntegrationConnections(...args),
  disconnectIntegrationUser: jest.fn(),
  resetIntegrationRegistration: jest.fn(),
  fetchInstalledIntegrations: jest.fn().mockResolvedValue({ items: [] })
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminGroups: jest.fn().mockResolvedValue({
    groups: { staff: { name: 'Staff', permissions: { integrations: ['type:storage'] } } }
  }),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn(),
  listCredentials: jest.fn().mockResolvedValue([])
}));
// runtimeBasePath uses `import.meta`; the deployment runs below /ihub here.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '/ihub',
  buildApiUrl: endpoint => `/ihub/api/${endpoint.replace(/^\//, '')}`
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/IntegrationTestResults', () => ({
  __esModule: true,
  default: ({ title }) => <div data-testid="test-results">{title}</div>
}));
jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: ({ id, label, value, onChange }) => (
    <label htmlFor={id}>
      {label}
      <input id={id} value={value} onChange={e => onChange(e.target.value)} />
    </label>
  )
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const {
  getInstallationEditor
} = require('../../../client/src/features/admin/components/integrations/editors');
const StorageProviderEditor =
  require('../../../client/src/features/admin/components/integrations/editors/StorageProviderEditor').default;
const {
  STORAGE_EDITOR_SPECS,
  storageRedirectUri,
  storageValuesProblem,
  storageValuesToSave,
  initialStorageValues
} = require('../../../client/src/features/admin/components/integrations/editors/storageEditorModel');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  });
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.fetchIntegrationConnections.mockResolvedValue([{ userId: 'erin' }, { userId: 'hana' }]);
  mockApi.updateInstalledIntegration.mockImplementation(async (id, body) => ({ id, ...body }));
  mockApi.testInstalledIntegration.mockResolvedValue({ ok: true, steps: [] });
});

const NEXTCLOUD_DEFINITION = {
  id: 'com.intrafind/nextcloud',
  name: 'Nextcloud',
  install: [],
  actions: []
};
const OFFICE_DEFINITION = {
  id: 'com.intrafind/office365',
  name: 'Microsoft Office 365',
  install: [],
  actions: []
};

function nextcloudInstance(values = {}) {
  return {
    id: 'nextcloud-branch',
    definition: 'com.intrafind/nextcloud',
    label: 'Branch office',
    labelLocalized: { en: 'Branch office', de: 'Zweigstelle' },
    enabled: true,
    auth: { mode: 'oauth-user' },
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    values: {
      serverUrl: 'https://branch.example.com',
      clientId: 'branch-client',
      clientSecretRef: 'branch-secret',
      ...values
    },
    liveActions: []
  };
}

function renderEditor(instance, definition, onSaved = jest.fn()) {
  const Editor = getInstallationEditor(instance.definition);
  render(
    <MemoryRouter>
      <Editor instance={instance} definition={definition} onSaved={onSaved} onCancel={jest.fn()} />
    </MemoryRouter>
  );
  return onSaved;
}

describe('storage provider editor', () => {
  it('is the dedicated editor of the three storage definitions', () => {
    for (const id of [
      'com.intrafind/office365',
      'com.intrafind/google-drive',
      'com.intrafind/nextcloud'
    ]) {
      expect(getInstallationEditor(id)).toBe(StorageProviderEditor);
    }
  });

  it('shows the redirect URI to register, with the base path and the installation id, and copies it', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderEditor(nextcloudInstance(), NEXTCLOUD_DEFINITION);
    const field = screen.getByLabelText('Redirect URI to register');
    expect(field).toHaveValue(
      'http://localhost/ihub/api/integrations/nextcloud/nextcloud-branch/callback'
    );
    expect(screen.getByText(/OAuth 2.0 clients → add a client/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'http://localhost/ihub/api/integrations/nextcloud/nextcloud-branch/callback'
      )
    );
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('shows a configured redirect URI instead of the derived one', () => {
    const configured =
      'https://ihub.example.com/x/api/integrations/nextcloud/nextcloud-branch/callback';
    renderEditor(nextcloudInstance({ redirectUri: configured }), NEXTCLOUD_DEFINITION);
    expect(screen.getByLabelText('Redirect URI to register')).toHaveValue(configured);
    expect(screen.getByText(/used for every sign-in/)).toBeInTheDocument();
  });

  it('refuses to save without the server URL, then saves the values without providerId', async () => {
    const onSaved = renderEditor(
      nextcloudInstance({ serverUrl: '', providerId: 'old' }),
      NEXTCLOUD_DEFINITION
    );
    const form = screen.getByTestId('nextcloud-editor').querySelector('form');
    fireEvent.submit(form);
    expect(
      (await screen.findAllByText('Enter the URL of the Nextcloud server.')).length
    ).toBeGreaterThan(0);
    expect(mockApi.updateInstalledIntegration).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Nextcloud server URL/), {
      target: { value: ' https://branch.example.com ' }
    });
    fireEvent.submit(form);
    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalled());
    const [id, body] = mockApi.updateInstalledIntegration.mock.calls[0];
    expect(id).toBe('nextcloud-branch');
    expect(body.values).toEqual({
      serverUrl: 'https://branch.example.com',
      clientId: 'branch-client',
      clientSecretRef: 'branch-secret'
    });
    expect(body.label).toEqual({ en: 'Branch office', de: 'Zweigstelle' });
    expect(onSaved).toHaveBeenCalled();
  });

  it('refuses a redirect URI of another installation', async () => {
    renderEditor(
      nextcloudInstance({
        redirectUri: 'https://ihub.example.com/api/integrations/nextcloud/nextcloud/callback'
      }),
      NEXTCLOUD_DEFINITION
    );
    fireEvent.submit(screen.getByTestId('nextcloud-editor').querySelector('form'));
    expect(
      (
        await screen.findAllByText(
          'The redirect URI has to end in /api/integrations/nextcloud/nextcloud-branch/callback.'
        )
      ).length
    ).toBeGreaterThan(0);
    expect(mockApi.updateInstalledIntegration).not.toHaveBeenCalled();
  });

  it('edits the Office 365 tenant, sources and restrictions', async () => {
    renderEditor(
      {
        ...nextcloudInstance(),
        id: 'o365-corp',
        definition: 'com.intrafind/office365',
        values: {
          tenantId: 'tenant-1',
          clientId: 'c',
          clientSecretRef: 's',
          sourcePersonalDrive: true,
          sourceFollowedSites: true,
          sourceTeams: false,
          driveId: 'drive-1'
        }
      },
      OFFICE_DEFINITION
    );
    expect(screen.getByLabelText(/Directory \(tenant\) ID/)).toHaveValue('tenant-1');
    const sources = screen.getByRole('group', { name: 'Sources users may browse' });
    expect(within(sources).getByLabelText(/Personal OneDrive/)).toBeChecked();
    expect(within(sources).getByLabelText(/Microsoft Teams/)).not.toBeChecked();
    // A stored restriction opens the advanced settings.
    expect(screen.getByLabelText('Drive ID')).toHaveValue('drive-1');
    expect(screen.getByLabelText('Redirect URI to register')).toHaveValue(
      'http://localhost/ihub/api/integrations/office365/o365-corp/callback'
    );

    fireEvent.click(within(sources).getByLabelText(/Followed SharePoint sites/));
    fireEvent.submit(screen.getByTestId('office365-editor').querySelector('form'));
    await waitFor(() => expect(mockApi.updateInstalledIntegration).toHaveBeenCalled());
    expect(mockApi.updateInstalledIntegration.mock.calls[0][1].values).toEqual({
      tenantId: 'tenant-1',
      clientId: 'c',
      clientSecretRef: 's',
      sourcePersonalDrive: true,
      sourceFollowedSites: false,
      sourceTeams: false,
      driveId: 'drive-1'
    });
  });

  it('counts the connected users and tests the unsaved values', async () => {
    renderEditor(nextcloudInstance(), NEXTCLOUD_DEFINITION);
    expect(await screen.findByTestId('nextcloud-connection-count')).toHaveTextContent(
      '2 user(s) connected'
    );
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mockApi.testInstalledIntegration).toHaveBeenCalled());
    const [id, body] = mockApi.testInstalledIntegration.mock.calls[0];
    expect(id).toBe('nextcloud-branch');
    expect(body.values.clientId).toBe('changed');
    expect(await screen.findByTestId('test-results')).toHaveTextContent('Storage provider test');
  });
});

describe('storageEditorModel', () => {
  const nextcloud = STORAGE_EDITOR_SPECS['com.intrafind/nextcloud'];
  const google = STORAGE_EDITOR_SPECS['com.intrafind/google-drive'];

  it('derives the redirect URI like the server, or keeps an absolute API URL', () => {
    expect(
      storageRedirectUri(nextcloud, 'nc a', {
        origin: 'https://ihub.example.com',
        apiUrl: e => `/ihub/api/${e}`
      })
    ).toEqual({
      url: 'https://ihub.example.com/ihub/api/integrations/nextcloud/nc%20a/callback',
      derived: true
    });
    expect(
      storageRedirectUri(google, 'gd', {
        origin: 'chrome-extension://x',
        apiUrl: e => `https://ihub.example.com/api/${e}`
      }).url
    ).toBe('https://ihub.example.com/api/integrations/googledrive/gd/callback');
    expect(
      storageRedirectUri(google, 'gd', { origin: 'o', apiUrl: e => e }, ' https://x/y ')
    ).toEqual({ url: 'https://x/y', derived: false });
  });

  it('names the first problem of the values', () => {
    const base = { clientId: 'c', clientSecretRef: 's' };
    expect(storageValuesProblem(google, 'gd', base)).toBeNull();
    expect(storageValuesProblem(google, 'gd', { ...base, clientId: ' ' }).key).toBe('clientId');
    expect(storageValuesProblem(nextcloud, 'nc', base).key).toBe('serverUrl');
    expect(
      storageValuesProblem(nextcloud, 'nc', { ...base, serverUrl: 'ftp://x' }).messageKey
    ).toBe('admin.integrations.editors.storage.errors.url');
    expect(
      storageValuesProblem(nextcloud, 'nc', {
        ...base,
        serverUrl: 'https://cloud.example.com',
        redirectUri: 'https://ihub/api/integrations/nextcloud/nc/callback'
      })
    ).toBeNull();
  });

  it('starts from the defaults and saves only the definition’s values', () => {
    const values = initialStorageValues(google, {
      clientId: 'c',
      providerId: 'x',
      sourceMyDrive: false
    });
    expect(values).toEqual({
      clientId: 'c',
      clientSecretRef: '',
      redirectUri: '',
      sourceMyDrive: false,
      sourceSharedDrives: true,
      sourceSharedWithMe: true
    });
    expect(
      storageValuesToSave(google, { ...values, providerId: 'x', clientId: ' c ' })
    ).not.toHaveProperty('providerId');
  });
});
