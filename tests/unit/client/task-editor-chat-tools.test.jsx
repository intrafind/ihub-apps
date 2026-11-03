// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TaskEditorPage, {
  chatToolsToTask
} from '../../../client/src/features/tasks/pages/TaskEditorPage';
import {
  createScheduledTask,
  fetchIntegrationScopes,
  fetchModels,
  fetchScheduledTask,
  fetchScheduledTaskAppTools
} from '../../../client/src/api';
import { useScheduledTaskLimits } from '../../../client/src/features/tasks/hooks/useScheduledTasksConfig';

/**
 * "Schedule this…" hands the task form the chat's `enabledTools`: tool
 * references such as `ifinder` (every iFinder tool) or an MCP server id, not
 * the tool ids a task stores. The form has the server resolve them against
 * the app's tools, so the chat's tools show switched on and the task saves
 * tool ids.
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

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid={`icon-${name}`} />
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

/** The app's tools as the server resolves a chat's `['ifinder']` against them. */
const RESOLVED = [
  { id: 'iFinder_search', name: 'iFinder search', toggleable: true, selected: true },
  { id: 'iFinder_getContent', name: 'iFinder content', toggleable: true, selected: true },
  { id: 'drawio__create_diagram', name: 'Draw a diagram', toggleable: true, selected: false },
  { id: 'braveSearch', name: 'Web search', toggleable: false, selected: false }
];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function scheduleFromChat(enabledTools) {
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: '/tasks/new',
          state: {
            draft: {
              name: 'Contracts digest',
              instructions: 'New contracts?',
              appId: 'ifinder-search',
              enabledTools
            }
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
}

async function create() {
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await flush();
}

describe('TaskEditorPage: the tools of the chat a task is scheduled from', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useScheduledTaskLimits.mockReturnValue(LIMITS);
    fetchModels.mockResolvedValue([]);
    fetchIntegrationScopes.mockResolvedValue({ integrations: [] });
    createScheduledTask.mockResolvedValue({ id: 'st-new' });
    fetchScheduledTaskAppTools.mockResolvedValue({ items: RESOLVED });
  });

  it('shows the tools an `ifinder` reference selects as on, and saves their ids', async () => {
    await scheduleFromChat(['ifinder']);

    expect(fetchScheduledTaskAppTools).toHaveBeenCalledWith('ifinder-search', {
      select: ['ifinder']
    });
    expect(screen.getByLabelText("Use the app's defaults")).not.toBeChecked();
    expect(screen.getByLabelText('iFinder search')).toBeChecked();
    expect(screen.getByLabelText('iFinder content')).toBeChecked();
    expect(screen.getByLabelText('Draw a diagram')).not.toBeChecked();

    await create();
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ enabledTools: ['iFinder_search', 'iFinder_getContent'] })
    );
  });

  it("keeps the app's defaults when the chat had every tool on", async () => {
    fetchScheduledTaskAppTools.mockResolvedValue({
      items: RESOLVED.map(tool => ({ ...tool, selected: tool.toggleable }))
    });
    await scheduleFromChat(['ifinder', 'drawio']);

    expect(screen.getByLabelText("Use the app's defaults")).toBeChecked();
    await create();
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ enabledTools: null })
    );
  });

  it('keeps every tool off when the chat had them all off', async () => {
    await scheduleFromChat([]);

    expect(fetchScheduledTaskAppTools).toHaveBeenCalledWith('ifinder-search', {});
    expect(screen.getByLabelText('iFinder search')).not.toBeChecked();
    await create();
    expect(createScheduledTask).toHaveBeenCalledWith(expect.objectContaining({ enabledTools: [] }));
  });

  it('resolves nothing for a saved task: its tools are tool ids already', async () => {
    fetchScheduledTask.mockResolvedValue({
      id: 'st-1',
      name: 'Digest',
      description: '',
      instructions: 'x',
      appId: 'ifinder-search',
      modelId: null,
      variables: {},
      enabledTools: ['iFinder_search'],
      integrationScopes: {},
      notify: 'always',
      memory: { enabled: false },
      schedule: { type: 'manual' }
    });
    render(
      <MemoryRouter initialEntries={['/tasks/st-1/edit']}>
        <Routes>
          <Route path="/tasks/:taskId/edit" element={<TaskEditorPage />} />
        </Routes>
      </MemoryRouter>
    );
    await flush();
    expect(fetchScheduledTaskAppTools).toHaveBeenCalledWith('ifinder-search', {});
    expect(screen.getByLabelText('iFinder search')).toBeChecked();
    expect(screen.getByLabelText('iFinder content')).not.toBeChecked();
  });
});

describe('chatToolsToTask', () => {
  it('maps resolved tools to the task tools', () => {
    expect(chatToolsToTask(RESOLVED, ['ifinder'])).toEqual([
      'iFinder_search',
      'iFinder_getContent'
    ]);
    expect(chatToolsToTask(RESOLVED, [])).toEqual([]);
    expect(
      chatToolsToTask(
        RESOLVED.map(tool => ({ ...tool, selected: true })),
        ['ifinder', 'drawio']
      )
    ).toBeNull();
  });
});
