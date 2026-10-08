import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminAgentMemoryPage from '../../../client/src/features/admin/pages/AdminAgentMemoryPage';
import {
  fetchAgentMemory,
  fetchMemoryShaperPrompt,
  writeAgentMemory
} from '../../../client/src/api/agentsAdminApi';

/**
 * The agent memory page now sits on the shared MemoryEditor. What an admin
 * could do before still works: read the notes, save them against the version
 * they loaded, and be told when someone else saved first.
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

jest.mock('../../../client/src/api/agentsAdminApi', () => ({
  fetchAgentMemory: jest.fn(),
  writeAgentMemory: jest.fn(),
  buildMemoryFromTool: jest.fn(),
  fetchMemoryShaperPrompt: jest.fn()
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminTools: jest.fn().mockResolvedValue([]),
  getAdminApiErrorMessage: err => `API error: ${err.message}`
}));

jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => <nav data-testid="breadcrumb" />
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/agents/researcher/memory']}>
      <Routes>
        <Route path="/admin/agents/:profileId/memory" element={<AdminAgentMemoryPage />} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
}

const notes = () => screen.getByRole('textbox', { name: 'Memory notes' });

describe('AdminAgentMemoryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchAgentMemory.mockResolvedValue({
      data: { body: 'known fact\n', version: 2, updatedAt: '2026-10-01T10:00:00Z' }
    });
    fetchMemoryShaperPrompt.mockResolvedValue({ data: { prompt: 'shape {TOOL_RESULT}' } });
  });

  it('loads the profile memory and shows its version', async () => {
    await renderPage();
    expect(fetchAgentMemory).toHaveBeenCalledWith('researcher');
    expect(notes()).toHaveValue('known fact\n');
    expect(screen.getByTestId('memory-version')).toHaveTextContent('Version 2');
    expect(screen.getByText('Memory — researcher')).toBeInTheDocument();
  });

  it('saves against the loaded version', async () => {
    writeAgentMemory.mockResolvedValue({ data: { version: 3 } });
    await renderPage();
    fireEvent.change(notes(), { target: { value: 'known fact\nnew fact\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(writeAgentMemory).toHaveBeenCalledWith('researcher', {
      content: 'known fact\nnew fact\n',
      expectedVersion: 2
    });
    expect(screen.getByTestId('memory-version')).toHaveTextContent('Version 3');
  });

  it('tells the admin when the memory was changed elsewhere', async () => {
    writeAgentMemory.mockRejectedValue({
      response: { data: { error: 'VERSION_CONFLICT', currentVersion: 5 } },
      message: 'Request failed with status code 409'
    });
    await renderPage();
    fireEvent.change(notes(), { target: { value: 'edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Conflict: memory was modified elsewhere. Reload to see the latest.'
    );
  });

  it('keeps the build-from-tool panel and the back button', async () => {
    await renderPage();
    expect(screen.getByText('Build memory section from a tool')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to profile' })).toBeInTheDocument();
  });

  it('shows a load failure', async () => {
    fetchAgentMemory.mockRejectedValue(new Error('profile not found'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('API error: profile not found');
  });
});
