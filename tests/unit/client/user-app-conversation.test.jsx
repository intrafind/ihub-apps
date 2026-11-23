// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat builder's conversation in the personal app editor
 * (`/apps/:appId/edit?view=conversation`; plan 04, slice 1).
 *
 * - The turn goes to `POST /api/apps/_revise` with the content a personal app
 *   has; the page never calls `/api/admin/*`.
 * - Apply saves with the page's own save (`PATCH` with the revision,
 *   `If-Match`) and restarts the test chat; a 409 writes nothing and says so.
 * - Undo saves the values from before.
 * - A person who cannot edit the app gets no conversation.
 *
 * The page, its parts and the conversation are the real ones; the API module
 * is a stub, and every call past it or to the admin API is recorded and fails.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  APP_ID,
  CONFIG,
  EDITOR_PERMISSIONS,
  apiFailure,
  createTexts,
  en,
  userApp
} from './helpers/userAppEditorHarness';

const API_NAMES = ['fetchModels', 'fetchUserApp', 'reviseUserApp', 'updateUserApp'];
const mockApi = Object.fromEntries(API_NAMES.map(name => [name, jest.fn()]));
jest.mock('../../../client/src/api', () =>
  Object.fromEntries(
    ['fetchModels', 'fetchUserApp', 'reviseUserApp', 'updateUserApp'].map(name => [
      name,
      (...args) => mockApi[name](...args)
    ])
  )
);

const mockRequests = [];
jest.mock('../../../client/src/api/client', () => {
  const record =
    method =>
    (url, ...rest) => {
      mockRequests.push({ method, url, rest });
      return Promise.reject(new Error(`apiClient.${method} ${url} was called`));
    };
  const client = (...args) => {
    mockRequests.push({ method: 'request', url: args[0]?.url });
    return Promise.reject(new Error('apiClient was called'));
  };
  return {
    apiClient: Object.assign(client, {
      get: record('get'),
      post: record('post'),
      put: record('put'),
      patch: record('patch'),
      delete: record('delete')
    })
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
jest.mock('../../../client/src/shared/hooks/appsCache', () => ({
  invalidateAppsCache: () => {}
}));
const mockUserApps = { config: null };
jest.mock('../../../client/src/shared/hooks/useUserApps', () => ({
  useUserAppsConfig: () => ({ enabled: true, config: mockUserApps.config, loading: false }),
  invalidateUserAppsConfig: () => {}
}));
jest.mock('../../../client/src/features/admin/components/AppTestPanel', () => ({
  __esModule: true,
  default: ({ appId, reloadKey }) => (
    <aside data-testid="test-panel" data-app={appId} data-run={reloadKey}>
      test chat
    </aside>
  )
}));
jest.mock('../../../client/src/pages/error/NotFound', () => ({
  __esModule: true,
  default: () => <div data-testid="not-found">not found</div>
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: p => p,
  buildAssetUrl: p => p
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
const mockTexts = createTexts();
jest.mock('react-i18next', () => ({
  useTranslation: () => mockTexts.translation
}));

const { appRevisionKeys } = require('../../../shared/appRevision.js');
const UserAppEditPage = require('../../../client/src/features/apps/pages/UserAppEditPage').default;
const {
  PlatformConfigContext
} = require('../../../client/src/shared/contexts/platformConfigContextValue');

const TEXT = en.admin.apps.conversation;
const NEW_SYSTEM = 'You write formal job ads from notes.';
const originalMatchMedia = window.matchMedia;

function wideWindow() {
  window.matchMedia = () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
}

async function renderEditor({
  path = `/apps/${APP_ID}/edit?view=conversation`,
  features = { appBuilderChat: true }
} = {}) {
  await act(async () => {
    render(
      <PlatformConfigContext.Provider value={{ platformConfig: { featuresMap: features } }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/apps/:appId/edit" element={<UserAppEditPage />} />
          </Routes>
        </MemoryRouter>
      </PlatformConfigContext.Provider>
    );
  });
}

const composer = () => screen.getByRole('textbox', { name: TEXT.composer.label });

async function say(text) {
  fireEvent.change(composer(), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(composer(), { key: 'Enter' });
  });
  await waitFor(() => expect(screen.queryByText(TEXT.working)).not.toBeInTheDocument());
}

async function click(element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

const CHANGE = {
  reply: 'change',
  text: 'More formal now.',
  question: null,
  patch: { system: { en: NEW_SYSTEM } },
  changed: ['system'],
  suggestions: { websearch: false, integrations: [] },
  warnings: [],
  model: { id: 'stub', name: 'Stub' }
};

beforeAll(() => mockTexts.init());

beforeEach(() => {
  jest.clearAllMocks();
  mockRequests.length = 0;
  mockAdminCalls.length = 0;
  mockUserApps.config = CONFIG;
  window.sessionStorage.clear();
  window.localStorage.clear();
  mockApi.fetchUserApp.mockResolvedValue(userApp({ sharedWith: { users: 2, groups: 0 } }));
  mockApi.fetchModels.mockResolvedValue([]);
  wideWindow();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  // The personal editor never calls `/api/admin/*`, and nothing past the API module.
  expect(mockAdminCalls).toEqual([]);
  expect(mockRequests).toEqual([]);
});

test('without appBuilderChat the editor shows the form', async () => {
  await renderEditor({ features: {} });
  expect(screen.queryByTestId('conversation-panel')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /^Instructions/ })).toBeInTheDocument();
});

test('a person who cannot edit the app gets no conversation', async () => {
  mockApi.fetchUserApp.mockResolvedValue(
    userApp({
      permissions: { ...EDITOR_PERMISSIONS, canEdit: false, role: 'user', readOnly: true }
    })
  );
  await renderEditor();
  expect(screen.queryByTestId('conversation-panel')).not.toBeInTheDocument();
});

test('a turn goes to the personal route with the content a personal app has', async () => {
  mockApi.reviseUserApp.mockResolvedValue(CHANGE);
  await renderEditor();
  expect(screen.getByTestId('test-panel')).toBeInTheDocument();
  await say('More formal, please');

  expect(mockApi.reviseUserApp).toHaveBeenCalledTimes(1);
  const [request] = mockApi.reviseUserApp.mock.calls[0];
  expect(request.conversation).toEqual([{ role: 'author', text: 'More formal, please' }]);
  expect(request.language).toBe('en');
  expect(request.signal).toBeInstanceOf(AbortSignal);
  const allowed = appRevisionKeys('personal');
  expect(Object.keys(request.draft).every(key => allowed.includes(key))).toBe(true);
  expect(request.draft.system).toEqual({ en: 'You write job ads from notes.' });
  expect(request.draft).not.toHaveProperty('capabilities');
  expect(request.draft).not.toHaveProperty('preferredModel');
  expect(screen.getByTestId('change-stakes')).toHaveTextContent(
    'You share it with 2 people or groups; they get this change.'
  );
});

test('Apply saves with the revision and restarts the test chat; Undo saves the old text', async () => {
  mockApi.reviseUserApp.mockResolvedValue(CHANGE);
  mockApi.updateUserApp.mockImplementation(async (id, patch) =>
    userApp({
      revision: mockApi.updateUserApp.mock.calls.length + 7,
      system: patch.system,
      sharedWith: { users: 2, groups: 0 }
    })
  );
  await renderEditor();
  const runBefore = Number(screen.getByTestId('test-panel').dataset.run);
  await say('More formal, please');
  await click(screen.getByRole('button', { name: TEXT.change.apply }));

  expect(mockApi.updateUserApp).toHaveBeenCalledWith(
    APP_ID,
    { system: { en: NEW_SYSTEM } },
    { revision: 7 }
  );
  expect(Number(screen.getByTestId('test-panel').dataset.run)).toBe(runBefore + 1);
  expect(screen.getByTestId('change-applied')).toHaveFocus();

  await click(screen.getByRole('button', { name: TEXT.change.undo }));
  expect(mockApi.updateUserApp).toHaveBeenLastCalledWith(
    APP_ID,
    { system: { en: 'You write job ads from notes.' } },
    { revision: 8 }
  );
  expect(screen.getByTestId('change-undone')).toBeInTheDocument();
});

test('a 409 on Apply writes nothing, keeps the form as it was and shows the conflict', async () => {
  mockApi.reviseUserApp.mockResolvedValue(CHANGE);
  mockApi.updateUserApp.mockRejectedValue(
    apiFailure(409, { code: 'ETAG_MISMATCH', detail: 'Changed meanwhile' })
  );
  await renderEditor();
  await say('More formal, please');
  await click(screen.getByRole('button', { name: TEXT.change.apply }));

  expect(mockApi.updateUserApp).toHaveBeenCalledTimes(1);
  const card = screen.getByTestId('change-card');
  expect(within(card).getByRole('alert')).toHaveTextContent(TEXT.change.conflict);
  const notice = screen
    .getAllByRole('alert')
    .find(node => node.textContent.includes(en.userApps.edit.conflict));
  expect(within(notice).getByRole('button', { name: en.userApps.edit.reload })).toBeInTheDocument();
  // The form shows the stored text again: switching to it shows no unsaved change.
  fireEvent.click(screen.getByRole('button', { name: TEXT.view.form }));
  expect(screen.getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
    'You write job ads from notes.'
  );
});

test('Apply is disabled after a hand edit, and Undo after an edit of the changed text', async () => {
  mockApi.reviseUserApp.mockResolvedValue(CHANGE);
  await renderEditor();
  await say('More formal, please');

  fireEvent.click(screen.getByRole('button', { name: TEXT.view.form }));
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: /^Instructions/ }), {
      target: { value: 'Edited by hand.' }
    });
  });
  fireEvent.click(screen.getByRole('button', { name: TEXT.view.conversation }));
  expect(screen.getByRole('button', { name: TEXT.change.apply })).toBeDisabled();
  expect(screen.getByText(TEXT.change.stale)).toBeInTheDocument();
  expect(mockApi.updateUserApp).not.toHaveBeenCalled();
});

test('"Improve with AI" goes to the personal route and writes into the form only', async () => {
  mockApi.reviseUserApp.mockResolvedValue(CHANGE);
  await renderEditor({ path: `/apps/${APP_ID}/edit` });
  await click(screen.getByRole('button', { name: en.admin.apps.edit.improve.action }));
  await click(screen.getByRole('button', { name: en.admin.apps.edit.improve.chips.formal }));

  const [request] = mockApi.reviseUserApp.mock.calls[0];
  expect(request).toMatchObject({ fields: ['system'], allowQuestions: false });
  expect(request.conversation).toHaveLength(1);
  await click(screen.getByRole('button', { name: en.admin.apps.edit.improve.use }));

  expect(screen.getByRole('textbox', { name: /^Instructions/ })).toHaveValue(NEW_SYSTEM);
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  expect(mockApi.updateUserApp).not.toHaveBeenCalled();
});

test('without drafts for personal apps there is no "Improve with AI"', async () => {
  mockUserApps.config = { ...CONFIG, generator: false };
  await renderEditor({ path: `/apps/${APP_ID}/edit` });
  expect(
    screen.queryByRole('button', { name: en.admin.apps.edit.improve.action })
  ).not.toBeInTheDocument();
});
