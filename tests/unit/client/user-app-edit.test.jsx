// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The editor of a personal app (`/apps/:appId/edit`).
 *
 * The page, its parts, the form sections of the admin editor and the language
 * component are the real ones, with the real English texts. Only the API
 * modules are stubs, plus the test chat (it would mount the whole chat) and
 * what the Jest transform cannot load.
 *
 * Slice P8 of concepts/app-builder-rework-2026-11/02-personal-apps.md
 * (sections 11.4, 14.3 and 21).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  ALLOWED,
  APP_ID,
  CONFIG,
  EDITOR_PERMISSIONS,
  apiFailure,
  createTexts,
  en,
  untranslated,
  userApp
} from './helpers/userAppEditorHarness';

const API_NAMES = [
  'acceptUserAppOffer',
  'clearUserAppOffer',
  'deleteUserApp',
  'duplicateUserApp',
  'fetchModels',
  'fetchUserApp',
  'fetchUserAppShareTargets',
  'offerUserApp',
  'setUserAppMembers',
  'updateUserApp'
];
const mockApi = Object.fromEntries(API_NAMES.map(name => [name, jest.fn()]));
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
      'setUserAppMembers',
      'updateUserApp',
      // The prompt share dialog names its defaults; the wrapper replaces both.
      'fetchPromptShareTargets',
      'updatePromptShares'
    ].map(name => [name, (...args) => mockApi[name](...args)])
  )
);

// Every request that does not go through the API module, and every call of
// the admin API module, is recorded: the page must make none of them.
const mockRequests = [];
jest.mock('../../../client/src/api/client', () => {
  const record =
    method =>
    (url, ...rest) => {
      mockRequests.push({ method, url, rest });
      return Promise.reject(new Error(`apiClient.${method} ${url} was called`));
    };
  return {
    apiClient: {
      get: record('get'),
      post: record('post'),
      put: record('put'),
      patch: record('patch'),
      delete: record('delete')
    }
  };
});
const mockAdminCalls = [];
jest.mock('../../../client/src/api/adminApi', () => {
  const refuse =
    name =>
    (...args) => {
      mockAdminCalls.push({ name, args });
      return Promise.reject(new Error(`adminApi.${name} was called`));
    };
  return new Proxy(
    { __esModule: true },
    {
      get: (target, name) =>
        name in target || typeof name !== 'string' ? target[name] : refuse(name)
    }
  );
});

const mockUserApps = { config: null, invalidated: 0 };
jest.mock('../../../client/src/shared/hooks/useUserApps', () => ({
  useUserAppsConfig: () => ({ enabled: true, config: mockUserApps.config, loading: false }),
  invalidateUserAppsConfig: () => {
    mockUserApps.invalidated += 1;
  }
}));

// The test chat mounts the whole chat page; here it only says what it would run.
jest.mock('../../../client/src/features/admin/components/AppTestPanel', () => ({
  __esModule: true,
  default: ({ appId, reloadKey, isDirty }) => (
    <aside data-testid="test-panel" data-app={appId} data-run={reloadKey} data-dirty={`${isDirty}`}>
      test chat
    </aside>
  )
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

// One `t` for every render, as react-i18next hands it out: effects depend on it.
const mockTexts = createTexts();
jest.mock('react-i18next', () => ({
  useTranslation: () => mockTexts.translation
}));

const UserAppEditPage = require('../../../client/src/features/apps/pages/UserAppEditPage').default;
const {
  WITHHELD_MODEL,
  formFromApp,
  patchFor,
  readOnlyReason,
  userAppStateChip,
  withheldCapabilities
} = require('../../../client/src/features/apps/components/user-app/userAppForm');

const EDIT = en.userApps.edit;

beforeAll(() => mockTexts.init());

beforeEach(() => {
  jest.clearAllMocks();
  mockRequests.length = 0;
  mockAdminCalls.length = 0;
  mockUserApps.config = CONFIG;
  mockUserApps.invalidated = 0;
  window.localStorage.clear();
  mockApi.fetchUserApp.mockResolvedValue(userApp());
  mockApi.fetchModels.mockResolvedValue([]);
});

// A state update outside act() means a test ended, or went on, before the page had settled.
let consoleError;
beforeEach(() => {
  consoleError = jest.spyOn(console, 'error');
});
afterEach(() => {
  const unsettled = consoleError.mock.calls.filter(call =>
    String(call[0]).includes('not wrapped in act')
  );
  consoleError.mockRestore();
  expect(unsettled).toEqual([]);
  // The page sends no request to `/api/admin/*`, and none past the API module.
  expect(mockAdminCalls).toEqual([]);
  expect(mockRequests).toEqual([]);
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

async function renderEditor(entry = `/apps/${APP_ID}/edit`) {
  let view;
  await act(async () => {
    view = render(
      <MemoryRouter initialEntries={[entry]}>
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
  return view;
}

const nameField = () => screen.getByRole('textbox', { name: /^Name/ });
const instructionsField = () => screen.getByRole('textbox', { name: /^Instructions/ });
// The save bar's own text (it carries its fallback; the key is not in the locale file).
const SAVE = 'Save Changes';
const saveButton = () => screen.getByRole('button', { name: SAVE });
const extras = () => within(screen.getByTestId('user-app-extras'));

async function typeName(value) {
  await act(async () => {
    fireEvent.change(nameField(), { target: { value } });
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

describe('the form state (userAppForm.js)', () => {
  test('rebuilds the stored capabilities from what the server tells', () => {
    const form = formFromApp(
      userApp({
        integrations: { 'jira-main': { actions: ['searchIssues'] } },
        capabilities: [
          { id: 'model', requested: true, granted: false, reason: 'offOnInstallation' },
          { id: 'upload', requested: true, granted: true },
          { id: 'webSearch', requested: true, granted: false, reason: 'ownerMayNot' },
          { id: 'skills', requested: false, granted: false, reason: 'notRequested' },
          { id: 'integration:jira-main', requested: true, granted: true },
          { id: 'integration:crm', requested: true, granted: false, reason: 'offOnInstallation' }
        ]
      })
    );
    expect(form.capabilities).toEqual({
      upload: true,
      webSearch: true,
      skills: false,
      integrations: [
        { id: 'jira-main', actions: ['searchIssues'] },
        { id: 'crm', actions: [] }
      ]
    });
    // The withheld model has no ID in the answer.
    expect(form.preferredModel).toBe(WITHHELD_MODEL);
    expect(Object.keys(form).sort()).toEqual(
      [
        'capabilities',
        'color',
        'description',
        'icon',
        'messagePlaceholder',
        'name',
        'preferredModel',
        'prompt',
        'starterPrompts',
        'system',
        'variables'
      ].sort()
    );
  });

  test('a save sends only what changed, as a merge patch', () => {
    const saved = formFromApp(
      userApp({ prompt: { en: 'Notes: {{content}}' }, preferredModel: 'gemini-flash' })
    );
    expect(patchFor(saved, saved)).toBeNull();
    expect(patchFor(saved, { ...saved, name: { en: 'Job ads' } })).toEqual({
      name: { en: 'Job ads' }
    });
    // An emptied optional text and a deselected model are removed.
    expect(patchFor(saved, { ...saved, prompt: { en: '  ' }, preferredModel: null })).toEqual({
      prompt: null,
      preferredModel: null
    });
    expect(
      patchFor(saved, { ...saved, capabilities: { ...saved.capabilities, webSearch: true } })
    ).toEqual({ capabilities: { webSearch: true } });
    // Lists are sent whole, with the keys a personal app may store.
    expect(
      patchFor(saved, {
        ...saved,
        starterPrompts: [
          { title: { en: 'A' }, message: { en: 'B' }, autoSend: true, variables: {} }
        ]
      })
    ).toEqual({ starterPrompts: [{ title: { en: 'A' }, message: { en: 'B' } }] });
  });

  test('a withheld model that was not touched is not sent; removing it sends null', () => {
    const saved = formFromApp(
      userApp({
        capabilities: [{ id: 'model', requested: true, granted: false, reason: 'ownerMayNot' }]
      })
    );
    expect(patchFor(saved, { ...saved, color: '#0EA5E9' })).toEqual({ color: '#0EA5E9' });
    expect(patchFor(saved, { ...saved, preferredModel: null })).toEqual({ preferredModel: null });
  });

  test('the state chip names one state, the strongest first', () => {
    const chip = changes => userAppStateChip(userApp(changes)).key;
    expect(chip({})).toBe('userApps.edit.state.private');
    expect(userAppStateChip(userApp({ sharedWith: { users: 4, groups: 1 } }))).toEqual({
      key: 'userApps.edit.state.shared',
      values: { count: 5 },
      tone: 'shared'
    });
    expect(chip({ sharedWith: { users: 1, groups: 0, everyone: true } })).toBe(
      'userApps.edit.state.everyone'
    );
    expect(chip({ pendingOwner: { id: 'ben', name: 'Ben Koch' } })).toBe(
      'userApps.edit.state.offered'
    );
    expect(chip({ state: 'promoted', pendingOwner: { id: 'ben', name: 'Ben Koch' } })).toBe(
      'userApps.edit.state.promoted'
    );
    expect(chip({ state: 'promoted', disabled: { at: 'x', reason: null } })).toBe(
      'userApps.edit.state.disabled'
    );
    // Every key the chip can pick is a text; the count has a form for one and for many.
    for (const state of ['private', 'everyone', 'promoted', 'offered', 'disabled']) {
      expect(typeof EDIT.state[state]).toBe('string');
    }
    const shared = count => mockTexts.instance.t('userApps.edit.state.shared', { count });
    expect(shared(1)).toBe('Shared with 1 person');
    expect(shared(5)).toBe('Shared with 5 people');
  });

  test('read-only has one reason, and an owner is never stopped by a capability', () => {
    expect(readOnlyReason(userApp())).toBeNull();
    const denied = [
      { id: 'integration:jira-main', requested: true, granted: false, reason: 'youMayNot' }
    ];
    expect(readOnlyReason(userApp({ capabilities: denied }))).toBeNull();
    expect(
      readOnlyReason(userApp({ capabilities: denied, permissions: EDITOR_PERMISSIONS }))
    ).toMatchObject({ reason: 'capability', capability: { installationId: 'jira-main' } });
    expect(
      readOnlyReason(
        userApp({ permissions: { ...EDITOR_PERMISSIONS, canEdit: false, readOnly: true } })
      )
    ).toEqual({ reason: 'ownerInactive' });
    expect(readOnlyReason(userApp({ state: 'promoted' }))).toEqual({ reason: 'promoted' });
    expect(readOnlyReason(userApp({ disabled: { at: 'x', reason: 'y' } }))).toEqual({
      reason: 'disabled'
    });
    expect(
      readOnlyReason(userApp({ permissions: { canEdit: false, isOwner: false, role: 'user' } }))
    ).toEqual({ reason: 'role' });
    expect(withheldCapabilities(userApp({ capabilities: denied }))).toEqual([
      {
        id: 'integration:jira-main',
        kind: 'integration',
        installationId: 'jira-main',
        name: null,
        reason: 'youMayNot'
      }
    ]);
  });
});

describe('what the app may use', () => {
  test('offers only the capabilities and actions the installation allows', async () => {
    await renderEditor();
    expect(extras().getByRole('checkbox', { name: EDIT.extras.upload })).toBeChecked();
    expect(extras().getByRole('checkbox', { name: EDIT.extras.webSearch })).not.toBeChecked();
    expect(extras().getByText(EDIT.extras.webSearchHelp)).toBeInTheDocument();
    // Off for the installation: not shown at all.
    expect(extras().queryByRole('checkbox', { name: EDIT.extras.skills })).not.toBeInTheDocument();
    expect(extras().queryByRole('combobox', { name: EDIT.extras.model })).not.toBeInTheDocument();
    expect(mockApi.fetchModels).not.toHaveBeenCalled();

    // A connected system is a checkbox; its actions are the ones the admin allowed.
    const jira = extras().getByRole('checkbox', { name: 'Jira' });
    expect(jira).not.toBeChecked();
    expect(extras().queryByRole('checkbox', { name: 'searchIssues' })).not.toBeInTheDocument();
    await click(jira);
    const boxes = within(screen.getByTestId('user-app-system-jira-main'))
      .getAllByRole('checkbox')
      .map(box => box.labels[0].textContent);
    expect(boxes).toEqual(['Jira', 'searchIssues', 'getIssue']);
    expect(extras().getByText(EDIT.extras.approvalHelp)).toBeInTheDocument();

    await click(extras().getByRole('checkbox', { name: 'getIssue' }));
    mockApi.updateUserApp.mockResolvedValue(userApp({ revision: 8 }));
    await click(saveButton());
    expect(mockApi.updateUserApp).toHaveBeenCalledWith(
      APP_ID,
      { capabilities: { integrations: [{ id: 'jira-main', actions: ['searchIssues'] }] } },
      { revision: 7 }
    );
  });

  test('offers nothing without an allowed capability, and says what an app can work with', async () => {
    mockUserApps.config = {
      ...CONFIG,
      capabilities: {
        modelChoice: false,
        upload: false,
        webSearch: false,
        skills: false,
        integrations: []
      }
    };
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({ capabilities: [], upload: { enabled: false } })
    );
    await renderEditor();
    expect(extras().queryAllByRole('checkbox')).toEqual([]);
    expect(extras().getByText(en.userApps.create.limits)).toBeInTheDocument();
  });

  test('lists the models the person may choose when the installation allows a choice', async () => {
    mockUserApps.config = { ...CONFIG, capabilities: { ...ALLOWED, modelChoice: true } };
    mockApi.fetchModels.mockResolvedValue([{ id: 'gemini-flash', name: { en: 'Gemini Flash' } }]);
    await renderEditor();
    const select = extras().getByRole('combobox', { name: EDIT.extras.model });
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual([en.admin.apps.edit.standardModel, 'Gemini Flash']);
    await act(async () => {
      fireEvent.change(select, { target: { value: 'gemini-flash' } });
    });
    mockApi.updateUserApp.mockResolvedValue(userApp({ revision: 8 }));
    await click(saveButton());
    expect(mockApi.updateUserApp).toHaveBeenCalledWith(
      APP_ID,
      { preferredModel: 'gemini-flash' },
      { revision: 7 }
    );
  });

  test('a stored capability that is gone stays visible with "Remove"', async () => {
    mockUserApps.config = { ...CONFIG, capabilities: { ...ALLOWED, webSearch: false } };
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        capabilities: [
          { id: 'upload', requested: true, granted: true },
          { id: 'webSearch', requested: true, granted: false, reason: 'offOnInstallation' },
          { id: 'integration:crm', requested: true, granted: false, reason: 'ownerMayNot' }
        ]
      })
    );
    await renderEditor();
    const notes = screen.getAllByTestId('user-app-gone').map(note => note.textContent);
    expect(notes[0]).toContain(
      'Web search is no longer available for your apps. The app runs without it.'
    );
    // A system the caller cannot name any more is named by its ID.
    expect(notes[1]).toContain('crm is no longer available for your apps.');
    // The switch itself is not offered: the installation does not allow it.
    expect(
      extras().queryByRole('checkbox', { name: EDIT.extras.webSearch })
    ).not.toBeInTheDocument();

    await click(screen.getByRole('button', { name: 'Remove: Web search' }));
    expect(screen.getAllByTestId('user-app-gone')).toHaveLength(1);
    await click(screen.getByRole('button', { name: 'Remove: crm' }));
    expect(screen.queryByTestId('user-app-gone')).not.toBeInTheDocument();

    mockApi.updateUserApp.mockResolvedValue(userApp({ revision: 8 }));
    await click(saveButton());
    expect(mockApi.updateUserApp).toHaveBeenCalledWith(
      APP_ID,
      { capabilities: { webSearch: false, integrations: [] } },
      { revision: 7 }
    );
  });
});

describe('saving', () => {
  test('sends the change with the revision the page loaded, and restarts the test', async () => {
    await renderEditor();
    expect(screen.queryByRole('button', { name: SAVE })).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: en.admin.apps.edit.test }));
    expect(screen.getByTestId('test-panel')).toHaveAttribute('data-run', '0');

    await typeName('Job ads');
    expect(screen.getByTestId('test-panel')).toHaveAttribute('data-dirty', 'true');
    mockApi.updateUserApp.mockResolvedValue(userApp({ name: { en: 'Job ads' }, revision: 8 }));
    await click(saveButton());

    // The API module turns `revision` into `If-Match: "7"`.
    expect(mockApi.updateUserApp).toHaveBeenCalledTimes(1);
    expect(mockApi.updateUserApp).toHaveBeenCalledWith(
      APP_ID,
      { name: { en: 'Job ads' } },
      { revision: 7 }
    );
    expect(screen.getByTestId('editor-toast')).toHaveTextContent(en.admin.apps.edit.saved);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Job ads');
    expect(screen.queryByRole('button', { name: SAVE })).not.toBeInTheDocument();
    expect(screen.getByTestId('test-panel')).toHaveAttribute('data-run', '1');

    // The next save names the new revision.
    await typeName('Job ads 2');
    mockApi.updateUserApp.mockResolvedValue(userApp({ name: { en: 'Job ads 2' }, revision: 9 }));
    await click(saveButton());
    expect(mockApi.updateUserApp).toHaveBeenLastCalledWith(
      APP_ID,
      { name: { en: 'Job ads 2' } },
      { revision: 8 }
    );
  });

  test('409 ETAG_MISMATCH shows the conflict line and keeps the input', async () => {
    await renderEditor();
    await typeName('My own wording');
    mockApi.updateUserApp.mockRejectedValue(
      apiFailure(409, { code: 'ETAG_MISMATCH', detail: 'The app was changed by someone else' })
    );
    await click(saveButton());

    expect(screen.getByTestId('save-bar-message')).toHaveTextContent(EDIT.conflict);
    expect(nameField()).toHaveValue('My own wording');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // "Reload" fetches the app again; only then is the input replaced.
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({ name: { en: 'Changed by Ben' }, revision: 8 })
    );
    await click(screen.getByRole('button', { name: 'Reload' }));
    expect(mockApi.fetchUserApp).toHaveBeenCalledTimes(2);
    expect(nameField()).toHaveValue('Changed by Ben');
    expect(screen.queryByTestId('save-bar-message')).not.toBeInTheDocument();
  });

  test('another refusal is shown with the text of its code, and the input stays', async () => {
    await renderEditor();
    await typeName('Still mine');
    mockApi.updateUserApp.mockRejectedValue(
      apiFailure(403, {
        code: 'USER_APP_CAPABILITY_DENIED',
        detail: 'A capability is not available',
        details: { capability: 'webSearch', reason: 'offOnInstallation' }
      })
    );
    await click(saveButton());
    expect(screen.getByRole('alert')).toHaveTextContent(en.apiErrors.USER_APP_CAPABILITY_DENIED);
    expect(nameField()).toHaveValue('Still mine');
    expect(screen.getByRole('button', { name: SAVE })).toBeInTheDocument();
  });

  test('"Discard" brings the stored content back without a request', async () => {
    await renderEditor();
    await typeName('Oops');
    await click(screen.getByRole('button', { name: 'Discard' }));
    expect(nameField()).toHaveValue('Job ad writer');
    expect(mockApi.updateUserApp).not.toHaveBeenCalled();
  });
});

describe('one language, and no admin route', () => {
  test('a full edit and save shows one input per text, no Translate and no "Improve with AI"', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        name: { de: 'Stellenanzeigen' },
        description: { de: 'Schreibt eine Stellenanzeige' },
        system: { de: 'Du schreibst Stellenanzeigen.' },
        language: 'de'
      })
    );
    await renderEditor();
    // One input, in the language of the app, without a language code beside it.
    expect(instructionsField()).toHaveValue('Du schreibst Stellenanzeigen.');
    expect(screen.queryByText('DE')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Translate')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /translate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /improve/i })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(instructionsField(), { target: { value: 'Du schreibst kurze Anzeigen.' } });
    });
    await click(screen.getByRole('button', { name: en.admin.apps.edit.addVariable }));
    await click(screen.getByRole('button', { name: en.admin.apps.edit.addStarterPrompt }));
    await click(extras().getByRole('checkbox', { name: EDIT.extras.webSearch }));
    mockApi.updateUserApp.mockImplementation(async () => userApp({ revision: 8 }));
    await click(saveButton());

    const [, patch, options] = mockApi.updateUserApp.mock.calls[0];
    expect(options).toEqual({ revision: 7 });
    expect(patch.system).toEqual({ de: 'Du schreibst kurze Anzeigen.' });
    expect(patch.capabilities).toEqual({ webSearch: true });
    // A new text is written in the language of the app, and a list entry has
    // only the keys a personal app may store.
    expect(patch.variables).toEqual([
      { name: '', label: { de: '' }, type: 'string', required: false }
    ]);
    expect(patch.starterPrompts).toEqual([{ title: { de: '' }, message: { de: '' } }]);
    // The `afterEach` of this file asserts that no admin call and no request
    // past the API module was made.
    expect(API_NAMES.filter(name => mockApi[name].mock.calls.length > 0).sort()).toEqual([
      'fetchUserApp',
      'updateUserApp'
    ]);
  });

  test('a text in two languages has no Translate button, and the admin-only controls are gone', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        name: { en: 'Job ad writer', de: 'Stellenanzeigen' },
        system: { en: 'You write job ads.', de: 'Du schreibst Stellenanzeigen.' },
        variables: [{ name: 'notes', label: { en: 'Notes' }, type: 'string', required: false }],
        starterPrompts: [{ title: { en: 'Start' }, message: { en: 'Write an ad' } }]
      })
    );
    await renderEditor();
    // Both languages show, each with its code; the machine translation is an admin route.
    expect(screen.getAllByText('DE').length).toBeGreaterThan(0);
    expect(screen.queryByTitle('Translate')).not.toBeInTheDocument();
    // A personal app stores no start form, no pinned panel and no auto-send.
    expect(
      screen.queryByRole('checkbox', { name: en.admin.apps.edit.startForm })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: en.admin.apps.edit.variablesPanelPinned })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: en.admin.apps.edit.autoSendPrompt })
    ).not.toBeInTheDocument();
  });

  test('an ID that is not a personal app is not requested', async () => {
    await renderEditor('/apps/chat/edit');
    expect(screen.getByTestId('not-found')).toBeInTheDocument();
    expect(mockApi.fetchUserApp).not.toHaveBeenCalled();
  });

  test('an unknown or hidden app is the 404 page; another failure offers Retry', async () => {
    mockApi.fetchUserApp.mockRejectedValue(
      apiFailure(404, { code: 'NOT_FOUND', detail: 'Not found' })
    );
    const view = await renderEditor();
    expect(screen.getByTestId('not-found')).toBeInTheDocument();
    view.unmount();

    mockApi.fetchUserApp.mockRejectedValue(
      apiFailure(503, { code: 'USER_APPS_UNAVAILABLE', detail: 'Unavailable' })
    );
    await renderEditor();
    expect(screen.getByRole('alert')).toHaveTextContent(en.apiErrors.USER_APPS_UNAVAILABLE);
    mockApi.fetchUserApp.mockResolvedValue(userApp());
    await click(screen.getByRole('button', { name: 'Retry' }));
    expect(nameField()).toHaveValue('Job ad writer');
  });
});

describe('read-only', () => {
  const banner = () => screen.getByTestId('user-app-status');

  test('an editor whose owner is inactive', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        owner: { id: 'anna', name: 'Anna Schmidt', active: false },
        permissions: { ...EDITOR_PERMISSIONS, canEdit: false, canShare: false, readOnly: true }
      })
    );
    await renderEditor();
    expect(banner()).toHaveTextContent(EDIT.readOnly.ownerInactive);
    expect(nameField()).toBeDisabled();
    expect(instructionsField()).toBeDisabled();
    expect(extras().getByRole('checkbox', { name: EDIT.extras.upload })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    // The groups still open and close.
    expect(screen.getByRole('button', { name: en.admin.apps.edit.groups.basics })).toBeEnabled();
  });

  test('an app that became a company app', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        state: 'promoted',
        publishedAs: { appId: 'job-ad-writer', at: '2026-11-21T09:00:00Z', by: null },
        permissions: { canEdit: false, canShare: false, canOffer: false, readOnly: true }
      })
    );
    await renderEditor();
    const date = new Date('2026-11-21T09:00:00Z').toLocaleDateString('en');
    expect(banner()).toHaveTextContent(
      `This app became a company app on ${date}. Administrators manage it now.`
    );
    expect(screen.getByTestId('user-app-state')).toHaveTextContent(EDIT.state.promoted);
    expect(nameField()).toBeDisabled();
    expect(await openMore()).not.toContain(en.userApps.transfer.action);
  });

  test('an app an administrator switched off shows the reason and nothing to edit', async () => {
    // The reduced body: no instructions, no capabilities.
    mockApi.fetchUserApp.mockResolvedValue({
      id: APP_ID,
      ownership: 'user',
      name: { en: 'Job ad writer' },
      icon: 'document-text',
      color: '#4F46E5',
      owner: { id: 'anna', name: 'Anna Schmidt', active: true },
      state: 'active',
      permissions: {
        canView: true,
        canUse: false,
        canEdit: false,
        canShare: false,
        canDelete: true,
        canOffer: false,
        isOwner: true,
        role: 'owner',
        readOnly: true,
        suspended: null
      },
      disabled: { at: '2026-11-21T09:00:00Z', reason: 'It leaks customer data.' }
    });
    await renderEditor();
    expect(banner()).toHaveTextContent(
      'An administrator switched this app off: It leaks customer data.'
    );
    expect(screen.getByTestId('user-app-state')).toHaveTextContent(EDIT.state.disabled);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.admin.apps.edit.test })).not.toBeInTheDocument();
    // The owner can still delete it, and cannot duplicate it.
    expect(await openMore()).toEqual([en.userApps.list.menu.delete]);
  });

  test('an editor who may not use what the app uses', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        permissions: EDITOR_PERMISSIONS,
        capabilities: [
          { id: 'upload', requested: true, granted: true },
          { id: 'integration:jira-main', requested: true, granted: false, reason: 'youMayNot' }
        ]
      })
    );
    await renderEditor();
    expect(banner()).toHaveTextContent(
      'This app uses Jira, which you may not use. You can use the app but not change it.'
    );
    expect(banner()).toHaveAttribute('data-reason', 'capability');
    expect(instructionsField()).toBeDisabled();
    expect(screen.queryByRole('button', { name: SAVE })).not.toBeInTheDocument();
    // The app still runs for this editor.
    expect(screen.getByRole('button', { name: en.admin.apps.edit.test })).toBeEnabled();
  });

  test('a member with "Can use" reads the form without a banner', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        permissions: {
          canEdit: false,
          canShare: false,
          canDelete: false,
          canOffer: false,
          isOwner: false,
          role: 'user'
        },
        members: undefined,
        capabilities: [{ id: 'upload', granted: true }]
      })
    );
    await renderEditor();
    expect(screen.queryByTestId('user-app-status')).not.toBeInTheDocument();
    expect(instructionsField()).toBeDisabled();
    expect(instructionsField()).toHaveValue('You write job ads from notes.');
  });
});

describe('the header', () => {
  test('offers what the server allows; "Publish" only when the server says so', async () => {
    mockApi.fetchUserApp.mockResolvedValue(userApp({ permissions: { canPublish: false } }));
    await renderEditor();
    expect(screen.getByTestId('user-app-state')).toHaveTextContent(EDIT.state.private);
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(await openMore()).toEqual([
      en.admin.apps.openApp,
      en.userApps.transfer.action,
      en.userApps.list.menu.duplicate,
      en.userApps.list.menu.delete
    ]);
  });

  test('an editor gets no hand-over and no delete; without the permission no "Share"', async () => {
    mockApi.fetchUserApp.mockResolvedValue(
      userApp({
        permissions: { ...EDITOR_PERMISSIONS, canShare: false },
        sharedWith: { users: 2, groups: 1, everyone: false }
      })
    );
    await renderEditor();
    expect(screen.getByTestId('user-app-state')).toHaveTextContent('Shared with 3 people');
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(await openMore()).toEqual([en.admin.apps.openApp, en.userApps.list.menu.duplicate]);
  });

  test('"Duplicate" opens the copy; "Delete" asks first and leads to the list', async () => {
    const copyId = 'uap_00000000000000000000000000000001';
    await renderEditor();
    mockApi.duplicateUserApp.mockResolvedValue(userApp({ id: copyId }));
    await openMore();
    await click(screen.getByRole('menuitem', { name: en.userApps.list.menu.duplicate }));
    expect(mockApi.duplicateUserApp).toHaveBeenCalledWith(APP_ID);
    expect(screen.getByTestId('where')).toHaveTextContent(`EDITOR:/apps/${copyId}/edit`);
    expect(mockUserApps.invalidated).toBe(1);

    await openMore();
    await click(screen.getByRole('menuitem', { name: en.userApps.list.menu.delete }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete "Job ad writer"?' });
    expect(within(dialog).getByText(EDIT.delete.body)).toBeInTheDocument();
    expect(mockApi.deleteUserApp).not.toHaveBeenCalled();
    mockApi.deleteUserApp.mockResolvedValue(undefined);
    await click(within(dialog).getByRole('button', { name: en.userApps.list.menu.delete }));
    expect(mockApi.deleteUserApp).toHaveBeenCalledWith(copyId);
    expect(screen.getByTestId('where')).toHaveTextContent('LIST:/apps');
  });
});

describe('arriving from "New app"', () => {
  test('?created=1 opens the test chat, says that the app exists and lists the next steps', async () => {
    await renderEditor(`/apps/${APP_ID}/edit?created=1`);
    expect(screen.getByTestId('test-panel')).toHaveAttribute('data-app', APP_ID);
    expect(screen.getByTestId('editor-toast')).toHaveTextContent('App "Job ad writer" created');
    expect(screen.getByTestId('where')).toHaveTextContent(`EDITOR:/apps/${APP_ID}/edit`);
    expect(screen.getByTestId('where')).not.toHaveTextContent('created');

    const steps = within(screen.getByTestId('user-app-next-steps'));
    expect(steps.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      en.admin.apps.create.done.steps.test,
      en.admin.apps.create.done.steps.inputFields,
      'Share it (optional)'
    ]);
    await click(steps.getByRole('button', { name: 'Share it (optional)' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Share "Job ad writer"');
  });

  test('without the right to share, the steps do not offer it', async () => {
    mockApi.fetchUserApp.mockResolvedValue(userApp({ permissions: { canShare: false } }));
    await renderEditor(`/apps/${APP_ID}/edit?created=1`);
    const steps = within(screen.getByTestId('user-app-next-steps'));
    expect(steps.getAllByRole('listitem')).toHaveLength(2);
    await click(steps.getByRole('button', { name: en.admin.apps.create.done.dismiss }));
    expect(screen.queryByTestId('user-app-next-steps')).not.toBeInTheDocument();
  });
});

describe('the texts this slice needs', () => {
  test('every text on the page is a text, in English and German', async () => {
    await renderEditor(`/apps/${APP_ID}/edit?created=1`);
    await waitFor(() => expect(nameField()).toBeInTheDocument());
    expect(untranslated(document.body)).toEqual([]);
    await act(async () => {
      await mockTexts.instance.changeLanguage('de');
    });
    await renderEditor();
    expect(untranslated(document.body)).toEqual([]);
    await mockTexts.instance.changeLanguage('en');
  });
});
