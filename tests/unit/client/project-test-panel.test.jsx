// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Try in chat for an admin project (#3309, `ProjectTestPanel`):
 *
 *   - it offers the enabled chat apps, the general chat first, and runs the
 *     chosen one with the project under test;
 *   - it says the chat runs as the admin and is temporary, and warns about
 *     items that cannot be searched yet or a project without items;
 *   - it says when there is no app to run;
 *   - every string comes from shared/i18n/en.json and de.json.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const mockApi = { fetchAdminApps: jest.fn() };
jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminApps: (...args) => mockApi.fetchAdminApps(...args),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// The real chat is the app editor's; here it only shows what it is told to run.
jest.mock('../../../client/src/features/admin/components/AppTestPanel', () => ({
  TestChat: ({ appId, testProjectId }) => (
    <div data-testid="test-chat" data-project={testProjectId}>
      {appId}
    </div>
  ),
  PanelMessage: ({ children }) => <div data-testid="panel-message">{children}</div>
}));

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

const ProjectTestPanel =
  require('../../../client/src/features/admin/components/ProjectTestPanel').default;
const {
  chatAppsToTest,
  projectItemReadiness
} = require('../../../client/src/features/admin/components/ProjectTestPanel');

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

beforeEach(() => {
  mockApi.fetchAdminApps.mockReset();
});

const APPS = [
  { id: 'translator', name: { en: 'Translator' }, enabled: true },
  { id: 'chat', name: { en: 'Chat' }, enabled: true },
  { id: 'dark', name: { en: 'Dark' }, enabled: false },
  { id: 'site', name: { en: 'Website' }, type: 'iframe', enabled: true },
  { id: 'assistant', name: { en: 'Assistant' } }
];

const item = status => ({ id: `i-${status}-${Math.random()}`, status });

function renderPanel(props = {}) {
  const onClose = jest.fn();
  const utils = render(
    <ProjectTestPanel
      projectId="handbook"
      project={{ id: 'handbook', items: [item('ready')] }}
      onClose={onClose}
      {...props}
    />
  );
  return { onClose, ...utils };
}

describe('chatAppsToTest', () => {
  test('keeps the enabled chat apps, the general chat first and the rest by name', () => {
    expect(chatAppsToTest(APPS)).toEqual([
      { id: 'chat', name: 'Chat' },
      { id: 'assistant', name: 'Assistant' },
      { id: 'translator', name: 'Translator' }
    ]);
  });

  test('copes with no apps and falls back to the id for an unnamed app', () => {
    expect(chatAppsToTest(null)).toEqual([]);
    expect(chatAppsToTest(undefined)).toEqual([]);
    expect(chatAppsToTest([{ id: 'plain' }])).toEqual([{ id: 'plain', name: 'plain' }]);
  });
});

describe('projectItemReadiness', () => {
  test('counts what a chat can search and what it cannot yet', () => {
    const project = {
      items: [
        item('ready'),
        item('stale'),
        item('pending'),
        item('extracting'),
        item('failed'),
        item('failed')
      ]
    };
    expect(projectItemReadiness(project)).toEqual({ total: 6, ready: 2, waiting: 2, failed: 2 });
  });

  test('copes with a project that is not loaded', () => {
    const none = { total: 0, ready: 0, waiting: 0, failed: 0 };
    expect(projectItemReadiness(null)).toEqual(none);
    expect(projectItemReadiness({})).toEqual(none);
  });
});

describe('ProjectTestPanel on a narrow screen, where it covers the editor', () => {
  // jsdom has no matchMedia, which the hook reads as "below lg".
  test('is a dialog: focus moves in, Escape closes it and focus goes back to the opener', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { onClose, unmount } = renderPanel();
    await screen.findByTestId('test-chat');

    const panel = screen.getByTestId('project-test-panel');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close chat' })).toHaveFocus();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});

describe('ProjectTestPanel beside the editor on a wide screen', () => {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {}
    });
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  test('is a plain side panel: no dialog, no focus taken, Escape left alone', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { onClose } = renderPanel();
    await screen.findByTestId('test-chat');

    const panel = screen.getByTestId('project-test-panel');
    expect(panel).not.toHaveAttribute('role');
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(opener).toHaveFocus();

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    opener.remove();
  });
});

describe('ProjectTestPanel', () => {
  test('runs the general chat with the project under test and offers the other apps', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    renderPanel();

    const chat = await screen.findByTestId('test-chat');
    expect(chat).toHaveTextContent('chat');
    expect(chat).toHaveAttribute('data-project', 'handbook');

    const select = screen.getByTestId('project-test-app-select');
    expect([...select.options].map(option => option.value)).toEqual([
      'chat',
      'assistant',
      'translator'
    ]);

    fireEvent.change(select, { target: { value: 'translator' } });
    const next = await screen.findByText('translator');
    expect(next).toHaveAttribute('data-project', 'handbook');
  });

  test('says the chat runs as the admin and is temporary', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    renderPanel();
    await screen.findByTestId('test-chat');

    const notice = screen.getByText(/runs as you/);
    expect(notice).toHaveTextContent('not tested');
    expect(notice).toHaveTextContent('temporary');
  });

  test('warns about items that are not searched yet', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    renderPanel({
      project: { id: 'handbook', items: [item('ready'), item('extracting'), item('failed')] }
    });
    await screen.findByTestId('test-chat');
    expect(screen.getByText(/2 of 3 items are not ready/)).toBeInTheDocument();
  });

  test('warns about a project without items, but stays quiet while it is not loaded', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    const { unmount } = renderPanel({ project: { id: 'handbook', items: [] } });
    await screen.findByTestId('test-chat');
    expect(screen.getByText(/has no items yet/)).toBeInTheDocument();
    unmount();

    renderPanel({ project: null });
    await screen.findByTestId('test-chat');
    expect(screen.queryByText(/has no items yet/)).toBeNull();
  });

  test('stays quiet when every item is ready', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    renderPanel();
    await screen.findByTestId('test-chat');
    expect(screen.queryByText(/not ready/)).toBeNull();
    expect(screen.queryByText(/has no items yet/)).toBeNull();
  });

  test('says so when no chat app is enabled', async () => {
    mockApi.fetchAdminApps.mockResolvedValue([APPS[2], APPS[3]]);
    renderPanel();
    expect(await screen.findByTestId('panel-message')).toHaveTextContent(
      'There is no enabled chat app'
    );
    expect(screen.queryByTestId('test-chat')).toBeNull();
    expect(screen.queryByTestId('project-test-app-select')).toBeNull();
  });

  test('shows why the apps could not be loaded', async () => {
    mockApi.fetchAdminApps.mockRejectedValue(new Error('Forbidden'));
    renderPanel();
    expect(await screen.findByTestId('panel-message')).toHaveTextContent('Forbidden');
  });

  test('restarts with a new chat and closes', async () => {
    mockApi.fetchAdminApps.mockResolvedValue(APPS);
    const { onClose } = renderPanel();
    const first = await screen.findByTestId('test-chat');

    fireEvent.click(screen.getByRole('button', { name: 'Restart with a new chat' }));
    await waitFor(() => expect(screen.getByTestId('test-chat')).not.toBe(first));

    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('has German texts for every key it uses', () => {
    const used = Object.keys(en.admin.projects.tryInChat);
    expect(Object.keys(de.admin.projects.tryInChat).sort()).toEqual(used.sort());
    for (const key of used) {
      expect(de.admin.projects.tryInChat[key]).not.toBe('');
    }
  });
});
