import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import AdminScheduledTasksPage from '../../../client/src/features/admin/pages/AdminScheduledTasksPage';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

/**
 * Admin → Scheduled Tasks, memory part. An admin sees that a task keeps notes
 * (size, version, last update) and can clear them; the page has no way to show
 * what they say, and never asks for it. The three memory limits go through the
 * same limits form as the others.
 */

// `t` reads the real English strings: the limits form labels its fields by key only, so a
// key the page uses but en.json lacks fails here.
jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const t = (key, fallback, values) => {
    const text = typeof lookup(key) === 'string' ? lookup(key) : fallback;
    if (typeof text !== 'string') return key;
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  const translation = { t, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

jest.mock('../../../client/src/shared/components/Modal', () => ({
  __esModule: true,
  default: ({ isOpen, children }) => (isOpen ? <div>{children}</div> : null)
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => err?.message || 'error'
}));

const SETTINGS = {
  enabled: true,
  maxTasksPerUser: 10,
  minIntervalMinutes: 15,
  maxConcurrentRuns: 4,
  maxConcurrentRunsPerUser: 2,
  staggerMinutes: 0,
  catchUpWindowHours: 24,
  maxConsecutiveFailures: 5,
  approvalTimeoutHours: 24,
  runRetentionDays: 30,
  maxRunChatsPerTask: 20,
  maxInstructionLength: 8000,
  maxRunMinutes: 10,
  memoryEnabled: true,
  memoryMaxChars: 8000,
  maxHistoryReadChars: 8000
};

const task = (id, extra = {}) => ({
  id,
  name: `Task ${id}`,
  appId: 'chat',
  ownerId: `owner-${id}`,
  owner: { name: `Owner ${id}` },
  status: 'active',
  scheduleDescription: 'Every day',
  consecutiveFailures: 0,
  memory: { enabled: true },
  memorySummary: null,
  ...extra
});

const SUMMARY = {
  version: 3,
  chars: 42,
  updatedAt: '2026-10-07T07:00:00Z',
  updatedBy: 'compose:r1'
};

let items;

function mockServer() {
  makeAdminApiCall.mockImplementation(async (url, options = {}) => {
    const method = options.method || 'GET';
    if (url === '/admin/scheduled-tasks' && method === 'GET') {
      return {
        data: {
          status: {
            active: true,
            featureEnabled: true,
            chatPersistence: true,
            platformEnabled: true
          },
          settings: SETTINGS,
          items
        }
      };
    }
    if (url === '/admin/scheduled-tasks/settings' && method === 'PUT') {
      return {
        data: { settings: { ...SETTINGS, ...options.body }, changed: Object.keys(options.body) }
      };
    }
    if (/^\/admin\/scheduled-tasks\/[^/]+\/memory$/.test(url) && method === 'DELETE') {
      return { data: { version: 4 } };
    }
    throw new Error(`unexpected admin call ${method} ${url}`);
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderPage() {
  render(
    <MemoryRouter>
      <AdminScheduledTasksPage />
    </MemoryRouter>
  );
  await flush();
}

const rowOf = name => screen.getByText(name).closest('tr');
const memoryCalls = () => makeAdminApiCall.mock.calls.filter(([url]) => /\/memory$/.test(url));

describe('AdminScheduledTasksPage: memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    items = [
      task('a', { memorySummary: SUMMARY }),
      task('b'),
      task('c', { memorySummary: { ...SUMMARY, chars: 0, version: 5 } })
    ];
    mockServer();
  });

  it('shows the size, version and last update of the notes of each task, and a dash when there are none', async () => {
    await renderPage();

    const header = screen.getAllByRole('columnheader').map(th => th.textContent);
    expect(header).toContain('Memory');

    const cell = row => within(row).getByText(/chars/).closest('td');
    expect(cell(rowOf('Task a'))).toHaveTextContent(/^42 chars · v3 · .*2026/);
    expect(within(rowOf('Task b')).queryByText(/chars/)).not.toBeInTheDocument();
    const memoryColumn = header.indexOf('Memory');
    expect(within(rowOf('Task b')).getAllByRole('cell')[memoryColumn]).toHaveTextContent('—');
  });

  it('never asks for, or shows, what the notes say', async () => {
    await renderPage();
    expect(memoryCalls()).toHaveLength(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('offers to clear notes that exist, and not notes that are empty or missing', async () => {
    await renderPage();
    expect(
      within(rowOf('Task a')).getByRole('button', { name: 'Clear memory' })
    ).toBeInTheDocument();
    expect(
      within(rowOf('Task b')).queryByRole('button', { name: 'Clear memory' })
    ).not.toBeInTheDocument();
    expect(
      within(rowOf('Task c')).queryByRole('button', { name: 'Clear memory' })
    ).not.toBeInTheDocument();
  });

  it('clears the notes through the admin endpoint after confirmation, then reloads the list', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();
    const listCalls = () =>
      makeAdminApiCall.mock.calls.filter(
        ([url, options]) => url === '/admin/scheduled-tasks' && !options?.method
      );
    expect(listCalls()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(within(rowOf('Task a')).getByRole('button', { name: 'Clear memory' }));
    });
    await flush();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Task a'));
    expect(memoryCalls()).toEqual([['/admin/scheduled-tasks/a/memory', { method: 'DELETE' }]]);
    expect(listCalls()).toHaveLength(2);
    confirm.mockRestore();
  });

  it('does nothing when the admin declines to clear', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    await renderPage();
    await act(async () => {
      fireEvent.click(within(rowOf('Task a')).getByRole('button', { name: 'Clear memory' }));
    });
    expect(memoryCalls()).toHaveLength(0);
    confirm.mockRestore();
  });

  it('shows an error and keeps the page when clearing fails', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const original = makeAdminApiCall.getMockImplementation();
    makeAdminApiCall.mockImplementation(async (url, options) => {
      if (/\/memory$/.test(url)) throw new Error('Storage unavailable');
      return original(url, options);
    });
    await renderPage();
    await act(async () => {
      fireEvent.click(within(rowOf('Task a')).getByRole('button', { name: 'Clear memory' }));
    });
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
    expect(within(rowOf('Task a')).getByRole('button', { name: 'Clear memory' })).toBeEnabled();
    confirm.mockRestore();
  });

  it('saves the three memory settings with the other limits', async () => {
    await renderPage();

    fireEvent.change(screen.getByLabelText('Longest notes (characters)'), {
      target: { value: '12000' }
    });
    fireEvent.change(screen.getByLabelText('Longest earlier answer a run may read (characters)'), {
      target: { value: '4000' }
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow memory between runs' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await flush();

    const put = makeAdminApiCall.mock.calls.find(
      ([url, options]) => url === '/admin/scheduled-tasks/settings' && options?.method === 'PUT'
    );
    expect(put[1].body).toEqual(
      expect.objectContaining({
        enabled: true,
        memoryEnabled: false,
        memoryMaxChars: 12000,
        maxHistoryReadChars: 4000,
        maxTasksPerUser: 10
      })
    );
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
  });

  it('sends memory enabled when the switch was left on, and the limits as numbers', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await flush();

    const put = makeAdminApiCall.mock.calls.find(
      ([url, options]) => url === '/admin/scheduled-tasks/settings' && options?.method === 'PUT'
    );
    expect(put[1].body.memoryEnabled).toBe(true);
    expect(put[1].body.memoryMaxChars).toBe(8000);
    expect(put[1].body.maxHistoryReadChars).toBe(8000);
  });

  it('bounds the two memory limits like the server does', async () => {
    await renderPage();
    const notes = screen.getByLabelText('Longest notes (characters)');
    expect(notes).toHaveAttribute('min', '1000');
    expect(notes).toHaveAttribute('max', '64000');
    const history = screen.getByLabelText('Longest earlier answer a run may read (characters)');
    expect(history).toHaveAttribute('min', '1000');
    expect(history).toHaveAttribute('max', '50000');
  });
});
