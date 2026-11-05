// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TaskEditorPage from '../../../client/src/features/tasks/pages/TaskEditorPage';
import ScheduleThisAction from '../../../client/src/features/tasks/components/ScheduleThisAction';
import {
  createScheduledTask,
  fetchIntegrationScopes,
  fetchModels,
  fetchScheduledTask,
  fetchScheduledTaskAppTools,
  updateScheduledTask
} from '../../../client/src/api';
import { useScheduledTaskLimits } from '../../../client/src/features/tasks/hooks/useScheduledTasksConfig';

/**
 * Scheduled tasks keep the integration scope they were saved with (#3057):
 * "Schedule this…" carries the chat's scopes into the form, the form shows
 * and changes them with the chat's own list, a saved scope the user lost is
 * named, and what the form saves is what it shows.
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
  default: () => ({ apps: [{ id: 'ifinder-search', name: { en: 'iFinder Search' } }] })
}));

jest.mock('../../../client/src/features/tasks/components/ScheduleBuilder', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasksConfig', () => ({
  useScheduledTaskLimits: jest.fn()
}));

jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasks', () => ({
  useScheduledTasksAvailable: () => true,
  useCanCreateScheduledTasks: () => true
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-icon={name} />
}));

// The attached-files section of the editor reads and writes through these.
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));
jest.mock('../../../client/src/api', () => ({
  fetchScheduledTaskFiles: jest.fn(async () => ({ items: [] })),
  uploadScheduledTaskFile: jest.fn(async () => ({ file: { id: 'file_1' } })),
  deleteScheduledTaskFile: jest.fn(async () => ({ deleted: true })),
  browserTimezone: () => 'Europe/Berlin',
  createScheduledTask: jest.fn(),
  fetchIntegrationScopes: jest.fn(),
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

const IFINDER = {
  id: 'ifinder',
  name: { en: 'iFinder', de: 'iFinder' },
  action: 'search',
  scopePicker: 'menu',
  fixed: false,
  defaultScope: 'standard',
  scopes: [
    { id: 'standard', name: 'Standard', isDefault: true },
    { id: 'contracts', name: 'Contracts', isDefault: false }
  ]
};

const TASK = {
  id: 'st-1',
  name: 'Contracts digest',
  description: '',
  instructions: 'New contracts?',
  appId: 'ifinder-search',
  modelId: null,
  variables: {},
  enabledTools: null,
  integrationScopes: { ifinder: 'contracts' },
  notify: 'always',
  memory: { enabled: false },
  schedule: { type: 'manual' }
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function renderEditor(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/tasks/new" element={<TaskEditorPage />} />
        <Route path="/tasks/:taskId/edit" element={<TaskEditorPage />} />
        <Route path="/tasks/:taskId" element={<p>Task page</p>} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
}

const scopeSelect = () => screen.getByLabelText('iFinder: Search in');

async function submit(name) {
  // fireEvent already wraps the click in act(); flush() then lets the save settle.
  fireEvent.click(screen.getByRole('button', { name }));
  await flush();
}

describe('TaskEditorPage: where the task searches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useScheduledTaskLimits.mockReturnValue(LIMITS);
    fetchModels.mockResolvedValue([]);
    fetchScheduledTaskAppTools.mockResolvedValue({ items: [] });
    fetchIntegrationScopes.mockResolvedValue({ integrations: [IFINDER] });
    createScheduledTask.mockResolvedValue({ id: 'st-new' });
    updateScheduledTask.mockResolvedValue({ id: 'st-1' });
    fetchScheduledTask.mockResolvedValue(TASK);
  });

  it('keeps the scope of the chat the task was scheduled from', async () => {
    await renderEditor({
      pathname: '/tasks/new',
      state: {
        draft: {
          name: 'Contracts digest',
          instructions: 'New contracts?',
          appId: 'ifinder-search',
          integrationScopes: { ifinder: 'contracts' }
        }
      }
    });
    expect(fetchIntegrationScopes).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'ifinder-search' })
    );
    expect(scopeSelect()).toHaveValue('contracts');
    await submit('Create task');
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ integrationScopes: { ifinder: 'contracts' } })
    );
  });

  it('shows and changes the scope of a saved task', async () => {
    await renderEditor('/tasks/st-1/edit');
    expect(scopeSelect()).toHaveValue('contracts');
    fireEvent.change(scopeSelect(), { target: { value: 'standard' } });
    await submit('Save');
    expect(updateScheduledTask).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ integrationScopes: { ifinder: 'standard' } })
    );
  });

  it('names a saved scope the user lost; the picker shows the default instead', async () => {
    fetchScheduledTask.mockResolvedValue({ ...TASK, integrationScopes: { ifinder: 'board' } });
    await renderEditor('/tasks/st-1/edit');
    expect(screen.getByRole('alert')).toHaveTextContent('“board” is no longer available to you');
    expect(scopeSelect()).toHaveValue('standard');
  });

  it('shows the server’s refusal of a scope', async () => {
    updateScheduledTask.mockRejectedValue({
      details: {
        issues: [
          {
            field: 'integrationScopes',
            code: 'INTEGRATION_SCOPE_NOT_ALLOWED',
            message: 'The iFinder search profile "contracts" is not available to you.'
          }
        ]
      }
    });
    await renderEditor('/tasks/st-1/edit');
    await submit('Save');
    expect(
      screen.getAllByText('The iFinder search profile "contracts" is not available to you.').length
    ).toBeGreaterThan(0);
  });

  it('sends the saved scopes as they are when the list cannot be loaded', async () => {
    fetchIntegrationScopes.mockRejectedValue(new Error('offline'));
    await renderEditor('/tasks/st-1/edit');
    expect(screen.queryByLabelText('iFinder: Search in')).not.toBeInTheDocument();
    await submit('Save');
    expect(updateScheduledTask).toHaveBeenCalledWith(
      'st-1',
      expect.objectContaining({ integrationScopes: { ifinder: 'contracts' } })
    );
  });

  it('shows a scope the app fixes without letting it change', async () => {
    fetchIntegrationScopes.mockResolvedValue({
      integrations: [
        { ...IFINDER, fixed: true, scopes: [IFINDER.scopes[1]], defaultScope: 'contracts' }
      ]
    });
    await renderEditor('/tasks/st-1/edit');
    expect(scopeSelect()).toBeDisabled();
    expect(screen.getByText('Set by the app; it cannot be changed.')).toBeInTheDocument();
  });
});

describe('ScheduleThisAction', () => {
  function Draft() {
    const location = useLocation();
    return <pre data-testid="draft">{JSON.stringify(location.state?.draft || null)}</pre>;
  }

  it('carries the chat’s integration scopes into the new task', () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route
            path="/chat"
            element={
              <ScheduleThisAction
                content="New contracts?"
                appId="ifinder-search"
                enabledTools={['iFinder_search']}
                integrationScopes={{ ifinder: 'contracts' }}
              />
            }
          />
          <Route path="/tasks/new" element={<Draft />} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Schedule this…' }));
    expect(JSON.parse(screen.getByTestId('draft').textContent)).toEqual({
      name: 'New contracts?',
      instructions: 'New contracts?',
      appId: 'ifinder-search',
      enabledTools: ['iFinder_search'],
      integrationScopes: { ifinder: 'contracts' }
    });
  });
});
