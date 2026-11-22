// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Publishing a personal app, as its owner and as an administrator see it
 * (slice P12 of concepts/app-builder-rework-2026-11/02-personal-apps.md,
 * sections 11.6 and 11.9):
 *
 * - "Publish" in the editor menu, only when the server says `canPublish`;
 * - the two forms of the owner's dialog, chosen and filled by the server;
 * - `If-Match` on the publish, and the line for a change by someone else;
 * - the banner of an app that waits for an administrator, and the pointer
 *   page of a retired app;
 * - the admin's take-over dialog with every action and every skill;
 * - the line about waiting apps on the "Apps" tab of the admin area.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  APP_ID,
  CONFIG,
  EDITOR_PERMISSIONS,
  apiFailure,
  createTexts,
  en,
  untranslated,
  userApp
} from './helpers/userAppEditorHarness';

const mockApi = {};
jest.mock('../../../client/src/api', () =>
  Object.fromEntries(
    [
      'acceptUserAppOffer',
      'clearUserAppOffer',
      'deleteUserApp',
      'duplicateUserApp',
      'fetchModels',
      'fetchUserApp',
      'fetchUserAppShareTargets',
      'offerUserApp',
      'publishUserApp',
      'setUserAppMembers',
      'updateUserApp',
      'fetchPromptShareTargets',
      'updatePromptShares',
      'fetchUIConfig'
    ].map(name => [
      name,
      (...args) => {
        mockApi[name] ||= jest.fn();
        return mockApi[name](...args);
      }
    ])
  )
);

const mockAdmin = {
  createAdminApp: jest.fn(),
  fetchAdminApps: jest.fn(),
  fetchAppIntegrationStatus: jest.fn(),
  reorderApps: jest.fn(),
  toggleApps: jest.fn(),
  makeAdminApiCall: jest.fn(),
  fetchAdminUserApps: jest.fn(),
  fetchAdminUserApp: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  createAdminApp: (...args) => mockAdmin.createAdminApp(...args),
  fetchAdminApps: (...args) => mockAdmin.fetchAdminApps(...args),
  fetchAppIntegrationStatus: (...args) => mockAdmin.fetchAppIntegrationStatus(...args),
  reorderApps: (...args) => mockAdmin.reorderApps(...args),
  toggleApps: (...args) => mockAdmin.toggleApps(...args),
  makeAdminApiCall: (...args) => mockAdmin.makeAdminApiCall(...args),
  fetchAdminUserApps: (...args) => mockAdmin.fetchAdminUserApps(...args),
  fetchAdminUserApp: (...args) => mockAdmin.fetchAdminUserApp(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: jest.fn().mockResolvedValue([]),
  fetchInstalledIntegration: jest.fn().mockResolvedValue(null)
}));

const mockUserApps = { config: null };
jest.mock('../../../client/src/shared/hooks/useUserApps', () => ({
  useUserAppsConfig: () => ({ enabled: true, config: mockUserApps.config, loading: false }),
  invalidateUserAppsConfig: () => {}
}));
const mockApps = { invalidated: 0 };
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  invalidateAppsCache: () => {
    mockApps.invalidated += 1;
  }
}));

// What the admin pages read about the installation and the person.
const mockEnv = { platformConfig: {}, user: null };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockEnv.platformConfig, refreshConfig: () => {} })
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => (mockEnv.user ? { user: mockEnv.user } : null)
}));

jest.mock('../../../client/src/features/admin/components/AppTestPanel', () => ({
  __esModule: true,
  default: () => <aside data-testid="test-panel">test chat</aside>
}));
jest.mock('../../../client/src/pages/error/NotFound', () => ({
  __esModule: true,
  default: () => <div data-testid="not-found">not found</div>
}));
// runtimeBasePath and Icon use `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: p => p,
  buildAssetUrl: p => p
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

const mockTexts = createTexts();
jest.mock('react-i18next', () => ({
  useTranslation: () => mockTexts.translation
}));

const UserAppEditPage = require('../../../client/src/features/apps/pages/UserAppEditPage').default;
const PublishDialog =
  require('../../../client/src/features/apps/components/user-app/PublishDialog').default;
const RetiredAppPage =
  require('../../../client/src/features/apps/components/RetiredAppPage').default;
const UserAppTakeOverDialog =
  require('../../../client/src/features/admin/components/UserAppTakeOverDialog').default;
const WaitingAppsNotice =
  require('../../../client/src/features/admin/components/WaitingAppsNotice').default;
const AdminAppsPage = require('../../../client/src/features/admin/pages/AdminAppsPage').default;
const {
  capabilityLines,
  droppedText
} = require('../../../client/src/features/apps/components/user-app/publishText');

const PUBLISH = en.userApps.publish;
const t = (key, options) => mockTexts.instance.t(key, options);

beforeAll(async () => {
  await mockTexts.init();
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of Object.keys(mockApi)) delete mockApi[name];
  mockApi.fetchModels = jest.fn().mockResolvedValue([]);
  mockApi.fetchUserApp = jest.fn();
  mockApi.publishUserApp = jest.fn();
  mockApi.fetchUIConfig = jest.fn().mockResolvedValue({});
  mockUserApps.config = { ...CONFIG, canPublish: true };
  mockApps.invalidated = 0;
  mockEnv.user = null;
  mockEnv.platformConfig = { featuresMap: { userApps: true } };
  mockAdmin.fetchAdminApps.mockResolvedValue([]);
  mockAdmin.fetchAppIntegrationStatus.mockResolvedValue({});
  mockAdmin.fetchAdminUserApps.mockResolvedValue([]);
  mockAdmin.makeAdminApiCall.mockResolvedValue({ data: {} });
});

function Where({ label }) {
  const location = useLocation();
  return (
    <div data-testid="where">
      {label}:{location.pathname}
      {location.search}
    </div>
  );
}

async function renderEditor() {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[`/apps/${APP_ID}/edit`]}>
        <Routes>
          <Route path="/apps" element={<Where label="LIST" />} />
          <Route path="/apps/:appId" element={<Where label="CHAT" />} />
          <Route
            path="/apps/:appId/edit"
            element={
              <>
                <UserAppEditPage />
                <Where label="EDITOR" />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );
  });
}

async function click(element) {
  await act(async () => {
    fireEvent.click(element);
  });
}
async function openMore() {
  await click(screen.getByRole('button', { name: 'More' }));
  return screen.getAllByRole('menuitem').map(item => item.textContent);
}

/** `publish` of the owner's view for an app without tools. */
const NOW = {
  startsEnabled: true,
  waitsFor: null,
  tools: [],
  capabilities: [{ id: 'upload' }],
  dropped: [],
  plain: false
};
/** … and for an app with web search, a connected system and a skill. */
const LATER = {
  startsEnabled: false,
  waitsFor: 'tools',
  tools: ['webSearch', 'skills', 'integrations'],
  capabilities: [
    { id: 'upload' },
    { id: 'webSearch' },
    { id: 'skills', skills: ['brand-voice', 'tone-check'] },
    {
      id: 'integration:jira-main',
      installationId: 'jira-main',
      name: 'Jira',
      actions: ['searchIssues', 'getIssue']
    }
  ],
  dropped: [{ id: 'integration:sharepoint', reason: 'offOnInstallation', name: 'SharePoint' }],
  plain: false
};

const publishable = (publish, changes = {}) =>
  userApp({ publish, ...changes, permissions: { canPublish: true, ...changes.permissions } });

function renderDialog(app, handlers = {}) {
  const props = {
    onClose: jest.fn(),
    onPublished: jest.fn(),
    onChanged: jest.fn(),
    ...handlers
  };
  render(<PublishDialog app={app} name="Job ad writer" {...props} />);
  return props;
}

describe('the sentences both dialogs share (publishText.js)', () => {
  test('one line per capability, with every action and every skill by name', () => {
    expect(capabilityLines(LATER.capabilities, t).map(line => line.text)).toEqual([
      'take files from users',
      'search the web',
      'use the skills: brand-voice, tone-check',
      'Jira: searchIssues, getIssue'
    ]);
    expect(capabilityLines([{ id: 'model', model: 'gpt-large' }], t)[0].text).toBe(
      'use the AI model gpt-large'
    );
    expect(capabilityLines([], t).map(line => line.id)).toEqual(['none']);
  });

  test('what is left behind, with the reason; the owner reads "you"', () => {
    const dropped = [
      { id: 'integration:sharepoint', reason: 'offOnInstallation', name: 'SharePoint' },
      { id: 'webSearch', reason: 'ownerMayNot' }
    ];
    expect(droppedText(dropped, t)).toBe(
      'SharePoint (no longer allowed for personal apps), Web search (the owner may not use it)'
    );
    expect(droppedText(dropped, t, { asOwner: true })).toContain('Web search (you may not use it)');
    expect(droppedText([], t)).toBe('');
  });
});

describe('the owner’s dialog', () => {
  test('an app without tools: visible at once, and the list the server sent', () => {
    renderDialog(publishable(NOW));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Publish "Job ad writer" for everyone?');
    expect(dialog).toHaveTextContent(PUBLISH.bodyNow);
    expect(screen.getByTestId('user-app-publish')).toHaveAttribute('data-form', 'now');
    const can = within(screen.getByTestId('user-app-publish-can'));
    expect(can.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'take files from users'
    ]);
    expect(dialog).toHaveTextContent(PUBLISH.managed);
    expect(dialog).toHaveTextContent(PUBLISH.membersNow);
    expect(dialog).not.toHaveTextContent(PUBLISH.membersLater);
    expect(screen.queryByTestId('user-app-publish-dropped')).toBeNull();
    expect(untranslated(dialog)).toEqual([]);
  });

  test('an app with tools: an administrator switches it on, and what is not taken over', () => {
    renderDialog(publishable(LATER));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Publish "Job ad writer"?');
    expect(dialog).not.toHaveTextContent('for everyone');
    expect(dialog).toHaveTextContent(
      'Because it uses web search, skills, and a connected system, an administrator checks it and switches it on.'
    );
    expect(screen.getByTestId('user-app-publish')).toHaveAttribute('data-form', 'later');
    const can = within(screen.getByTestId('user-app-publish-can'));
    expect(can.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'take files from users',
      'search the web',
      'use the skills: brand-voice, tone-check',
      'Jira: searchIssues, getIssue'
    ]);
    expect(screen.getByTestId('user-app-publish-dropped')).toHaveTextContent(
      'Not taken over: SharePoint (no longer allowed for personal apps)'
    );
    expect(dialog).toHaveTextContent(PUBLISH.membersLater);
    expect(dialog).not.toHaveTextContent(PUBLISH.membersNow);
    expect(untranslated(dialog)).toEqual([]);
  });

  test('with "every app waits" the sentence names no tool', () => {
    renderDialog(publishable({ ...NOW, startsEnabled: false, waitsFor: 'always' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(PUBLISH.bodyLaterAlways);
    expect(dialog).toHaveTextContent('Publish "Job ad writer"?');
  });

  test('"Publish" sends the revision the page loaded, and hands the answer on', async () => {
    const answer = userApp({ state: 'promoted', revision: 8 });
    mockApi.publishUserApp.mockResolvedValue(answer);
    const props = renderDialog(publishable(NOW, { revision: 7 }));
    await click(screen.getByRole('button', { name: PUBLISH.submit }));
    expect(mockApi.publishUserApp).toHaveBeenCalledWith(APP_ID, { revision: 7 });
    expect(props.onPublished).toHaveBeenCalledWith(answer);
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  test('a 409 for a change by someone else hands over to the page', async () => {
    mockApi.publishUserApp.mockRejectedValue(apiFailure(409, { code: 'ETAG_MISMATCH' }));
    const props = renderDialog(publishable(NOW));
    await click(screen.getByRole('button', { name: PUBLISH.submit }));
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    expect(props.onPublished).not.toHaveBeenCalled();
  });

  test('any other refusal stays in the dialog, with the text of its code', async () => {
    mockApi.publishUserApp.mockRejectedValue(
      apiFailure(403, { code: 'USER_APP_ACCESS_CHANGED', detail: 'changed' })
    );
    const props = renderDialog(publishable(NOW));
    await click(screen.getByRole('button', { name: PUBLISH.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      en.apiErrors.USER_APP_ACCESS_CHANGED
    );
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: PUBLISH.submit })).toBeInTheDocument();
  });
});

describe('"Publish" in the editor', () => {
  test('is absent when the server says canPublish is false', async () => {
    mockApi.fetchUserApp.mockResolvedValue(userApp());
    await renderEditor();
    expect(await openMore()).not.toContain(PUBLISH.action);
  });

  test('is absent for an editor of the app', async () => {
    mockApi.fetchUserApp.mockResolvedValue(userApp({ permissions: EDITOR_PERMISSIONS }));
    await renderEditor();
    expect(await openMore()).not.toContain(PUBLISH.action);
  });

  test('opens the dialog; a publish that waits shows the banner with the date', async () => {
    mockApi.fetchUserApp.mockResolvedValue(publishable(LATER));
    mockApi.publishUserApp.mockResolvedValue(
      userApp({
        state: 'promoted',
        revision: 8,
        publishedAs: {
          appId: 'job-ad-writer',
          name: { en: 'Job ad writer' },
          enabled: false,
          at: '2026-11-20T10:00:00Z'
        },
        permissions: { canEdit: false, canPublish: false, readOnly: true }
      })
    );
    await renderEditor();
    expect(await openMore()).toContain(PUBLISH.action);
    await click(screen.getByRole('menuitem', { name: PUBLISH.action }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Publish "Job ad writer"?');
    await click(screen.getByRole('button', { name: PUBLISH.submit }));

    expect(mockApi.publishUserApp).toHaveBeenCalledWith(APP_ID, { revision: 7 });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const banner = await screen.findByTestId('user-app-status');
    expect(banner).toHaveAttribute('data-reason', 'promoted');
    expect(banner).toHaveTextContent('An administrator has not switched the company app on yet.');
    expect(banner).toHaveTextContent(new Date('2026-11-20T10:00:00Z').toLocaleDateString('en'));
    expect(screen.getByTestId('user-app-state')).toHaveTextContent(en.userApps.edit.state.promoted);
    expect(screen.getByTestId('where')).toHaveTextContent('EDITOR:');
    expect(mockApps.invalidated).toBe(1);
    // Nothing more to publish.
    expect(await openMore()).not.toContain(PUBLISH.action);
  });

  test('a publish that is visible at once leads to the pointer page', async () => {
    mockApi.fetchUserApp.mockResolvedValue(publishable(NOW));
    // The reduced body: the owner may use the company app, so the personal one is retired.
    mockApi.publishUserApp.mockResolvedValue({
      id: APP_ID,
      ownership: 'user',
      name: { en: 'Job ad writer' },
      owner: { id: 'anna', name: 'Anna Schmidt', active: true },
      state: 'promoted',
      permissions: { canView: true, canUse: false, isOwner: true, role: 'owner', readOnly: true },
      disabled: null,
      publishedAs: { appId: 'job-ad-writer', name: { en: 'Job ad writer' } }
    });
    await renderEditor();
    await openMore();
    await click(screen.getByRole('menuitem', { name: PUBLISH.action }));
    await click(screen.getByRole('button', { name: PUBLISH.submit }));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(`CHAT:/apps/${APP_ID}`)
    );
  });

  test('a change by someone else closes the dialog and says what to do', async () => {
    mockApi.fetchUserApp.mockResolvedValue(publishable(NOW));
    mockApi.publishUserApp.mockRejectedValue(apiFailure(409, { code: 'ETAG_MISMATCH' }));
    await renderEditor();
    await openMore();
    await click(screen.getByRole('menuitem', { name: PUBLISH.action }));
    await click(screen.getByRole('button', { name: PUBLISH.submit }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText(PUBLISH.changed)).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('EDITOR:');
  });

  test('a published app that is switched on reads "became a company app"', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        state: 'promoted',
        publishedAs: { appId: 'job-ad-writer', enabled: true, at: '2026-11-20T10:00:00Z' },
        permissions: { canEdit: false, readOnly: true }
      })
    );
    await renderEditor();
    const banner = await screen.findByTestId('user-app-status');
    expect(banner).toHaveTextContent('Administrators manage it now.');
    expect(banner).not.toHaveTextContent('has not switched the company app on yet');
  });
});

describe('the pointer page of a retired app', () => {
  test('names the company app and links to it', () => {
    render(
      <MemoryRouter>
        <RetiredAppPage
          app={{
            id: APP_ID,
            ownership: 'user',
            state: 'retired',
            publishedAs: { appId: 'job-ad-writer', name: { en: 'Job ad writer', de: 'Anzeigen' } }
          }}
        />
      </MemoryRouter>
    );
    const page = screen.getByTestId('personal-app-retired');
    expect(within(page).getByRole('heading', { level: 1 })).toHaveTextContent('Job ad writer');
    expect(page).toHaveTextContent(PUBLISH.retired.title);
    expect(within(page).getByRole('link', { name: 'Open "Job ad writer"' })).toHaveAttribute(
      'href',
      '/apps/job-ad-writer'
    );
    expect(page).toHaveTextContent(PUBLISH.retired.chats);
  });
});

describe('the admin’s take-over dialog', () => {
  const ITEM = {
    id: APP_ID,
    name: 'Job ad writer',
    owner: { id: 'anna', name: 'Anna Schmidt', active: true },
    state: 'active'
  };
  const VIEW = {
    ...ITEM,
    revision: 12,
    sharedWith: { users: 5, groups: 1, everyone: false },
    takeOverPreview: {
      suggestedId: 'job-ad-writer',
      capabilities: LATER.capabilities,
      dropped: [
        { id: 'integration:sharepoint', reason: 'offOnInstallation', name: 'SharePoint' },
        { id: 'model', reason: 'youMayNot' }
      ],
      plain: false
    }
  };

  async function renderTakeOver(handlers = {}) {
    const props = { onClose: jest.fn(), onDone: jest.fn(), ...handlers };
    await act(async () => {
      render(<UserAppTakeOverDialog app={ITEM} {...props} />);
    });
    return props;
  }

  beforeEach(() => {
    mockAdmin.fetchAdminUserApp.mockResolvedValue(VIEW);
    mockAdmin.makeAdminApiCall.mockImplementation(async url => {
      if (url === '/admin/ui/config') {
        return {
          data: {
            appsList: {
              categories: {
                list: [{ id: 'all' }, { id: 'writing', name: { en: 'Writing' } }]
              }
            }
          }
        };
      }
      return { data: { id: 'hr-job-ads', enabled: false } };
    });
  });

  test('lists every action and every skill of the preview, and what is dropped', async () => {
    await renderTakeOver();
    const dialog = screen.getByTestId('user-app-take-over');
    expect(dialog).toHaveTextContent('Take over "Job ad writer" as an app?');
    expect(screen.getByLabelText('App ID')).toHaveValue('job-ad-writer');
    const can = within(screen.getByTestId('user-app-take-over-can'));
    expect(can.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'take files from users',
      'search the web',
      'use the skills: brand-voice, tone-check',
      'Jira: searchIssues, getIssue'
    ]);
    expect(screen.getByTestId('user-app-take-over-dropped')).toHaveTextContent(
      'Not taken over: SharePoint (no longer allowed for personal apps), AI model (you may not use it)'
    );
    expect(dialog).toHaveTextContent(en.admin.userApps.takeOver.notPublished);
    expect(dialog).toHaveTextContent('Anna Schmidt can no longer change the personal app.');
    expect(dialog).toHaveTextContent('5 people use the personal app today.');
    expect(untranslated(dialog)).toEqual([]);
  });

  test('"Take over" sends the ID, the category and If-Match, then hands the new ID on', async () => {
    const props = await renderTakeOver();
    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'hr-job-ads' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'writing' } });
    await click(screen.getByRole('button', { name: en.admin.userApps.takeOver.submit }));
    expect(mockAdmin.makeAdminApiCall).toHaveBeenCalledWith(`/admin/user-apps/${APP_ID}/_promote`, {
      method: 'POST',
      body: { id: 'hr-job-ads', category: 'writing' },
      headers: { 'If-Match': '"12"' }
    });
    expect(props.onDone).toHaveBeenCalledWith('hr-job-ads');
  });

  test('an ID that cannot be one is refused before anything is sent', async () => {
    const props = await renderTakeOver();
    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'Not An Id' } });
    await click(screen.getByRole('button', { name: en.admin.userApps.takeOver.submit }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use only lowercase letters');
    expect(screen.getByLabelText('App ID')).toHaveAttribute('aria-invalid', 'true');
    expect(
      mockAdmin.makeAdminApiCall.mock.calls.filter(([url]) => url.endsWith('/_promote'))
    ).toEqual([]);
    expect(props.onDone).not.toHaveBeenCalled();
  });

  test('a taken ID and a change by someone else each get their sentence', async () => {
    const refuse = data => {
      const error = new Error('refused');
      error.response = { status: 409, data };
      return error;
    };
    mockAdmin.makeAdminApiCall.mockImplementation(async url => {
      if (url === '/admin/ui/config') return { data: {} };
      throw refuse({ code: 'CONFLICT', details: { reason: 'idTaken' } });
    });
    const props = await renderTakeOver();
    await click(screen.getByRole('button', { name: en.admin.userApps.takeOver.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An app with the ID "job-ad-writer" already exists.'
    );

    mockAdmin.makeAdminApiCall.mockImplementation(async url => {
      if (url === '/admin/ui/config') return { data: {} };
      throw refuse({ code: 'ETAG_MISMATCH' });
    });
    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'another-id' } });
    await click(screen.getByRole('button', { name: en.admin.userApps.takeOver.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.admin.userApps.changed);
    expect(props.onDone).not.toHaveBeenCalled();
  });

  test('says so when the owner’s rights could not be checked', async () => {
    mockAdmin.fetchAdminUserApp.mockResolvedValue({
      ...VIEW,
      takeOverPreview: {
        suggestedId: 'job-ad-writer',
        capabilities: [],
        dropped: [{ id: 'webSearch', reason: 'ownerInactive' }],
        plain: true
      }
    });
    await renderTakeOver();
    expect(screen.getByTestId('user-app-take-over')).toHaveTextContent(
      en.admin.userApps.takeOver.plain
    );
  });
});

describe('the line about waiting apps', () => {
  const WAITING = {
    data: {
      items: [
        {
          appId: 'research-helper',
          name: { en: 'Research helper' },
          publishedAt: '2026-11-19T10:00:00Z',
          publishedBy: { name: 'Anna Schmidt' }
        },
        {
          appId: 'meeting-recap',
          name: { en: 'Meeting recap' },
          publishedAt: '2026-11-20T10:00:00Z',
          publishedBy: { name: 'Ben Koch' }
        }
      ],
      nextCursor: null
    }
  };
  const CONTENT_ADMIN = { id: 'cora', isAdmin: false, permissions: { contentAdmin: true } };

  const renderNotice = () =>
    act(async () => {
      render(
        <MemoryRouter>
          <WaitingAppsNotice />
        </MemoryRouter>
      );
    });

  test('names the waiting apps as links to the admin editor', async () => {
    mockAdmin.makeAdminApiCall.mockResolvedValue(WAITING);
    await renderNotice();
    expect(mockAdmin.makeAdminApiCall).toHaveBeenCalledWith('/admin/user-apps/_waiting');
    const notice = screen.getByTestId('waiting-apps-notice');
    expect(notice).toHaveTextContent('2 apps published by users are not switched on yet.');
    expect(within(notice).getByRole('link', { name: 'Research helper' })).toHaveAttribute(
      'href',
      '/admin/apps/research-helper'
    );
    expect(within(notice).getByRole('link', { name: 'Meeting recap' })).toHaveAttribute(
      'href',
      '/admin/apps/meeting-recap'
    );
    // Nothing of the personal app or of its owner beyond what the route sends.
    expect(notice).not.toHaveTextContent('uap_');
  });

  test('renders nothing when no app waits, or when the list cannot be read', async () => {
    mockAdmin.makeAdminApiCall.mockResolvedValue({ data: { items: [], nextCursor: null } });
    await renderNotice();
    expect(screen.queryByTestId('waiting-apps-notice')).toBeNull();

    mockAdmin.makeAdminApiCall.mockRejectedValue(new Error('403'));
    await renderNotice();
    expect(screen.queryByTestId('waiting-apps-notice')).toBeNull();
  });

  test('with the feature off nothing is requested and nothing is shown', async () => {
    mockEnv.platformConfig = { featuresMap: { userApps: false } };
    mockAdmin.makeAdminApiCall.mockResolvedValue(WAITING);
    await renderNotice();
    expect(mockAdmin.makeAdminApiCall).not.toHaveBeenCalled();
    expect(screen.queryByTestId('waiting-apps-notice')).toBeNull();
  });

  test('a content admin sees the line above the list of the "Apps" tab', async () => {
    mockEnv.user = CONTENT_ADMIN;
    mockAdmin.makeAdminApiCall.mockImplementation(async url =>
      url === '/admin/user-apps/_waiting' ? WAITING : { data: {} }
    );
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/admin/apps']}>
          <Routes>
            <Route path="*" element={<AdminAppsPage />} />
          </Routes>
        </MemoryRouter>
      );
    });
    const notice = await screen.findByTestId('waiting-apps-notice');
    expect(notice).toHaveTextContent('2 apps published by users are not switched on yet.');
    expect(within(notice).getByRole('link', { name: 'Research helper' })).toHaveAttribute(
      'href',
      '/admin/apps/research-helper'
    );
    // The tab of personal apps is not theirs.
    expect(screen.queryByRole('tab', { name: /Personal apps/ })).toBeNull();
  });
});
