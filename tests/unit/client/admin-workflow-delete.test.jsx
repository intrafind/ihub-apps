// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Deleting a workflow from its edit page leaves the page: the unsaved-changes
 * guard is told the edits are settled first (`markSaved`), so it does not
 * block the navigation to the list. A failed delete keeps the page dirty.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'wf1' }),
  useNavigate: () => mockNavigate
}));
const mockMarkSaved = jest.fn();
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({
    isDirty: true,
    blocker: { state: 'unblocked' },
    markSaved: mockMarkSaved
  })
}));
const mockDeleteAdminWorkflow = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  createAdminWorkflow: jest.fn(),
  deleteAdminWorkflow: (...a) => mockDeleteAdminWorkflow(...a),
  fetchAdminApps: jest.fn().mockResolvedValue([]),
  fetchAdminWorkflow: jest.fn().mockResolvedValue({
    id: 'wf1',
    name: { en: 'Triage' },
    description: { en: '' },
    nodes: [],
    edges: []
  }),
  getAdminApiErrorMessage: err => err?.message || 'error',
  updateAdminWorkflow: jest.fn()
}));
const stub = () => ({ __esModule: true, default: () => null });
jest.mock('../../../client/src/shared/components/Icon', () => stub());
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => stub());
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => stub());
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => stub());
jest.mock('../../../client/src/features/admin/components/WorkflowChatIntegrationSection', () =>
  stub()
);
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const AdminWorkflowEditPage =
  require('../../../client/src/features/admin/pages/AdminWorkflowEditPage').default;

beforeEach(() => {
  jest.clearAllMocks();
});

async function confirmDelete() {
  render(<AdminWorkflowEditPage />);
  const header = await screen.findByRole('heading', { level: 1 });
  const deleteButton = within(header.closest('div').parentElement).getByRole('button', {
    name: 'Delete'
  });
  fireEvent.click(deleteButton);
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
  });
}

test('a successful delete marks the edits settled before it navigates', async () => {
  mockDeleteAdminWorkflow.mockResolvedValue({});
  await confirmDelete();
  expect(mockDeleteAdminWorkflow).toHaveBeenCalledWith('wf1');
  expect(mockMarkSaved).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith('/admin/workflows');
  expect(mockMarkSaved.mock.invocationCallOrder[0]).toBeLessThan(
    mockNavigate.mock.invocationCallOrder[0]
  );
});

test('a failed delete keeps the page dirty and stays', async () => {
  mockDeleteAdminWorkflow.mockRejectedValue(new Error('Workflow is in use'));
  await confirmDelete();
  expect(mockMarkSaved).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toBeInTheDocument();
});
