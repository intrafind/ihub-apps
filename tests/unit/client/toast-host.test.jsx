// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import { AnnouncerProvider } from '../../../client/src/shared/announce/AnnouncerProvider';
import {
  MAX_VISIBLE_TOASTS,
  TOAST_MS,
  ToastProvider,
  useToasts,
  visibleToasts
} from '../../../client/src/shared/components/ToastHost';
import ScheduledTaskNotifier from '../../../client/src/features/tasks/components/ScheduledTaskNotifier';

/**
 * The page's toasts (#3782, #3197), generalised from the scheduled-task
 * notifier: at most three at once, a 24 px close target, a toast about
 * something that needs the person stays until it is closed, and what a toast
 * says is said through the page's one live region, not a region of its own.
 */

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const mockNotifications = { items: [] };
jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasks', () => ({
  useScheduledTaskNotifications: () => mockNotifications
}));

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  jest.advanceTimersByTime(10_000);
  localStorage.clear();
  mockNotifications.items = [];
});

afterEach(async () => {
  jest.useRealTimers();
  await mockI18n.changeLanguage('en');
});

/** Shows `toasts` when mounted. */
function Producer({ toasts }) {
  const { show } = useToasts();
  useEffect(() => {
    for (const toast of toasts) show(toast);
  }, [show, toasts]);
  return null;
}

function Page({ children, path = '/' }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <AnnouncerProvider>
        <ToastProvider>{children}</ToastProvider>
      </AnnouncerProvider>
    </MemoryRouter>
  );
}

const toast = (n, extra = {}) => ({ id: `t${n}`, text: `Toast ${n}`, ...extra });

describe('ToastHost', () => {
  test('shows nothing, and no landmark, without toasts', () => {
    render(<Page />);
    expect(screen.queryByTestId('toast-host')).toBeNull();
  });

  test('a toast is said through the page announcer; the host has no live region of its own', () => {
    render(
      <Page>
        <Producer toasts={[toast(1, { links: [{ label: 'Open chat', to: '/apps/a/c/1' }] })]} />
      </Page>
    );
    const host = screen.getByRole('region', { name: 'Notifications' });
    expect(within(host).getByText('Toast 1')).toBeInTheDocument();
    expect(host.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(host).not.toHaveAttribute('aria-live');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Toast 1');
    expect(within(host).getByRole('link', { name: 'Open chat' })).toHaveAttribute(
      'href',
      '/apps/a/c/1'
    );
  });

  test(`shows at most ${MAX_VISIBLE_TOASTS}; the next one appears when one closes`, () => {
    render(
      <Page>
        <Producer toasts={[toast(1), toast(2), toast(3), toast(4)]} />
      </Page>
    );
    expect(screen.getAllByTestId('toast')).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(screen.queryByText('Toast 4', { selector: 'p' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close notification: Toast 2' }));
    expect(screen.getAllByTestId('toast')).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(screen.getByText('Toast 4', { selector: 'p' })).toBeInTheDocument();
  });

  test('toasts that need the person never hold every slot: a later failure is shown and said', () => {
    const sticky = n => toast(n, { needsYou: true, text: `Waits ${n}` });
    const { rerender } = render(
      <Page>
        <Producer toasts={[sticky(1), sticky(2), sticky(3)]} />
      </Page>
    );
    expect(screen.getAllByTestId('toast')).toHaveLength(MAX_VISIBLE_TOASTS - 1);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    rerender(
      <Page>
        <Producer toasts={[sticky(1), sticky(2), sticky(3), toast(4, { text: 'Run failed' })]} />
      </Page>
    );
    expect(screen.getByText('Run failed', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getAllByTestId('toast')).toHaveLength(MAX_VISIBLE_TOASTS);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Run failed');
  });

  test('visibleToasts: oldest first, one slot kept free of toasts that need the person, stable as toasts arrive', () => {
    const sticky = n => toast(n, { needsYou: true });
    const ids = list => visibleToasts(list).map(entry => entry.id);
    expect(ids([sticky(1), sticky(2), sticky(3), toast(4)])).toEqual(['t1', 't2', 't4']);
    expect(ids([sticky(1), sticky(2), sticky(3)])).toEqual(['t1', 't2']);
    expect(ids([toast(1), toast(2), toast(3), toast(4)])).toEqual(['t1', 't2', 't3']);
    // A newer toast never pushes out a visible one.
    expect(ids([sticky(1), toast(2), toast(3), sticky(4)])).toEqual(['t1', 't2', 't3']);
    // Closing one lets the next waiting toast in.
    expect(ids([sticky(1), toast(3), sticky(4)])).toEqual(['t1', 't3', 't4']);
  });

  test('a toast that waited for a slot is said when it appears, and a visible one is said once', () => {
    const { rerender } = render(
      <Page>
        <Producer toasts={[toast(1), toast(2), toast(3), toast(4)]} />
      </Page>
    );
    const said = [];
    const listen = () => {
      const text = screen.getByRole('status').textContent;
      if (text && text !== said[said.length - 1]) said.push(text);
    };
    for (let i = 0; i < 60; i += 1) {
      act(() => {
        jest.advanceTimersByTime(100);
      });
      listen();
    }
    expect(said).toEqual(['Toast 1', 'Toast 2', 'Toast 3']);
    fireEvent.click(screen.getByRole('button', { name: 'Close notification: Toast 1' }));
    // Shown again with the same text: a toast that is already there is not said again.
    rerender(
      <Page>
        <Producer toasts={[toast(2), toast(3), toast(4)]} />
      </Page>
    );
    for (let i = 0; i < 30; i += 1) {
      act(() => {
        jest.advanceTimersByTime(100);
      });
      listen();
    }
    expect(said).toEqual(['Toast 1', 'Toast 2', 'Toast 3', 'Toast 4']);
  });

  test('the close button is a named 24 px target', () => {
    render(
      <Page>
        <Producer toasts={[toast(1)]} />
      </Page>
    );
    const close = screen.getByRole('button', { name: 'Close notification: Toast 1' });
    expect(close.className).toMatch(/\bmin-h-6\b/);
    expect(close.className).toMatch(/\bmin-w-6\b/);
  });

  test('a toast closes by itself after 12 s; one that needs the person stays until closed', () => {
    render(
      <Page>
        <Producer toasts={[toast(1), toast(2, { needsYou: true })]} />
      </Page>
    );
    act(() => {
      jest.advanceTimersByTime(TOAST_MS - 100);
    });
    expect(screen.getByText('Toast 1', { selector: 'p' })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Toast 1', { selector: 'p' })).toBeNull();
    act(() => {
      jest.advanceTimersByTime(10 * TOAST_MS);
    });
    expect(screen.getByText('Toast 2', { selector: 'p' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close notification: Toast 2' }));
    expect(screen.queryByTestId('toast-host')).toBeNull();
  });

  test('a waiting toast starts its clock when it becomes visible', () => {
    render(
      <Page>
        <Producer toasts={[toast(1, { needsYou: true }), toast(2), toast(3), toast(4)]} />
      </Page>
    );
    act(() => {
      jest.advanceTimersByTime(TOAST_MS + 100);
    });
    // 2 and 3 closed by themselves, and 4 came in their place with a clock of its own.
    expect(screen.getByText('Toast 4', { selector: 'p' })).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(TOAST_MS + 100);
    });
    expect(screen.queryByText('Toast 4', { selector: 'p' })).toBeNull();
    expect(screen.getByText('Toast 1', { selector: 'p' })).toBeInTheDocument();
  });

  test('outside a provider useToasts does nothing', () => {
    expect(() =>
      render(
        <MemoryRouter>
          <Producer toasts={[toast(1)]} />
        </MemoryRouter>
      )
    ).not.toThrow();
    expect(screen.queryByText('Toast 1', { selector: 'p' })).toBeNull();
  });

  test('German names from the real locale file', async () => {
    await mockI18n.changeLanguage('de');
    render(
      <Page>
        <Producer toasts={[toast(1)]} />
      </Page>
    );
    expect(screen.getByRole('region', { name: 'Benachrichtigungen' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Benachrichtigung schließen: Toast 1' })
    ).toBeInTheDocument();
  });
});

describe('ScheduledTaskNotifier through the ToastHost', () => {
  const run = (id, status, extra = {}) => ({
    id,
    status,
    taskId: `task-${id}`,
    taskName: `Task ${id}`,
    appId: 'chat',
    chatId: `chat-${id}`,
    ...extra
  });

  test('a finished run gets a toast with its links; a run that waits for approval stays', () => {
    mockNotifications.items = [run('r1', 'succeeded'), run('r2', 'awaiting_approval')];
    render(
      <Page>
        <ScheduledTaskNotifier />
      </Page>
    );
    const toasts = screen.getAllByTestId('toast');
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toHaveTextContent('"Task r1" finished');
    expect(within(toasts[0]).getByRole('link', { name: 'Open chat' })).toHaveAttribute(
      'href',
      '/apps/chat/c/chat-r1'
    );
    expect(toasts[1]).toHaveTextContent('"Task r2" needs your approval');
    expect(within(toasts[1]).queryByRole('link', { name: 'Open chat' })).toBeNull();
    expect(within(toasts[1]).getByRole('link', { name: 'Open task' })).toHaveAttribute(
      'href',
      '/tasks/task-r2'
    );
    act(() => {
      jest.advanceTimersByTime(TOAST_MS + 100);
    });
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(
      screen.getByText('"Task r2" needs your approval', { selector: 'p' })
    ).toBeInTheDocument();
  });

  /** Exposes the router's navigate to the test. */
  function Navigator({ onNavigate }) {
    onNavigate(useNavigate());
    return null;
  }

  test('a toast the person closed does not come back on the next navigation or language switch, nor is said again', async () => {
    mockNotifications.items = [run('r5', 'awaiting_approval')];
    let navigate;
    render(
      <Page path="/apps">
        <Navigator onNavigate={value => (navigate = value)} />
        <ScheduledTaskNotifier />
      </Page>
    );
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(screen.getByRole('status')).toHaveTextContent('"Task r5" needs your approval');
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('button', { name: /^Close notification: .*Task r5/ }));
    expect(screen.queryByTestId('toast')).toBeNull();

    act(() => navigate('/chats'));
    await act(async () => {
      await mockI18n.changeLanguage('de');
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  test("following the toast's own link to the task and leaving the Tasks page does not bring it back", () => {
    mockNotifications.items = [run('r6', 'awaiting_approval')];
    let navigate;
    render(
      <Page path="/apps">
        <Navigator onNavigate={value => (navigate = value)} />
        <ScheduledTaskNotifier />
      </Page>
    );
    fireEvent.click(screen.getByRole('link', { name: 'Open task' }));
    expect(screen.queryByTestId('toast')).toBeNull();
    act(() => navigate('/apps'));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  test('the remembered runs hold each id once, however often the page moves', () => {
    localStorage.setItem('ihub.scheduledTasks.toastedRuns', JSON.stringify(['old-1', 'old-2']));
    mockNotifications.items = [run('r7', 'succeeded'), run('old-1', 'succeeded')];
    let navigate;
    render(
      <Page path="/apps">
        <Navigator onNavigate={value => (navigate = value)} />
        <ScheduledTaskNotifier />
      </Page>
    );
    for (const path of ['/chats', '/apps', '/tasks', '/apps']) act(() => navigate(path));
    expect(JSON.parse(localStorage.getItem('ihub.scheduledTasks.toastedRuns'))).toEqual([
      'old-1',
      'old-2',
      'r7'
    ]);
  });

  test('once per run and browser, and not on the Tasks page', () => {
    mockNotifications.items = [run('r1', 'failed')];
    const { unmount } = render(
      <Page path="/tasks">
        <ScheduledTaskNotifier />
      </Page>
    );
    expect(screen.queryByTestId('toast')).toBeNull();
    unmount();
    render(
      <Page>
        <ScheduledTaskNotifier />
      </Page>
    );
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  test('a failed run is said, and its toast carries the warning icon', () => {
    mockNotifications.items = [run('r3', 'failed')];
    render(
      <Page>
        <ScheduledTaskNotifier />
      </Page>
    );
    expect(screen.getByRole('status')).toHaveTextContent('"Task r3" failed');
    expect(
      within(screen.getByTestId('toast'))
        .getAllByTestId('icon')
        .map(icon => icon.dataset.name)
    ).toContain('exclamation-triangle');
  });
});
