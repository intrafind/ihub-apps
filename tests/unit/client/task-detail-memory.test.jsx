import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TaskDetailPage from '../../../client/src/features/tasks/pages/TaskDetailPage';
import {
  deleteScheduledTaskMemory,
  fetchScheduledTask,
  fetchScheduledTaskMemory,
  fetchScheduledTaskRuns,
  writeScheduledTaskMemory
} from '../../../client/src/api';
import { useCanCreateScheduledTasks } from '../../../client/src/features/tasks/hooks/useScheduledTasks';

/**
 * The Memory card of the task page: the owner reads, edits and clears the notes
 * a task keeps between runs, and the run history says which runs found nothing
 * new and which updated the notes.
 *
 * The page polls the task every 4 s while a run is active and holds a new task
 * object after each poll. Typing in the editor must survive that: this is the
 * regression the card exists to prevent (a person typing for a minute while the
 * run is going would lose their text every few seconds).
 */

// `t` reads the real English strings, so a key the page uses but en.json lacks fails here.
// It must be one stable function, like react-i18next's: the page's `load` depends on it.
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

jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [{ id: 'chat', name: { en: 'Chat' } }] })
}));

jest.mock('../../../client/src/features/tasks/components/ApprovalControls', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasks', () => ({
  useCanCreateScheduledTasks: jest.fn(),
  useNow: () => Date.parse('2026-10-08T08:00:00Z')
}));

jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasksConfig', () => ({
  useScheduledTaskLimits: () => ({ memoryEnabled: true, memoryMaxChars: 8000 })
}));

jest.mock('../../../client/src/api', () => ({
  cancelScheduledTaskRun: jest.fn(),
  deleteScheduledTask: jest.fn(),
  deleteScheduledTaskMemory: jest.fn(),
  duplicateScheduledTask: jest.fn(),
  fetchScheduledTask: jest.fn(),
  fetchScheduledTaskMemory: jest.fn(),
  fetchScheduledTaskRuns: jest.fn(),
  pauseScheduledTask: jest.fn(),
  resumeScheduledTask: jest.fn(),
  revokeScheduledTaskTool: jest.fn(),
  runScheduledTaskNow: jest.fn(),
  writeScheduledTaskMemory: jest.fn()
}));

const TASK = {
  id: 'st-1',
  name: 'OpenWebUI changelog',
  description: '',
  instructions: 'Summarize the latest features.',
  appId: 'chat',
  modelId: null,
  status: 'active',
  notify: 'changes',
  enabledTools: null,
  allowedTools: [],
  memory: { enabled: true },
  memorySummary: {
    version: 3,
    chars: 22,
    updatedAt: '2026-10-07T07:00:00Z',
    updatedBy: 'compose:r1'
  },
  scheduleDescription: 'Every Monday at 08:00',
  upcomingRuns: [],
  staggerMinutes: 0,
  schedule: { type: 'weekly' }
};

const MEMORY = {
  enabled: true,
  platformEnabled: true,
  body: 'Reported up to v1.2.0\n',
  version: 3,
  chars: 22,
  maxChars: 8000,
  updatedAt: '2026-10-07T07:00:00Z',
  updatedBy: 'compose:r1'
};

const run = (id, extra = {}) => ({
  id,
  status: 'succeeded',
  trigger: 'schedule',
  scheduledFor: '2026-10-07T06:00:00.000Z',
  startedAt: '2026-10-07T06:00:05.000Z',
  durationMs: 12000,
  chatId: `chat-${id}`,
  ...extra
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/tasks/st-1']}>
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
}

const notes = () => screen.getByRole('textbox', { name: 'Memory notes' });
const memoryCard = () => screen.getByRole('heading', { name: 'Memory' }).closest('section');

describe('TaskDetailPage: memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useCanCreateScheduledTasks.mockReturnValue(true);
    fetchScheduledTask.mockResolvedValue(TASK);
    fetchScheduledTaskRuns.mockResolvedValue({ items: [], nextCursor: null });
    fetchScheduledTaskMemory.mockResolvedValue(MEMORY);
    writeScheduledTaskMemory.mockResolvedValue({
      version: 4,
      chars: 6,
      updatedAt: '2026-10-08T07:00:00Z'
    });
    deleteScheduledTaskMemory.mockResolvedValue({ version: 4 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the memory setting and the notes with their size against the limit', async () => {
    await renderPage();

    const row = screen.getByText('Memory', { selector: 'dt' }).closest('div');
    expect(within(row).getByText('On')).toBeInTheDocument();

    expect(fetchScheduledTaskMemory).toHaveBeenCalledWith('st-1');
    expect(notes()).toHaveValue(MEMORY.body);
    expect(within(memoryCard()).getByTestId('memory-size')).toHaveTextContent(
      '22 / 8000 characters'
    );
    expect(within(memoryCard()).getByText(/consider clearing its memory/)).toBeInTheDocument();
  });

  it('puts the Memory card between "Allowed without asking" and "Run history"', async () => {
    await renderPage();
    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    expect(headings.indexOf('Memory')).toBe(headings.indexOf('Allowed without asking') + 1);
    expect(headings.indexOf('Run history')).toBe(headings.indexOf('Memory') + 1);
  });

  it('shows the notify mode "only when something changed" by name', async () => {
    await renderPage();
    expect(screen.getByText('Notify me', { selector: 'dt' }).nextSibling).toHaveTextContent(
      'Only when something changed (and on failures)'
    );
  });

  it('saves the notes with the version they were loaded at, then refreshes the task', async () => {
    await renderPage();
    expect(fetchScheduledTask).toHaveBeenCalledTimes(1);

    fireEvent.change(notes(), { target: { value: 'Reported up to v1.3.0\n' } });
    await act(async () => {
      fireEvent.click(within(memoryCard()).getByRole('button', { name: 'Save' }));
    });
    await flush();

    expect(writeScheduledTaskMemory).toHaveBeenCalledWith('st-1', {
      content: 'Reported up to v1.3.0\n',
      expectedVersion: 3
    });
    expect(within(memoryCard()).getByTestId('memory-version')).toHaveTextContent('Version 4');
    // The page re-reads the task so its memory summary is not left behind.
    expect(fetchScheduledTask).toHaveBeenCalledTimes(2);
    expect(notes()).toHaveValue('Reported up to v1.3.0\n');
  });

  it('tells the owner when someone else saved first, without losing the text', async () => {
    writeScheduledTaskMemory.mockRejectedValue(
      Object.assign(new Error('Conflict'), {
        status: 409,
        code: 'VERSION_CONFLICT',
        originalError: {
          response: {
            data: { error: 'Conflict', code: 'VERSION_CONFLICT', details: { currentVersion: 5 } }
          }
        }
      })
    );
    await renderPage();
    fireEvent.change(notes(), { target: { value: 'my edit' } });
    await act(async () => {
      fireEvent.click(within(memoryCard()).getByRole('button', { name: 'Save' }));
    });
    await flush();

    expect(within(memoryCard()).getByRole('alert')).toHaveTextContent(
      /Conflict: memory was modified elsewhere/
    );
    expect(notes()).toHaveValue('my edit');
  });

  it('explains a note that is too long with the numbers from the server', async () => {
    writeScheduledTaskMemory.mockRejectedValue(
      Object.assign(new Error('too long'), {
        status: 400,
        code: 'MEMORY_TOO_LONG',
        originalError: {
          response: {
            data: {
              error: 'too long',
              code: 'MEMORY_TOO_LONG',
              details: { chars: 9001, maxChars: 8000 }
            }
          }
        }
      })
    );
    await renderPage();
    fireEvent.change(notes(), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(within(memoryCard()).getByRole('button', { name: 'Save' }));
    });
    await flush();

    expect(within(memoryCard()).getByRole('alert')).toHaveTextContent(
      'The notes are too long (9001 of 8000 characters)'
    );
  });

  it('clears the notes through the API after confirmation', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    fetchScheduledTaskMemory
      .mockResolvedValueOnce(MEMORY)
      .mockResolvedValue({ ...MEMORY, body: '', version: 4, chars: 0 });
    await renderPage();

    await act(async () => {
      fireEvent.click(within(memoryCard()).getByRole('button', { name: 'Clear' }));
    });
    await flush();

    expect(confirm).toHaveBeenCalled();
    expect(deleteScheduledTaskMemory).toHaveBeenCalledWith('st-1');
    expect(notes()).toHaveValue('');
    confirm.mockRestore();
  });

  it('does not clear when the owner declines', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    await renderPage();
    await act(async () => {
      fireEvent.click(within(memoryCard()).getByRole('button', { name: 'Clear' }));
    });
    expect(deleteScheduledTaskMemory).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('says the notes are kept but unused while memory is off', async () => {
    fetchScheduledTask.mockResolvedValue({ ...TASK, notify: 'always', memory: { enabled: false } });
    fetchScheduledTaskMemory.mockResolvedValue({ ...MEMORY, enabled: false });
    await renderPage();

    const row = screen.getByText('Memory', { selector: 'dt' }).closest('div');
    expect(within(row).getByText('Off')).toBeInTheDocument();
    expect(within(memoryCard()).getByTestId('memory-notice')).toHaveTextContent(
      'Memory is off; these notes are kept but not used.'
    );
    // Still readable and editable: the notes are kept.
    expect(notes()).toHaveValue(MEMORY.body);
    expect(notes()).not.toHaveAttribute('readonly');
  });

  it('says so when memory is switched off for the whole platform', async () => {
    fetchScheduledTaskMemory.mockResolvedValue({ ...MEMORY, platformEnabled: false });
    await renderPage();
    expect(within(memoryCard()).getByTestId('memory-notice')).toHaveTextContent(
      'Memory is switched off for the whole platform'
    );
  });

  it('shows the notes read-only to someone who may not edit tasks', async () => {
    useCanCreateScheduledTasks.mockReturnValue(false);
    await renderPage();
    expect(notes()).toHaveAttribute('readonly');
    expect(within(memoryCard()).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(memoryCard()).getByTestId('memory-notice')).toHaveTextContent(
      'these notes are read-only'
    );
  });

  describe('run history', () => {
    it('marks runs that found nothing new and runs that updated the notes', async () => {
      fetchScheduledTaskRuns.mockResolvedValue({
        items: [
          run('r-nochange', { memory: { enabled: true, changed: false, compose: 'unchanged' } }),
          run('r-updated', { memory: { enabled: true, changed: true, compose: 'written' } }),
          run('r-both', { memory: { enabled: true, changed: false, compose: 'written' } }),
          run('r-versions', {
            memory: { enabled: true, changed: null, versionRead: 2, versionWritten: 3 }
          }),
          run('r-failed', { memory: { enabled: true, changed: null, compose: 'failed' } }),
          run('r-plain')
        ],
        nextCursor: null
      });
      await renderPage();

      const rows = screen.getAllByRole('row').slice(1);
      expect(rows).toHaveLength(6);
      const badges = row => ({
        noChanges: within(row).queryByText('No changes') !== null,
        updated: within(row).queryByText('Memory updated') !== null
      });
      expect(badges(rows[0])).toEqual({ noChanges: true, updated: false });
      expect(badges(rows[1])).toEqual({ noChanges: false, updated: true });
      expect(badges(rows[2])).toEqual({ noChanges: true, updated: true });
      expect(badges(rows[3])).toEqual({ noChanges: false, updated: true });
      expect(badges(rows[4])).toEqual({ noChanges: false, updated: false });
      expect(badges(rows[5])).toEqual({ noChanges: false, updated: false });
    });
  });

  describe('while a run is active (the page polls every 4 s)', () => {
    const ACTIVE = { ...TASK, activeRun: { id: 'r-live', status: 'running' } };

    beforeEach(() => {
      jest.useFakeTimers();
      fetchScheduledTask.mockImplementation(async () => ({ ...ACTIVE }));
    });

    it('keeps what the owner is typing when a poll brings a new task object', async () => {
      await renderPage();
      fireEvent.change(notes(), { target: { value: 'half-written thought' } });
      const readsBefore = fetchScheduledTaskMemory.mock.calls.length;
      const pollsBefore = fetchScheduledTask.mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      await flush();
      expect(fetchScheduledTask.mock.calls.length).toBe(pollsBefore + 1);

      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      await flush();
      expect(fetchScheduledTask.mock.calls.length).toBe(pollsBefore + 2);

      expect(notes()).toHaveValue('half-written thought');
      // Nothing changed on the server, so the notes are not read again, and no prompt appears.
      expect(fetchScheduledTaskMemory.mock.calls.length).toBe(readsBefore);
      expect(within(memoryCard()).queryByRole('status')).not.toBeInTheDocument();
    });

    it('keeps the typed text and asks first when a run updated the notes meanwhile', async () => {
      await renderPage();
      fireEvent.change(notes(), { target: { value: 'half-written thought' } });

      fetchScheduledTask.mockImplementation(async () => ({
        ...ACTIVE,
        memorySummary: { ...TASK.memorySummary, version: 4, chars: 40 }
      }));
      fetchScheduledTaskMemory.mockResolvedValue({
        ...MEMORY,
        body: 'the run wrote this',
        version: 4
      });
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      await flush();

      expect(notes()).toHaveValue('half-written thought');
      const prompt = within(memoryCard()).getByRole('status');
      expect(prompt).toHaveTextContent('The notes changed since you started editing');

      // Reloading is the owner's choice and discards the edit.
      await act(async () => {
        fireEvent.click(within(prompt).getByRole('button', { name: 'Reload (discard my edits)' }));
      });
      await flush();
      expect(notes()).toHaveValue('the run wrote this');
    });

    it('follows a run that updated the notes when there is nothing unsaved', async () => {
      await renderPage();
      fetchScheduledTask.mockImplementation(async () => ({
        ...ACTIVE,
        memorySummary: { ...TASK.memorySummary, version: 4 }
      }));
      fetchScheduledTaskMemory.mockResolvedValue({
        ...MEMORY,
        body: 'the run wrote this',
        version: 4
      });

      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      await flush();

      expect(notes()).toHaveValue('the run wrote this');
      expect(within(memoryCard()).queryByRole('status')).not.toBeInTheDocument();
    });
  });
});
