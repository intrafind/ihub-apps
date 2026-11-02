// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The marketplace update dialog of an integration (versioning concept §4):
 *
 *   - from `migrationPreview` it says per installation what the update's
 *     migrations change ("This update changes 2 install values … of GovData;
 *     a backup is made first."), which installation's migration will fail
 *     (the update still goes in; it stays on its version until the admin
 *     acts), which one is planned only when the update is downloaded
 *     (`planFromCatalog: false`), which one needs a review;
 *   - after the update it reports `integrationMigrations` per installation
 *     (migrated / failed with the reason), each with a link to its page;
 *   - a migration lock (409) is reported in the dialog;
 *   - every string comes from shared/i18n/en.json.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  fetchMarketplaceItemDetail: jest.fn(),
  updateMarketplaceItem: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || 'error',
  fetchMarketplaceItemDetail: (...args) => mockApi.fetchMarketplaceItemDetail(...args),
  fetchMarketplaceItemFile: jest.fn(),
  installMarketplaceItem: jest.fn(),
  updateMarketplaceItem: (...args) => mockApi.updateMarketplaceItem(...args),
  uninstallMarketplaceItem: jest.fn(),
  detachMarketplaceItem: jest.fn(),
  makeAdminApiCall: jest.fn()
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
jest.mock('../../../client/src/features/chat/components/StreamingMarkdown', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock(
  '../../../client/src/features/admin/components/integrations/IntegrationReleaseNotes',
  () => ({
    __esModule: true,
    default: () => <div data-testid="release-notes" />,
    releasesBetween: releases => releases || []
  })
);

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const MarketplaceItemDetail =
  require('../../../client/src/features/admin/components/marketplace/MarketplaceItemDetail').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

const ROW = {
  from: '1.2.0',
  to: '1.4.0',
  planFromCatalog: true,
  reason: null,
  migrations: ['1.3.0', '1.4.0'],
  summary: null,
  warnings: [],
  collisions: [],
  ok: true
};

const PREVIEW = {
  definitionId: 'org.ckan/open-data-portal',
  to: '1.4.0',
  planFromCatalog: false,
  reason: 'an installation is older than the releases the catalog lists',
  errors: [],
  installations: [
    {
      ...ROW,
      id: 'govdata',
      label: { en: 'GovData', de: 'GovData DE' },
      summary: { values: 2, actions: 1, apps: 0 },
      warnings: [
        {
          code: 'ACTION_REMOVED_FROM_APP',
          message: '1.4.0: the action "package_show" was removed; …',
          appId: 'open-data',
          action: 'package_show',
          key: 'govdata'
        }
      ]
    },
    {
      ...ROW,
      id: 'berlin',
      label: 'Berlin open data',
      summary: { values: 0, actions: 0, apps: 0 },
      collisions: [
        {
          migration: '1.3.0',
          step: 'renameValue',
          kind: 'value',
          key: 'defaultFilter',
          message: 'renameValue fq → defaultFilter: "defaultFilter" already holds a value'
        }
      ],
      ok: false
    },
    {
      ...ROW,
      id: 'old',
      label: null,
      from: '1.0.0',
      planFromCatalog: false,
      reason: '1.0.0 is older than the oldest release the catalog lists (1.2.0); …'
    },
    {
      ...ROW,
      id: 'unversioned',
      label: 'Unversioned',
      from: null,
      planFromCatalog: false,
      ok: false,
      reason: 'needs a review (no valid definitionVersion); the update does not migrate it'
    },
    { ...ROW, id: 'current', label: 'Current', from: '1.4.0', reason: 'already at 1.4.0' }
  ]
};

const ITEM = {
  registryId: 'reg',
  type: 'integration',
  name: 'org.ckan__open-data-portal',
  displayName: { en: 'CKAN open data portal' },
  version: '1.4.0',
  installationStatus: 'update-available',
  installation: { version: '1.2.0', installedAt: '2026-10-01T00:00:00.000Z' },
  releases: [{ version: '1.4.0', date: '2026-11-12', summary: { en: 'New' } }],
  migrationPreview: PREVIEW
};

let detail;
beforeEach(() => {
  jest.clearAllMocks();
  detail = ITEM;
  mockApi.fetchMarketplaceItemDetail.mockImplementation(async () => detail);
});

async function openUpdateDialog() {
  render(
    <MemoryRouter>
      <MarketplaceItemDetail item={ITEM} onClose={() => {}} />
    </MemoryRouter>
  );
  await waitFor(() => expect(mockApi.fetchMarketplaceItemDetail).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: 'Update 1.2.0 → 1.4.0' }));
  return screen.getByTestId('update-dialog');
}

function expectNoMissingKeys() {
  expect(document.body.textContent).not.toMatch(/MISSING:/);
}

test('the update dialog says per installation what the migrations change, what fails and what is planned later', async () => {
  const dialog = await openUpdateDialog();
  const preview = within(dialog).getByTestId('update-migration-preview');
  const rows = within(preview).getAllByTestId('update-migration-row');
  expect(rows.map(row => row.getAttribute('data-kind'))).toEqual([
    'changes',
    'fails',
    'notPlanned',
    'review',
    'current'
  ]);

  expect(rows[0]).toHaveTextContent(
    'This update changes 2 install values and 1 action of GovData; a backup is made first.'
  );
  expect(within(rows[0]).getByTestId('update-migration-warnings')).toHaveTextContent(
    'The action “package_show” is removed from the app “open-data” (binding govdata)'
  );

  expect(rows[1]).toHaveTextContent(
    'The migration of Berlin open data will fail. The update still goes in, but Berlin open data stays on v1.2.0 and offers no actions until you act on its page'
  );
  expect(within(rows[1]).getByTestId('update-migration-collisions')).toHaveTextContent(
    '"defaultFilter" already holds a value'
  );

  // planFromCatalog: false — named by id when it has no label.
  expect(rows[2]).toHaveTextContent(
    'The migration of old (v1.0.0) is planned when the update is downloaded'
  );
  expect(rows[3]).toHaveTextContent(
    'Unversioned needs a review (it records no valid version), so the update does not migrate it.'
  );
  expect(rows[4]).toHaveTextContent('Current is already at v1.4.0.');
  expectNoMissingKeys();
});

test('migrations the catalog cannot plan are announced for the download, with the problems', async () => {
  detail = {
    ...ITEM,
    migrationPreview: {
      ...PREVIEW,
      planFromCatalog: false,
      reason: 'the catalog item lists migrations this server cannot read',
      errors: [{ path: ['0', 'steps', '0'], message: 'module steps are not supported' }],
      installations: []
    }
  };
  const dialog = await openUpdateDialog();
  const notPlanned = within(dialog).getByTestId('update-migration-not-planned');
  expect(notPlanned).toHaveTextContent(
    'The migrations cannot be planned from the catalog; they are planned when the update is downloaded'
  );
  expect(within(notPlanned).getByTestId('update-migration-errors')).toHaveTextContent(
    'module steps are not supported'
  );
  expectNoMissingKeys();
});

test('an item without installations shows no migration preview', async () => {
  detail = { ...ITEM, migrationPreview: null };
  const dialog = await openUpdateDialog();
  expect(within(dialog).queryByTestId('update-migration-preview')).not.toBeInTheDocument();
});

test('a pinned registry updates to the offered version, named in the dialog and sent explicitly', async () => {
  detail = { ...ITEM, version: '1.5.0', offeredVersion: '1.4.0', pin: '1.4.x' };
  mockApi.updateMarketplaceItem.mockResolvedValue({ version: '1.4.0' });
  const dialog = await openUpdateDialog();
  expect(dialog).toHaveTextContent('Update 1.2.0 → 1.4.0');
  expect(screen.getByTestId('version-pin')).toHaveTextContent('Pinned to 1.4.x');
  expect(screen.getByTestId('offered-version')).toHaveTextContent('offered here: v1.4.0');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
  await waitFor(() =>
    expect(mockApi.updateMarketplaceItem).toHaveBeenCalledWith(
      'reg',
      'integration',
      'org.ckan__open-data-portal',
      { version: '1.4.0' }
    )
  );
});

test('after the update it reports each installation’s migration with a link to its page', async () => {
  mockApi.updateMarketplaceItem.mockResolvedValue({
    version: '1.4.0',
    integrationMigrations: [
      {
        id: 'govdata',
        result: 'migrated',
        from: '1.2.0',
        to: '1.4.0',
        status: null,
        summary: { values: 2, actions: 1, apps: 0 },
        warnings: []
      },
      {
        id: 'berlin',
        result: 'failed',
        from: '1.2.0',
        to: '1.4.0',
        status: 'migrationFailed',
        statusReason: 'renameValue fq → defaultFilter: "defaultFilter" already holds a value',
        warnings: []
      },
      { id: 'current', result: 'skipped', reason: 'already at 1.4.0' }
    ]
  });
  const dialog = await openUpdateDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));

  const report = await screen.findByTestId('update-migration-report');
  expect(mockApi.updateMarketplaceItem).toHaveBeenCalledWith(
    'reg',
    'integration',
    'org.ckan__open-data-portal',
    { version: undefined }
  );
  // A failure makes the report an alert.
  expect(report).toHaveAttribute('role', 'alert');
  const results = within(report).getAllByTestId('update-migration-result');
  expect(results[0]).toHaveTextContent('GovData was migrated from v1.2.0 to v1.4.0.');
  expect(results[1]).toHaveTextContent(
    'The migration of Berlin open data failed: it stays on v1.2.0 and offers no actions until you act on its page. Reason: renameValue fq → defaultFilter: "defaultFilter" already holds a value'
  );
  expect(results[2]).toHaveTextContent('Current was not migrated: already at 1.4.0');
  expect(within(results[1]).getByRole('link', { name: 'Open Berlin open data' })).toHaveAttribute(
    'href',
    '/admin/integrations/berlin'
  );
  expect(screen.queryByTestId('update-dialog')).not.toBeInTheDocument();
  expectNoMissingKeys();

  fireEvent.click(within(report).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByTestId('update-migration-report')).not.toBeInTheDocument();
});

test('a migration lock (409) is reported in the dialog, which stays open', async () => {
  const error = new Error('Request failed with status code 409');
  error.response = {
    status: 409,
    data: { error: 'The migration lock of "govdata" is held', code: 'MIGRATION_LOCKED' }
  };
  mockApi.updateMarketplaceItem.mockRejectedValue(error);
  const dialog = await openUpdateDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));

  const alert = await within(dialog).findByTestId('update-error');
  expect(alert).toHaveAttribute('role', 'alert');
  expect(alert).toHaveTextContent(
    'A migration of an installation of this integration is running. Nothing was changed; try again in a moment.'
  );
  expect(alert).toHaveTextContent('The migration lock of "govdata" is held');
  expect(screen.queryByTestId('update-migration-report')).not.toBeInTheDocument();
  expectNoMissingKeys();
});
