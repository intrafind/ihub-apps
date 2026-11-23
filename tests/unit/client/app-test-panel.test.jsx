// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The test panel of the app editor (#2510, `AppTestPanel`): the saved app's
 * chat beside the editor.
 *
 * - Beside the editor on wide screens; below `lg` it covers the editor and is
 *   a dialog there: focus moves in, Escape closes, and focus goes back to the
 *   Test button (WCAG 2.4.3).
 * - An app that is not published runs too, and the panel says that nobody
 *   else sees it. When its load answers 404, the author's groups cannot use
 *   it: the panel says so and leads to "Who can use this app".
 * - Without a model it explains that instead of showing a chat.
 *
 * The panel and its parts are the real ones, with the real English and German
 * texts; the chat page and the request for the app are stand-ins.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const mockI18n = i18next.createInstance();
const mockT = (...args) => mockI18n.t(...args);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: mockI18n })
}));

const mockApi = { fetchAppDetails: jest.fn() };
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchAppDetails: (...args) => mockApi.fetchAppDetails(...args)
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildPath: path => `/ihub${path}`
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/apps/pages/AppChat', () => ({
  __esModule: true,
  default: () => <div data-testid="app-chat" />
}));

const AppTestPanel = require('../../../client/src/features/admin/components/AppTestPanel').default;

const TEST = en.admin.apps.test;
const EDIT = en.admin.apps.edit;
const NO_MODEL = en.admin.apps.create.noModel;
const original = window.matchMedia;

/** An error as the API layer throws it: with the HTTP status on it. */
function httpError(status) {
  const error = new Error(`Request failed with status code ${status}`);
  error.status = status;
  return error;
}

function openedFrom() {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  return opener;
}

function panelElement({ onClose, ...props }) {
  return (
    <MemoryRouter>
      <AppTestPanel
        appId="support"
        enabled
        isDirty={false}
        reloadKey={0}
        onClose={onClose}
        {...props}
      />
    </MemoryRouter>
  );
}

function renderPanel(props = {}) {
  const onClose = jest.fn();
  const utils = render(panelElement({ onClose, ...props }));
  return {
    onClose,
    rerenderWith: next => utils.rerender(panelElement({ onClose, ...next })),
    ...utils
  };
}

/** From `lg` up the panel sits beside the editor. */
function wideWindow() {
  window.matchMedia = () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
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
  mockApi.fetchAppDetails.mockReset();
  mockApi.fetchAppDetails.mockResolvedValue({ id: 'support', type: 'chat' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  window.matchMedia = original;
  jest.restoreAllMocks();
});

describe('AppTestPanel covering the editor (below lg)', () => {
  // jsdom has no matchMedia, which the hook reads as "below lg".
  test('is a dialog: focus moves in, Escape closes, focus goes back to the opener', async () => {
    const opener = openedFrom();
    const { onClose, unmount } = renderPanel();
    await screen.findByTestId('app-chat');

    const panel = screen.getByRole('dialog', { name: TEST.title });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: TEST.close })).toHaveFocus();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  test('is a dialog for an app that does not run here too, with only the close button to reach', async () => {
    const opener = openedFrom();
    const { onClose } = renderPanel({ enabled: false, runsUnpublished: false });

    const panel = screen.getByRole('dialog', { name: TEST.title });
    expect(screen.getByRole('button', { name: TEST.close })).toHaveFocus();
    expect(screen.queryByRole('button', { name: TEST.restart })).toBeNull();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    opener.remove();
  });

  test('still closes with the button', async () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: TEST.close }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('makes way before it leads to "Who can use this app"', async () => {
    mockApi.fetchAppDetails.mockRejectedValue(httpError(404));
    const order = [];
    const onOpenAccess = jest.fn(() => order.push('open access'));
    const { onClose } = renderPanel({ enabled: false, onOpenAccess });
    onClose.mockImplementation(() => order.push('close'));

    fireEvent.click(await screen.findByRole('button', { name: EDIT.groups.access }));

    // Covering the editor, the panel has to go before the group can be shown.
    expect(order).toEqual(['close', 'open access']);
  });
});

describe('AppTestPanel beside the editor (from lg up)', () => {
  beforeEach(wideWindow);

  test('is a plain side panel: no dialog, no focus taken, Escape left alone', async () => {
    const opener = openedFrom();
    const { onClose } = renderPanel();
    await screen.findByTestId('app-chat');

    const panel = screen.getByLabelText(TEST.title);
    expect(panel).not.toHaveAttribute('role');
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    opener.remove();
  });

  test('takes the focus only when the author followed a link to the test', async () => {
    const opener = openedFrom();
    const { rerenderWith } = renderPanel({ focusToken: 0 });
    await screen.findByTestId('app-chat');
    expect(opener).toHaveFocus();

    rerenderWith({ focusToken: 1 });
    expect(screen.getByLabelText(TEST.title)).toHaveFocus();

    // The same link again, after the focus went elsewhere.
    opener.focus();
    rerenderWith({ focusToken: 2 });
    expect(screen.getByLabelText(TEST.title)).toHaveFocus();
    opener.remove();
  });

  test('says while there are unsaved changes that the test does not run them yet', async () => {
    const { rerenderWith } = renderPanel({ isDirty: true });
    await screen.findByTestId('app-chat');
    expect(screen.getByText(TEST.unsavedHint)).toBeInTheDocument();

    rerenderWith({ isDirty: false });
    expect(screen.queryByText(TEST.unsavedHint)).not.toBeInTheDocument();
  });

  test('the link to the app carries the base path and opens a new tab', async () => {
    renderPanel();
    await screen.findByTestId('app-chat');

    const link = screen.getByRole('link', { name: en.admin.apps.openApp });
    expect(link).toHaveAttribute('href', '/ihub/apps/support');
    expect(link).toHaveAttribute('target', '_blank');
  });
});

describe('AppTestPanel for an app that is not published', () => {
  beforeEach(wideWindow);

  test('runs the app and says that only the people who manage apps see it', async () => {
    renderPanel({ enabled: false });

    expect(await screen.findByTestId('app-chat')).toBeInTheDocument();
    expect(mockApi.fetchAppDetails).toHaveBeenCalledWith('support');
    expect(screen.getByTestId('test-not-published')).toHaveTextContent(EDIT.notPublishedHint);
    expect(screen.getByRole('button', { name: TEST.restart })).toBeInTheDocument();
    expect(screen.queryByText(TEST.disabled)).not.toBeInTheDocument();
  });

  test('says the hint in German', async () => {
    await mockI18n.changeLanguage('de');
    renderPanel({ enabled: false });

    await screen.findByTestId('app-chat');
    expect(screen.getByTestId('test-not-published')).toHaveTextContent(
      'Nicht veröffentlicht. Nur Sie und andere, die Apps verwalten, können diese App öffnen und testen.'
    );
    expect(document.body).not.toHaveTextContent('MISSING:');
  });

  test('a published app carries no such hint', async () => {
    renderPanel();

    await screen.findByTestId('app-chat');
    expect(screen.queryByTestId('test-not-published')).not.toBeInTheDocument();
  });

  test('a 404 means the author’s groups cannot use it: the panel says so and leads to the access group', async () => {
    mockApi.fetchAppDetails.mockRejectedValue(httpError(404));
    const onOpenAccess = jest.fn();
    const { onClose } = renderPanel({ enabled: false, onOpenAccess });

    expect(
      await screen.findByRole('heading', { name: EDIT.testNoAccess.title })
    ).toBeInTheDocument();
    expect(screen.getByText(EDIT.testNoAccess.body)).toBeInTheDocument();
    expect(screen.queryByText(TEST.loadError)).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: EDIT.groups.access }));
    expect(onOpenAccess).toHaveBeenCalledTimes(1);
    // Beside the editor the panel stays: the group is visible next to it.
    expect(onClose).not.toHaveBeenCalled();
  });

  test('names the missing access in German', async () => {
    await mockI18n.changeLanguage('de');
    mockApi.fetchAppDetails.mockRejectedValue(httpError(404));
    renderPanel({ enabled: false, onOpenAccess: () => {} });

    expect(
      await screen.findByRole('heading', {
        name: 'Ihre Gruppen dürfen diese App noch nicht nutzen'
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText('Geben Sie einer Ihrer Gruppen Zugriff und testen Sie dann.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wer die App nutzen darf' })).toBeInTheDocument();
  });

  test('without a way to open the access group it offers no button', async () => {
    mockApi.fetchAppDetails.mockRejectedValue(httpError(404));
    renderPanel({ enabled: false });

    const heading = await screen.findByRole('heading', { name: EDIT.testNoAccess.title });
    expect(within(heading.parentElement).queryByRole('button')).toBeNull();
  });

  test('after a restart that finds the app, the chat is there', async () => {
    mockApi.fetchAppDetails.mockRejectedValueOnce(httpError(404));
    const { rerenderWith } = renderPanel({ enabled: false, onOpenAccess: () => {} });
    await screen.findByRole('heading', { name: EDIT.testNoAccess.title });

    // The editor bumps `reloadKey` once a group got access.
    rerenderWith({ enabled: false, onOpenAccess: () => {}, reloadKey: 1 });

    expect(await screen.findByTestId('app-chat')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: EDIT.testNoAccess.title })).toBeNull();
  });

  test('another failure is not explained as missing access', async () => {
    mockApi.fetchAppDetails.mockRejectedValue(httpError(500));
    renderPanel({ enabled: false, onOpenAccess: () => {} });

    expect(await screen.findByText(TEST.loadError)).toBeInTheDocument();
    expect(screen.queryByText(EDIT.testNoAccess.title)).not.toBeInTheDocument();
  });

  test('a 404 for a published app is not explained as missing access either', async () => {
    mockApi.fetchAppDetails.mockRejectedValue(httpError(404));
    renderPanel({ enabled: true, onOpenAccess: () => {} });

    expect(await screen.findByText(TEST.loadError)).toBeInTheDocument();
    expect(screen.queryByText(EDIT.testNoAccess.title)).not.toBeInTheDocument();
  });

  test('where unpublished apps do not run, it only says that the app is not available', async () => {
    renderPanel({ enabled: false, runsUnpublished: false });

    expect(screen.getByText(TEST.disabled)).toBeInTheDocument();
    expect(screen.queryByTestId('test-not-published')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TEST.restart })).toBeNull();
    expect(screen.queryByRole('link', { name: en.admin.apps.openApp })).toBeNull();
    expect(mockApi.fetchAppDetails).not.toHaveBeenCalled();
  });
});

describe('AppTestPanel without a model', () => {
  beforeEach(wideWindow);

  test('explains that instead of showing a chat that cannot answer', async () => {
    renderPanel({ noModel: true });

    expect(screen.getByText(NO_MODEL.title)).toBeInTheDocument();
    expect(screen.getByText(NO_MODEL.body)).toBeInTheDocument();
    expect(screen.getByText(NO_MODEL.actionOther)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: NO_MODEL.actionAdmin })).toBeNull();
    expect(screen.queryByTestId('app-chat')).not.toBeInTheDocument();
    expect(mockApi.fetchAppDetails).not.toHaveBeenCalled();
  });

  test('leads someone who may set up models to that page', async () => {
    renderPanel({ noModel: true, modelSetupHref: '/admin/models' });

    expect(screen.getByRole('link', { name: NO_MODEL.actionAdmin })).toHaveAttribute(
      'href',
      '/admin/models'
    );
    expect(screen.queryByText(NO_MODEL.actionOther)).not.toBeInTheDocument();
  });
});
