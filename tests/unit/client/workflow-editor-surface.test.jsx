// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import WorkflowEditorPage from '../../../client/src/features/admin/pages/WorkflowEditorPage';

/**
 * The full-screen workflow editor (/admin/workflows/:id/edit) sits outside AdminLayout, so it has
 * to mark the admin surface itself; otherwise its fields get neither the admin field rule nor the
 * admin carve-out from the end-user dark rule in App.css.
 */

jest.mock('../../../client/src/api/client', () => ({
  apiClient: { get: jest.fn(() => new Promise(() => {})), post: jest.fn(), put: jest.fn() }
}));

jest.mock('../../../client/src/features/workflows/editor/WorkflowEditor', () => ({
  WorkflowEditor: () => <div data-testid="workflow-editor" />
}));

const surface = () => document.documentElement.getAttribute('data-surface');

afterEach(() => {
  document.documentElement.removeAttribute('data-surface');
});

test('the workflow editor marks the admin surface while it is open', () => {
  const view = render(
    <MemoryRouter initialEntries={['/admin/workflows/new/edit']}>
      <Routes>
        <Route path="/admin/workflows/:id/edit" element={<WorkflowEditorPage />} />
      </Routes>
    </MemoryRouter>
  );
  expect(surface()).toBe('admin');
  view.unmount();
  expect(surface()).toBeNull();
});
