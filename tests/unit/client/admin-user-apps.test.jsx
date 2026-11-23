// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin area of personal apps (concepts/app-builder-rework-2026-11/02-personal-apps.md,
 * section 11.9, slice P9):
 *
 * - the tab "Personal apps" of Admin → Apps: a full admin sees it with the feature on and off,
 *   with the line about the features page while it is off; a content admin does not see it;
 * - the list: the filters, and the menu (switch off and on, offer, earlier versions, delete);
 * - the settings panel: the groups of fields of the project panel in its order, then the fields
 *   only apps have; it names the groups that hold each permission, round-trips every field,
 *   lists the functions per installation and does not list `ihub`;
 * - the two checkboxes of the group page, beside the project ones;
 * - the count and the button that blocks an owner on the user page.
 *
 * The texts are those of `shared/i18n/en.json`. A key that file does not hold yet is rendered as
 * the key, on the page and in the expectations alike.
 */
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';

const mockApi = {
  createAdminApp: jest.fn(),
  fetchAdminApps: jest.fn(),
  fetchAppIntegrationStatus: jest.fn(),
  reorderApps: jest.fn(),
  toggleApps: jest.fn(),
  makeAdminApiCall: jest.fn(),
  fetchAdminGroups: jest.fn(),
  fetchAdminUserApps: jest.fn(),
  fetchAdminUserApp: jest.fn(),
  fetchAdminUserAppRevisions: jest.fn(),
  disableAdminUserApp: jest.fn(),
  enableAdminUserApp: jest.fn(),
  deleteAdminUserApp: jest.fn(),
  releaseAdminUserApp: jest.fn(),
  fetchUserAppSettings: jest.fn(),
  saveUserAppSettings: jest.fn(),
  fetchUserAppOfferTargets: jest.fn(),
  offerAdminUserApp: jest.fn(),
  withdrawAdminUserAppOffer: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  createAdminApp: (...args) => mockApi.createAdminApp(...args),
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  fetchAppIntegrationStatus: (...args) => mockApi.fetchAppIntegrationStatus(...args),
  reorderApps: (...args) => mockApi.reorderApps(...args),
  toggleApps: (...args) => mockApi.toggleApps(...args),
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args),
  fetchAdminGroups: (...args) => mockApi.fetchAdminGroups(...args),
  fetchAdminUserApps: (...args) => mockApi.fetchAdminUserApps(...args),
  fetchAdminUserApp: (...args) => mockApi.fetchAdminUserApp(...args),
  fetchAdminUserAppRevisions: (...args) => mockApi.fetchAdminUserAppRevisions(...args),
  disableAdminUserApp: (...args) => mockApi.disableAdminUserApp(...args),
  enableAdminUserApp: (...args) => mockApi.enableAdminUserApp(...args),
  deleteAdminUserApp: (...args) => mockApi.deleteAdminUserApp(...args),
  releaseAdminUserApp: (...args) => mockApi.releaseAdminUserApp(...args),
  fetchUserAppSettings: (...args) => mockApi.fetchUserAppSettings(...args),
  saveUserAppSettings: (...args) => mockApi.saveUserAppSettings(...args),
  fetchUserAppOfferTargets: (...args) => mockApi.fetchUserAppOfferTargets(...args),
  offerAdminUserApp: (...args) => mockApi.offerAdminUserApp(...args),
  withdrawAdminUserAppOffer: (...args) => mockApi.withdrawAdminUserAppOffer(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));

const mockIntegrations = {
  fetchInstalledIntegrations: jest.fn(),
  fetchInstalledIntegration: jest.fn()
};
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...args) => mockIntegrations.fetchInstalledIntegrations(...args),
  fetchInstalledIntegration: (...args) => mockIntegrations.fetchInstalledIntegration(...args)
}));

jest.mock('../../../client/src/api', () => ({
  fetchUIConfig: jest.fn().mockResolvedValue({})
}));

// What the pages read about the installation and the person.
const mockEnv = { platformConfig: {}, user: null };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockEnv.platformConfig, refreshConfig: () => {} })
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => (mockEnv.user ? { user: mockEnv.user } : null)
}));

// runtimeBasePath and Icon use `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: target => target,
  buildAssetUrl: target => target
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/components/AppDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => ({
  __esModule: true,
  default: () => null
}));
// Parts of the group form that load data of their own.
jest.mock('../../../client/src/features/admin/components/ResourceSelector', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/GroupMultiSelect', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/GroupIntegrationsSection', () => ({
  __esModule: true,
  default: () => null
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const AdminAppsPage = require('../../../client/src/features/admin/pages/AdminAppsPage').default;
const AdminUserViewPage =
  require('../../../client/src/features/admin/pages/AdminUserViewPage').default;
const AdminUserAppsTab =
  require('../../../client/src/features/admin/components/AdminUserAppsTab').default;
const {
  ageText,
  isWaiting
} = require('../../../client/src/features/admin/components/AdminUserAppsTab');
const UserAppSettingsPanel =
  require('../../../client/src/features/admin/components/UserAppSettingsPanel').default;
const {
  SaveSectionsBar,
  SaveSectionsProvider
} = require('../../../client/src/features/admin/components/SaveSections');
const {
  changedKeys,
  groupsWithPermission,
  PUBLISHING_AVAILABLE
} = require('../../../client/src/features/admin/components/UserAppSettingsPanel');
const GroupFormEditor =
  require('../../../client/src/features/admin/components/GroupFormEditor').default;

/** The text of a key as the page renders it. */
const text = (key, options) => mockI18n.t(key, options);

const FULL_ADMIN = { id: 'root', isAdmin: true, permissions: { adminAccess: true } };
const CONTENT_ADMIN = { id: 'cora', isAdmin: false, permissions: { contentAdmin: true } };

const APP_ID = `uap_${'a'.repeat(32)}`;

/** A list item of `GET /api/admin/user-apps`. */
function item(overrides = {}) {
  return {
    id: APP_ID,
    name: 'Meeting recap',
    icon: 'sparkles',
    color: '#4F46E5',
    owner: { id: 'ben', name: 'Ben Koch', active: true, rightsCheckedAt: null, stale: false },
    pendingOwner: null,
    state: 'active',
    disabled: null,
    clash: false,
    publishedAs: null,
    sharedWith: { users: 0, groups: 0, everyone: false },
    capabilities: ['upload'],
    revision: 7,
    updatedAt: '2026-11-12T10:00:00Z',
    lastUsedAt: '2026-11-12T10:00:00Z',
    ...overrides
  };
}

const RESEARCH = item({
  id: `uap_${'b'.repeat(32)}`,
  name: 'Research helper',
  owner: { id: 'anna', name: 'Anna Schmidt', active: true, stale: false },
  state: 'promoted',
  publishedAs: {
    appId: 'research-helper',
    at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    by: { id: 'anna', name: 'Anna Schmidt' },
    enabled: false
  },
  sharedWith: { users: 4, groups: 1, everyone: false },
  membersWithoutCompanyApp: 3,
  capabilities: ['upload', 'webSearch']
});
const RECAP = item();
const ORPHAN = item({
  id: `uap_${'c'.repeat(32)}`,
  name: 'Orphan notes',
  owner: { id: 'carl', name: 'Carl Left', active: false, stale: false },
  sharedWith: { users: 0, groups: 0, everyone: true }
});
const OFF = item({
  id: `uap_${'d'.repeat(32)}`,
  name: 'Switched off app',
  owner: { id: 'dora', name: 'Dora Stale', active: true, stale: true },
  disabled: { at: '2026-11-20T10:00:00Z', by: { id: 'root', name: 'Ada Admin' }, reason: 'Spam' }
});

function settings(overrides = {}) {
  return {
    limits: { maxAppsPerUser: 20, maxOpenOffersPerUser: 5, ownerSnapshotMaxAgeDays: 30 },
    sharing: { allowUsers: true, allowGroups: true, allowEveryone: false, allowPublish: false },
    capabilities: {
      modelChoice: true,
      upload: true,
      webSearch: false,
      skills: false,
      integrations: []
    },
    publishing: { adminEnables: 'withTools' },
    blockedOwners: [],
    ...overrides
  };
}

const GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { userApps: true, userAppSharing: true } },
    users: { id: 'users', name: 'Users', permissions: { userApps: true, userAppSharing: false } },
    hr: { id: 'hr', name: 'HR', inherits: ['users'], permissions: {} },
    guests: { id: 'guests', name: 'Guests', permissions: {} }
  }
};

/** Shows where the router is, for links and navigations. */
function Location() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderAt(url, routes) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Location />
      <Routes>{routes}</Routes>
    </MemoryRouter>
  );
}

const renderAppsPage = (url = '/admin/apps') =>
  renderAt(url, <Route path="*" element={<AdminAppsPage />} />);

const renderTab = (url = '/admin/apps?tab=personal') =>
  renderAt(url, <Route path="*" element={<AdminUserAppsTab />} />);

// The panel sits on a tab whose bar carries Save and Discard.
const renderPanel = props =>
  renderAt(
    '/admin/apps?tab=personal',
    <Route
      path="*"
      element={
        <SaveSectionsProvider>
          <UserAppSettingsPanel {...props} />
          <SaveSectionsBar />
        </SaveSectionsProvider>
      }
    />
  );

const SAVE_BAR = 'Save changes';
const saveButton = () => screen.getByRole('button', { name: text('admin.ui.save') });

/** The table row that names an app. */
const rowOf = name => screen.getByText(name).closest('tr');

/** Open the "⋯" menu of an app's row and return the menu. */
async function openMenu(name) {
  const row = await waitFor(() => rowOf(name));
  fireEvent.click(row.querySelector('[aria-haspopup="menu"]'));
  return screen.findByRole('menu');
}

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEnv.user = FULL_ADMIN;
  mockEnv.platformConfig = { featuresMap: { userApps: true } };
  mockApi.fetchAdminApps.mockResolvedValue([]);
  mockApi.fetchAppIntegrationStatus.mockResolvedValue({});
  mockApi.fetchAdminGroups.mockResolvedValue(GROUPS);
  mockApi.fetchAdminUserApps.mockImplementation(async (filters = {}) => {
    const all = [RESEARCH, RECAP, ORPHAN, OFF];
    if (filters.waiting) return all.filter(isWaiting);
    if (filters.ownerId) return all.filter(app => app.owner.id === filters.ownerId);
    return all;
  });
  mockApi.fetchUserAppSettings.mockResolvedValue(settings());
  mockApi.saveUserAppSettings.mockImplementation(async body => settings(body));
  mockApi.makeAdminApiCall.mockResolvedValue({ data: { users: {} } });
  mockIntegrations.fetchInstalledIntegrations.mockResolvedValue({ items: [] });
  mockIntegrations.fetchInstalledIntegration.mockResolvedValue({ actions: [] });
  mockApi.fetchUserAppOfferTargets.mockResolvedValue([]);
});

describe('the tab "Personal apps" of Admin → Apps', () => {
  it('is shown to a full admin with the feature off, with the line about the features page', async () => {
    mockEnv.platformConfig = { featuresMap: { userApps: false } };
    renderAppsPage();

    const tab = await screen.findByRole('tab', { name: /Personal apps/ });
    expect(screen.getByRole('tab', { name: 'Apps' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab);

    expect(screen.getByTestId('location')).toHaveTextContent('/admin/apps?tab=personal');
    const panel = await screen.findByRole('tabpanel');
    const line = within(panel).getAllByText(text('admin.userApps.featureOff'), { exact: false })[0];
    expect(within(line).getByRole('link', { name: 'Features' })).toHaveAttribute(
      'href',
      '/admin/features'
    );
    // The settings and the stored apps are below it, so everything can be set up first.
    expect(await screen.findByText(text('admin.userApps.settings.title'))).toBeInTheDocument();
    expect(await screen.findByText('Meeting recap')).toBeInTheDocument();
  });

  it('is shown to a full admin with the feature on, without that line', async () => {
    renderAppsPage('/admin/apps?tab=personal');

    expect(await screen.findByText('Meeting recap')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Personal apps/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.queryByText(text('admin.userApps.featureOff'), { exact: false })).toBeNull();
    // The buttons of the "Apps" tab are not offered here.
    expect(screen.queryByRole('button', { name: en.admin.apps.createApp })).toBeNull();
  });

  it('carries the number of published apps that are not switched on', async () => {
    renderAppsPage();
    expect(
      await screen.findByRole('tab', { name: text('admin.userApps.tabWaiting', { count: 1 }) })
    ).toBeInTheDocument();
    expect(mockApi.fetchAdminUserApps).toHaveBeenCalledWith({ waiting: true });
  });

  it('is not shown to a content admin, also when the address names it', async () => {
    mockEnv.user = CONTENT_ADMIN;
    renderAppsPage('/admin/apps?tab=personal');

    await waitFor(() => expect(mockApi.fetchAdminApps).toHaveBeenCalled());
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText(text('admin.userApps.settings.title'))).toBeNull();
    expect(screen.getByRole('button', { name: en.admin.apps.createApp })).toBeVisible();
    expect(mockApi.fetchAdminUserApps).not.toHaveBeenCalled();
    expect(mockApi.fetchUserAppSettings).not.toHaveBeenCalled();
  });

  it('mounts the take-over dialog and the waiting-apps notice of the publish slice', () => {
    const read = file =>
      fs.readFileSync(path.resolve(__dirname, '../../../client/src/features/admin', file), 'utf8');
    expect(read('components/AdminUserAppsTab.jsx')).toContain(
      'const TakeOverDialog = UserAppTakeOverDialog;'
    );
    expect(read('pages/AdminAppsPage.jsx')).toContain(
      '<WaitingAppsNotice refreshKey={waitingRefresh} />'
    );
  });
});

describe('the tab "Personal apps" keeps its unsaved settings', () => {
  const everyone = () =>
    screen.getByRole('checkbox', {
      name: new RegExp(`^${text('admin.userApps.settings.allowEveryone')}`)
    });
  const bar = () => screen.queryByRole('region', { name: SAVE_BAR });

  /** The apps page with a button that leaves it, as a sidebar link would. */
  function GoAway() {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate('/admin/groups')}>
        go away
      </button>
    );
  }
  const renderWithExit = () =>
    renderAt(
      '/admin/apps?tab=personal',
      <Route
        path="*"
        element={
          <>
            <AdminAppsPage />
            <GoAway />
          </>
        }
      />
    );

  it('keeps the edit and the bar when the admin switches to the Apps tab and back', async () => {
    renderAppsPage('/admin/apps?tab=personal');
    await screen.findByText(text('admin.userApps.settings.shareWith'));
    expect(bar()).toBeNull();

    fireEvent.click(everyone());
    expect(bar()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    expect(screen.getByTestId('location')).not.toHaveTextContent('tab=personal');
    // The settings are out of sight, the edit is not gone: the bar still carries it.
    expect(
      screen.queryByRole('checkbox', {
        name: new RegExp(`^${text('admin.userApps.settings.allowEveryone')}`)
      })
    ).toBeNull();
    expect(bar()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Personal apps/ }));
    expect(everyone()).toBeChecked();
    expect(mockApi.saveUserAppSettings).not.toHaveBeenCalled();
  });

  it('saves the edit from the Apps tab, with the one bar of the page', async () => {
    renderAppsPage('/admin/apps?tab=personal');
    await screen.findByText(text('admin.userApps.settings.shareWith'));
    fireEvent.click(everyone());
    fireEvent.click(screen.getByRole('tab', { name: 'Apps' }));

    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(mockApi.saveUserAppSettings).toHaveBeenCalledWith({ sharing: { allowEveryone: true } });
    expect(bar()).toBeNull();
    // Only the page's bar exists: the tab's own is not drawn a second time.
    expect(screen.queryAllByRole('region', { name: SAVE_BAR })).toHaveLength(0);
  });

  it('asks before the admin leaves the page with the edit', async () => {
    renderWithExit();
    await screen.findByText(text('admin.userApps.settings.shareWith'));
    fireEvent.click(everyone());

    fireEvent.click(screen.getByRole('button', { name: 'go away' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/apps');
  });

  it('lets the admin leave when nothing changed', async () => {
    renderWithExit();
    await screen.findByText(text('admin.userApps.settings.shareWith'));

    fireEvent.click(screen.getByRole('button', { name: 'go away' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/groups');
  });
});

describe('the list of personal apps', () => {
  it('shows owner, shares, what the app may use and what is special about it', async () => {
    renderTab();

    const research = await waitFor(() => rowOf('Research helper'));
    expect(research).toHaveTextContent('Anna Schmidt');
    expect(research).toHaveTextContent(text('admin.userApps.shared.users', { count: 4 }));
    expect(research).toHaveTextContent(text('admin.userApps.shared.groups', { count: 1 }));
    expect(research).toHaveTextContent(text('userApps.edit.extras.webSearch'));
    expect(research).toHaveTextContent(
      text('admin.userApps.waiting.row', {
        age: ageText(RESEARCH.publishedAs.at, Date.now(), 'en')
      })
    );
    // Whom the company app does not reach yet, so the admin can grant it to their groups.
    expect(research).toHaveTextContent('3 of 4 members cannot use the company app.');
    // The company app is opened in the admin editor, where it is tested and published.
    fireEvent.click(
      within(research).getByRole('button', { name: text('admin.userApps.waiting.open') })
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/apps/research-helper');
  });

  it('names a switched-off app, its reason, an inactive owner and stale rights', async () => {
    renderTab();

    const off = await waitFor(() => rowOf('Switched off app'));
    expect(off).toHaveTextContent(`${text('userApps.edit.state.disabled')}: Spam`);
    expect(off).toHaveTextContent(text('admin.userApps.filter.ownerStale'));
    const orphan = rowOf('Orphan notes');
    expect(orphan).toHaveTextContent(text('admin.userApps.filter.ownerInactive'));
    expect(orphan).toHaveTextContent(text('userApps.edit.state.everyone'));
    expect(rowOf('Meeting recap')).toHaveTextContent(text('admin.userApps.shared.none'));
    expect(
      within(rowOf('Meeting recap')).getByRole('link', { name: en.admin.apps.openApp })
    ).toHaveAttribute('href', `/apps/${APP_ID}`);
  });

  it('filters by the chips, each with its count', async () => {
    renderTab();
    await screen.findByText('Meeting recap');

    const chips = screen.getByRole('radiogroup');
    const chip = key => within(chips).getByRole('radio', { name: new RegExp(`^${text(key)}`) });
    expect(chip('admin.userApps.filter.all')).toHaveTextContent('4');
    expect(chip('admin.userApps.filter.all')).toHaveAttribute('aria-checked', 'true');
    expect(chip('admin.userApps.filter.waiting')).toHaveTextContent('1');
    expect(chip('admin.userApps.filter.everyone')).toHaveTextContent('1');
    expect(chip('admin.userApps.filter.ownerInactive')).toHaveTextContent('1');
    expect(chip('admin.userApps.filter.ownerStale')).toHaveTextContent('1');

    const only = async (key, name) => {
      fireEvent.click(chip(key));
      await waitFor(() => expect(chip(key)).toHaveAttribute('aria-checked', 'true'));
      const rows = screen.getAllByRole('row').slice(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent(name);
    };
    await only('admin.userApps.filter.waiting', 'Research helper');
    await only('admin.userApps.filter.everyone', 'Orphan notes');
    await only('admin.userApps.filter.ownerInactive', 'Orphan notes');
    await only('admin.userApps.filter.ownerStale', 'Switched off app');

    fireEvent.click(chip('admin.userApps.filter.all'));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(5));
  });

  it('shows the apps of one owner when the address names the owner', async () => {
    renderTab('/admin/apps?tab=personal&owner=anna');

    await screen.findByText('Research helper');
    expect(screen.queryByText('Meeting recap')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: text('admin.userApps.filter.clearOwner') }));
    expect(await screen.findByText('Meeting recap')).toBeInTheDocument();
  });

  it('has the menu, with the take-over entry for an app that is not published', async () => {
    renderTab();

    const menu = await openMenu('Meeting recap');
    const entries = within(menu)
      .getAllByRole('menuitem')
      .map(entry => entry.textContent);
    expect(entries).toEqual(
      expect.arrayContaining([
        text('admin.userApps.takeOver.action'),
        text('admin.userApps.offerOwner'),
        text('admin.userApps.disable.action'),
        text('admin.userApps.revisions')
      ])
    );
    expect(entries).not.toContain(text('admin.userApps.release.action'));
    expect(
      within(rowOf('Meeting recap')).getByRole('button', { name: 'Delete' })
    ).toBeInTheDocument();
  });

  it('switches an app off with a reason, and on again', async () => {
    mockApi.disableAdminUserApp.mockResolvedValue({});
    mockApi.enableAdminUserApp.mockResolvedValue({});
    renderTab();

    fireEvent.click(
      within(await openMenu('Meeting recap')).getByRole('menuitem', {
        name: text('admin.userApps.disable.action')
      })
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(text('admin.userApps.disable.body'));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Leaks data' } });
    fireEvent.click(
      within(dialog).getByRole('button', { name: text('admin.userApps.disable.action') })
    );
    await waitFor(() =>
      expect(mockApi.disableAdminUserApp).toHaveBeenCalledWith(APP_ID, 'Leaks data')
    );
    // The list is read again after the change.
    await waitFor(() => expect(mockApi.fetchAdminUserApps).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(
      within(await openMenu('Switched off app')).getByRole('menuitem', {
        name: text('admin.userApps.enable.action')
      })
    );
    await waitFor(() => expect(mockApi.enableAdminUserApp).toHaveBeenCalledWith(OFF.id));
  });

  it('deletes an app after a confirmation that names it', async () => {
    mockApi.deleteAdminUserApp.mockResolvedValue();
    renderTab();

    const row = await waitFor(() => rowOf('Meeting recap'));
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Meeting recap');
    expect(mockApi.deleteAdminUserApp).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.deleteAdminUserApp).toHaveBeenCalledWith(APP_ID));
  });

  it('offers an app to a new owner on the state the admin sees', async () => {
    mockApi.fetchUserAppOfferTargets.mockResolvedValue([
      { id: 'ben', name: 'Ben Koch', email: null },
      { id: 'eva', name: 'Eva Neu', email: 'eva@example.com' }
    ]);
    mockApi.offerAdminUserApp.mockResolvedValue({});
    renderTab();

    fireEvent.click(
      within(await openMenu('Meeting recap')).getByRole('menuitem', {
        name: text('admin.userApps.offerOwner')
      })
    );
    const dialog = await screen.findByRole('dialog');
    const eva = await within(dialog).findByRole('radio', { name: /Eva Neu/ });
    // The owner is not offered their own app.
    expect(within(dialog).queryByRole('radio', { name: /Ben Koch/ })).toBeNull();
    // The admin is, first: to change a personal app an admin becomes its owner (design 8.4).
    expect(within(dialog).getAllByRole('radio')[0]).toHaveAccessibleName(
      text('admin.userApps.offer.me', { name: 'root' })
    );
    expect(mockApi.fetchUserAppOfferTargets).toHaveBeenCalledWith('');
    fireEvent.click(eva);
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: text('userApps.transfer.submit', { owner: 'Eva Neu' })
      })
    );
    // The revision of the list: no read of the admin view, which is audited as a read of the content.
    await waitFor(() => expect(mockApi.offerAdminUserApp).toHaveBeenCalledWith(APP_ID, 'eva', 7));
    expect(mockApi.fetchAdminUserApp).not.toHaveBeenCalled();
  });

  it('the admin can offer an app to themselves', async () => {
    mockApi.fetchUserAppOfferTargets.mockResolvedValue([]);
    mockApi.offerAdminUserApp.mockResolvedValue({});
    renderTab();
    fireEvent.click(
      within(await openMenu('Meeting recap')).getByRole('menuitem', {
        name: text('admin.userApps.offerOwner')
      })
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('radio', { name: text('admin.userApps.offer.me', { name: 'root' }) })
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /root/ }));
    await waitFor(() => expect(mockApi.offerAdminUserApp).toHaveBeenCalledWith(APP_ID, 'root', 7));
  });

  it('the people of the offer dialog are one radio group: one tab stop, the arrow keys pick', async () => {
    mockApi.fetchUserAppOfferTargets.mockResolvedValue([
      { id: 'ben', name: 'Ben Koch', email: null },
      { id: 'eva', name: 'Eva Neu', email: null },
      { id: 'finn', name: 'Finn Ott', email: null }
    ]);
    // The admin owns the app here, so the list holds no entry for the admin.
    mockEnv.user = { ...FULL_ADMIN, id: 'ben' };
    renderTab();
    fireEvent.click(
      within(await openMenu('Meeting recap')).getByRole('menuitem', {
        name: text('admin.userApps.offerOwner')
      })
    );
    const dialog = await screen.findByRole('dialog');
    const eva = await within(dialog).findByRole('radio', { name: /Eva Neu/ });
    const finn = within(dialog).getByRole('radio', { name: /Finn Ott/ });
    const group = within(dialog).getByRole('radiogroup', {
      name: text('admin.userApps.offer.results')
    });
    // The radios are the group's own children: no list items without a list.
    expect(group.querySelector('li')).toBeNull();
    expect(eva).toHaveAttribute('tabindex', '0');
    expect(finn).toHaveAttribute('tabindex', '-1');

    eva.focus();
    fireEvent.keyDown(eva, { key: 'ArrowDown' });
    await waitFor(() => expect(finn).toHaveAttribute('aria-checked', 'true'));
    expect(finn).toHaveFocus();
    expect(finn).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(finn, { key: 'ArrowDown' });
    await waitFor(() => expect(eva).toHaveAttribute('aria-checked', 'true'));
    expect(eva).toHaveFocus();
  });

  it('the filter chips move and select with the arrow keys', async () => {
    renderTab();
    await screen.findByText('Meeting recap');
    const chips = screen.getByRole('radiogroup');
    const radios = within(chips).getAllByRole('radio');
    expect(radios.map(radio => radio.getAttribute('tabindex'))).toEqual(
      radios.map((_, index) => (index === 0 ? '0' : '-1'))
    );
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    await waitFor(() =>
      expect(within(chips).getAllByRole('radio')[1]).toHaveAttribute('aria-checked', 'true')
    );
    expect(within(chips).getAllByRole('radio')[1]).toHaveFocus();
  });

  it('lists the earlier versions with who saved them', async () => {
    mockApi.fetchAdminUserAppRevisions.mockResolvedValue([
      {
        revision: 3,
        contentHash: 'h3',
        content: { system: { en: 'Summarize the meeting.' } },
        savedAt: '2026-11-12T10:00:00Z',
        savedBy: { id: 'ben', name: 'Ben Koch' }
      }
    ]);
    renderTab();

    fireEvent.click(
      within(await openMenu('Meeting recap')).getByRole('menuitem', {
        name: text('admin.userApps.revisions')
      })
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Summarize the meeting.')).toBeInTheDocument();
    expect(mockApi.fetchAdminUserAppRevisions).toHaveBeenCalledWith(APP_ID);
  });

  it('with the feature off the menu has no offer: it needs the routes of personal apps', async () => {
    mockEnv.platformConfig = { featuresMap: { userApps: false } };
    renderTab();
    const menu = await openMenu('Meeting recap');
    const entries = within(menu)
      .getAllByRole('menuitem')
      .map(entry => entry.textContent);
    expect(entries).not.toContain(text('admin.userApps.offerOwner'));
    expect(entries).not.toContain(text('userApps.transfer.withdraw'));
    // What an admin does while setting things up stays.
    expect(entries).toContain(text('admin.userApps.disable.action'));
    expect(entries).toContain(text('admin.userApps.revisions'));
    // The chat does not resolve a personal app while the feature is off.
    expect(
      within(rowOf('Meeting recap')).queryByRole('link', { name: text('admin.apps.openApp') })
    ).toBeNull();
  });

  it('"Open app" leads to the chat of the app while the feature is on', async () => {
    renderTab();
    await screen.findByText('Meeting recap');
    expect(
      within(rowOf('Meeting recap')).getByRole('link', { name: text('admin.apps.openApp') })
    ).toHaveAttribute('href', `/apps/${APP_ID}`);
  });

  it('a switched-off app has no offer: it cannot change hands', async () => {
    renderTab();
    const menu = await openMenu('Switched off app');
    const entries = within(menu)
      .getAllByRole('menuitem')
      .map(entry => entry.textContent);
    expect(entries).not.toContain(text('admin.userApps.offerOwner'));
    expect(entries).toContain(text('admin.userApps.enable.action'));
  });

  it('offers "Give back to the owner" for a promoted app, and says when the company app is in the way', async () => {
    mockApi.releaseAdminUserApp.mockRejectedValue({
      response: { status: 409, data: { code: 'CONFLICT', details: { reason: 'published' } } }
    });
    renderTab();

    fireEvent.click(
      within(await openMenu('Research helper')).getByRole('menuitem', {
        name: text('admin.userApps.release.action')
      })
    );
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: text('admin.userApps.release.action') })
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      text('admin.userApps.release.published')
    );
    expect(mockApi.releaseAdminUserApp).toHaveBeenCalledWith(RESEARCH.id);
  });

  it('says what a span of time is in words', () => {
    const now = Date.parse('2026-11-22T10:00:00Z');
    expect(ageText('2026-11-19T10:00:00Z', now, 'en')).toBe('3 days');
    expect(ageText('2026-11-22T05:00:00Z', now, 'en')).toBe('5 hours');
    expect(ageText('2026-11-19T10:00:00Z', now, 'de')).toBe('3 Tagen');
    expect(ageText('2026-11-22T09:59:30Z', now, 'en')).toBe('1 minute');
  });
});

describe('the settings panel', () => {
  const box = name => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });

  it('has the groups of fields of the project panel in its order, then the fields only apps have', async () => {
    renderPanel({ publishingAvailable: true });
    await screen.findByText(text('admin.userApps.settings.shareWith'));

    const order = [
      text('admin.userApps.featureOn'),
      text('admin.userApps.settings.shareWith'),
      text('admin.userApps.settings.allowUsers'),
      text('admin.userApps.settings.allowGroups'),
      text('admin.userApps.settings.allowEveryone'),
      text('admin.userApps.settings.allowPublish'),
      text('admin.userApps.settings.permissionHint'),
      text('admin.userApps.settings.limits'),
      text('admin.userApps.settings.max'),
      text('admin.userApps.settings.mayUse'),
      text('admin.userApps.settings.blocked')
    ];
    const page = document.body.textContent;
    const positions = order.map(entry => page.indexOf(entry));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(screen.getByRole('link', { name: 'Features' })).toHaveAttribute(
      'href',
      '/admin/features'
    );
  });

  it('says that the feature is off and links to the features page', async () => {
    mockEnv.platformConfig = { featuresMap: { userApps: false } };
    renderPanel();
    expect(await screen.findByText(text('admin.userApps.featureOff'))).toBeInTheDocument();
  });

  it('names the groups that hold each permission, inherited ones included', async () => {
    renderPanel();

    expect(
      await screen.findByText(
        text('admin.userApps.settings.groupsCreate', { list: 'Admins, Users, HR' })
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(text('admin.userApps.settings.groupsShare', { list: 'Admins' }))
    ).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', {
      name: text('admin.userApps.settings.change')
    })) {
      expect(link).toHaveAttribute('href', '/admin/groups');
    }
    expect(groupsWithPermission(GROUPS.groups, 'userApps')).toEqual(['Admins', 'Users', 'HR']);
    expect(
      groupsWithPermission(
        { a: { name: 'A', inherits: ['b'] }, b: { inherits: ['a'] } },
        'userApps'
      )
    ).toEqual([]);
  });

  it('round-trips every field, with the actions per installation and without ihub', async () => {
    mockApi.fetchUserAppSettings.mockResolvedValue(settings({ blockedOwners: ['carl', 'dora'] }));
    mockApi.makeAdminApiCall.mockResolvedValue({
      data: { users: { carl: { id: 'carl', name: 'Carl Left' } } }
    });
    mockIntegrations.fetchInstalledIntegrations.mockResolvedValue({
      items: [
        { id: 'ihub', label: 'iHub' },
        { id: 'jira-main', label: 'Jira' },
        { id: 'sharepoint', label: 'SharePoint' }
      ]
    });
    mockIntegrations.fetchInstalledIntegration.mockImplementation(async id => ({
      actions:
        id === 'jira-main'
          ? [
              { name: 'searchIssues', title: 'Search issues' },
              { name: 'readIssue', title: 'Read issue' }
            ]
          : [{ name: 'searchFiles', title: 'Search files' }]
    }));
    renderPanel({ publishingAvailable: true });
    await screen.findByText(text('admin.userApps.settings.shareWith'));

    // What is stored is what is shown.
    expect(box(text('admin.userApps.settings.allowUsers'))).toBeChecked();
    expect(box(text('admin.userApps.settings.allowEveryone'))).not.toBeChecked();
    expect(box(text('admin.userApps.settings.allowPublish'))).not.toBeChecked();
    expect(screen.getByRole('spinbutton')).toHaveValue(20);
    expect(await screen.findByText('Carl Left')).toBeInTheDocument();
    expect(screen.getByText('dora')).toBeInTheDocument();
    // No Save button of its own, and no bar until something changes.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('region', { name: SAVE_BAR })).toBeNull();

    // The audiences and the publishing switch with the checkbox under it.
    fireEvent.click(box(text('admin.userApps.settings.allowUsers')));
    fireEvent.click(box(text('admin.userApps.settings.allowEveryone')));
    expect(
      screen.queryByRole('checkbox', { name: text('admin.userApps.settings.adminEnablesAlways') })
    ).toBeNull();
    fireEvent.click(box(text('admin.userApps.settings.allowPublish')));
    fireEvent.click(box(text('admin.userApps.settings.adminEnablesAlways')));
    // The limit.
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    // What personal apps may use.
    fireEvent.click(box(text('admin.userApps.capability.model')));
    fireEvent.click(box(text('userApps.edit.extras.webSearch')));
    fireEvent.click(box(text('userApps.edit.extras.skills')));
    // The connected systems: every installation with its functions, never `ihub`.
    fireEvent.click(screen.getByRole('button', { name: text('admin.userApps.settings.choose') }));
    const jira = (await screen.findByText('Jira')).closest('fieldset');
    expect(screen.getByText(text('admin.userApps.settings.integrationsHelp'))).toBeInTheDocument();
    expect(screen.getByText('SharePoint')).toBeInTheDocument();
    expect(screen.queryByText('iHub')).toBeNull();
    expect(mockIntegrations.fetchInstalledIntegration).not.toHaveBeenCalledWith('ihub');
    expect(
      within(jira)
        .getAllByRole('checkbox')
        .map(entry => entry.closest('label').textContent)
    ).toEqual(['Search issues', 'Read issue']);
    fireEvent.click(within(jira).getByRole('checkbox', { name: 'Search issues' }));
    fireEvent.click(within(jira).getByRole('checkbox', { name: 'Read issue' }));
    fireEvent.click(within(jira).getByRole('checkbox', { name: 'Search issues' }));
    // An installation is on the list only while one of its functions is ticked.
    const sharepoint = screen.getByText('SharePoint').closest('fieldset');
    fireEvent.click(within(sharepoint).getByRole('checkbox', { name: 'Search files' }));
    fireEvent.click(within(sharepoint).getByRole('checkbox', { name: 'Search files' }));
    // The people whose apps are switched off.
    fireEvent.click(
      screen.getByRole('button', {
        name: `${text('admin.userApps.settings.unblock')}: Carl Left`
      })
    );

    expect(screen.getByRole('region', { name: SAVE_BAR })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mockApi.saveUserAppSettings).toHaveBeenCalledTimes(1);
    // Only the keys that changed: the server merges key by key.
    expect(mockApi.saveUserAppSettings).toHaveBeenCalledWith({
      sharing: { allowUsers: false, allowEveryone: true, allowPublish: true },
      publishing: { adminEnables: 'always' },
      limits: { maxAppsPerUser: 5 },
      capabilities: {
        modelChoice: false,
        webSearch: true,
        skills: true,
        integrations: [{ id: 'jira-main', actions: ['readIssue'] }]
      },
      blockedOwners: ['dora']
    });

    // The answer of the server is what the panel shows afterwards.
    await waitFor(() => expect(screen.queryByRole('region', { name: SAVE_BAR })).toBeNull());
    expect(box(text('admin.userApps.settings.allowUsers'))).not.toBeChecked();
    expect(box(text('admin.userApps.settings.allowEveryone'))).toBeChecked();
    expect(box(text('admin.userApps.settings.allowPublish'))).toBeChecked();
    expect(box(text('admin.userApps.settings.adminEnablesAlways'))).toBeChecked();
    expect(screen.getByRole('spinbutton')).toHaveValue(5);
    expect(box(text('admin.userApps.capability.model'))).not.toBeChecked();
    expect(box(text('userApps.edit.extras.webSearch'))).toBeChecked();
    expect(within(jira).getByRole('checkbox', { name: 'Read issue' })).toBeChecked();
    expect(within(jira).getByRole('checkbox', { name: 'Search issues' })).not.toBeChecked();
    expect(screen.queryByText('Carl Left')).toBeNull();
    expect(screen.getByText('dora')).toBeInTheDocument();
  });

  it('sends only what changed', async () => {
    renderPanel({ publishingAvailable: true });
    await screen.findByText(text('admin.userApps.settings.shareWith'));

    fireEvent.click(box(text('admin.userApps.capability.upload')));
    await act(async () => {
      fireEvent.click(saveButton());
    });
    // Not the other switches nor the list of connected systems as the panel
    // loaded them: another admin may have changed them since.
    expect(mockApi.saveUserAppSettings).toHaveBeenCalledWith({
      capabilities: { upload: false }
    });

    fireEvent.click(box(text('admin.userApps.settings.allowEveryone')));
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mockApi.saveUserAppSettings).toHaveBeenLastCalledWith({
      sharing: { allowEveryone: true }
    });
  });

  it('changedKeys: the keys that differ, a list as one value, null for none', () => {
    expect(changedKeys({ a: 1, b: [1], c: true }, { a: 1, b: [1, 2], c: false })).toEqual({
      b: [1],
      c: true
    });
    expect(changedKeys({ a: [{ id: 'x' }] }, { a: [{ id: 'x' }] })).toBeNull();
    expect(changedKeys(undefined, { a: 1 })).toBeNull();
  });

  it('refuses a limit that is no whole number in the range', async () => {
    renderPanel();
    await screen.findByText(text('admin.userApps.settings.shareWith'));

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-1' } });
    expect(screen.getByRole('spinbutton')).toHaveAttribute('aria-invalid', 'true');
    // The bar is there, but Save refuses and says why; nothing is sent.
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(screen.getByTestId('save-bar-message')).toHaveTextContent(
      'Enter a whole number for the limit'
    );
    expect(mockApi.saveUserAppSettings).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mockApi.saveUserAppSettings).toHaveBeenCalledWith({ limits: { maxAppsPerUser: 0 } });
  });

  it('lists a stored installation that is gone, so its functions can be removed', async () => {
    mockApi.fetchUserAppSettings.mockResolvedValue(
      settings({
        capabilities: {
          ...settings().capabilities,
          integrations: [{ id: 'old-crm', actions: ['findContact'] }]
        }
      })
    );
    renderPanel();
    await screen.findByText(text('admin.userApps.settings.shareWith'));

    fireEvent.click(screen.getByRole('button', { name: text('admin.userApps.settings.choose') }));
    const gone = (await screen.findByText('old-crm', { selector: 'legend' })).closest('fieldset');
    fireEvent.click(within(gone).getByRole('checkbox', { name: 'findContact' }));
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mockApi.saveUserAppSettings).toHaveBeenCalledWith({
      capabilities: { integrations: [] }
    });
  });

  it('shows the publishing switch disabled with a note until publishing is available', async () => {
    mockApi.fetchUserAppSettings.mockResolvedValue(
      settings({ sharing: { ...settings().sharing, allowPublish: true } })
    );
    renderPanel({ publishingAvailable: false });
    await screen.findByText(text('admin.userApps.settings.shareWith'));

    const publish = box(text('admin.userApps.settings.allowPublish'));
    expect(publish).toBeDisabled();
    expect(publish).not.toBeChecked();
    expect(screen.getByText(text('admin.userApps.settings.notAvailable'))).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: text('admin.userApps.settings.adminEnablesAlways') })
    ).toBeNull();
    // The build says so until P12 has registered the publish routes.
    expect(typeof PUBLISHING_AVAILABLE).toBe('boolean');
  });

  it('is not shown to someone who is no full admin', async () => {
    mockApi.fetchUserAppSettings.mockRejectedValue({ response: { status: 403 } });
    const { container } = renderPanel();
    await waitFor(() => expect(mockApi.fetchUserAppSettings).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('details')).toBeNull());
  });
});

describe('the group page', () => {
  it('has the two checkboxes beside the project ones, with their hints', () => {
    const onChange = jest.fn();
    const group = {
      id: 'hr',
      name: 'HR',
      permissions: { projects: true, projectSharing: false, userApps: false, userAppSharing: true }
    };
    render(<GroupFormEditor value={group} onChange={onChange} onValidationChange={() => {}} />);

    const boxes = screen.getAllByRole('checkbox').map(entry => entry.id);
    const projects = boxes.indexOf('group-permission-project-sharing');
    expect(boxes.slice(projects, projects + 3)).toEqual([
      'group-permission-project-sharing',
      'group-permission-user-apps',
      'group-permission-user-app-sharing'
    ]);
    const create = screen.getByRole('checkbox', { name: en.admin.userApps.groups.userApps });
    const share = screen.getByRole('checkbox', { name: en.admin.userApps.groups.userAppSharing });
    expect(create).not.toBeChecked();
    expect(share).toBeChecked();
    expect(create).toHaveAccessibleDescription(en.admin.userApps.groups.userAppsHint);
    expect(share).toHaveAccessibleDescription(en.admin.userApps.groups.userAppSharingHint);

    fireEvent.click(create);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permissions: expect.objectContaining({ userApps: true, userAppSharing: true })
      })
    );
    fireEvent.click(share);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissions: expect.objectContaining({ userAppSharing: false }) })
    );
  });
});

describe('the user page', () => {
  const USERS = {
    data: { users: { anna: { id: 'anna', username: 'anna', name: 'Anna Schmidt', active: true } } }
  };
  const renderUserPage = () =>
    renderAt(
      '/admin/users/anna/view',
      <Route path="/admin/users/:userId/view" element={<AdminUserViewPage />} />
    );

  beforeEach(() => {
    mockApi.makeAdminApiCall.mockImplementation(async url =>
      url.startsWith('/admin/oauth/connections') ? { data: { items: [] } } : USERS
    );
  });

  it('has the count with a link to the apps of the person', async () => {
    mockApi.fetchAdminUserApps.mockResolvedValue([RESEARCH, { ...RECAP, owner: RESEARCH.owner }]);
    renderUserPage();

    const link = await screen.findByRole('link', {
      name: text('admin.userApps.user.count', { count: 2, shared: 1 })
    });
    expect(link).toHaveAttribute('href', '/admin/apps?tab=personal&owner=anna');
    expect(mockApi.fetchAdminUserApps).toHaveBeenCalledWith({ ownerId: 'anna' });
  });

  it('blocks the owner: the person is added to the list as it is stored now', async () => {
    mockApi.fetchAdminUserApps.mockResolvedValue([RESEARCH]);
    mockApi.fetchUserAppSettings
      .mockResolvedValueOnce(settings())
      // Someone else was blocked in the meantime.
      .mockResolvedValueOnce(settings({ blockedOwners: ['carl'] }));
    renderUserPage();

    fireEvent.click(await screen.findByRole('button', { name: text('admin.userApps.user.block') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(text('admin.userApps.user.blockBody'));
    expect(mockApi.saveUserAppSettings).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole('button', { name: text('admin.userApps.disable.action') })
    );

    await waitFor(() =>
      expect(mockApi.saveUserAppSettings).toHaveBeenCalledWith({ blockedOwners: ['carl', 'anna'] })
    );
    expect(await screen.findByText(text('admin.userApps.user.blocked'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: text('admin.userApps.user.block') })).toBeNull();
  });

  it('says so when the person is blocked already', async () => {
    mockApi.fetchAdminUserApps.mockResolvedValue([]);
    mockApi.fetchUserAppSettings.mockResolvedValue(settings({ blockedOwners: ['anna'] }));
    mockEnv.platformConfig = { featuresMap: { userApps: false } };
    renderUserPage();

    expect(await screen.findByText(text('admin.userApps.user.blocked'))).toBeInTheDocument();
  });

  it('shows nothing with the feature off for a person without personal apps', async () => {
    mockApi.fetchAdminUserApps.mockResolvedValue([]);
    mockEnv.platformConfig = { featuresMap: { userApps: false } };
    renderUserPage();

    await screen.findByRole('heading', { name: 'Anna Schmidt' });
    await waitFor(() => expect(mockApi.fetchUserAppSettings).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: text('admin.userApps.user.block') })).toBeNull();
    expect(screen.queryByText(text('admin.userApps.tab'))).toBeNull();
  });

  it('shows nothing to someone who may not read personal apps', async () => {
    mockApi.fetchAdminUserApps.mockRejectedValue({ response: { status: 403 } });
    renderUserPage();

    await screen.findByRole('heading', { name: 'Anna Schmidt' });
    await waitFor(() => expect(mockApi.fetchAdminUserApps).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: text('admin.userApps.user.block') })).toBeNull();
  });
});
