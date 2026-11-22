// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import en from '../../../shared/i18n/en.json';

/**
 * Personal apps on the apps page (concept 02-personal-apps, 11.2) and the two
 * routes of 11.1:
 *
 * - with the feature off the page is the one it was and asks nothing new of
 *   the server;
 * - with it on, `useApps` returns one list of admin and personal apps, the
 *   scope chips filter it, a personal tile says whose it is and, for the
 *   owner, which state it is in, and "New app" needs `canCreate`;
 * - `/apps/new` is the create page only for a viewer who may create, and
 *   `/apps/:appId/edit` exists only with the feature.
 *
 * The texts are the English texts of `shared/i18n/en.json`, so a key that is
 * missing there shows up here as its key.
 */

const mockApi = {
  fetchApps: jest.fn(),
  fetchUserApps: jest.fn(),
  fetchUserAppsConfig: jest.fn(),
  deleteUserApp: jest.fn(),
  duplicateUserApp: jest.fn(),
  leaveUserApp: jest.fn()
};
jest.mock('../../../client/src/api', () =>
  Object.fromEntries(
    [
      'fetchApps',
      'fetchUserApps',
      'fetchUserAppsConfig',
      'deleteUserApp',
      'duplicateUserApp',
      'leaveUserApp'
    ].map(name => [name, (...args) => mockApi[name](...args)])
  )
);

const mockState = {
  uiConfig: {},
  resetHeaderColor: () => {},
  features: { userApps: false },
  auth: { user: { id: 'me', name: 'Me' }, isAuthenticated: true, isLoading: false }
};
jest.mock('../../../client/src/shared/contexts/platformConfigContextValue', () => ({
  usePlatformConfig: () => ({
    platformConfig: { featuresMap: mockState.features },
    isLoading: false
  })
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => mockState.auth,
  useViewerKey: () =>
    mockState.auth.isLoading
      ? null
      : `${mockState.auth.isAuthenticated ? 'auth' : 'anon'}:${mockState.auth.user?.id ?? ''}`
}));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => mockState.auth
}));
jest.mock('../../../client/src/shared/hooks/useFavorites', () => ({
  __esModule: true,
  default: () => ({ favorites: [], isFavorite: () => false, toggleFavorite: jest.fn() })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({
    resetHeaderColor: mockState.resetHeaderColor,
    uiConfig: mockState.uiConfig
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock(
  '../../../client/src/features/nextcloud-embed/components/NextcloudSelectionBanner',
  () => ({ __esModule: true, default: () => null })
);
jest.mock('../../../client/src/features/apps/hooks/usePendingDocumentCheck', () => ({
  __esModule: true,
  default: () => ({ status: 'idle', info: null, title: '' })
}));
jest.mock('../../../client/src/pages/error/NotFound', () => ({
  __esModule: true,
  default: () => <div data-testid="not-found" />
}));

/** `t` over the English locale file: a missing key reads as the key. */
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const found = key.split('.').reduce((node, part) => node?.[part], mockLocale.en);
  const fallback =
    typeof defaultOrOptions === 'string' ? defaultOrOptions : options.defaultValue || key;
  const text = typeof found === 'string' ? found : fallback;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
    text
  );
};
const mockLocale = { en };
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const AppsList = require('../../../client/src/features/apps/pages/AppsList').default;
const { invalidateAppsCache } = require('../../../client/src/shared/hooks/appsCache');
const { invalidateUserAppsConfig } = require('../../../client/src/shared/hooks/useUserApps');
const UserAppsRoute = require('../../../client/src/features/apps/components/UserAppsRoute').default;
const {
  userAppBadgeText,
  userAppScope
} = require('../../../client/src/features/apps/components/UserAppBadge');

const uap = n => `uap_${String(n).repeat(32).slice(0, 32)}`;
const OWNER = { canView: true, canUse: true, canEdit: true, canShare: true, canDelete: true };
const permissions = (role, extra = {}) => ({
  canView: true,
  canUse: true,
  canEdit: false,
  canShare: false,
  canDelete: false,
  isOwner: role === 'owner',
  role,
  suspended: null,
  ...(role === 'owner' ? OWNER : {}),
  ...extra
});
const personalApp = (n, name, role, extra = {}) => ({
  id: uap(n),
  ownership: 'user',
  name: { de: name },
  description: { de: `${name} description` },
  icon: 'sparkles',
  color: '#4F46E5',
  owner: role === 'owner' ? { id: 'me', name: 'Me' } : { id: 'anna', name: 'Anna Schmidt' },
  permissions: permissions(role),
  state: 'active',
  disabled: null,
  ...extra
});

const ADMIN_APPS = [
  { id: 'chat', name: { en: 'Chat' }, description: { en: 'General chat' } },
  { id: 'translator', name: { en: 'Translator' }, description: { en: 'Translates' } }
];
const MINE = personalApp(1, 'Job ad writer', 'owner');
// Shared with the viewer by name: the share can be left.
const SHARED = personalApp(2, 'Reply to a customer', 'user', {
  permissions: permissions('user', { canLeave: true })
});
const OFFERED = personalApp(3, 'Meeting notes', 'offered', {
  permissions: permissions('offered', { canAcceptOffer: true })
});
const PROMOTED = personalApp(4, 'Glossary', 'owner', {
  state: 'promoted',
  publishedAs: { appId: 'glossary' }
});
const DISABLED = personalApp(5, 'Risky helper', 'owner', {
  permissions: permissions('owner', { canUse: false, canEdit: false, readOnly: true }),
  disabled: { at: '2026-11-20T10:00:00Z', reason: 'Under review' }
});
const HANDING_OVER = personalApp(6, 'Onboarding guide', 'owner', {
  pendingOwner: { id: 'ben', name: 'Ben Koch' }
});
const PERSONAL = [MINE, SHARED, OFFERED, PROMOTED, DISABLED, HANDING_OVER];
const CONFIG = {
  enabled: true,
  canCreate: true,
  canShare: true,
  canPublish: false,
  maxApps: 20,
  used: 4
};

function Where() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

const renderList = () =>
  render(
    <MemoryRouter initialEntries={['/apps']}>
      <Routes>
        <Route path="/apps" element={<AppsList />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

const tile = name => screen.getByRole('button', { name }).closest('[role="listitem"]');
const tileNames = () =>
  screen
    .queryAllByRole('listitem')
    .map(item => within(item).getAllByRole('button')[0].getAttribute('aria-label'));

beforeEach(() => {
  invalidateAppsCache();
  invalidateUserAppsConfig();
  Object.values(mockApi).forEach(mock => mock.mockReset());
  mockApi.fetchApps.mockResolvedValue(ADMIN_APPS);
  mockApi.fetchUserApps.mockResolvedValue(PERSONAL);
  mockApi.fetchUserAppsConfig.mockResolvedValue(CONFIG);
  mockState.features = { userApps: true };
  mockState.uiConfig = {};
  mockState.auth = { user: { id: 'me', name: 'Me' }, isAuthenticated: true, isLoading: false };
});

describe('with the feature off', () => {
  beforeEach(() => {
    mockState.features = { userApps: false };
  });

  test('the page is the one it was and sends no new request', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Chat' });

    expect(tileNames()).toEqual(['Chat', 'Translator']);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText('New app')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-app-badge')).not.toBeInTheDocument();
    expect(mockApi.fetchApps).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchUserApps).not.toHaveBeenCalled();
    expect(mockApi.fetchUserAppsConfig).not.toHaveBeenCalled();
  });

  test('a missing feature entry reads as off', async () => {
    mockState.features = {};
    renderList();
    await screen.findByRole('button', { name: 'Chat' });
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(mockApi.fetchUserApps).not.toHaveBeenCalled();
  });

  test('an installation without apps still shows the "no apps" page', async () => {
    mockApi.fetchApps.mockResolvedValue([]);
    renderList();
    expect(await screen.findByText('No apps available from server')).toBeInTheDocument();
  });
});

test('an anonymous viewer gets the old page although the feature is on', async () => {
  mockState.auth = { user: { id: 'anonymous' }, isAuthenticated: false, isLoading: false };
  renderList();
  await screen.findByRole('button', { name: 'Chat' });
  expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  expect(mockApi.fetchUserApps).not.toHaveBeenCalled();
  expect(mockApi.fetchUserAppsConfig).not.toHaveBeenCalled();
});

describe('with the feature on', () => {
  test('one list of admin and personal apps, loaded with scope "personal"', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });

    expect(mockApi.fetchApps).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchUserApps).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchUserApps).toHaveBeenCalledWith({ scope: 'personal' });
    // "All": every admin app and every personal app the viewer can use. The
    // switched-off app is listed under "My apps" only.
    expect(tileNames().sort()).toEqual(
      [
        'Chat',
        'Translator',
        'Job ad writer',
        'Reply to a customer',
        'Meeting notes',
        'Glossary',
        'Onboarding guide'
      ].sort()
    );
  });

  test('a failing personal list leaves the admin apps in place', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockApi.fetchUserApps.mockRejectedValue(new Error('boom'));
    renderList();
    await screen.findByRole('button', { name: 'Chat' });
    expect(tileNames()).toEqual(['Chat', 'Translator']);
    quiet.mockRestore();
  });

  test('the chips are a radiogroup with the counts of both scopes', async () => {
    renderList();
    const group = await screen.findByRole('radiogroup');
    const chips = within(group).getAllByRole('radio');
    expect(chips.map(chip => chip.textContent)).toEqual(['All', 'My apps 5', 'Shared with me 1']);
    expect(chips[0]).toHaveAttribute('aria-checked', 'true');
    expect(chips[1]).toHaveAttribute('aria-checked', 'false');
  });

  test('a personal tile says "Mine", "Offered to you" or the owner\'s name; an admin tile says nothing', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });

    expect(within(tile('Job ad writer')).getByTestId('user-app-badge')).toHaveTextContent('Mine');
    expect(within(tile('Reply to a customer')).getByTestId('user-app-badge')).toHaveTextContent(
      'Anna Schmidt'
    );
    expect(within(tile('Meeting notes')).getByTestId('user-app-badge')).toHaveTextContent(
      'Offered to you'
    );
    expect(within(tile('Chat')).queryByTestId('user-app-badge')).not.toBeInTheDocument();
  });

  test('"My apps" shows the owned apps with their state, and the app offered to the viewer', async () => {
    renderList();
    fireEvent.click(await screen.findByTestId('apps-scope-mine'));

    await waitFor(() =>
      expect(tileNames().sort()).toEqual(
        ['Job ad writer', 'Meeting notes', 'Glossary', 'Risky helper', 'Onboarding guide'].sort()
      )
    );
    const badge = name => within(tile(name)).getByTestId('user-app-badge');
    expect(badge('Job ad writer')).toHaveTextContent('Mine');
    expect(badge('Glossary')).toHaveTextContent('Now with the administrators');
    expect(badge('Risky helper')).toHaveTextContent('Switched off by an administrator');
    expect(badge('Onboarding guide')).toHaveTextContent('Offered to Ben Koch');
    expect(badge('Meeting notes')).toHaveTextContent('Offered to you');
    expect(screen.getByTestId('apps-scope-mine')).toHaveAttribute('aria-checked', 'true');
  });

  test('"Shared with me" shows the apps of other people only', async () => {
    renderList();
    fireEvent.click(await screen.findByTestId('apps-scope-shared'));
    await waitFor(() => expect(tileNames()).toEqual(['Reply to a customer']));
  });

  test('the arrow keys move through the chips', async () => {
    renderList();
    const all = await screen.findByTestId('apps-scope-all');
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(screen.getByTestId('apps-scope-mine')).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByTestId('apps-scope-mine'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('apps-scope-all')).toHaveAttribute('aria-checked', 'true');
  });

  test('"New app" appears only with canCreate and opens /apps/new', async () => {
    const first = renderList();
    fireEvent.click(await screen.findByTestId('user-app-new'));
    expect(await screen.findByTestId('location')).toHaveTextContent('/apps/new');
    first.unmount();

    invalidateUserAppsConfig();
    mockApi.fetchUserAppsConfig.mockResolvedValue({ ...CONFIG, canCreate: false });
    renderList();
    await screen.findByRole('radiogroup');
    await waitFor(() => expect(mockApi.fetchUserAppsConfig).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('user-app-new')).not.toBeInTheDocument();
  });

  test('at the limit "New app" does nothing and the page says why', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({ ...CONFIG, maxApps: 4, used: 4 });
    renderList();
    const button = await screen.findByTestId('user-app-new');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByText('You have 4 apps, which is the limit. Delete one to create a new one.')
    ).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
  });

  test('an empty "My apps" explains what an app is, offers "New app" and names the limit of personal apps', async () => {
    mockApi.fetchUserApps.mockResolvedValue([SHARED]);
    renderList();
    fireEvent.click(await screen.findByTestId('apps-scope-mine'));

    const empty = await screen.findByTestId('user-apps-empty');
    expect(empty).toHaveTextContent('You have no apps of your own yet.');
    expect(within(empty).getByRole('button', { name: 'New app' })).toBeInTheDocument();
    expect(empty).toHaveTextContent('An app of your own cannot use a document collection yet.');
  });

  test('an empty "Shared with me" says so, without a button', async () => {
    mockApi.fetchUserApps.mockResolvedValue([MINE]);
    renderList();
    fireEvent.click(await screen.findByTestId('apps-scope-shared'));
    const empty = await screen.findByTestId('user-apps-empty');
    expect(empty).toHaveTextContent('Nobody has shared an app with you yet.');
    expect(within(empty).queryByRole('button')).not.toBeInTheDocument();
  });

  test('an installation without admin apps still offers the chips and "New app"', async () => {
    mockApi.fetchApps.mockResolvedValue([]);
    mockApi.fetchUserApps.mockResolvedValue([]);
    renderList();
    expect(await screen.findByRole('radiogroup')).toBeInTheDocument();
    expect(await screen.findByTestId('user-app-new')).toBeInTheDocument();
  });

  test('a personal app has no category: it is not filed under "utility"', async () => {
    mockState.uiConfig = {
      appsList: {
        categories: {
          enabled: true,
          showAll: true,
          list: [
            { id: 'all', name: { en: 'Every category' } },
            { id: 'utility', name: { en: 'Utility' } },
            { id: 'writing', name: { en: 'Writing' } }
          ]
        }
      }
    };
    mockApi.fetchApps.mockResolvedValue([ADMIN_APPS[0], { ...ADMIN_APPS[1], category: 'writing' }]);
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });

    fireEvent.click(screen.getByRole('button', { name: 'Utility' }));
    await waitFor(() => expect(tileNames()).toEqual(['Chat']));

    // Categories belong to the admin apps: under a personal scope there are no pills.
    fireEvent.click(screen.getByTestId('apps-scope-mine'));
    await waitFor(() => expect(tileNames()).toContain('Job ad writer'));
    expect(screen.queryByRole('button', { name: 'Utility' })).not.toBeInTheDocument();
  });

  test('the menu of a tile offers what the permissions allow', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });

    fireEvent.click(
      within(tile('Job ad writer')).getByRole('button', { name: 'Actions for "Job ad writer"' })
    );
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Edit',
      'Share',
      'Duplicate',
      'Delete'
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(`/apps/${MINE.id}/edit`);
  });

  test('a member with "Can use" gets Duplicate and Leave, and no menu on an admin tile', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Reply to a customer' });

    expect(within(tile('Chat')).queryByRole('button', { name: /^Actions for/ })).toBeNull();
    fireEvent.click(
      within(tile('Reply to a customer')).getByRole('button', {
        name: 'Actions for "Reply to a customer"'
      })
    );
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Duplicate',
      'Leave'
    ]);
    mockApi.leaveUserApp.mockResolvedValue(undefined);
    mockApi.fetchUserApps.mockResolvedValue([MINE]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave' }));
    await waitFor(() => expect(mockApi.leaveUserApp).toHaveBeenCalledWith(SHARED.id));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reply to a customer' })).toBeNull()
    );
  });

  test('a member through a group or everyone gets no Leave: the server cannot remove that', async () => {
    mockApi.fetchUserApps.mockResolvedValue([
      { ...SHARED, permissions: permissions('user', { canLeave: false }) }
    ]);
    renderList();
    await screen.findByRole('button', { name: 'Reply to a customer' });
    fireEvent.click(
      within(tile('Reply to a customer')).getByRole('button', {
        name: 'Actions for "Reply to a customer"'
      })
    );
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Duplicate']);
  });

  test('a refused Leave is worded from its reason, not with the English sentence', async () => {
    mockApi.leaveUserApp.mockRejectedValue({
      originalError: {
        response: {
          status: 409,
          data: {
            code: 'CONFLICT',
            detail: 'The app is not shared with you directly',
            details: { reason: 'noDirectShare' }
          }
        }
      }
    });
    renderList();
    await screen.findByRole('button', { name: 'Reply to a customer' });
    fireEvent.click(
      within(tile('Reply to a customer')).getByRole('button', {
        name: 'Actions for "Reply to a customer"'
      })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.userApps.conflict.noDirectShare);
  });

  test('the receiver of an offer reaches it from the tile and from the menu', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Meeting notes' });
    fireEvent.click(
      within(tile('Meeting notes')).getByRole('button', { name: 'Actions for "Meeting notes"' })
    );
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toContain('View offer');
    fireEvent.click(screen.getByRole('menuitem', { name: 'View offer' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(`/apps/${OFFERED.id}/edit`);
  });

  test('the tile of an offered app opens the editor with the offer, not the chat', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Meeting notes' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(`/apps/${OFFERED.id}/edit`);
  });

  test('an open menu is not covered by the trigger of the next tile', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });
    const trigger = within(tile('Job ad writer')).getByRole('button', {
      name: 'Actions for "Job ad writer"'
    });
    // No z-index on the wrapper of a tile's menu: it would trap the open menu in a
    // stacking context under the wrapper of the next tile.
    const wrapper = trigger.parentElement.parentElement;
    expect(wrapper.className).not.toMatch(/\bz-\d+/);
    expect(trigger.parentElement.className).not.toMatch(/\bz-\d+/);
    fireEvent.click(trigger);
    expect(trigger.parentElement).toHaveClass('z-30');
  });

  test('Duplicate says what it did and moves the focus to the copy', async () => {
    const COPY = personalApp(7, 'Job ad writer (copy)', 'owner');
    mockApi.duplicateUserApp.mockResolvedValue(COPY);
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });
    mockApi.fetchUserApps.mockResolvedValue([...PERSONAL, COPY]);
    fireEvent.click(
      within(tile('Job ad writer')).getByRole('button', { name: 'Actions for "Job ad writer"' })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(screen.getByTestId('user-apps-status')).toHaveTextContent(
        'App "Job ad writer (copy)" created'
      )
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Job ad writer (copy)' })).toHaveFocus()
    );
  });

  test('Leave says what it did and moves the focus to the selected scope', async () => {
    mockApi.leaveUserApp.mockResolvedValue(undefined);
    renderList();
    await screen.findByRole('button', { name: 'Reply to a customer' });
    mockApi.fetchUserApps.mockResolvedValue(PERSONAL.filter(app => app !== SHARED));
    fireEvent.click(
      within(tile('Reply to a customer')).getByRole('button', {
        name: 'Actions for "Reply to a customer"'
      })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave' }));
    await waitFor(() =>
      expect(screen.getByTestId('user-apps-status')).toHaveTextContent(
        'You left "Reply to a customer".'
      )
    );
    await waitFor(() => expect(screen.getByTestId('apps-scope-all')).toHaveFocus());
  });

  test('Delete asks first, deletes, and reloads the list', async () => {
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });
    fireEvent.click(
      within(tile('Job ad writer')).getByRole('button', { name: 'Actions for "Job ad writer"' })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete "Job ad writer"?');
    expect(dialog).toHaveTextContent('Chats stay in the chat history and cannot be continued.');
    expect(mockApi.deleteUserApp).not.toHaveBeenCalled();

    mockApi.deleteUserApp.mockResolvedValue(undefined);
    mockApi.fetchUserApps.mockResolvedValue(PERSONAL.filter(app => app !== MINE));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.deleteUserApp).toHaveBeenCalledWith(MINE.id));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Job ad writer' })).toBeNull());
    expect(mockApi.fetchUserApps).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('user-apps-status')).toHaveTextContent('"Job ad writer" deleted.');
  });

  test("a refused duplicate shows the server's reason", async () => {
    mockApi.duplicateUserApp.mockRejectedValue({
      originalError: {
        response: { status: 409, data: { code: 'QUOTA_USER_APPS', detail: 'limit' } }
      }
    });
    renderList();
    await screen.findByRole('button', { name: 'Job ad writer' });
    fireEvent.click(
      within(tile('Job ad writer')).getByRole('button', { name: 'Actions for "Job ad writer"' })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The limit of personal apps is reached.'
    );
  });
});

describe('the words of a tile', () => {
  const t = mockT;
  test.each([
    [MINE, 'Mine'],
    [SHARED, 'Anna Schmidt'],
    [OFFERED, 'Offered to you'],
    // Offered to a person the app is already shared with: the share keeps its role.
    [{ ...SHARED, permissions: { ...SHARED.permissions, canAcceptOffer: true } }, 'Offered to you'],
    [PROMOTED, 'Now with the administrators'],
    [{ ...PROMOTED, state: 'retired' }, 'Now with the administrators'],
    [DISABLED, 'Switched off by an administrator'],
    [HANDING_OVER, 'Offered to Ben Koch']
  ])('%#', (app, text) => {
    expect(userAppBadgeText(app, t)).toBe(text);
  });

  test('the scope of an app comes from the permissions the server sent', () => {
    expect(userAppScope(MINE)).toBe('mine');
    expect(userAppScope(OFFERED)).toBe('mine');
    expect(userAppScope(SHARED)).toBe('shared');
    expect(
      userAppScope({ ...SHARED, permissions: { ...SHARED.permissions, canAcceptOffer: true } })
    ).toBe('mine');
    expect(userAppScope(ADMIN_APPS[0])).toBeNull();
  });
});

describe('the routes of personal apps', () => {
  const Create = () => <div data-testid="create-page" />;
  const Edit = () => <div data-testid="edit-page" />;
  const Chat = () => <div data-testid="chat-of-app" />;
  const renderAt = path =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="apps/:appId"
            element={<UserAppsRoute page="create" component={Create} fallback={<Chat />} />}
          />
          <Route path="apps/:appId/edit" element={<UserAppsRoute page="edit" component={Edit} />} />
        </Routes>
      </MemoryRouter>
    );

  test('/apps/new is the create page for a viewer who may create', async () => {
    renderAt('/apps/new');
    expect(await screen.findByTestId('create-page')).toBeInTheDocument();
  });

  test('the chat of "new" is never mounted for a viewer who may create, also when the sign-in lands late', async () => {
    let chatMounts = 0;
    const CountingChat = () => {
      chatMounts += 1;
      return <div data-testid="chat-of-app" />;
    };
    const tree = () => (
      <MemoryRouter initialEntries={['/apps/new']}>
        <Routes>
          <Route
            path="apps/:appId"
            element={<UserAppsRoute page="create" component={Create} fallback={<CountingChat />} />}
          />
        </Routes>
      </MemoryRouter>
    );
    // The sign-in is still loading on the first render; the gate opens one render later, and
    // the request for the configuration starts one render after that.
    const signedIn = mockState.auth;
    mockState.auth = { user: null, isAuthenticated: false, isLoading: true };
    const view = render(tree());
    mockState.auth = signedIn;
    view.rerender(tree());
    expect(await screen.findByTestId('create-page')).toBeInTheDocument();
    // A mounted chat would ask the server for an app with the ID "new".
    expect(chatMounts).toBe(0);
  });

  test('/apps/new is the chat of the app "new" for a viewer who may not create', async () => {
    mockApi.fetchUserAppsConfig.mockResolvedValue({ ...CONFIG, canCreate: false });
    renderAt('/apps/new');
    expect(await screen.findByTestId('chat-of-app')).toBeInTheDocument();
  });

  test('with the feature off /apps/new is the chat and nothing is asked', async () => {
    mockState.features = { userApps: false };
    renderAt('/apps/new');
    expect(await screen.findByTestId('chat-of-app')).toBeInTheDocument();
    expect(mockApi.fetchUserAppsConfig).not.toHaveBeenCalled();
  });

  test('any other app ID goes straight to the chat, without a request', async () => {
    renderAt(`/apps/${uap(1)}`);
    expect(await screen.findByTestId('chat-of-app')).toBeInTheDocument();
    expect(mockApi.fetchUserAppsConfig).not.toHaveBeenCalled();
  });

  test('the chat stays mounted when its first message moves the address to /apps/<id>/c/<chat>', async () => {
    // A second mount would drop the turn that is running at that moment.
    const { useNavigate } = require('react-router-dom');
    let chatMounts = 0;
    const NavigatingChat = () => {
      const navigate = useNavigate();
      const [mountNumber] = require('react').useState(() => (chatMounts += 1));
      return (
        <button type="button" onClick={() => navigate('/apps/helper/c/chat-1')}>
          chat mount {mountNumber}
        </button>
      );
    };
    render(
      <MemoryRouter initialEntries={['/apps/helper']}>
        <Routes>
          <Route
            path="apps/:appId"
            element={
              <UserAppsRoute page="create" component={Create} fallback={<NavigatingChat />} />
            }
          />
          <Route
            path="apps/:appId/c/:chatId"
            element={<UserAppsRoute page="chat" fallback={<NavigatingChat />} />}
          />
        </Routes>
        <Where />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'chat mount 1' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/apps/helper/c/chat-1')
    );
    expect(screen.getByRole('button', { name: 'chat mount 1' })).toBeInTheDocument();
    expect(chatMounts).toBe(1);
  });

  test('/apps/<id>/edit is the editor with the feature on and the 404 page with it off', async () => {
    const on = renderAt(`/apps/${uap(1)}/edit`);
    expect(await screen.findByTestId('edit-page')).toBeInTheDocument();
    on.unmount();

    mockState.features = { userApps: false };
    renderAt(`/apps/${uap(1)}/edit`);
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });

  test('an anonymous viewer gets the 404 page at the editor', async () => {
    mockState.auth = { user: null, isAuthenticated: false, isLoading: false };
    renderAt(`/apps/${uap(1)}/edit`);
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });
});
