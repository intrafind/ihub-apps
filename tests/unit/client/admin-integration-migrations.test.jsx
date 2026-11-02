// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin UI of definition migrations (versioning concept §3/§4, issue
 * #3090) on an installation's page and on the Installed tab's tiles:
 *
 *   - each state has its pill and its reason as text, and offers exactly its
 *     actions: pending → Migrate now; failed → Re-run migration, Restore
 *     backup, Uninstall; needs review → Restore backup (only with a matching
 *     backup), Adopt current version, Uninstall;
 *   - a pending migration says what it changes (counts, warnings,
 *     collisions, validation problems) before the admin clicks;
 *   - Restore, Adopt and Uninstall ask first; every action shows the log
 *     entry it wrote or the error with its reason, and reloads;
 *   - while the installation is blocked, Settings (the generic form and a
 *     dedicated editor) is read-only with the reason;
 *   - the migration log lists the runs, newest first;
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
  fetchIntegrationCatalog: jest.fn(),
  updateInstalledIntegration: jest.fn(),
  deleteInstalledIntegration: jest.fn(),
  migrateInstalledIntegration: jest.fn(),
  restoreInstalledIntegration: jest.fn(),
  adoptInstalledIntegration: jest.fn(),
  fetchAdminApps: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegration: (...args) => mockApi.fetchInstalledIntegration(...args),
  fetchInstalledIntegrations: (...args) => mockApi.fetchInstalledIntegrations(...args),
  fetchIntegrationCatalog: (...args) => mockApi.fetchIntegrationCatalog(...args),
  updateInstalledIntegration: (...args) => mockApi.updateInstalledIntegration(...args),
  deleteInstalledIntegration: (...args) => mockApi.deleteInstalledIntegration(...args),
  migrateInstalledIntegration: (...args) => mockApi.migrateInstalledIntegration(...args),
  restoreInstalledIntegration: (...args) => mockApi.restoreInstalledIntegration(...args),
  adoptInstalledIntegration: (...args) => mockApi.adoptInstalledIntegration(...args),
  testInstalledIntegration: jest.fn().mockResolvedValue({ success: true, steps: [] }),
  setInstalledIntegrationEnabled: jest.fn(),
  reloadIntegrationCatalog: jest.fn(),
  fetchIntegrationDefinitionFile: jest.fn(),
  fetchIntegrationDefinition: jest.fn(),
  installIntegration: jest.fn(),
  testIntegrationDraft: jest.fn(),
  fetchIntegrationConnections: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAdminPlatformConfig: jest.fn().mockResolvedValue(null),
  fetchAdminGroups: jest.fn().mockResolvedValue({ groups: {} }),
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
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({ isEnabled: () => true })
}));
jest.mock('../../../client/src/features/admin/components/IntegrationTestResults', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock(
  '../../../client/src/features/admin/components/integrations/IntegrationReleaseNotes',
  () => ({ __esModule: true, default: () => <div data-testid="release-notes" /> })
);
jest.mock(
  '../../../client/src/features/admin/components/integrations/IntegrationInstallDialog',
  () => ({ __esModule: true, default: () => null })
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
const AdminIntegrationsPage =
  require('../../../client/src/features/admin/pages/AdminIntegrationsPage').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    // As the app's i18n service: React escapes, i18next must not.
    interpolation: { escapeValue: false },
    // A key missing from en.json shows as the key, so the assertions catch it.
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

const BACKUP_ID = 'govdata-1.2.0-20261102T100000000Z';
const BACKUP = {
  id: BACKUP_ID,
  representedVersion: '1.2.0',
  createdAt: '2026-11-02T10:00:00.000Z',
  kind: 'pre-migration',
  hasDefinition: true
};

const DEFINITION = {
  id: 'org.ckan/open-data-portal',
  name: 'CKAN open data portal',
  version: '1.4.0',
  protocol: 'openapi',
  supported: true,
  authModes: ['none'],
  supportedAuthModes: ['none'],
  releases: [{ version: '1.4.0', summary: 'Current', migration: '1.4.0' }],
  migrations: [{ id: '1.4.0', steps: ['renameValue fq → defaultFilter'] }],
  install: [
    { key: 'baseUrl', type: 'url', scope: 'admin', title: { en: 'Portal URL' } },
    { key: 'maxRows', type: 'number', scope: 'admin', title: { en: 'Rows' } }
  ],
  actions: [{ name: 'search_datasets', title: 'Search datasets', sideEffect: 'read' }]
};

const BASE_INSTANCE = {
  id: 'govdata',
  definition: 'org.ckan/open-data-portal',
  definitionName: 'CKAN open data portal',
  label: 'GovData',
  labelLocalized: { en: 'GovData' },
  enabled: true,
  protocol: 'openapi',
  builtIn: false,
  auth: { mode: 'none' },
  actions: { enabled: ['*'], disabled: [], overrides: {} },
  definitionVersion: '1.2.0',
  currentVersion: '1.4.0',
  status: null,
  statusReason: null,
  migration: null,
  migrationLog: []
};

const MIGRATION_BASE = {
  pending: true,
  blocked: true,
  downgrade: false,
  from: '1.2.0',
  to: '1.4.0',
  migrations: ['1.3.0', '1.4.0'],
  summary: null,
  warnings: [],
  collisions: [],
  errors: [],
  backups: [],
  defaultBackup: null
};

const PENDING = {
  ...BASE_INSTANCE,
  status: 'migrationPending',
  statusReason:
    'org.ckan/open-data-portal 1.4.0 is loaded, the installation is at 1.2.0; the migrations 1.3.0, 1.4.0 are pending',
  migration: {
    ...MIGRATION_BASE,
    summary: { values: 2, actions: 1, apps: 1 },
    warnings: [
      {
        code: 'ACTION_REMOVED_FROM_APP',
        message: '1.4.0: the action "package_show" was removed; …',
        appId: 'open-data',
        action: 'package_show',
        key: 'govdata'
      }
    ]
  }
};

const FAILED = {
  ...BASE_INSTANCE,
  status: 'migrationFailed',
  statusReason: 'renameValue fq → defaultFilter: "defaultFilter" already holds a value',
  migration: { ...MIGRATION_BASE, backups: [BACKUP], defaultBackup: BACKUP_ID },
  migrationLog: [
    {
      from: '1.2.0',
      to: '1.4.0',
      at: '2026-11-02T10:00:00.000Z',
      by: 'admin',
      trigger: 'marketplace',
      result: 'failed',
      migrations: ['1.3.0', '1.4.0'],
      steps: ['1.3.0: renameValue fq → defaultFilter'],
      warnings: [],
      changes: { values: 0, actions: 0, apps: 0 },
      reason: 'renameValue fq → defaultFilter: "defaultFilter" already holds a value',
      backup: BACKUP_ID
    }
  ]
};

const REVIEW = {
  ...BASE_INSTANCE,
  definitionVersion: null,
  status: 'needsReview',
  statusReason:
    'the installation records no definitionVersion; adopt the loaded definition version after checking its values, restore a backup, or uninstall it',
  migration: { ...MIGRATION_BASE, pending: false, from: null, migrations: [] }
};

const MIGRATED = {
  ...BASE_INSTANCE,
  definitionVersion: '1.4.0',
  migrationLog: [
    {
      from: '1.2.0',
      to: '1.4.0',
      at: '2026-11-02T11:00:00.000Z',
      by: 'admin',
      trigger: 'manual',
      result: 'migrated',
      migrations: ['1.3.0', '1.4.0'],
      steps: ['1.3.0: renameValue fq → defaultFilter', '1.4.0: removeAction package_show'],
      warnings: [PENDING.migration.warnings[0]],
      changes: { values: 2, actions: 1, apps: 1 },
      backup: BACKUP_ID
    }
  ]
};

/** `GET …/installed/:id` for an installation. */
function detailOf(instance) {
  return {
    instance,
    values: { baseUrl: 'https://www.govdata.de/ckan', maxRows: 10 },
    actions: instance.migration?.blocked ? [] : DEFINITION.actions,
    definition: DEFINITION
  };
}

const APPS = [
  {
    id: 'open-data',
    name: { en: 'Open data search' },
    integrations: { govdata: { actions: ['search_datasets'] } }
  }
];

/** An HTTP error as axios throws it. */
function httpError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

let current;
beforeEach(() => {
  jest.clearAllMocks();
  current = PENDING;
  mockApi.fetchInstalledIntegration.mockImplementation(async () => detailOf(current));
  mockApi.fetchInstalledIntegrations.mockImplementation(async () => ({ items: [current] }));
  mockApi.fetchIntegrationCatalog.mockResolvedValue({ items: [] });
  mockApi.fetchAdminApps.mockResolvedValue(APPS);
  mockApi.deleteInstalledIntegration.mockResolvedValue(undefined);
});

function renderPage(path = '/admin/integrations/govdata') {
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

/** The names of the panel's action buttons, in order. */
function panelActions(panel) {
  return within(within(panel).getByTestId('migration-actions'))
    .getAllByRole('button')
    .map(button => button.textContent);
}

describe('installation page: migration pending', () => {
  test('says what the migration changes, then Migrate now runs it, shows the log entry and reloads', async () => {
    renderPage();
    const panel = await screen.findByTestId('migration-panel');

    // The pill in the header and in the panel, the reason as text.
    expect(within(panel).getByTestId('migration-status')).toHaveTextContent('Migration pending');
    expect(within(panel).getByTestId('migration-reason')).toHaveTextContent(
      'the migrations 1.3.0, 1.4.0 are pending'
    );
    expect(panel).toHaveTextContent(
      'Until it is migrated it offers no actions and its settings cannot be saved.'
    );
    // What it changes, before anything runs.
    expect(within(panel).getByTestId('migration-pending-changes')).toHaveTextContent(
      /The migrations 1\.3\.0, 1\.4\.0 change 2 install values, 1 action,? and 1 app binding; a backup is made first\./
    );
    expect(within(panel).getByTestId('migration-warnings')).toHaveTextContent(
      'The action “package_show” is removed from the app “Open data search” (binding govdata); the app no longer offers it.'
    );
    expect(within(panel).getByRole('link', { name: 'Open the app' })).toHaveAttribute(
      'href',
      '/admin/apps/open-data'
    );
    expect(panelActions(panel)).toEqual(['Migrate now']);
    expectNoMissingKeys();

    mockApi.migrateInstalledIntegration.mockImplementation(async () => {
      current = MIGRATED;
      return {
        success: true,
        result: 'migrated',
        logEntry: MIGRATED.migrationLog[0],
        instance: MIGRATED
      };
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Migrate now' }));

    const outcome = await screen.findByTestId('migration-outcome');
    expect(mockApi.migrateInstalledIntegration).toHaveBeenCalledWith('govdata');
    expect(outcome.tagName).toBe('OUTPUT');
    expect(outcome).toHaveTextContent('GovData was migrated from v1.2.0 to v1.4.0.');
    expect(within(outcome).getByTestId('migration-log-entry')).toHaveTextContent(
      /Changed 2 install values, 1 action,? and 1 app binding\./
    );
    // Reloaded: the state is gone, the log has the run.
    await waitFor(() => expect(screen.queryByTestId('migration-panel')).not.toBeInTheDocument());
    expect(mockApi.fetchInstalledIntegration).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('migration-log')).toHaveTextContent('v1.2.0 → v1.4.0');

    fireEvent.click(within(outcome).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('migration-outcome')).not.toBeInTheDocument();
    expectNoMissingKeys();
  });

  test('shows collisions and validation problems as "the migration will fail"', async () => {
    current = {
      ...PENDING,
      migration: {
        ...PENDING.migration,
        warnings: [],
        collisions: [
          {
            migration: '1.3.0',
            step: 'renameValue',
            kind: 'value',
            key: 'defaultFilter',
            message: 'renameValue fq → defaultFilter: "defaultFilter" already holds a value'
          }
        ],
        errors: [{ kind: 'value', key: 'rows', message: 'rows: must be a number' }]
      }
    };
    renderPage();
    const panel = await screen.findByTestId('migration-panel');
    const collisions = within(panel).getByTestId('migration-collisions');
    expect(collisions).toHaveTextContent('Collisions: the migration will fail');
    expect(collisions).toHaveTextContent('"defaultFilter" already holds a value');
    expect(within(panel).getByTestId('migration-errors')).toHaveTextContent(
      'The result would not fit v1.4.0: the migration will fail'
    );
    expect(within(panel).getByTestId('migration-errors')).toHaveTextContent(
      'rows: must be a number'
    );
    expectNoMissingKeys();
  });

  test('a pending installation with no migration between keeps an editable editor', async () => {
    current = {
      ...PENDING,
      migration: { ...MIGRATION_BASE, blocked: false, migrations: [], summary: null }
    };
    renderPage('/admin/integrations/govdata?tab=settings');
    const form = await screen.findByTestId('generic-installation-editor');
    expect(screen.queryByTestId('settings-read-only')).not.toBeInTheDocument();
    expect(within(form).getByLabelText(/Portal URL/)).toBeEnabled();
    expect(screen.getByTestId('migration-panel')).toHaveTextContent(
      'No migration lies between the versions'
    );
  });
});

describe('installation page: migration failed', () => {
  beforeEach(() => {
    current = FAILED;
  });

  test('offers Re-run, Restore and Uninstall; a failed re-run shows the reason and the collisions', async () => {
    renderPage();
    const panel = await screen.findByTestId('migration-panel');
    expect(within(panel).getByTestId('migration-status')).toHaveTextContent('Migration failed');
    expect(panelActions(panel)).toEqual(['Re-run migration', 'Restore backup', 'Uninstall']);
    // The Actions card says why it lists nothing.
    expect(
      screen.getByText(/No actions while the migration state is unresolved/)
    ).toBeInTheDocument();
    expect(within(panel).getByTestId('migration-backup')).toHaveTextContent(
      `Restore backup puts back ${BACKUP_ID} (v1.2.0, taken`
    );

    mockApi.migrateInstalledIntegration.mockRejectedValue(
      httpError(422, {
        success: false,
        code: 'MIGRATION_FAILED',
        error: 'Migration of "govdata" failed',
        reason: 'renameValue fq → defaultFilter: "defaultFilter" already holds a value',
        details: {
          collisions: [
            { key: 'defaultFilter', message: 'renameValue fq → defaultFilter: collision' }
          ],
          errors: []
        },
        logEntry: FAILED.migrationLog[0]
      })
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Re-run migration' }));

    const outcome = await screen.findByRole('alert');
    expect(outcome).toHaveAttribute('data-testid', 'migration-outcome');
    expect(outcome).toHaveTextContent('The migration of GovData failed.');
    expect(within(outcome).getByTestId('migration-outcome-reason')).toHaveTextContent(
      'Reason: renameValue fq → defaultFilter: "defaultFilter" already holds a value (MIGRATION_FAILED)'
    );
    expect(within(outcome).getByTestId('migration-problems')).toHaveTextContent(
      'renameValue fq → defaultFilter: collision'
    );
    expect(within(outcome).getByTestId('migration-log-entry')).toHaveTextContent('Failed');
    await waitFor(() => expect(mockApi.fetchInstalledIntegration).toHaveBeenCalledTimes(2));
    expectNoMissingKeys();
  });

  test('Restore backup asks first, names the backup, then restores exactly that backup', async () => {
    renderPage();
    const panel = await screen.findByTestId('migration-panel');

    fireEvent.click(within(panel).getByRole('button', { name: 'Restore backup' }));
    let dialog = screen.getByRole('alertdialog', { name: 'Restore a backup of GovData?' });
    expect(dialog).toHaveTextContent(`go back to the backup ${BACKUP_ID} (v1.2.0, taken`);
    expect(dialog).toHaveTextContent('The backup also holds the definition of v1.2.0');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockApi.restoreInstalledIntegration).not.toHaveBeenCalled();

    mockApi.restoreInstalledIntegration.mockImplementation(async () => {
      current = { ...BASE_INSTANCE, currentVersion: '1.2.0' };
      return {
        success: true,
        backup: BACKUP,
        logEntry: {
          from: '1.2.0',
          to: '1.2.0',
          at: '2026-11-02T12:00:00.000Z',
          by: 'admin',
          trigger: 'restore',
          result: 'restored',
          reason: `restored backup ${BACKUP_ID} with its definition folder`,
          backup: BACKUP_ID
        },
        instance: current
      };
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Restore backup' }));
    dialog = screen.getByRole('alertdialog', { name: 'Restore a backup of GovData?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore backup' }));

    await waitFor(() =>
      expect(mockApi.restoreInstalledIntegration).toHaveBeenCalledWith('govdata', BACKUP_ID)
    );
    expect(await screen.findByTestId('migration-outcome')).toHaveTextContent(
      `The backup ${BACKUP_ID} of GovData was restored; it is at v1.2.0 again.`
    );
    expectNoMissingKeys();
  });

  test('Uninstall asks with the remove dialog, then removes the installation', async () => {
    renderPage();
    const panel = await screen.findByTestId('migration-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Uninstall' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove integration?' });
    expect(dialog).toHaveTextContent('Bound by: Open data search');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.deleteInstalledIntegration).toHaveBeenCalledWith('govdata'));
    expect(await screen.findByTestId('list-page')).toBeInTheDocument();
  });

  test('Settings is read-only with the reason: the generic form', async () => {
    renderPage('/admin/integrations/govdata?tab=settings');
    const form = await screen.findByTestId('generic-installation-editor');
    expect(screen.getByTestId('settings-read-only')).toHaveTextContent(
      'The settings are read-only until the migration state is resolved'
    );
    const fieldset = screen.getByTestId('settings-fieldset');
    expect(fieldset).toBeDisabled();
    expect(fieldset).toHaveAccessibleDescription(/read-only until the migration state/);
    expect(within(form).getByLabelText(/Portal URL/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expectNoMissingKeys();
  });

  test('Settings is read-only with the reason: a dedicated editor', async () => {
    const definition = {
      id: 'com.intrafind/brave-search',
      name: 'Brave Search',
      version: '1.1.0',
      protocol: 'native',
      type: 'web-search',
      builtIn: true,
      authModes: ['none'],
      releases: [],
      install: [],
      actions: [{ name: 'search', title: 'Search the web', sideEffect: 'read' }]
    };
    mockApi.fetchInstalledIntegration.mockResolvedValue({
      instance: {
        ...FAILED,
        id: 'brave',
        definition: definition.id,
        definitionName: 'Brave Search',
        label: 'Brave Search',
        type: 'web-search',
        builtIn: true
      },
      values: {},
      actions: [],
      definition
    });
    renderPage('/admin/integrations/brave?tab=settings');
    const editor = await screen.findByTestId('web-search-engine-editor');
    expect(screen.getByTestId('settings-read-only')).toBeInTheDocument();
    expect(within(editor).getByLabelText('Label')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('the migration log on Overview lists the runs newest first', async () => {
    current = {
      ...FAILED,
      migrationLog: [MIGRATED.migrationLog[0], FAILED.migrationLog[0]]
    };
    renderPage();
    const log = await screen.findByTestId('migration-log');
    expect(screen.getByRole('heading', { name: /Migration log/, level: 2 })).toBeInTheDocument();
    const entries = within(log).getAllByTestId('migration-log-entry');
    expect(entries).toHaveLength(2);
    // Newest first: the failed run (stored last) leads.
    expect(entries[0]).toHaveTextContent('v1.2.0 → v1.4.0');
    expect(entries[0]).toHaveTextContent('Failed');
    expect(entries[0]).toHaveTextContent('by admin');
    expect(entries[0]).toHaveTextContent('marketplace update');
    expect(entries[0]).toHaveTextContent(
      'Reason: renameValue fq → defaultFilter: "defaultFilter" already holds a value'
    );
    expect(entries[0]).toHaveTextContent(`Backup: ${BACKUP_ID}`);
    expect(within(entries[0]).getByRole('heading', { level: 3 })).toHaveTextContent(
      'v1.2.0 → v1.4.0'
    );
    expect(entries[0].querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-11-02T10:00:00.000Z'
    );
    expect(entries[1]).toHaveTextContent('Migrated');
    expect(entries[1]).toHaveTextContent('run by hand');
    expect(entries[1]).toHaveTextContent(
      /Changed 2 install values, 1 action,? and 1 app binding\./
    );
    expect(entries[1]).toHaveTextContent('Migrations: 1.3.0, 1.4.0');
    expect(within(entries[1]).getByTestId('migration-log-warnings')).toHaveTextContent(
      'The action “package_show” is removed from the app “Open data search”'
    );
    // The steps are folded under a summary.
    expect(within(entries[1]).getByText('2 steps').tagName).toBe('SUMMARY');
    expect(entries[1]).toHaveTextContent('1.4.0: removeAction package_show');
    expectNoMissingKeys();
  });
});

describe('installation page: needs review', () => {
  test('without a backup it offers Adopt and Uninstall; Adopt asks first and lists values that do not fit', async () => {
    current = REVIEW;
    renderPage();
    const panel = await screen.findByTestId('migration-panel');
    expect(within(panel).getByTestId('migration-status')).toHaveTextContent('Needs review');
    expect(within(panel).getByTestId('migration-reason')).toHaveTextContent(
      'the installation records no definitionVersion'
    );
    expect(panelActions(panel)).toEqual(['Adopt current version', 'Uninstall']);
    expect(within(panel).getByTestId('migration-backup')).toHaveTextContent(
      'No backup of this installation matches its state'
    );

    fireEvent.click(within(panel).getByRole('button', { name: 'Adopt current version' }));
    let dialog = screen.getByRole('alertdialog', { name: 'Adopt v1.4.0 for GovData?' });
    expect(dialog).toHaveTextContent(
      'You confirm that the stored values already fit CKAN open data portal v1.4.0.'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mockApi.adoptInstalledIntegration).not.toHaveBeenCalled();

    mockApi.adoptInstalledIntegration.mockRejectedValue(
      httpError(422, {
        success: false,
        code: 'ADOPT_INVALID',
        error: 'The stored values of "govdata" do not fit org.ckan/open-data-portal 1.4.0',
        reason: 'The stored values of "govdata" do not fit org.ckan/open-data-portal 1.4.0',
        details: [{ kind: 'value', key: 'baseUrl', message: 'baseUrl: must be a URL' }]
      })
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Adopt current version' }));
    dialog = screen.getByRole('alertdialog', { name: 'Adopt v1.4.0 for GovData?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adopt version' }));

    const outcome = await screen.findByTestId('migration-outcome');
    expect(mockApi.adoptInstalledIntegration).toHaveBeenCalledWith('govdata');
    expect(outcome).toHaveTextContent('The current version could not be adopted for GovData.');
    expect(within(outcome).getByTestId('migration-problems')).toHaveTextContent(
      'baseUrl: must be a URL'
    );
    expectNoMissingKeys();
  });

  test('a downgrade with a matching backup offers Restore, Adopt and Uninstall; Adopt records the version', async () => {
    current = {
      ...REVIEW,
      definitionVersion: '1.5.0',
      statusReason:
        'org.ckan/open-data-portal 1.4.0 is loaded, older than the installed 1.5.0 (a downgrade); restore the backup of 1.4.0 or adopt the loaded version',
      migration: {
        ...REVIEW.migration,
        downgrade: true,
        from: '1.5.0',
        backups: [{ ...BACKUP, id: 'govdata-1.4.0-x', representedVersion: '1.4.0' }],
        defaultBackup: 'govdata-1.4.0-x'
      }
    };
    renderPage();
    const panel = await screen.findByTestId('migration-panel');
    expect(panel).toHaveTextContent('(a downgrade)');
    expect(panelActions(panel)).toEqual(['Restore backup', 'Adopt current version', 'Uninstall']);

    mockApi.adoptInstalledIntegration.mockImplementation(async () => {
      current = { ...BASE_INSTANCE, definitionVersion: '1.4.0' };
      return {
        success: true,
        logEntry: {
          from: '1.5.0',
          to: '1.4.0',
          at: '2026-11-02T12:00:00.000Z',
          by: 'admin',
          trigger: 'adopt',
          result: 'adopted'
        },
        instance: current
      };
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Adopt current version' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Adopt version' })
    );
    expect(await screen.findByTestId('migration-outcome')).toHaveTextContent(
      'GovData now records v1.4.0.'
    );
    await waitFor(() => expect(screen.queryByTestId('migration-panel')).not.toBeInTheDocument());
    expectNoMissingKeys();
  });
});

describe('Installed tab: tiles', () => {
  function renderList() {
    return render(
      <MemoryRouter initialEntries={['/admin/integrations']}>
        <Routes>
          <Route path="/admin/integrations" element={<AdminIntegrationsPage />} />
          <Route path="/admin/integrations/:instanceId" element={<div data-testid="page" />} />
        </Routes>
      </MemoryRouter>
    );
  }

  test('show the version, the state pill, the reason as text and the state actions', async () => {
    current = FAILED;
    renderList();
    const tile = await screen.findByTestId('installation-tile');
    expect(within(tile).getByTestId('installed-version')).toHaveTextContent('v1.2.0');
    const pill = within(tile).getByTestId('migration-status');
    expect(pill).toHaveTextContent('Migration failed');
    expect(pill.parentElement.className).toMatch(/bg-red-100/);
    expect(within(tile).getByTestId('migration-reason')).toHaveTextContent(
      '"defaultFilter" already holds a value'
    );
    // Uninstall is the tile's Remove quick action.
    const actions = within(within(tile).getByTestId('migration-actions')).getAllByRole('button');
    expect(actions.map(button => button.textContent)).toEqual([
      'Re-run migration',
      'Restore backup'
    ]);
    expect(actions[0]).toHaveAccessibleName('Re-run migration: GovData');
    expect(within(tile).getByRole('button', { name: 'Remove govdata' })).toBeInTheDocument();
    expectNoMissingKeys();
  });

  test('a pending tile is amber; Migrate now reports the outcome with a link to the page', async () => {
    renderList();
    const tile = await screen.findByTestId('installation-tile');
    expect(within(tile).getByTestId('migration-status').parentElement.className).toMatch(
      /bg-amber-100/
    );
    mockApi.migrateInstalledIntegration.mockImplementation(async () => {
      current = MIGRATED;
      return { success: true, result: 'migrated', logEntry: MIGRATED.migrationLog[0] };
    });
    fireEvent.click(within(tile).getByRole('button', { name: 'Migrate now: GovData' }));
    const outcome = await screen.findByTestId('migration-outcome');
    expect(outcome).toHaveTextContent('GovData was migrated from v1.2.0 to v1.4.0.');
    expect(within(outcome).getByRole('link', { name: 'Open GovData' })).toHaveAttribute(
      'href',
      '/admin/integrations/govdata'
    );
    await waitFor(() => expect(screen.queryByTestId('migration-status')).not.toBeInTheDocument());
    expectNoMissingKeys();
  });

  test('Restore on a tile asks first', async () => {
    current = FAILED;
    renderList();
    const tile = await screen.findByTestId('installation-tile');
    fireEvent.click(within(tile).getByRole('button', { name: 'Restore backup: GovData' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Restore a backup of GovData?' })
    ).toBeInTheDocument();
    expect(mockApi.restoreInstalledIntegration).not.toHaveBeenCalled();
  });
});
