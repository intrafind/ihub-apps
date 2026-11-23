// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The frame of the app editor (`AdminAppEditPage`; issue #2510 and the app
 * builder rework, plan sections 3.3 and 3.5).
 *
 * - Save persists and stays in the editor; there is no "Save & Exit" and no
 *   way to create an app here.
 * - The save bar sits in the form's scroll column, shows while there is
 *   something to save, names the fields that need attention and jumps to the
 *   first one. Ctrl/Cmd+S saves; leaving with unsaved changes asks.
 * - The header shows the app's name (also when it has no English name), its
 *   ID and whether it is published; "More" holds the secondary actions.
 * - Arriving with `?created=1` opens the test chat, says that the app exists
 *   and shows the next steps, once.
 * - The test panel renders the real chat, embedded, for the saved app, also
 *   when the app is not published, and restarts it after a save.
 *
 * The page, its parts, the admin API module, the save bar, the test panel and
 * the group state are the real ones, with the real English and German texts.
 */

import fs from 'fs';
import path from 'path';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// Stand in for a subpath deployment, so the links must carry the base path.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => `/ihub${p}`,
  buildApiUrl: p => `/api${p}`
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));

const mockFetchModels = jest.fn();
const mockFetchAppDetails = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchModels: (...args) => mockFetchModels(...args),
  fetchUIConfig: jest.fn(() => Promise.resolve({})),
  fetchAppDetails: (...args) => mockFetchAppDetails(...args)
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(() => Promise.resolve(null))
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

// The chat page itself has its own suites (app-chat-embedded); here it only
// has to show which app it was handed, how, and each time it mounts.
const mockChatMounts = [];
jest.mock('../../../client/src/features/apps/pages/AppChat', () => {
  const React = require('react');
  return function AppChat(props) {
    React.useEffect(() => {
      mockChatMounts.push(props);
    }, []);
    return (
      <div data-testid="app-chat" data-embedded={String(props.embedded)}>
        {props.appId}: {props.preloadedApp?.name?.en}
      </div>
    );
  };
});

jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => props => (
  <div data-testid="history" data-open={String(props.isOpen)} />
));
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => () => (
  <div data-testid="content-access-section" />
));
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

const { createAppServer } = require('./helpers/appEditorHarness');
const { AuthContext } = require('../../../client/src/shared/contexts/authContextValue');
const AdminAppEditPage =
  require('../../../client/src/features/admin/pages/AdminAppEditPage').default;

const TEXT = en.admin.apps.edit;
const DONE = en.admin.apps.create.done;
const SAVED_APP = {
  id: 'chat',
  type: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  system: { en: 'You are a helpful assistant.' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  enabled: true
};
const APP_URL = '/admin/apps/chat';

let server;
const originalMatchMedia = window.matchMedia;

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>
  );
}

/**
 * @param {object} [options]
 * @param {object} [options.app] - The stored app.
 * @param {string} [options.path] - Where the editor is opened.
 * @param {object|null} [options.user] - Who is signed in; without one the page is
 *   rendered outside an auth provider, as for someone who is no full admin.
 */
async function renderEditor({
  app = SAVED_APP,
  path: route = '/admin/apps/chat',
  user = null
} = {}) {
  server = createAppServer({ app });
  mockRequest.mockImplementation(server.request);
  const routes = (
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/admin/apps/new" element={<div>New app page</div>} />
        <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
        <Route path="/admin/apps" element={<div>Apps list</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
  const view = render(
    user ? <AuthContext.Provider value={{ user }}>{routes}</AuthContext.Provider> : routes
  );
  await screen.findByRole('heading', { level: 1 });
  return view;
}

/** From `lg` up the test panel sits beside the editor and takes no focus. */
function wideWindow() {
  window.matchMedia = () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
}

const saveBar = () => screen.queryByRole('region', { name: mockI18n.t('admin.ui.saveBar.label') });
const saveButton = () => within(saveBar()).getByRole('button', { name: 'Save Changes' });
const puts = () => server.calls.filter(call => call.method === 'PUT' && call.url === APP_URL);
const editName = value => fireEvent.change(screen.getByLabelText('Name'), { target: { value } });
const testButton = () => screen.getByRole('button', { name: /^(Test|Hide test)$/ });
const location = () => screen.getByTestId('location').textContent;

function chooseMore(label) {
  fireEvent.click(screen.getByRole('button', { name: TEXT.more }));
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: label }));
}

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false },
    // A call that carries its own fallback text gets it, as in the product;
    // a key without one shows up as missing.
    parseMissingKeyHandler: (key, fallback) => fallback ?? `MISSING:${key}`
  });
});

beforeEach(async () => {
  await mockI18n.changeLanguage('en');
  mockRequest.mockReset();
  mockFetchModels.mockReset();
  mockFetchModels.mockResolvedValue([{ id: 'stub', name: 'Stub model', default: true }]);
  mockFetchAppDetails.mockReset();
  mockFetchAppDetails.mockImplementation(appId =>
    Promise.resolve({ ...server.state.app, id: appId })
  );
  mockChatMounts.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  jest.restoreAllMocks();
});

describe('saving', () => {
  test('Save persists, stays in the editor and clears the dirty state', async () => {
    await renderEditor();
    expect(saveBar()).not.toBeInTheDocument();

    editName('Chat 2');
    fireEvent.click(saveButton());

    expect(await screen.findByText(TEXT.saved)).toBeInTheDocument();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].data.name.en).toBe('Chat 2');
    expect(location()).toBe('/admin/apps/chat');
    expect(saveBar()).not.toBeInTheDocument();

    // Leaving right after the save is not blocked by the unsaved-changes guard.
    fireEvent.click(screen.getByRole('link', { name: en.admin.apps.title }));
    expect(await screen.findByText('Apps list')).toBeInTheDocument();
    expect(screen.queryByText(en.admin.unsavedChanges.message)).not.toBeInTheDocument();
  });

  test('what is sent is the cleaned app, not the editor’s padding', async () => {
    await renderEditor();
    // The editor pads the loaded app for the form …
    expect(JSON.parse(screen.getByTestId('form-value').textContent).upload.enabled).toBe(false);

    editName('Chat 2');
    fireEvent.click(saveButton());
    await screen.findByText(TEXT.saved);

    // … and `cleanAppForSave` takes the switched-off upload block out again.
    expect(puts()[0].data).not.toHaveProperty('upload');
    expect(puts()[0].data).toMatchObject({ id: 'chat', name: { en: 'Chat 2' }, enabled: true });
  });

  test('there is no "Save & Exit", and the editor never creates an app', async () => {
    await renderEditor();
    editName('Chat 2');

    expect(screen.queryByRole('button', { name: /Save & Exit/ })).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await screen.findByText(TEXT.saved);
    expect(server.writes().map(call => call.method)).toEqual(['PUT']);

    // Neither the page nor its parts hold a default app, a "new" mode or a
    // request that creates one.
    const adminRoot = path.resolve(__dirname, '../../../client/src/features/admin');
    const partsRoot = path.join(adminRoot, 'components/app-editor');
    const sources = [
      path.join(adminRoot, 'pages/AdminAppEditPage.jsx'),
      ...fs.readdirSync(partsRoot).map(name => path.join(partsRoot, name))
    ];
    expect(sources.length).toBeGreaterThan(5);
    const offenders = sources.filter(file =>
      /makeDefault|newAppDefaults|isNew|saveAndExit|['"]POST['"]/.test(
        fs.readFileSync(file, 'utf8')
      )
    );
    expect(offenders.map(file => path.basename(file))).toEqual([]);
  });

  test('"new" is an ID like any other: the editor looks it up and offers nothing to create', async () => {
    server = createAppServer({ app: SAVED_APP });
    mockRequest.mockImplementation(server.request);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={['/admin/apps/new']}>
        <Routes>
          <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
          <Route path="/admin/apps" element={<div>Apps list</div>} />
        </Routes>
      </MemoryRouter>
    );

    // The stand-in server has no app "new" and answers 404.
    fireEvent.click(await screen.findByRole('button', { name: TEXT.backToApps }));

    expect(screen.getByText('Apps list')).toBeInTheDocument();
    expect(server.calls.map(call => `${call.method} ${call.url}`)).toContain('GET /admin/apps/new');
    expect(server.writes()).toEqual([]);
  });

  test('Ctrl+S and Cmd+S save without leaving the editor', async () => {
    await renderEditor();

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(await screen.findByText(TEXT.saved)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(location()).toBe('/admin/apps/chat');
  });

  test('two key presses in a row send one request', async () => {
    await renderEditor();
    editName('Chat 2');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(await screen.findByText(TEXT.saved)).toBeInTheDocument();
    expect(puts()).toHaveLength(1);
  });

  test('other key combinations do not save', async () => {
    await renderEditor();
    editName('Chat 2');

    fireEvent.keyDown(window, { key: 's' });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true });
    await act(async () => {});

    expect(server.writes()).toEqual([]);
  });

  test('a failed save says why and keeps the edit unsaved', async () => {
    await renderEditor();
    const failure = new Error('Request failed with status code 400');
    failure.response = { status: 400, data: { detail: 'The name is too long.' }, headers: {} };
    server.failures[`PUT ${APP_URL}`] = failure;

    editName('Chat 2');
    fireEvent.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('The name is too long.');
    expect(screen.getByLabelText('Name')).toHaveValue('Chat 2');
    expect(saveBar()).toBeInTheDocument();
  });

  test('leaving with unsaved changes asks first', async () => {
    await renderEditor();
    editName('Chat 2');

    fireEvent.click(screen.getByRole('link', { name: en.admin.apps.title }));

    expect(await screen.findByText(en.admin.unsavedChanges.message)).toBeInTheDocument();
    expect(location()).toBe('/admin/apps/chat');
  });
});

describe('the save bar', () => {
  test('is in the form’s scroll column, not at page level and not in the test panel', async () => {
    wideWindow();
    await renderEditor();
    fireEvent.click(testButton());
    await screen.findByTestId('app-chat');
    editName('Chat 2');

    const bar = saveBar();
    const column = bar.parentElement;
    // The column that scrolls beside the open test panel …
    expect(column).toHaveClass('lg:overflow-y-auto');
    // … holds the form and the bar; the panel is its sibling.
    expect(column).toContainElement(screen.getByTestId('app-form'));
    const panel = screen.getByLabelText(en.admin.apps.test.title);
    expect(column).not.toContainElement(panel);
    expect(panel).not.toContainElement(bar);
    expect(column.parentElement).toContainElement(panel);
  });

  test('Discard takes the edits back without a request', async () => {
    await renderEditor();
    editName('Chat 2');

    fireEvent.click(within(saveBar()).getByRole('button', { name: 'Discard' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Chat');
    expect(saveBar()).not.toBeInTheDocument();
    expect(server.writes()).toEqual([]);
  });

  test('says for a published app that users get the change on save', async () => {
    await renderEditor();
    editName('Chat 2');

    expect(saveBar()).toHaveTextContent(TEXT.liveHint);
  });

  test('says nothing of the kind for an app that is not published', async () => {
    await renderEditor({ app: { ...SAVED_APP, enabled: false } });
    editName('Chat 2');

    expect(saveBar()).toBeInTheDocument();
    expect(saveBar()).not.toHaveTextContent(TEXT.liveHint);
  });

  test('names one field in the singular and several in the plural', async () => {
    await renderEditor();
    editName('Chat 2');

    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));
    expect(saveBar()).toHaveTextContent('1 field needs your attention.');
    // The count takes the place of the hint: a save cannot go through yet.
    expect(saveBar()).not.toHaveTextContent(TEXT.liveHint);

    fireEvent.click(screen.getByRole('button', { name: 'report two errors' }));
    expect(saveBar()).toHaveTextContent('2 fields need your attention.');

    fireEvent.click(screen.getByRole('button', { name: 'report valid' }));
    expect(saveBar()).not.toHaveTextContent(/need(s)? your attention/);
  });

  test('names the fields in German too', async () => {
    await mockI18n.changeLanguage('de');
    await renderEditor();
    editName('Chat 2');

    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));
    expect(saveBar()).toHaveTextContent('1 Feld benötigt Ihre Aufmerksamkeit.');
    fireEvent.click(screen.getByRole('button', { name: 'report two errors' }));
    expect(saveBar()).toHaveTextContent('2 Felder benötigen Ihre Aufmerksamkeit.');
    expect(within(saveBar()).getByRole('button', { name: 'Anzeigen' })).toBeInTheDocument();
  });

  test('"Show" opens the group of the first field and moves the focus to it', async () => {
    await renderEditor();
    editName('Chat 2');
    fireEvent.click(screen.getByRole('button', { name: 'report two errors' }));
    // The author collapsed the group that holds the field.
    const header = screen.getByRole('button', { name: 'group:instructions' });
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(within(saveBar()).getByRole('button', { name: TEXT.showFirstError }));

    expect(header).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getByLabelText('Instructions')).toHaveFocus());
  });

  test('Save with a field that needs attention sends nothing and shows the field', async () => {
    await renderEditor();
    editName('Chat 2');
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByLabelText('Instructions')).toHaveFocus());
    expect(server.writes()).toEqual([]);
    expect(saveBar()).toBeInTheDocument();
  });

  test('in the JSON editor there is no field to jump to, so no "Show" and no index', async () => {
    await renderEditor();
    expect(screen.getByTestId('group-nav')).toBeInTheDocument();
    editName('Chat 2');
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));
    fireEvent.click(screen.getByRole('button', { name: 'JSON mode' }));

    // The JSON editor names no field, so the bar counts none; it says why Save will not go through.
    expect(saveBar()).toHaveTextContent(TEXT.validationErrorsExist);
    expect(saveBar()).not.toHaveTextContent(/needs? your attention/);
    expect(within(saveBar()).queryByRole('button', { name: TEXT.showFirstError })).toBeNull();
    expect(screen.queryByTestId('group-nav')).not.toBeInTheDocument();

    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(TEXT.validationErrorsExist);
    expect(server.writes()).toEqual([]);
  });

  test('a warning of the JSON editor is not a field that needs attention, and Save goes through', async () => {
    await renderEditor();
    editName('Chat 2');
    fireEvent.click(screen.getByRole('button', { name: 'JSON mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'report a JSON warning' }));

    expect(saveBar()).not.toHaveTextContent(/needs? your attention/);
    expect(saveBar()).not.toHaveTextContent(TEXT.validationErrorsExist);
    expect(saveBar()).toHaveTextContent(TEXT.liveHint);

    fireEvent.click(saveButton());
    await waitFor(() => expect(puts()).toHaveLength(1));

    // Back in the form no group was opened or marked for it.
    fireEvent.click(screen.getByRole('button', { name: 'Form mode' }));
    expect(screen.getByTestId('group-nav')).toBeInTheDocument();
  });

  test('beside the open test chat the form is marked as narrow, so its cards are one column', async () => {
    wideWindow();
    await renderEditor();
    const column = () => screen.getByTestId('app-form').closest('[data-form-narrow]');
    expect(column()).toBeNull();

    fireEvent.click(testButton());
    expect(column()).not.toBeNull();

    fireEvent.click(testButton());
    expect(column()).toBeNull();
  });
});

describe('the header', () => {
  test('shows the name as the heading, the ID and the status', async () => {
    await renderEditor();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Chat');
    expect(screen.getByTestId('app-id')).toHaveTextContent('chat');
    expect(screen.getByTestId('app-status')).toHaveTextContent(en.admin.apps.status.published);
  });

  test('follows the name while the author types', async () => {
    await renderEditor();

    editName('Chat for sales');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Chat for sales');
  });

  test('shows the name of an app that is named only in German, in an English UI too', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await renderEditor({
      app: { ...SAVED_APP, name: { de: 'Zusammenfassung in einfacher Sprache' }, enabled: false }
    });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Zusammenfassung in einfacher Sprache'
    );
    expect(screen.getByTestId('app-id')).toHaveTextContent('chat');
    expect(screen.getByTestId('app-status')).toHaveTextContent(en.admin.apps.status.notPublished);
    // The breadcrumb names the app the same way.
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail).toHaveTextContent('Zusammenfassung in einfacher Sprache');
  });

  test('resolves the name by the base language of a regional UI language', async () => {
    await mockI18n.changeLanguage('de-DE');
    await renderEditor({ app: { ...SAVED_APP, name: { en: 'Chat', de: 'Plaudern' } } });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Plaudern');
  });

  test('status, actions and breadcrumb are translated', async () => {
    await mockI18n.changeLanguage('de');
    await renderEditor({ app: { ...SAVED_APP, enabled: false } });

    expect(screen.getByTestId('app-status')).toHaveTextContent('Nicht veröffentlicht');
    expect(screen.getByRole('button', { name: 'Veröffentlichen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Testen' })).toBeInTheDocument();
    const trail = screen.getByRole('navigation', { name: de.admin.breadcrumbLabel });
    expect(within(trail).getByRole('link', { name: de.documentTitle.admin })).toHaveAttribute(
      'href',
      '/admin'
    );
    expect(within(trail).getByRole('link', { name: de.admin.apps.title })).toHaveAttribute(
      'href',
      '/admin/apps'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mehr' }));
    const items = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map(item => item.textContent);
    expect(items).toEqual(['App öffnen', 'Verlauf', 'Herunterladen', 'Duplizieren']);
    expect(document.body).not.toHaveTextContent('MISSING:');
  });

  test('"More" opens the app under the base path in a new tab', async () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    await renderEditor();

    chooseMore(en.admin.apps.openApp);

    expect(open).toHaveBeenCalledWith('/ihub/apps/chat', '_blank', 'noopener,noreferrer');
  });

  test('"More" opens the history and duplicates through the "New app" page', async () => {
    await renderEditor();

    chooseMore(TEXT.history);
    expect(screen.getByTestId('history')).toHaveAttribute('data-open', 'true');

    chooseMore(en.admin.apps.list.duplicate);
    expect(await screen.findByText('New app page')).toBeInTheDocument();
    expect(location()).toBe('/admin/apps/new?from=chat');
  });
});

describe('arriving from "Create and test"', () => {
  const NEW_APP = { ...SAVED_APP, name: { en: 'Plain-language summary' }, enabled: false };
  const CREATED = '/admin/apps/chat?created=1';

  test('opens the test chat, says that the app exists, shows the next steps and cleans the URL', async () => {
    wideWindow();
    await renderEditor({ app: NEW_APP, path: CREATED });

    expect(await screen.findByText('App "Plain-language summary" created')).toBeInTheDocument();
    expect(await screen.findByTestId('app-chat')).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: DONE.heading });
    expect(heading).toHaveFocus();
    expect(screen.getByText(DONE.body)).toBeInTheDocument();
    await waitFor(() => expect(location()).toBe('/admin/apps/chat'));
    // Removing the marker is not an edit.
    expect(saveBar()).not.toBeInTheDocument();
  });

  test('keeps the rest of the URL', async () => {
    await renderEditor({ app: NEW_APP, path: '/admin/apps/chat?created=1&tab=x#access' });

    await screen.findByText('App "Plain-language summary" created');
    await waitFor(() => expect(location()).toBe('/admin/apps/chat?tab=x#access'));
  });

  test('happens once: a later visit shows the steps, but no toast and no test chat', async () => {
    const first = await renderEditor({ app: NEW_APP, path: CREATED });
    await screen.findByText('App "Plain-language summary" created');
    first.unmount();

    await renderEditor({ app: NEW_APP });

    expect(screen.getByRole('heading', { name: DONE.heading })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: DONE.heading })).not.toHaveFocus();
    expect(screen.queryByText('App "Plain-language summary" created')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();
  });

  test('an app that was not just created shows no steps', async () => {
    await renderEditor();

    expect(screen.queryByRole('heading', { name: DONE.heading })).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();
  });

  test('"Hide these steps" is remembered for this app', async () => {
    const first = await renderEditor({ app: NEW_APP, path: CREATED });
    const dismiss = await screen.findByRole('button', { name: DONE.dismiss });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(screen.queryByRole('heading', { name: DONE.heading })).not.toBeInTheDocument();
    // The button went with the card; the focus is on the page's heading, not on <body>.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    first.unmount();

    await renderEditor({ app: NEW_APP });
    expect(screen.queryByRole('heading', { name: DONE.heading })).not.toBeInTheDocument();
  });

  test('an app that is created again under the ID of a hidden one gets its steps', async () => {
    const first = await renderEditor({ app: NEW_APP, path: CREATED });
    fireEvent.click(await screen.findByRole('button', { name: DONE.dismiss }));
    first.unmount();

    // The first app was deleted; another one was created with the same ID.
    await renderEditor({ app: { ...NEW_APP, name: { en: 'Second try' } }, path: CREATED });

    expect(await screen.findByText('App "Second try" created')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: DONE.heading })).toBeInTheDocument();
  });

  test('the steps show for this visit when the browser keeps nothing', async () => {
    // Only for the card's own entries; the rest of the page reads storage too.
    const refuse = original =>
      function refusing(key, ...rest) {
        if (String(key).includes('appNextSteps')) throw new Error('storage is not available');
        return original.call(this, key, ...rest);
      };
    const { getItem, setItem } = Storage.prototype;
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse(setItem));
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse(getItem));

    await renderEditor({ app: NEW_APP, path: CREATED });

    expect(await screen.findByRole('heading', { name: DONE.heading })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: DONE.dismiss }));
    expect(screen.queryByRole('heading', { name: DONE.heading })).not.toBeInTheDocument();
  });

  test('the steps for input fields and conversation starters open their group and focus it', async () => {
    wideWindow();
    await renderEditor({ app: NEW_APP, path: CREATED });
    await screen.findByText('App "Plain-language summary" created');
    const header = screen.getByRole('button', { name: 'group:instructions' });
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: DONE.steps.inputFields }));
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(header).toHaveFocus());

    fireEvent.click(header);
    screen.getByRole('heading', { name: DONE.heading }).focus();
    fireEvent.click(screen.getByRole('button', { name: DONE.steps.starters }));
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(header).toHaveFocus());
  });

  test('from the JSON editor a step of the form brings the form back and then focuses its group', async () => {
    wideWindow();
    await renderEditor({ app: NEW_APP, path: CREATED });
    await screen.findByText('App "Plain-language summary" created');
    fireEvent.click(screen.getByRole('button', { name: 'JSON mode' }));
    expect(screen.queryByRole('button', { name: 'group:instructions' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: DONE.steps.inputFields }));

    const header = await screen.findByRole('button', { name: 'group:instructions' });
    expect(screen.getByTestId('group-nav')).toBeInTheDocument();
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(header).toHaveFocus());
  });

  test('from the JSON editor the step for access stays in the JSON editor', async () => {
    wideWindow();
    await renderEditor({ app: NEW_APP, path: CREATED });
    await screen.findByText('App "Plain-language summary" created');
    fireEvent.click(screen.getByRole('button', { name: 'JSON mode' }));

    fireEvent.click(screen.getByRole('button', { name: DONE.steps.access }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'group:access' })).toHaveFocus());
    expect(screen.queryByTestId('group-nav')).not.toBeInTheDocument();
  });

  test('a link app is offered only the steps it has: no test, no input fields, no starters', async () => {
    await renderEditor({
      app: { ...NEW_APP, type: 'redirect', redirectConfig: { url: 'https://example.com' } },
      path: CREATED
    });
    await screen.findByText('App "Plain-language summary" created');

    const steps = screen.getByRole('heading', { name: DONE.heading }).closest('section');
    const offered = within(steps)
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(offered).toEqual([DONE.steps.access, DONE.steps.publish]);
  });

  test('the step "Check who can use the app" opens that group and focuses it', async () => {
    wideWindow();
    await renderEditor({ app: NEW_APP, path: CREATED });
    await screen.findByText('App "Plain-language summary" created');
    const header = screen.getByRole('button', { name: 'group:access' });
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: DONE.steps.access }));

    expect(header).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(header).toHaveFocus());
    expect(screen.getByTestId('content-access-section')).toBeVisible();
  });

  test('the step "Test it" leads to the test chat, the step "Publish" to the dialog', async () => {
    wideWindow();
    await renderEditor({ app: NEW_APP, path: CREATED });
    await screen.findByText('App "Plain-language summary" created');

    fireEvent.click(screen.getByRole('button', { name: DONE.steps.test }));
    await waitFor(() => expect(screen.getByLabelText(en.admin.apps.test.title)).toHaveFocus());

    // The last step; the header has a button of the same name.
    const steps = screen.getByRole('heading', { name: DONE.heading }).closest('section');
    fireEvent.click(within(steps).getByRole('button', { name: DONE.steps.publish }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Publish "Plain-language summary"?'
    );
  });

  test('offers the guide to someone who may open the documentation only', async () => {
    const first = await renderEditor({
      app: NEW_APP,
      path: CREATED,
      user: { id: 'builder', isAdmin: false, isContentAdmin: true, permissions: {} }
    });
    await screen.findByText('App "Plain-language summary" created');

    // The documentation is for full admins; it would refuse a content admin.
    expect(screen.getByRole('heading', { name: DONE.heading })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: DONE.guide })).not.toBeInTheDocument();
    first.unmount();

    await renderEditor({ app: NEW_APP, user: { id: 'admin', isAdmin: true } });

    const guide = screen.getByRole('link', { name: DONE.guide });
    expect(guide).toHaveAttribute('href', '/ihub/admin/docs/app-quickstart.md');
    // In a new tab, so that the editor and its unsaved edits stay as they are.
    expect(guide).toHaveAttribute('target', '_blank');
  });

  test('a published app is not offered "Publish" among the steps', async () => {
    await renderEditor({ app: { ...NEW_APP, enabled: true }, path: CREATED });
    await screen.findByText('App "Plain-language summary" created');

    const steps = screen.getByRole('heading', { name: DONE.heading }).closest('section');
    expect(within(steps).getByRole('button', { name: DONE.steps.test })).toBeInTheDocument();
    expect(within(steps).queryByRole('button', { name: DONE.steps.publish })).toBeNull();
  });
});

describe('the test panel', () => {
  test('embeds the saved app and restarts it after a save', async () => {
    await renderEditor();
    expect(screen.getByTestId('group-nav')).toHaveAttribute('data-compact', 'false');

    fireEvent.click(testButton());
    const chat = await screen.findByTestId('app-chat');
    expect(chat).toHaveAttribute('data-embedded', 'true');
    expect(chat).toHaveTextContent('chat: Chat');
    expect(document.querySelector('iframe')).toBeNull();
    expect(mockFetchAppDetails).toHaveBeenCalledWith('chat');
    expect(mockChatMounts).toHaveLength(1);
    // Beside the panel the form has less room; the index is told so.
    expect(screen.getByTestId('group-nav')).toHaveAttribute('data-compact', 'true');

    // Unsaved edits are not in the test yet, and the panel says so.
    editName('Chat 2');
    expect(screen.getByText(en.admin.apps.test.unsavedHint)).toBeInTheDocument();

    fireEvent.click(saveButton());
    await screen.findByText(TEXT.saved);

    // The saved app is fetched again and the chat starts over with it.
    expect(await screen.findByText('chat: Chat 2')).toBeInTheDocument();
    expect(mockFetchAppDetails).toHaveBeenCalledTimes(2);
    expect(mockChatMounts).toHaveLength(2);
    expect(screen.queryByText(en.admin.apps.test.unsavedHint)).not.toBeInTheDocument();

    // Restart does the same without a save.
    fireEvent.click(screen.getByRole('button', { name: en.admin.apps.test.restart }));
    await waitFor(() => expect(mockChatMounts).toHaveLength(3));

    // Opening and closing the panel never trips the unsaved-changes guard.
    editName('Chat 3');
    fireEvent.click(screen.getByRole('button', { name: en.admin.apps.test.close }));
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();
    expect(screen.queryByText(en.admin.unsavedChanges.message)).not.toBeInTheDocument();
  });

  test('runs an app that is not published and says that nobody else sees it', async () => {
    await renderEditor({ app: { ...SAVED_APP, enabled: false } });

    fireEvent.click(testButton());

    expect(await screen.findByTestId('app-chat')).toHaveTextContent('chat: Chat');
    expect(screen.getByTestId('test-not-published')).toHaveTextContent(TEXT.notPublishedHint);
    expect(screen.queryByText(en.admin.apps.test.disabled)).not.toBeInTheDocument();
  });

  test('a published app carries no such hint', async () => {
    await renderEditor();

    fireEvent.click(testButton());

    await screen.findByTestId('app-chat');
    expect(screen.queryByTestId('test-not-published')).not.toBeInTheDocument();
  });

  test('when the author’s groups cannot use the new app, it says so and leads to the access group', async () => {
    wideWindow();
    await renderEditor({ app: { ...SAVED_APP, enabled: false } });
    const notFound = new Error('Request failed with status code 404');
    notFound.status = 404;
    mockFetchAppDetails.mockRejectedValue(notFound);

    fireEvent.click(testButton());

    expect(await screen.findByText(TEXT.testNoAccess.title)).toBeInTheDocument();
    expect(screen.getByText(TEXT.testNoAccess.body)).toBeInTheDocument();
    expect(screen.queryByText(en.admin.apps.test.loadError)).not.toBeInTheDocument();

    const header = screen.getByRole('button', { name: 'group:access' });
    fireEvent.click(screen.getByRole('button', { name: TEXT.groups.access }));
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(header).toHaveFocus());
  });

  test('covering the editor, it makes way for the access group', async () => {
    await renderEditor({ app: { ...SAVED_APP, enabled: false } });
    const notFound = new Error('Request failed with status code 404');
    notFound.status = 404;
    mockFetchAppDetails.mockRejectedValue(notFound);
    fireEvent.click(testButton());

    fireEvent.click(await screen.findByRole('button', { name: TEXT.groups.access }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const header = screen.getByRole('button', { name: 'group:access' });
    await waitFor(() => expect(header).toHaveFocus());
    // The focus stays there; closing the panel does not pull it back to "Test".
    await act(async () => {});
    expect(header).toHaveFocus();
  });

  test('without a model it explains that instead of showing a chat', async () => {
    mockFetchModels.mockResolvedValue([]);
    await renderEditor();

    fireEvent.click(testButton());

    expect(await screen.findByText(en.admin.apps.create.noModel.title)).toBeInTheDocument();
    expect(screen.getByText(en.admin.apps.create.noModel.actionOther)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: en.admin.apps.create.noModel.actionAdmin })
    ).toBeNull();
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();
    expect(mockFetchAppDetails).not.toHaveBeenCalled();
  });

  test('without a model it leads a full admin to the page where one is set up', async () => {
    mockFetchModels.mockResolvedValue([]);
    await renderEditor({ user: { id: 'admin', permissions: { adminAccess: true } } });

    fireEvent.click(testButton());

    const setup = await screen.findByRole('link', {
      name: en.admin.apps.create.noModel.actionAdmin
    });
    expect(setup).toHaveAttribute('href', '/admin/models');
  });

  test('a model list that could not be loaded is not read as "no model"', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchModels.mockRejectedValue(new Error('offline'));
    await renderEditor();

    fireEvent.click(testButton());

    expect(await screen.findByTestId('app-chat')).toBeInTheDocument();
    expect(screen.queryByText(en.admin.apps.create.noModel.title)).not.toBeInTheDocument();
  });

  test('explains that only chat apps can be tested in it', async () => {
    await renderEditor({ app: { ...SAVED_APP, type: 'iframe' } });

    fireEvent.click(testButton());

    expect(await screen.findByText(en.admin.apps.test.chatOnly)).toBeInTheDocument();
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();
  });
});
