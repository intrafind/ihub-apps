// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WorkflowEditorPage from '../../../client/src/features/admin/pages/WorkflowEditorPage';
import { createStarterWorkflow } from '../../../client/src/features/workflows/editor/workflowEditorUtils';
import { apiClient } from '../../../client/src/api/client';

/**
 * AX-B6: the visual workflow editor asks before its Back button, the "Chat
 * integration" link or any other navigation drops unsaved canvas edits.
 */

// A stable `t`, as react-i18next gives: the page reloads the workflow when it changes.
jest.mock('react-i18next', () => {
  const translation = {
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  };
  return { useTranslation: () => translation };
});

jest.mock('../../../client/src/api/client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), put: jest.fn() }
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />
}));

// The canvas itself (React Flow) is replaced by a stand-in that reports its
// nodes like the real editor does and can "move" the first step or save.
jest.mock('../../../client/src/features/workflows/editor/WorkflowEditor', () => ({
  WorkflowEditor: ({ initialNodes, initialEdges, onSave, onFlowChange }) => {
    const { useEffect } = require('react');
    useEffect(() => {
      onFlowChange?.(initialNodes, initialEdges);
    }, []);
    const moved = initialNodes.map((node, index) =>
      index === 0 ? { ...node, position: { x: node.position.x + 50, y: node.position.y } } : node
    );
    return (
      <div data-testid="canvas">
        <button type="button" onClick={() => onFlowChange(moved, initialEdges)}>
          move step
        </button>
        <button type="button" onClick={() => onSave(moved, initialEdges)}>
          save canvas
        </button>
      </div>
    );
  }
}));

function renderEditor() {
  return render(
    <MemoryRouter
      initialEntries={['/admin/workflows', '/admin/workflows/rule-check/edit']}
      initialIndex={1}
    >
      <Routes>
        <Route path="/admin/workflows" element={<p>workflow list</p>} />
        <Route path="/admin/workflows/:id/edit" element={<WorkflowEditorPage />} />
        <Route path="/admin/workflows/:id" element={<p>workflow page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('workflow canvas unsaved-changes guard', () => {
  beforeEach(() => {
    apiClient.get.mockReset();
    apiClient.put.mockReset();
    apiClient.get.mockResolvedValue({ data: createStarterWorkflow({ id: 'rule-check' }) });
    apiClient.put.mockResolvedValue({ data: {} });
  });

  it('Back leaves at once while the canvas is unchanged', async () => {
    renderEditor();
    await screen.findByTestId('canvas');
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByText('workflow list')).toBeInTheDocument();
  });

  it('Back (navigate(-1)) asks after a canvas edit; Stay keeps the canvas, Discard goes back', async () => {
    renderEditor();
    await screen.findByTestId('canvas');
    fireEvent.click(screen.getByText('move step'));

    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Leave without saving?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByTestId('canvas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByText('workflow list')).toBeInTheDocument();
  });

  it('the "Chat integration" link asks after a canvas edit', async () => {
    renderEditor();
    await screen.findByTestId('canvas');
    fireEvent.click(screen.getByText('move step'));
    fireEvent.click(screen.getByRole('link', { name: 'Chat integration' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('does not ask after the edit was saved', async () => {
    renderEditor();
    await screen.findByTestId('canvas');
    fireEvent.click(screen.getByText('move step'));
    await act(async () => {
      fireEvent.click(screen.getByText('save canvas'));
    });
    expect(apiClient.put).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: 'Chat integration' }));
    expect(screen.getByText('workflow page')).toBeInTheDocument();
  });
});
