// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Publishing and unpublishing from the app editor (`AdminAppEditPage`, plan
 * section 3.4).
 *
 * - Publish with a clean form sets the flag (`POST …/_toggle`) and saves nothing.
 * - Publish with unsaved changes saves first; when that save does not go
 *   through, nothing is published.
 * - Unpublish never saves, so an app with an invalid field can be unpublished,
 *   and unsaved edits stay.
 * - After a toggle the page is not dirty because of it.
 * - The page has one control that changes the published state.
 *
 * The page, its parts, the admin API module, the save bar, the access section
 * and the group state are the real ones, with the real English and German
 * texts. `apiClient` is the stand-in for the server; the form is a stand-in
 * that follows the contract between page and form (see the harness).
 */

import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const mockI18n = i18next.createInstance();
const mockT = (...args) => mockI18n.t(...args);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: mockI18n })
}));

const mockRequest = jest.fn();
jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: (...args) => mockRequest(...args)
}));
// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => `/ihub${p}`,
  buildApiUrl: p => `/api${p}`
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));

const mockFetchModels = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchModels: (...args) => mockFetchModels(...args),
  fetchUIConfig: jest.fn(() => Promise.resolve({})),
  fetchAppDetails: jest.fn(() => Promise.resolve({ id: 'chat', type: 'chat' }))
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/pages/AppChat', () => () => (
  <div data-testid="app-chat" />
));
jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);
jest.mock(
  '../../../client/src/shared/components/DualModeEditor',
  () => require('./helpers/appEditorHarness').MockDualModeEditor
);
// The form's two group components belong to the form; the page only places them.
jest.mock(
  '../../../client/src/features/admin/components/app-form/EditorGroup',
  () => require('./helpers/appEditorHarness').MockEditorGroup,
  { virtual: true }
);
jest.mock(
  '../../../client/src/features/admin/components/app-form/EditorGroupNav',
  () => require('./helpers/appEditorHarness').MockEditorGroupNav,
  { virtual: true }
);

const { createAppServer, httpError } = require('./helpers/appEditorHarness');
const AdminAppEditPage =
  require('../../../client/src/features/admin/pages/AdminAppEditPage').default;

const TEXT = en.admin.apps.edit;
const APP = {
  id: 'chat',
  type: 'chat',
  name: { en: 'Plain-language summary' },
  description: { en: 'Rewrites a text so that everyone understands it.' },
  system: { en: 'You rewrite texts in plain language.' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  enabled: false
};
const TOGGLE_URL = '/admin/apps/chat/_toggle';
const APP_URL = '/admin/apps/chat';

let server;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function renderEditor({ app = APP, access } = {}) {
  server = createAppServer({ app, access });
  mockRequest.mockImplementation(server.request);
  render(
    <MemoryRouter initialEntries={['/admin/apps/chat']}>
      <Routes>
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
        <Route path="/admin/apps" element={<div>Apps list</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
  await screen.findByRole('heading', { level: 1 });
}

const status = () => screen.getByTestId('app-status');
const saveBar = () => screen.queryByRole('region', { name: 'Save changes' });
const requests = (method, url) =>
  server.calls.filter(call => call.method === method && call.url === url);
const editName = value => fireEvent.change(screen.getByLabelText('Name'), { target: { value } });

/** Opens "More" and returns the menu. */
function openMore() {
  fireEvent.click(screen.getByRole('button', { name: TEXT.more }));
  return screen.getByRole('menu');
}

/** Presses "Publish" in the header and returns the dialog. */
async function askPublish() {
  fireEvent.click(screen.getByRole('button', { name: TEXT.publish.action }));
  return screen.findByRole('alertdialog');
}

/** Chooses "Unpublish" under "More" and returns the dialog. */
async function askUnpublish() {
  fireEvent.click(within(openMore()).getByRole('menuitem', { name: TEXT.unpublish.action }));
  return screen.findByRole('alertdialog');
}

const confirmIn = (dialog, label) =>
  fireEvent.click(within(dialog).getByRole('button', { name: label }));

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: (key, fallback) => fallback ?? `MISSING:${key}`
  });
});

beforeEach(async () => {
  await mockI18n.changeLanguage('en');
  mockRequest.mockReset();
  mockFetchModels.mockReset();
  mockFetchModels.mockResolvedValue([{ id: 'stub', name: 'Stub model', default: true }]);
  window.localStorage.clear();
});

describe('publishing an app', () => {
  test('with a clean form it sends one toggle and no save', async () => {
    await renderEditor();
    expect(status()).toHaveTextContent(en.admin.apps.status.notPublished);

    const dialog = await askPublish();
    expect(dialog).toHaveTextContent('Publish "Plain-language summary"?');
    expect(dialog).toHaveTextContent(TEXT.publish.who);
    expect(dialog).not.toHaveTextContent(TEXT.publish.savesFirst);
    confirmIn(dialog, TEXT.publish.action);

    await waitFor(() => expect(status()).toHaveTextContent(en.admin.apps.status.published));
    expect(requests('POST', TOGGLE_URL)).toEqual([
      { method: 'POST', url: TOGGLE_URL, data: { enabled: true } }
    ]);
    expect(requests('PUT', APP_URL)).toHaveLength(0);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(server.state.app.enabled).toBe(true);
  });

  test('the form state follows the toggle, and the page is not dirty because of it', async () => {
    await renderEditor();
    confirmIn(await askPublish(), TEXT.publish.action);
    await waitFor(() => expect(status()).toHaveTextContent(en.admin.apps.status.published));

    // The form holds the new value, so a later save does not undo the toggle …
    expect(JSON.parse(screen.getByTestId('form-value').textContent).enabled).toBe(true);
    // … and nothing counts as an unsaved edit: no save bar, no question on leaving.
    expect(saveBar()).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: en.admin.apps.title }));
    expect(await screen.findByText('Apps list')).toBeInTheDocument();
    expect(screen.queryByText(en.admin.unsavedChanges.message)).not.toBeInTheDocument();
  });

  test('with unsaved changes it saves first and then sends the toggle', async () => {
    await renderEditor();
    editName('Summary in plain words');

    const dialog = await askPublish();
    expect(dialog).toHaveTextContent(TEXT.publish.savesFirst);
    confirmIn(dialog, TEXT.publish.action);
    await waitFor(() => expect(status()).toHaveTextContent(en.admin.apps.status.published));

    const writes = server.writes().map(call => `${call.method} ${call.url}`);
    expect(writes).toEqual([`PUT ${APP_URL}`, `POST ${TOGGLE_URL}`]);
    // The save carries the edit and the state before the toggle; the toggle publishes.
    expect(requests('PUT', APP_URL)[0].data).toMatchObject({
      name: { en: 'Summary in plain words' },
      enabled: false
    });
    expect(server.state.app).toMatchObject({
      name: { en: 'Summary in plain words' },
      enabled: true
    });
    expect(saveBar()).not.toBeInTheDocument();
  });

  test('when the save fails, no toggle is sent and the dialog closes', async () => {
    await renderEditor();
    server.failures[`PUT ${APP_URL}`] = httpError(400, 'The name is too long.');
    editName('Summary in plain words');

    confirmIn(await askPublish(), TEXT.publish.action);

    expect(await screen.findByText('The name is too long.')).toBeInTheDocument();
    expect(requests('PUT', APP_URL)).toHaveLength(1);
    expect(requests('POST', TOGGLE_URL)).toHaveLength(0);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(status()).toHaveTextContent(en.admin.apps.status.notPublished);
    // The edit is still there and still unsaved.
    expect(screen.getByLabelText('Name')).toHaveValue('Summary in plain words');
    expect(saveBar()).toBeInTheDocument();
  });

  test('with unsaved changes and an invalid field, nothing is sent and the field is shown', async () => {
    await renderEditor();
    editName('Summary in plain words');
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));

    confirmIn(await askPublish(), TEXT.publish.action);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(server.writes()).toEqual([]);
    expect(status()).toHaveTextContent(en.admin.apps.status.notPublished);
    await waitFor(() => expect(screen.getByLabelText('Instructions')).toHaveFocus());
  });

  test('a failed toggle is said in the dialog, and the app stays as it was', async () => {
    await renderEditor();
    server.failures[`POST ${TOGGLE_URL}`] = httpError(403, 'You may not publish apps.');

    const dialog = await askPublish();
    confirmIn(dialog, TEXT.publish.action);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You may not publish apps.');
    expect(status()).toHaveTextContent(en.admin.apps.status.notPublished);
    expect(saveBar()).not.toBeInTheDocument();

    // Cancel leaves everything as it was.
    confirmIn(dialog, en.common.cancel);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('who will see the app', () => {
  const CONTENT_ADMIN_VIEW = {
    type: 'apps',
    id: 'chat',
    scope: 'membership',
    groups: [],
    audience: { allSignedIn: true, anonymous: false }
  };

  test('the dialog asks the server again when it opens and says what the view says', async () => {
    await renderEditor({ access: CONTENT_ADMIN_VIEW });
    const before = requests('GET', '/admin/content-access/apps/chat').length;

    const dialog = await askPublish();

    await waitFor(() =>
      expect(requests('GET', '/admin/content-access/apps/chat').length).toBeGreaterThan(before)
    );
    expect(within(dialog).getByTestId('publish-audience')).toHaveTextContent(
      'Everyone who signs in can use this app.'
    );
    expect(dialog).not.toHaveTextContent(/No group can use this app yet/);
  });

  test('a group that gets access in the editor is named in the dialog', async () => {
    await renderEditor({
      access: {
        type: 'apps',
        id: 'chat',
        scope: 'all',
        groups: [
          {
            id: 'sales',
            name: 'Sales',
            description: '',
            granted: false,
            wildcard: false,
            inheritedFrom: [],
            effective: false
          }
        ],
        audience: { allSignedIn: false, anonymous: false }
      }
    });

    fireEvent.click(screen.getByRole('button', { name: 'group:access' }));
    const search = await screen.findByRole('combobox');
    fireEvent.focus(search);
    fireEvent.click(await screen.findByRole('option', { name: /Sales/ }));
    await waitFor(() => expect(requests('PUT', '/admin/content-access/apps/chat')).toHaveLength(1));

    const dialog = await askPublish();
    await waitFor(() =>
      expect(within(dialog).getByTestId('publish-audience')).toHaveTextContent(
        'Members of these groups can use it: Sales.'
      )
    );
  });

  test('says that users get no answer when no model is available', async () => {
    mockFetchModels.mockResolvedValue([]);
    await renderEditor();

    const dialog = await askPublish();

    await waitFor(() => expect(dialog).toHaveTextContent(TEXT.publish.noModel));
  });

  test('says nothing about models when one is available', async () => {
    await renderEditor();

    const dialog = await askPublish();

    expect(dialog).not.toHaveTextContent(TEXT.publish.noModel);
  });

  test('in German', async () => {
    await mockI18n.changeLanguage('de');
    await renderEditor({ access: CONTENT_ADMIN_VIEW });

    fireEvent.click(screen.getByRole('button', { name: de.admin.apps.edit.publish.action }));
    const dialog = await screen.findByRole('alertdialog');

    expect(dialog).toHaveTextContent('„Plain-language summary“ veröffentlichen?');
    expect(dialog).toHaveTextContent(de.admin.apps.edit.publish.who);
    expect(dialog).toHaveTextContent('Alle, die sich anmelden, können diese App nutzen.');
    expect(document.body).not.toHaveTextContent('MISSING:');
  });
});

describe('unpublishing an app', () => {
  const PUBLISHED = { ...APP, enabled: true };

  test('sends one toggle and no save, after asking once', async () => {
    await renderEditor({ app: PUBLISHED });
    expect(status()).toHaveTextContent(en.admin.apps.status.published);

    const dialog = await askUnpublish();
    expect(dialog).toHaveTextContent('Unpublish "Plain-language summary"?');
    expect(dialog).toHaveTextContent(TEXT.unpublish.body);
    expect(server.writes()).toEqual([]);
    confirmIn(dialog, TEXT.unpublish.action);

    await waitFor(() => expect(status()).toHaveTextContent(en.admin.apps.status.notPublished));
    expect(server.writes()).toEqual([
      { method: 'POST', url: TOGGLE_URL, data: { enabled: false } }
    ]);
    expect(saveBar()).not.toBeInTheDocument();
  });

  test('an app with an invalid field can be unpublished, and unsaved edits stay', async () => {
    await renderEditor({ app: PUBLISHED });
    editName('Summary in plain words');
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));

    confirmIn(await askUnpublish(), TEXT.unpublish.action);

    await waitFor(() => expect(status()).toHaveTextContent(en.admin.apps.status.notPublished));
    expect(server.writes()).toEqual([
      { method: 'POST', url: TOGGLE_URL, data: { enabled: false } }
    ]);
    expect(requests('PUT', APP_URL)).toHaveLength(0);
    // The edit is still in the form and still unsaved; the server kept the old name.
    expect(screen.getByLabelText('Name')).toHaveValue('Summary in plain words');
    expect(saveBar()).toBeInTheDocument();
    expect(server.state.app.name).toEqual({ en: 'Plain-language summary' });
  });

  test('after the toggle only the author’s own edits count as unsaved', async () => {
    await renderEditor({ app: PUBLISHED });
    editName('Summary in plain words');

    confirmIn(await askUnpublish(), TEXT.unpublish.action);
    await waitFor(() => expect(status()).toHaveTextContent(en.admin.apps.status.notPublished));
    expect(saveBar()).toBeInTheDocument();

    // Taking the edit back leaves nothing to save: the toggle is not an edit.
    editName('Plain-language summary');
    expect(saveBar()).not.toBeInTheDocument();
  });

  test('a later save keeps the app unpublished', async () => {
    await renderEditor({ app: PUBLISHED });
    confirmIn(await askUnpublish(), TEXT.unpublish.action);
    await waitFor(() => expect(status()).toHaveTextContent(en.admin.apps.status.notPublished));

    editName('Summary in plain words');
    fireEvent.click(within(saveBar()).getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(requests('PUT', APP_URL)).toHaveLength(1));
    expect(requests('PUT', APP_URL)[0].data.enabled).toBe(false);
    expect(server.state.app.enabled).toBe(false);
  });
});

describe('one control that changes the published state', () => {
  /** Every control of the page that publishes or unpublishes, by its accessible name. */
  function publishControls() {
    const names = new Set([
      TEXT.publish.action,
      TEXT.unpublish.action,
      TEXT.enabled,
      en.admin.apps.status.published,
      en.admin.apps.status.notPublished
    ]);
    return ['button', 'menuitem', 'checkbox', 'switch'].flatMap(role =>
      screen.queryAllByRole(role, { name: name => names.has(name) })
    );
  }

  test('an app that is not published has "Publish" and nothing else', async () => {
    await renderEditor();
    const menu = openMore();

    const controls = publishControls();

    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveTextContent(TEXT.publish.action);
    expect(within(menu).queryByRole('menuitem', { name: TEXT.unpublish.action })).toBeNull();
  });

  test('a published app has "Unpublish" under "More" and nothing else', async () => {
    await renderEditor({ app: { ...APP, enabled: true } });
    openMore();

    const controls = publishControls();

    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveTextContent(TEXT.unpublish.action);
    expect(screen.queryByRole('button', { name: TEXT.publish.action })).toBeNull();
  });

  test('the form, which the page renders, has no control for it', () => {
    // The form is a stand-in in this file, so this reads its source: no part of
    // the form writes the app's `enabled` field or shows the "Enabled" label.
    const formRoot = path.resolve(__dirname, '../../../client/src/features/admin/components');
    const sources = [
      path.join(formRoot, 'AppFormEditor.jsx'),
      ...fs
        .readdirSync(path.join(formRoot, 'app-form'))
        .filter(name => /\.jsx?$/.test(name))
        .map(name => path.join(formRoot, 'app-form', name))
    ];

    const offenders = sources.filter(file => {
      const source = fs.readFileSync(file, 'utf8');
      return (
        /handleInputChange\(\s*['"]enabled['"]/.test(source) ||
        /['"]admin\.apps\.edit\.enabled['"]/.test(source)
      );
    });

    expect(offenders.map(file => path.basename(file))).toEqual([]);
  });
});
