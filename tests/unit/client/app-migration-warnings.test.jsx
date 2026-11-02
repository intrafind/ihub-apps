// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin → Apps warns when a definition migration removed an action an app
 * was bound to (versioning concept, "App bindings are not versioned"), or
 * left a type binding naming a renamed action or scope:
 *
 *   - `appMigrationWarnings` reads the installations' `migrationLog`
 *     (`warnings` with `appId`, `key`, `action` / `scope`): migrated runs since
 *     the last restore, warnings still applying to the app, once each;
 *   - the apps list shows them in the app's status cell;
 *   - the app editor shows them next to the binding they concern.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchInstalledIntegrations: jest.fn(),
  fetchInstalledIntegration: jest.fn(),
  fetchAdminApps: jest.fn(),
  fetchAppIntegrationStatus: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  fetchInstalledIntegration: (...args) => mockApi.fetchInstalledIntegration(...args)
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAppIntegrationStatus: (...args) => mockApi.fetchAppIntegrationStatus(...args),
  getAdminApiErrorMessage: err => err?.message || 'error',
  makeAdminApiCall: jest.fn(),
  reorderApps: jest.fn(),
  toggleApps: jest.fn()
}));
jest.mock('../../../client/src/api', () => ({
  fetchUIConfig: jest.fn().mockResolvedValue({})
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));
jest.mock('../../../client/src/features/apps/components/AppDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppCreationWizard', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppTemplateSelector', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/UploadConfigButton', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const {
  appMigrationWarnings,
  warningsByBindingKey
} = require('../../../client/src/features/admin/components/integrations/appMigrationWarningRules');
const AdminAppsPage = require('../../../client/src/features/admin/pages/AdminAppsPage').default;
const IntegrationsConfigSection =
  require('../../../client/src/features/admin/components/app-form/IntegrationsConfigSection').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

const REMOVED = {
  code: 'ACTION_REMOVED_FROM_APP',
  message: '1.4.0: the action "package_show" was removed; app "open-data" bound it (govdata) …',
  appId: 'open-data',
  action: 'package_show',
  key: 'govdata'
};
const TYPE_ACTION = {
  code: 'TYPE_BINDING_NOT_REWRITTEN',
  message: '1.4.0: removeAction search — app "people" names it in its type binding …',
  appId: 'people',
  key: 'type:people-directory',
  action: 'search'
};

function run(result, warnings, extra = {}) {
  return {
    from: '1.2.0',
    to: '1.4.0',
    at: '2026-11-02T10:00:00.000Z',
    by: 'admin',
    trigger: 'marketplace',
    result,
    warnings,
    ...extra
  };
}

const GOVDATA = {
  id: 'govdata',
  label: 'GovData',
  definition: 'org.ckan/open-data-portal',
  definitionName: 'CKAN',
  migrationLog: [run('migrated', [REMOVED])]
};
const DIRECTORY = {
  id: 'corp',
  label: 'Corporate directory',
  definition: 'com.intrafind/ldap-directory',
  type: 'people-directory',
  builtIn: true,
  migrationLog: [run('migrated', [TYPE_ACTION])]
};

const OPEN_DATA_APP = {
  id: 'open-data',
  name: { en: 'Open data search' },
  enabled: true,
  integrations: { govdata: { actions: ['search_datasets'] } }
};
const PEOPLE_APP = {
  id: 'people',
  name: { en: 'People finder' },
  enabled: true,
  integrations: { 'type:people-directory': { actions: ['search'] } }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.fetchInstalledIntegrations.mockResolvedValue({ items: [GOVDATA, DIRECTORY] });
  mockApi.fetchInstalledIntegration.mockResolvedValue({ actions: [], definition: null });
  mockApi.fetchAdminApps.mockResolvedValue([OPEN_DATA_APP, PEOPLE_APP]);
  mockApi.fetchAppIntegrationStatus.mockResolvedValue({});
});

describe('appMigrationWarnings', () => {
  test('collects the warnings of migrated runs about the app, with the installation and version', () => {
    const warnings = appMigrationWarnings([GOVDATA, DIRECTORY], OPEN_DATA_APP);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'ACTION_REMOVED_FROM_APP',
        action: 'package_show',
        key: 'govdata',
        instanceId: 'govdata',
        installationLabel: 'GovData',
        to: '1.4.0'
      })
    ]);
    expect(appMigrationWarnings([GOVDATA], { id: 'other', integrations: {} })).toEqual([]);
    expect(appMigrationWarnings(null, OPEN_DATA_APP)).toEqual([]);
  });

  test('a restore after the run takes its warnings back; failed runs and other codes do not count', () => {
    const restored = {
      ...GOVDATA,
      migrationLog: [run('migrated', [REMOVED]), run('restored', [])]
    };
    expect(appMigrationWarnings([restored], OPEN_DATA_APP)).toEqual([]);
    const failed = {
      ...GOVDATA,
      migrationLog: [run('failed', [REMOVED]), run('migrated', [{ ...REMOVED, code: 'OTHER' }])]
    };
    expect(appMigrationWarnings([failed], OPEN_DATA_APP)).toEqual([]);
    // A later migrated run counts again, once.
    const again = {
      ...GOVDATA,
      migrationLog: [
        run('migrated', [REMOVED]),
        run('restored', []),
        run('migrated', [REMOVED]),
        run('migrated', [REMOVED], { to: '1.5.0' })
      ]
    };
    const warnings = appMigrationWarnings([again], OPEN_DATA_APP);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].to).toBe('1.5.0');
  });

  test('a warning settles once the app no longer has what it is about', () => {
    // Unbound: the removed action's binding is gone.
    expect(appMigrationWarnings([GOVDATA], { id: 'open-data', integrations: {} })).toEqual([]);
    // A type binding still naming the action warns; edited, it does not.
    expect(appMigrationWarnings([DIRECTORY], PEOPLE_APP)).toHaveLength(1);
    expect(
      appMigrationWarnings([DIRECTORY], {
        ...PEOPLE_APP,
        integrations: { 'type:people-directory': { actions: ['lookup'] } }
      })
    ).toEqual([]);
    const scope = {
      ...DIRECTORY,
      migrationLog: [run('migrated', [{ ...TYPE_ACTION, action: undefined, scope: 'staff' }])]
    };
    expect(
      appMigrationWarnings([scope], {
        ...PEOPLE_APP,
        integrations: { 'type:people-directory': { defaultScope: 'staff' } }
      })
    ).toHaveLength(1);
    expect(
      appMigrationWarnings([scope], {
        ...PEOPLE_APP,
        integrations: { 'type:people-directory': { defaultScope: 'everyone' } }
      })
    ).toEqual([]);
  });

  test('groups by binding key', () => {
    const byKey = warningsByBindingKey(appMigrationWarnings([GOVDATA], OPEN_DATA_APP));
    expect([...byKey.keys()]).toEqual(['govdata']);
  });
});

test('the apps list shows the warning in the app’s status cell', async () => {
  render(
    <MemoryRouter>
      <AdminAppsPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(mockApi.fetchInstalledIntegrations).toHaveBeenCalled());
  const warnings = await screen.findAllByTestId('app-migration-warnings');
  expect(warnings).toHaveLength(2);
  const texts = warnings.map(list => list.textContent);
  expect(texts).toContain(
    'The update of GovData to v1.4.0 removed the action “package_show”, which this app was bound to; the app no longer offers it.'
  );
  expect(texts).toContain(
    'The update of Corporate directory to v1.4.0 renamed or removed the action “search”, which this app still names in its binding type:people-directory: edit the binding.'
  );
  for (const list of warnings) expect(list.textContent).not.toMatch(/MISSING:/);
});

test('the apps list works without the installations', async () => {
  mockApi.fetchInstalledIntegrations.mockRejectedValue(new Error('down'));
  render(
    <MemoryRouter>
      <AdminAppsPage />
    </MemoryRouter>
  );
  expect(await screen.findByText('Open data search')).toBeInTheDocument();
  expect(screen.queryByTestId('app-migration-warnings')).not.toBeInTheDocument();
});

test('the app editor shows the warning next to the binding it concerns', async () => {
  render(
    <MemoryRouter>
      <IntegrationsConfigSection app={OPEN_DATA_APP} onChange={jest.fn()} />
    </MemoryRouter>
  );
  const card = await screen.findByTestId('app-integrations');
  const warning = await within(card).findByTestId('app-migration-warnings');
  // Inside the GovData binding row, under its name.
  const row = warning.closest('.rounded-lg');
  expect(within(row).getByText('GovData')).toBeInTheDocument();
  expect(warning).toHaveTextContent(
    'The update of GovData to v1.4.0 removed the action “package_show”, which this app was bound to; the app no longer offers it.'
  );
  expect(within(warning).getByRole('link', { name: 'Migration log of GovData' })).toHaveAttribute(
    'href',
    '/admin/integrations/govdata'
  );
  expect(warning.textContent).not.toMatch(/MISSING:/);
});

test('a warning about a binding without its own row shows on top of the card', async () => {
  mockApi.fetchInstalledIntegrations.mockResolvedValue({
    items: [
      {
        ...GOVDATA,
        id: 'gone-portal',
        definitionMissing: true,
        migrationLog: [run('migrated', [{ ...REMOVED, key: 'gone-portal' }])]
      }
    ]
  });
  render(
    <MemoryRouter>
      <IntegrationsConfigSection
        app={{ ...OPEN_DATA_APP, integrations: { 'gone-portal': { actions: [] } } }}
        onChange={jest.fn()}
      />
    </MemoryRouter>
  );
  const card = await screen.findByTestId('app-integrations');
  const warning = await within(card).findByTestId('app-migration-warnings');
  expect(warning.closest('[data-testid="stale-integration-gone-portal"]')).toBeNull();
  expect(warning).toHaveTextContent('removed the action “package_show”');
});
