// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The workflow edit page shows the bottom save bar only while there is something to
 * save (an edit, or JSON the editor cannot parse yet). Save keeps refusing invalid JSON,
 * Discard goes back to the stored workflow, and a new workflow says Create.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockUpdate = jest.fn();
const mockCreate = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  createAdminWorkflow: (...a) => mockCreate(...a),
  deleteAdminWorkflow: jest.fn(),
  fetchAdminApps: jest.fn().mockResolvedValue([]),
  fetchAdminWorkflow: jest.fn().mockResolvedValue({
    id: 'wf1',
    version: '1.0.0',
    name: { en: 'Triage' },
    description: { en: '' },
    config: { maxExecutionTime: 300000 },
    nodes: [],
    edges: []
  }),
  getAdminApiErrorMessage: err => err?.message || 'error',
  updateAdminWorkflow: (...a) => mockUpdate(...a)
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

const en = require('../../../shared/i18n/en.json');
const AdminWorkflowEditPage =
  require('../../../client/src/features/admin/pages/AdminWorkflowEditPage').default;

const renderPage = path =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/workflows/new" element={<AdminWorkflowEditPage />} />
        <Route path="/admin/workflows/:id" element={<AdminWorkflowEditPage />} />
        <Route path="/admin/workflows" element={<div>workflows list</div>} />
      </Routes>
    </MemoryRouter>
  );

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const barButtons = () => within(bar()).getAllByRole('button');
const saveButton = () => barButtons().at(-1);

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue({});
  mockCreate.mockResolvedValue({});
});

describe('AdminWorkflowEditPage save bar', () => {
  it('shows no bar until something changes, then Discard goes back to the stored workflow', async () => {
    renderPage('/admin/workflows/wf1');
    const version = await screen.findByLabelText('Version');
    await settle();
    expect(bar()).toBeNull();

    fireEvent.change(version, { target: { value: '2.0.0' } });
    expect(bar()).toBeInTheDocument();
    expect(within(bar()).getByText(en.admin.ui.saveBar.unsaved)).toBeInTheDocument();

    fireEvent.click(within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard }));
    expect(screen.getByLabelText('Version')).toHaveValue('1.0.0');
    expect(screen.getByRole('textbox', { name: '' }).value).toContain('"version": "1.0.0"');
    expect(bar()).toBeNull();
  });

  it('saves the edited workflow and returns to the list', async () => {
    renderPage('/admin/workflows/wf1');
    fireEvent.change(await screen.findByLabelText('Version'), { target: { value: '2.0.0' } });

    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith('wf1', expect.objectContaining({ version: '2.0.0' }));
    expect(await screen.findByText('workflows list')).toBeInTheDocument();
  });

  it('counts an edit of a nested setting as a change: it can be saved and discarded', async () => {
    renderPage('/admin/workflows/wf1');
    const seconds = await screen.findByLabelText('Max execution time (seconds)');
    await settle();
    expect(bar()).toBeNull();

    // Only the nested `config.maxExecutionTime` changes; nothing else on the page does.
    fireEvent.change(seconds, { target: { value: '600' } });
    expect(bar()).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      'wf1',
      expect.objectContaining({ config: expect.objectContaining({ maxExecutionTime: 600000 }) })
    );
  });

  it('discards an edit of a nested setting', async () => {
    renderPage('/admin/workflows/wf1');
    const seconds = await screen.findByLabelText('Max execution time (seconds)');
    await settle();

    fireEvent.change(seconds, { target: { value: '600' } });
    fireEvent.click(within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard }));

    expect(screen.getByLabelText('Max execution time (seconds)')).toHaveValue(300);
    expect(bar()).toBeNull();
  });

  it('shows the bar for JSON that cannot be parsed, and Save refuses it', async () => {
    renderPage('/admin/workflows/wf1');
    await screen.findByLabelText('Version');
    const json = screen.getByRole('textbox', { name: '' });

    fireEvent.change(json, { target: { value: '{ "id": ' } });

    expect(bar()).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please fix JSON errors before saving'
    );

    // Discard takes the broken text away too.
    fireEvent.click(within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard }));
    expect(bar()).toBeNull();
    expect(screen.queryByText(/JSON Validation Error/)).not.toBeInTheDocument();
  });

  it('says Create for a new workflow once it is edited', async () => {
    renderPage('/admin/workflows/new');
    const id = await screen.findByLabelText('Workflow ID');
    expect(bar()).toBeNull();

    fireEvent.change(id, { target: { value: 'fresh' } });

    expect(saveButton()).toHaveTextContent(en.admin.ui.saveBar.create);
  });
});
