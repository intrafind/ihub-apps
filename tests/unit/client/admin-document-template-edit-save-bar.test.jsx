// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The document template page keeps its settings behind the bottom save bar: it shows only
 * after an edit, Discard restores the stored template, Save keeps its validation, and a
 * new template says Create.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockSave = jest.fn();
const mockCreate = jest.fn();
const STORED = {
  id: 'corporate',
  name: { en: 'Corporate' },
  description: {},
  enabled: true,
  default: false,
  brand: {},
  fonts: [],
  document: {},
  pdf: {},
  docx: {},
  pptx: {}
};
jest.mock('../../../client/src/api/documentTemplatesAdminApi', () => ({
  createDocumentTemplate: (...a) => mockCreate(...a),
  fetchDocumentTemplate: jest.fn(async () => ({ template: STORED, files: {} })),
  fetchDocumentTemplateFile: jest.fn(),
  fetchDocumentTemplateSample: jest.fn(),
  removeDocumentTemplateFile: jest.fn(),
  saveDocumentTemplate: (...a) => mockSave(...a),
  uploadDocumentTemplateFile: jest.fn()
}));
jest.mock('../../../client/src/api/adminApi', () => ({
  getAdminApiErrorMessage: err => err?.message || 'error'
}));
const stub = () => ({ __esModule: true, default: () => null });
jest.mock('../../../client/src/shared/components/Icon', () => stub());
jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => stub());
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => stub());
jest.mock('../../../client/src/features/admin/components/document-templates/TemplateFileSlot', () =>
  stub()
);
jest.mock('../../../client/src/features/admin/components/document-templates/TemplateSlots', () =>
  stub()
);
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const en = require('../../../shared/i18n/en.json');
const AdminDocumentTemplateEditPage =
  require('../../../client/src/features/admin/pages/AdminDocumentTemplateEditPage').default;

const renderPage = path =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/admin/document-templates/:templateId"
          element={<AdminDocumentTemplateEditPage />}
        />
        <Route path="/admin/document-templates" element={<div>templates list</div>} />
      </Routes>
    </MemoryRouter>
  );

const bar = () => screen.queryByRole('region', { name: en.admin.ui.saveBar.label });
const barButtons = () => within(bar()).getAllByRole('button');
const saveButton = () => barButtons().at(-1);

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockImplementation(async (id, template) => ({ template, files: {} }));
  mockCreate.mockResolvedValue({ id: 'fresh' });
});

describe('AdminDocumentTemplateEditPage save bar', () => {
  it('has no bar until a setting changes; Discard restores the stored template', async () => {
    renderPage('/admin/document-templates/corporate');
    const enabled = await screen.findByLabelText(/^Enabled/);
    expect(bar()).toBeNull();

    fireEvent.click(enabled);
    expect(bar()).toBeInTheDocument();
    expect(screen.getByLabelText(/^Enabled/)).not.toBeChecked();

    fireEvent.click(within(bar()).getByRole('button', { name: en.admin.ui.saveBar.discard }));
    expect(screen.getByLabelText(/^Enabled/)).toBeChecked();
    expect(bar()).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('saves, stays on the page and the bar goes away', async () => {
    renderPage('/admin/document-templates/corporate');
    fireEvent.click(await screen.findByLabelText(/^Enabled/));

    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(mockSave).toHaveBeenCalledWith('corporate', expect.objectContaining({ enabled: false }));
    expect(bar()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Template saved.');
  });

  it('says Create for a new template, and validation still stops a template without a name', async () => {
    renderPage('/admin/document-templates/new');
    const id = await screen.findByLabelText(/^ID/);
    expect(bar()).toBeNull();

    fireEvent.change(id, { target: { value: 'fresh' } });
    expect(saveButton()).toHaveTextContent(en.admin.ui.saveBar.create);

    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByText('Fix the marked fields first.')).toBeInTheDocument();
  });
});
