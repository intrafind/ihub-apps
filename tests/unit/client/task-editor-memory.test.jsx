import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TaskEditorPage from '../../../client/src/features/tasks/pages/TaskEditorPage';
import {
  createScheduledTask,
  fetchModels,
  fetchScheduledTask,
  fetchScheduledTaskAppTools,
  updateScheduledTask
} from '../../../client/src/api';
import { useScheduledTaskLimits } from '../../../client/src/features/tasks/hooks/useScheduledTasksConfig';

/**
 * "Remember between runs" on the task form. The form's field lists (the empty
 * draft, the mapping of a loaded task and the submit body) are explicit, so a
 * setting missing from any one of them is dropped without an error: these tests
 * pin all three. "Only when something changed" needs the notes, so the form
 * keeps the two consistent and shows the server's own refusal when it still
 * comes.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => ({ apps: [{ id: 'chat', name: { en: 'Chat' } }] })
}));

jest.mock('../../../client/src/features/tasks/components/ScheduleBuilder', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasksConfig', () => ({
  useScheduledTaskLimits: jest.fn()
}));

jest.mock('../../../client/src/api', () => ({
  browserTimezone: () => 'Europe/Berlin',
  createScheduledTask: jest.fn(),
  fetchModels: jest.fn(),
  fetchScheduledTask: jest.fn(),
  fetchScheduledTaskAppTools: jest.fn(),
  updateScheduledTask: jest.fn()
}));

const LIMITS = {
  minIntervalMinutes: 15,
  staggerMinutes: 0,
  maxTasksPerUser: 10,
  maxInstructionLength: 8000,
  memoryEnabled: true,
  memoryMaxChars: 8000
};

const TASK = {
  id: 'st-1',
  name: 'OpenWebUI changelog',
  description: '',
  instructions: 'Summarize the latest features.',
  appId: 'chat',
  modelId: null,
  variables: {},
  enabledTools: null,
  notify: 'always',
  memory: { enabled: true },
  schedule: { type: 'manual' }
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderEditor(path = '/tasks/new') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks/new" element={<TaskEditorPage />} />
        <Route path="/tasks/:taskId/edit" element={<TaskEditorPage />} />
        <Route path="/tasks/:taskId" element={<p>Task page</p>} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
}

const memoryToggle = () => screen.getByRole('checkbox', { name: 'Remember between runs' });
const notifySelect = () => screen.getByLabelText('Notify me');
const changesOption = () =>
  screen.getByRole('option', { name: 'Only when something changed (and on failures)' });

async function submit(name) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
  await flush();
}

describe('TaskEditorPage: remember between runs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useScheduledTaskLimits.mockReturnValue(LIMITS);
    fetchModels.mockResolvedValue([]);
    fetchScheduledTaskAppTools.mockResolvedValue({ items: [] });
    createScheduledTask.mockResolvedValue({ id: 'st-new' });
    updateScheduledTask.mockResolvedValue({ id: 'st-1' });
    fetchScheduledTask.mockResolvedValue(TASK);
  });

  it('starts a new task with memory off and sends the setting when it is created', async () => {
    await renderEditor();
    expect(memoryToggle()).not.toBeChecked();

    await submit('Create task');
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ memory: { enabled: false } })
    );
  });

  it('sends memory on when the box is ticked on a new task', async () => {
    await renderEditor();
    fireEvent.click(memoryToggle());
    expect(memoryToggle()).toBeChecked();

    await submit('Create task');
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ memory: { enabled: true } })
    );
  });

  it('maps the memory setting of a task being edited and sends it back on save', async () => {
    await renderEditor('/tasks/st-1/edit');
    expect(memoryToggle()).toBeChecked();

    await submit('Save');
    expect(updateScheduledTask).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ memory: { enabled: true } })
    );
  });

  it('sends memory off when it is unticked while editing', async () => {
    await renderEditor('/tasks/st-1/edit');
    fireEvent.click(memoryToggle());

    await submit('Save');
    expect(updateScheduledTask).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ memory: { enabled: false } })
    );
  });

  it('treats a task from before the feature, which has no memory field, as off', async () => {
    const { memory, ...legacy } = TASK;
    expect(memory).toBeDefined();
    fetchScheduledTask.mockResolvedValue(legacy);
    await renderEditor('/tasks/st-1/edit');
    expect(memoryToggle()).not.toBeChecked();

    await submit('Save');
    expect(updateScheduledTask).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ memory: { enabled: false } })
    );
  });

  it('describes what the setting does', async () => {
    await renderEditor();
    expect(memoryToggle()).toHaveAccessibleDescription(
      /keeps notes and updates them after each run/
    );
  });

  it('offers "only when something changed" only while memory is on', async () => {
    await renderEditor();
    expect(changesOption()).toBeDisabled();
    expect(
      screen.getByText('"Only when something changed" needs "Remember between runs".')
    ).toBeInTheDocument();

    fireEvent.click(memoryToggle());
    expect(changesOption()).toBeEnabled();
    expect(
      screen.queryByText('"Only when something changed" needs "Remember between runs".')
    ).not.toBeInTheDocument();

    fireEvent.change(notifySelect(), { target: { value: 'changes' } });
    await submit('Create task');
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ notify: 'changes', memory: { enabled: true } })
    );
  });

  it('switches notify back to "After every run" when memory is turned off under it', async () => {
    fetchScheduledTask.mockResolvedValue({ ...TASK, notify: 'changes' });
    await renderEditor('/tasks/st-1/edit');
    expect(notifySelect()).toHaveValue('changes');

    fireEvent.click(memoryToggle());
    expect(notifySelect()).toHaveValue('always');

    await submit('Save');
    expect(updateScheduledTask).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ notify: 'always', memory: { enabled: false } })
    );
  });

  it('keeps other notify choices when memory is turned off', async () => {
    fetchScheduledTask.mockResolvedValue({ ...TASK, notify: 'failure' });
    await renderEditor('/tasks/st-1/edit');
    fireEvent.click(memoryToggle());
    expect(notifySelect()).toHaveValue('failure');
  });

  it('shows the field error the server gives for notify', async () => {
    const refusal = Object.assign(new Error('Validation failed'), {
      status: 400,
      code: 'VALIDATION_FAILED',
      originalError: {
        response: {
          data: {
            error: 'Validation failed',
            code: 'VALIDATION_FAILED',
            details: [
              {
                field: 'notify',
                code: 'NOTIFY_CHANGES_NEEDS_MEMORY',
                message: 'Notifying only when something changed needs "Remember between runs"'
              }
            ]
          }
        }
      }
    });
    updateScheduledTask.mockRejectedValue(refusal);
    await renderEditor('/tasks/st-1/edit');

    await submit('Save');
    expect(
      screen.getByText('Notifying only when something changed needs "Remember between runs"')
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('disables the setting, with a reason, when memory is switched off for the platform', async () => {
    useScheduledTaskLimits.mockReturnValue({ ...LIMITS, memoryEnabled: false });
    await renderEditor('/tasks/st-1/edit');
    expect(memoryToggle()).toBeDisabled();
    expect(screen.getByText(/switched memory off for all tasks/)).toBeInTheDocument();

    // The task's own setting is kept, not silently dropped by saving.
    expect(memoryToggle()).toBeChecked();
    await submit('Save');
    expect(updateScheduledTask).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ memory: { enabled: true } })
    );
  });

  it('keeps the setting of a task that arrives pre-filled from a chat card', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/tasks/new',
            state: {
              draft: {
                name: 'Weekly digest',
                instructions: 'Summarize.',
                appId: 'chat',
                notify: 'changes',
                memory: { enabled: true },
                schedule: { type: 'manual' }
              },
              proposalId: 'p-1'
            }
          }
        ]}
      >
        <Routes>
          <Route path="/tasks/new" element={<TaskEditorPage />} />
          <Route path="/tasks/:taskId" element={<p>Task page</p>} />
        </Routes>
      </MemoryRouter>
    );
    await flush();
    expect(memoryToggle()).toBeChecked();
    expect(notifySelect()).toHaveValue('changes');

    await submit('Create task');
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: { enabled: true },
        notify: 'changes',
        proposalId: 'p-1'
      })
    );
  });
});
