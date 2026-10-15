import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WorkflowEditorPage from '../../../client/src/features/admin/pages/WorkflowEditorPage';
import { createStarterWorkflow } from '../../../client/src/features/workflows/editor/workflowEditorUtils';
import { apiClient } from '../../../client/src/api/client';

/**
 * The visual editor has no fields for `chatIntegration`; its header points to
 * the workflow page, where they are. A workflow that does not exist yet has no
 * such page, so there is no link while creating one.
 */

// The translation function reads the real English strings, so a key the page uses but en.json
// lacks fails here.
jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const translate = (key, fallback, values) => {
    const text = typeof lookup(key) === 'string' ? lookup(key) : fallback;
    if (typeof text !== 'string') return key;
    return text.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => String(values?.[name] ?? ''));
  };
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

jest.mock('../../../client/src/api/client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() }
}));

jest.mock('../../../client/src/features/workflows/editor/WorkflowEditor', () => ({
  WorkflowEditor: () => <div data-testid="canvas" />
}));

function renderEditorAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="admin/workflows/:id/edit" element={<WorkflowEditorPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('visual editor: link to the chat integration settings', () => {
  beforeEach(() => {
    apiClient.get.mockReset();
  });

  it('links a saved workflow to its workflow page', async () => {
    apiClient.get.mockResolvedValue({ data: createStarterWorkflow({ id: 'rule-check' }) });

    renderEditorAt('/admin/workflows/rule-check/edit');

    const link = await screen.findByRole('link', { name: 'Chat integration' });
    expect(link).toHaveAttribute('href', '/admin/workflows/rule-check');
    expect(link).toHaveAttribute('title', expect.stringContaining('set on the workflow page'));
    expect(apiClient.get).toHaveBeenCalledWith('/workflows/rule-check');
  });

  it('has no link while a new workflow is being created', async () => {
    renderEditorAt('/admin/workflows/new/edit');

    await waitFor(() => expect(screen.getByTestId('canvas')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Chat integration' })).not.toBeInTheDocument();
  });
});
