// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat builder's conversation in the admin app editor (plan
 * concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md,
 * slice 1: sections 2.4, 2.5, 2.7 and 3), and the editor's conditional save
 * (`ETag` / `If-Match`, 412).
 *
 * - "Form | Conversation" in the header, only with `appBuilderChat` on; the
 *   view is `?view=conversation`, and opening it opens the test chat.
 * - A turn sends the app's content and the conversation to
 *   `POST /api/admin/apps/_revise`; a question shows its choices, a change its
 *   diff and who gets it.
 * - Apply saves through the editor's save (with `If-Match`) and restarts the
 *   test chat; a 412 writes nothing and says so; a hand edit since disables
 *   Apply; Undo saves the values from before, and is disabled once a changed
 *   part was edited again.
 *
 * The page, its parts, the admin API module and the conversation are the real
 * ones, with the real English texts; the server is the harness stand-in.
 */

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
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => p,
  buildApiUrl: p => `/api${p}`
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));
const mockFetchAppDetails = jest.fn();
jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(() => Promise.resolve([{ id: 'stub', name: 'Stub', default: true }])),
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

const mockChatMounts = [];
jest.mock('../../../client/src/features/apps/pages/AppChat', () => {
  const React = require('react');
  return function AppChat(props) {
    React.useEffect(() => {
      mockChatMounts.push(props);
    }, []);
    return <div data-testid="app-chat">{props.appId}</div>;
  };
});
jest.mock('../../../client/src/features/admin/components/AppFormEditor', () => () => null);
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => () => null);
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => () => null);
jest.mock(
  '../../../client/src/shared/components/DualModeEditor',
  () => require('./helpers/appEditorHarness').MockDualModeEditor
);
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
const {
  PlatformConfigContext
} = require('../../../client/src/shared/contexts/platformConfigContextValue');
const AdminAppEditPage =
  require('../../../client/src/features/admin/pages/AdminAppEditPage').default;

const TEXT = en.admin.apps.conversation;
const EDIT = en.admin.apps.edit;
const APP = {
  id: 'chat',
  type: 'chat',
  name: { en: 'Chat' },
  description: { en: 'General chat' },
  system: { en: 'Answer in a friendly tone.' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  enabled: false
};
const APP_URL = '/admin/apps/chat';
const REVISE_URL = '/admin/apps/_revise';

let server;
const originalMatchMedia = window.matchMedia;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function wideWindow(matches = true) {
  window.matchMedia = () => ({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
}

async function renderEditor({
  app = APP,
  path = `${APP_URL}?view=conversation`,
  features = { appBuilderChat: true }
} = {}) {
  server = createAppServer({ app, etags: true });
  mockRequest.mockImplementation(server.request);
  const view = render(
    <PlatformConfigContext.Provider value={{ platformConfig: { featuresMap: features } }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/apps/:appId" element={<AdminAppEditPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </PlatformConfigContext.Provider>
  );
  await screen.findByRole('heading', { level: 1 });
  return view;
}

const location = () => screen.getByTestId('location').textContent;
const composer = () => screen.getByRole('textbox', { name: TEXT.composer.label });
const reviseCalls = () => server.calls.filter(call => call.url === REVISE_URL);
const puts = () => server.calls.filter(call => call.method === 'PUT' && call.url === APP_URL);
const viewButton = name =>
  within(screen.getByRole('group', { name: TEXT.view.label })).getByRole('button', { name });

/** Types a message and presses Enter; resolves once the answer is in the log. */
async function say(text) {
  fireEvent.change(composer(), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(composer(), { key: 'Enter' });
  });
  await waitFor(() => expect(screen.queryByText(TEXT.working)).not.toBeInTheDocument());
}

function changeAnswer(patch = { system: { en: 'Address the reader formally.' } }) {
  return {
    reply: 'change',
    text: 'Here is the change.',
    question: null,
    patch,
    changed: Object.keys(patch),
    suggestions: { websearch: false, integrations: [] },
    warnings: [],
    model: { id: 'stub', name: 'Stub' }
  };
}

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false }
  });
});

beforeEach(() => {
  mockRequest.mockReset();
  mockChatMounts.length = 0;
  mockFetchAppDetails.mockReset();
  mockFetchAppDetails.mockImplementation(appId =>
    Promise.resolve({ ...server.state.app, id: appId })
  );
  window.sessionStorage.clear();
  window.localStorage.clear();
  wideWindow();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('the view', () => {
  test('without appBuilderChat there is no conversation, even with ?view=conversation', async () => {
    await renderEditor({ features: {} });
    expect(screen.queryByRole('group', { name: TEXT.view.label })).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversation-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-form')).toBeInTheDocument();
  });

  test('without appGenerator there is no conversation either', async () => {
    await renderEditor({ features: { appBuilderChat: true, appGenerator: false } });
    expect(screen.queryByTestId('conversation-panel')).not.toBeInTheDocument();
  });

  test('Form | Conversation switches the view in the URL and opens the test chat', async () => {
    await renderEditor({ path: APP_URL });
    expect(viewButton(TEXT.view.form)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();

    fireEvent.click(viewButton(TEXT.view.conversation));
    expect(await screen.findByTestId('conversation-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('app-form')).not.toBeInTheDocument();
    expect(location()).toBe(`${APP_URL}?view=conversation`);
    expect(await screen.findByTestId('app-chat')).toBeInTheDocument();

    fireEvent.click(viewButton(TEXT.view.form));
    expect(screen.getByTestId('app-form')).toBeInTheDocument();
    expect(location()).toBe(APP_URL);
  });

  test('on a small screen the conversation is the page and the test stays closed', async () => {
    wideWindow(false);
    await renderEditor();
    expect(screen.getByTestId('conversation-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();
  });

  test('after a create from a description the editor opens with the conversation', async () => {
    await renderEditor({ path: `${APP_URL}?created=1&view=conversation` });
    expect(screen.getByTestId('conversation-panel')).toBeInTheDocument();
    await waitFor(() => expect(location()).toBe(`${APP_URL}?view=conversation`));
    expect(await screen.findByTestId('app-chat')).toBeInTheDocument();
  });
});

describe('a turn', () => {
  test('sends the content and the conversation; Enter sends and the focus stays', async () => {
    await renderEditor();
    server.revise.push({
      reply: 'message',
      text: 'I cannot publish; use the Publish button.',
      question: null,
      patch: {},
      changed: [],
      suggestions: {},
      warnings: [],
      model: { id: 'stub', name: 'Stub' }
    });
    composer().focus();
    await say('Publish it');

    expect(reviseCalls()).toHaveLength(1);
    expect(reviseCalls()[0].data).toEqual({
      draft: {
        name: APP.name,
        description: APP.description,
        system: APP.system,
        color: APP.color,
        icon: APP.icon
      },
      conversation: [{ role: 'author', text: 'Publish it' }],
      language: 'en'
    });
    expect(screen.getByText('I cannot publish; use the Publish button.')).toBeInTheDocument();
    expect(composer()).toHaveValue('');
    expect(composer()).toHaveFocus();
    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'polite');
  });

  test('Shift+Enter adds a line instead of sending', async () => {
    await renderEditor();
    fireEvent.change(composer(), { target: { value: 'One' } });
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(reviseCalls()).toHaveLength(0);
  });

  test('a question offers its choices, "Something else" and "Skip"; the answer is the next turn', async () => {
    await renderEditor();
    server.revise.push({
      reply: 'question',
      text: 'Which departments?',
      question: { text: 'Which departments?', choices: ['Sales', 'HR'], allowOther: true },
      patch: {},
      changed: [],
      suggestions: {},
      warnings: [],
      model: { id: 'stub', name: 'Stub' }
    });
    await say('Add a field for the department');

    const group = screen.getByRole('radiogroup', { name: 'Which departments?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: TEXT.question.other })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: TEXT.question.skip })).toBeInTheDocument();

    server.revise.push(changeAnswer());
    fireEvent.click(within(group).getByRole('radio', { name: 'HR' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.question.answer }));
    });
    await screen.findByTestId('change-card');
    expect(reviseCalls()[1].data.conversation).toEqual([
      { role: 'author', text: 'Add a field for the department' },
      { role: 'builder', kind: 'question', text: 'Which departments?' },
      { role: 'author', text: 'HR' }
    ]);
    // The answered question lost its controls.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  test('a failed turn says why and keeps the message for "Try again"', async () => {
    await renderEditor();
    server.revise.push(
      Object.assign(httpError(429, 'Too many', 'RATE_LIMITED'), {}),
      changeAnswer()
    );
    server.revise[0].response.data.details = { limiter: 'appRevise' };
    await say('Shorter');
    expect(screen.getByRole('alert')).toHaveTextContent(TEXT.error.tooManyTurns);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.retry }));
    });
    await screen.findByTestId('change-card');
    expect(reviseCalls()[1].data.conversation).toEqual([{ role: 'author', text: 'Shorter' }]);
  });

  test('Escape cancels a running turn', async () => {
    await renderEditor();
    let aborted = false;
    mockRequest.mockImplementation(config =>
      config.url === REVISE_URL
        ? new Promise((resolve, reject) =>
            config.signal.addEventListener('abort', () => {
              aborted = true;
              reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
            })
          )
        : server.request(config)
    );
    fireEvent.change(composer(), { target: { value: 'Make it formal' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(await screen.findByText(TEXT.working)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: TEXT.cancel })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(composer(), { key: 'Escape' });
    });
    expect(aborted).toBe(true);
    expect(screen.queryByText(TEXT.working)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('the conversation is kept for the tab, and "Start over" clears it', async () => {
    const first = await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    first.unmount();

    await renderEditor();
    expect(screen.getByText('Be formal')).toBeInTheDocument();
    expect(screen.getByTestId('change-card')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: TEXT.startOver }));
    expect(screen.queryByText('Be formal')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('ihub.appConversation.admin.chat')).toBeNull();
  });
});

describe('Apply and Undo', () => {
  test('Apply saves with If-Match, restarts the test chat and moves the focus to "Applied"', async () => {
    await renderEditor();
    await screen.findByTestId('app-chat');
    const mounts = mockChatMounts.length;
    server.revise.push(changeAnswer());
    await say('Be formal');

    const card = screen.getByTestId('change-card');
    expect(within(card).getByTestId('change-stakes')).toHaveTextContent(TEXT.stakes.notPublished);
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: TEXT.change.apply }));
    });

    expect(puts()).toHaveLength(1);
    expect(puts()[0].ifMatch).toBe('"1"');
    expect(server.state.app.system).toEqual({ en: 'Address the reader formally.' });
    expect(server.state.app.name).toEqual(APP.name);
    await waitFor(() => expect(mockChatMounts.length).toBe(mounts + 1));
    const applied = screen.getByTestId('change-applied');
    expect(applied).toHaveTextContent(TEXT.change.appliedTest);
    expect(applied).toHaveFocus();
    // Saved: nothing is left for the save bar.
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });

  test('a 412 on Apply writes nothing and shows the conflict', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    // Another admin saved the app meanwhile.
    server.bumpRevision();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    });

    expect(server.state.app.system).toEqual(APP.system);
    const card = screen.getByTestId('change-card');
    expect(within(card).getByRole('alert')).toHaveTextContent(TEXT.change.conflict);
    expect(screen.getByRole('heading', { name: EDIT.conflict.title })).toBeInTheDocument();
    // The form went back to what it held: nothing unsaved is left behind.
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });

  test('Apply is disabled after a hand edit of the content since the change was made', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');

    fireEvent.click(viewButton(TEXT.view.form));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    fireEvent.click(viewButton(TEXT.view.conversation));

    const apply = await screen.findByRole('button', { name: TEXT.change.apply });
    expect(apply).toBeDisabled();
    expect(screen.getByText(TEXT.change.stale)).toBeInTheDocument();
  });

  test('Undo saves the values from before through the same conditional save', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.undo }));
    });

    expect(puts()).toHaveLength(2);
    expect(puts()[1].ifMatch).toBe('"2"');
    expect(server.state.app.system).toEqual(APP.system);
    expect(screen.getByTestId('change-undone')).toHaveFocus();
  });

  test('Undo is disabled once a changed part was edited after Apply', async () => {
    await renderEditor();
    server.revise.push(changeAnswer({ name: { en: 'Formal chat' } }));
    await say('Rename it');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    });

    fireEvent.click(viewButton(TEXT.view.form));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My chat' } });
    fireEvent.click(viewButton(TEXT.view.conversation));

    const undo = await screen.findByRole('button', { name: TEXT.change.undo });
    expect(undo).toBeDisabled();
    expect(screen.getByText(TEXT.change.undoChanged)).toBeInTheDocument();
  });

  test('on a small screen a toast says to try it', async () => {
    wideWindow(false);
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    });
    expect(screen.getByTestId('editor-toast')).toHaveTextContent(TEXT.toast);
  });
});

describe('Apply and Undo with other unsaved changes in the form', () => {
  /** Changes a setting outside the content keys in the form, then goes back to the conversation. */
  function editModelInForm(model = 'big-model') {
    fireEvent.click(viewButton(TEXT.view.form));
    fireEvent.change(screen.getByLabelText('Preferred model'), { target: { value: model } });
  }

  test('without them the change card says nothing more', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    expect(screen.queryByTestId('change-also-saves')).not.toBeInTheDocument();
  });

  test('the card says Apply saves them too, and Apply saves them', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    editModelInForm();
    fireEvent.click(viewButton(TEXT.view.conversation));

    const card = await screen.findByTestId('change-card');
    const line = within(card).getByTestId('change-also-saves');
    expect(line).toHaveTextContent(TEXT.change.alsoSaves);
    const apply = within(card).getByRole('button', { name: TEXT.change.apply });
    expect(apply).toBeEnabled();
    expect(apply.getAttribute('aria-describedby')).toContain(line.id);

    await act(async () => {
      fireEvent.click(apply);
    });
    expect(puts()).toHaveLength(1);
    expect(server.state.app.preferredModel).toBe('big-model');
    expect(server.state.app.system).toEqual({ en: 'Address the reader formally.' });
  });

  test('a form that is not valid is not saved by Apply, and the card says why', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    editModelInForm();
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));
    fireEvent.click(viewButton(TEXT.view.conversation));

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: TEXT.change.apply }));
    });

    expect(puts()).toHaveLength(0);
    const card = screen.getByTestId('change-card');
    expect(within(card).getByRole('alert')).toHaveTextContent(EDIT.validationErrorsExist);
    expect(within(card).getByRole('button', { name: TEXT.change.apply })).toBeEnabled();
  });

  /** Changes the name in the form: a content key the change below does not touch. */
  function editNameInForm(name = 'Renamed chat') {
    fireEvent.click(viewButton(TEXT.view.form));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  }

  test('an unsaved edit of a content key the change does not touch is announced and checked', async () => {
    await renderEditor();
    // The name is edited before the turn, so the change is not stale: Apply would save it too.
    editNameInForm();
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));
    fireEvent.click(viewButton(TEXT.view.conversation));
    server.revise.push(changeAnswer());
    await say('Be formal');

    const card = await screen.findByTestId('change-card');
    expect(within(card).getByTestId('change-also-saves')).toHaveTextContent(TEXT.change.alsoSaves);
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: TEXT.change.apply }));
    });
    // The form is not valid: the editor's check runs, as for Save, and nothing is sent.
    expect(puts()).toHaveLength(0);
    expect(within(card).getByRole('alert')).toHaveTextContent(EDIT.validationErrorsExist);
  });

  test('an unsaved edit of the name after an Apply goes with Undo, which says so', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    });
    expect(puts()).toHaveLength(1);
    editNameInForm();
    fireEvent.click(viewButton(TEXT.view.conversation));

    expect(await screen.findByTestId('change-undo-also-saves')).toHaveTextContent(
      TEXT.change.undoAlsoSaves
    );
    fireEvent.click(viewButton(TEXT.view.form));
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));
    fireEvent.click(viewButton(TEXT.view.conversation));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: TEXT.change.undo }));
    });
    expect(puts()).toHaveLength(1);
    expect(screen.getByTestId('change-card')).toHaveTextContent(EDIT.validationErrorsExist);
  });

  test('the same holds for Undo', async () => {
    await renderEditor();
    server.revise.push(changeAnswer());
    await say('Be formal');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    });
    editModelInForm();
    fireEvent.click(viewButton(TEXT.view.conversation));

    expect(await screen.findByTestId('change-undo-also-saves')).toHaveTextContent(
      TEXT.change.undoAlsoSaves
    );
    fireEvent.click(viewButton(TEXT.view.form));
    fireEvent.click(screen.getByRole('button', { name: 'report one error' }));
    fireEvent.click(viewButton(TEXT.view.conversation));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: TEXT.change.undo }));
    });
    expect(puts()).toHaveLength(1);
    expect(screen.getByTestId('change-card')).toHaveTextContent(EDIT.validationErrorsExist);
  });
});

describe('Publish and Unpublish keep the editor revision', () => {
  const saveButton = () => screen.getByRole('button', { name: 'Save Changes' });
  const toggles = () => server.calls.filter(call => call.url === `${APP_URL}/_toggle`);

  async function publish() {
    fireEvent.click(screen.getByRole('button', { name: EDIT.publish.action }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: EDIT.publish.action }));
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  }

  test('publish, then save, no 412', async () => {
    await renderEditor({ path: APP_URL });
    await publish();
    expect(toggles()[0].ifMatch).toBe('"1"');
    expect(server.state.revision).toBe(2);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(puts().map(call => call.ifMatch)).toEqual(['"2"']);
    expect(server.state.app).toMatchObject({ name: { en: 'Chat 2' }, enabled: true });
    expect(screen.queryByRole('heading', { name: EDIT.conflict.title })).not.toBeInTheDocument();
  });

  test('publish, then Apply in the conversation, no 412', async () => {
    await renderEditor();
    await publish();
    server.revise.push(changeAnswer());
    await say('Be formal');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: TEXT.change.apply }));
    });

    expect(puts().map(call => call.ifMatch)).toEqual(['"2"']);
    expect(server.state.app.system).toEqual({ en: 'Address the reader formally.' });
    expect(screen.getByTestId('change-applied')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: EDIT.conflict.title })).not.toBeInTheDocument();
  });

  test('unpublish, then save, no 412', async () => {
    await renderEditor({ path: APP_URL, app: { ...APP, enabled: true } });
    fireEvent.click(screen.getByRole('button', { name: EDIT.more }));
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: EDIT.unpublish.action })
    );
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: EDIT.unpublish.action }));
    });
    expect(server.state.app.enabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(puts().map(call => call.ifMatch)).toEqual(['"2"']);
    expect(server.state.app.name).toEqual({ en: 'Chat 2' });
  });

  test('publish over a newer change is refused: nothing toggled, the conflict shown', async () => {
    await renderEditor({ path: APP_URL });
    server.bumpRevision();
    await publish();

    expect(server.state.app.enabled).toBe(false);
    expect(screen.getByRole('heading', { name: EDIT.conflict.title })).toBeInTheDocument();
  });
});

describe('the editor save with If-Match', () => {
  const saveButton = () => screen.getByRole('button', { name: 'Save Changes' });

  test('sends the loaded ETag and takes the new one after each save', async () => {
    await renderEditor({ path: APP_URL });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 3' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(puts().map(call => call.ifMatch)).toEqual(['"1"', '"2"']);
    expect(server.state.app.name).toEqual({ en: 'Chat 3' });
  });

  test('a save over a newer change is refused: nothing written, the conflict and Reload shown', async () => {
    await renderEditor({ path: APP_URL });
    server.bumpRevision();
    server.state.app = { ...server.state.app, description: { en: 'Changed elsewhere' } };
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 2' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(server.state.app.name).toEqual(APP.name);
    const alert = screen
      .getAllByRole('alert')
      .find(node => node.textContent.includes(EDIT.conflict.title));
    expect(alert).toHaveTextContent(EDIT.conflict.message);
    // The edit is kept until the author reloads.
    expect(screen.getByLabelText('Name')).toHaveValue('Chat 2');

    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: EDIT.conflict.reload }));
    });
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Chat'));
    expect(screen.queryByRole('heading', { name: EDIT.conflict.title })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat 4' } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(server.state.app.name).toEqual({ en: 'Chat 4' });
    expect(server.state.app.description).toEqual({ en: 'Changed elsewhere' });
  });
});
