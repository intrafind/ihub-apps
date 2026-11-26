// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The document template page: colours and margins show what the template's
 * files give while nothing is set (never a black swatch), a picked colour
 * stays, "Take colours from this file" fills the fields, the fields of the
 * Word template are listed and edited, and what is saved holds only the
 * settings of the new model.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockSave = jest.fn();
const mockReadBrand = jest.fn();
const STORED = {
  id: 'corporate',
  name: { en: 'Corporate' },
  description: {},
  enabled: true,
  default: false,
  brand: {},
  pdf: {},
  docx: { template: 'word-template.dotx' },
  pptx: { template: 'powerpoint-template.potx' },
  fields: { classification: { required: true, options: ['public', 'internal'] } }
};
const FILES = {
  wordTemplate: {
    placeholders: ['content', 'title', 'classification'],
    customFields: ['classification'],
    contentPlaceholder: true,
    tocPlaceholder: false,
    page: { width: 595, height: 842, landscape: false },
    styles: { headings: true }
  },
  powerpointTemplate: {
    layouts: [{ name: 'Title and Content' }],
    mapping: { title: 'Title Slide', content: 'Title and Content' },
    slideSize: { aspectRatio: '16:9' },
    slots: [{ id: 'kicker', layouts: [] }]
  }
};
const RESOLVED = {
  brand: {
    primaryColor: '#E30613',
    accentColor: '#374151',
    textColor: '#1F2937',
    palette: ['#E30613', '#374151'],
    headingFont: 'Brand Serif',
    bodyFont: 'Brand Sans',
    sources: {
      primaryColor: 'powerpoint',
      accentColor: 'powerpoint',
      textColor: 'word',
      palette: 'powerpoint',
      headingFont: 'powerpoint',
      bodyFont: 'powerpoint'
    }
  },
  pdf: { margins: [85, 72, 57, 57], source: 'word' }
};
jest.mock('../../../client/src/api/documentTemplatesAdminApi', () => ({
  createDocumentTemplate: jest.fn(),
  fetchDocumentTemplate: jest.fn(async () => ({
    template: STORED,
    files: FILES,
    resolved: RESOLVED
  })),
  fetchDocumentTemplateSample: jest.fn(),
  readDocumentTemplateBrand: (...a) => mockReadBrand(...a),
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
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const AdminDocumentTemplateEditPage =
  require('../../../client/src/features/admin/pages/AdminDocumentTemplateEditPage').default;

const en = require('../../../shared/i18n/en.json');
const saveButton = () =>
  within(screen.getByRole('region', { name: en.admin.ui.saveBar.label }))
    .getAllByRole('button')
    .at(-1);

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/document-templates/corporate']}>
      <Routes>
        <Route
          path="/admin/document-templates/:templateId"
          element={<AdminDocumentTemplateEditPage />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockImplementation(async (id, template) => ({
    template,
    files: FILES,
    resolved: RESOLVED
  }));
});

describe('the colours', () => {
  it('show the colour the files give while none is set, with its source, never black', async () => {
    renderPage();
    const picker = await screen.findByLabelText('Primary colour', {
      selector: 'input[type=color]'
    });
    expect(picker).toHaveValue('#e30613');
    expect(screen.getByLabelText('Accent colour', { selector: 'input[type=color]' })).toHaveValue(
      '#374151'
    );
    expect(screen.getAllByText('From the PowerPoint template').length).toBeGreaterThan(0);
    expect(screen.getByText('From the Word template')).toBeInTheDocument();
  });

  it('keep a picked colour, and it is saved as the template’s own', async () => {
    renderPage();
    const picker = await screen.findByLabelText('Primary colour', {
      selector: 'input[type=color]'
    });
    fireEvent.change(picker, { target: { value: '#00ff00' } });
    expect(screen.getByLabelText('Primary colour', { selector: 'input[type=color]' })).toHaveValue(
      '#00ff00'
    );
    const text = screen.getAllByDisplayValue('#00ff00').find(el => el.type === 'text');
    expect(text).toBeDefined();

    fireEvent.click(saveButton());
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockSave).toHaveBeenCalledWith(
      'corporate',
      expect.objectContaining({ brand: { primaryColor: '#00ff00' } })
    );
  });

  it('are filled from a file with "Take colours from the PowerPoint template", not saved yet', async () => {
    mockReadBrand.mockResolvedValue({
      primaryColor: '#112233',
      accentColor: '#445566',
      textColor: '#000000'
    });
    renderPage();
    const button = await screen.findByRole('button', {
      name: 'Take colours from the PowerPoint template'
    });
    fireEvent.click(button);
    await waitFor(() => expect(mockReadBrand).toHaveBeenCalled());
    await screen.findAllByRole('status');
    expect(mockReadBrand).toHaveBeenCalledWith('corporate', 'powerpointTemplate');
    expect(screen.getByLabelText('Primary colour', { selector: 'input[type=color]' })).toHaveValue(
      '#112233'
    );
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Save to keep them.');
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('the PDF margins', () => {
  it('show the margins of the Word template with their source until they are set', async () => {
    renderPage();
    expect(await screen.findByLabelText('Left', { selector: 'input[type=number]' })).toHaveValue(
      85
    );
    expect(screen.getByLabelText('Top', { selector: 'input[type=number]' })).toHaveValue(72);
    expect(
      screen.getByText(/^From the Word template\. Left, top, right, bottom/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: "Use the Word template's margins" })
    ).not.toBeInTheDocument();
  });

  it('become the template’s own when one is changed, and can go back to the Word template’s', async () => {
    renderPage();
    const left = await screen.findByLabelText('Left', { selector: 'input[type=number]' });
    fireEvent.change(left, { target: { value: '40' } });
    expect(screen.getByLabelText('Top', { selector: 'input[type=number]' })).toHaveValue(72);

    fireEvent.click(saveButton());
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockSave).toHaveBeenCalledWith(
      'corporate',
      expect.objectContaining({ pdf: { margins: [40, 72, 57, 57] } })
    );

    fireEvent.click(screen.getByRole('button', { name: "Use the Word template's margins" }));
    expect(screen.getByLabelText('Left', { selector: 'input[type=number]' })).toHaveValue(85);
  });

  it('are refused when out of range', async () => {
    renderPage();
    const left = await screen.findByLabelText('Left', { selector: 'input[type=number]' });
    fireEvent.change(left, { target: { value: '5' } });
    fireEvent.click(saveButton());
    await screen.findAllByRole('alert');
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').some(el => /between 18 and 200/.test(el.textContent))).toBe(
      true
    );
  });
});

describe('what the files hold', () => {
  it('lists the placeholders and fields of the Word template and the layouts of the PowerPoint one', async () => {
    renderPage();
    expect(
      await screen.findByText(/Built-in placeholders: \{\{content\}\}, \{\{title\}\}/)
    ).toBeInTheDocument();
    expect(screen.getByText('Fields: {{classification}}')).toBeInTheDocument();
    expect(
      screen.getByText(/A table of contents.*No \{\{toc\}\}|No \{\{toc\}\} placeholder/)
    ).toBeInTheDocument();
    expect(screen.getByText('Title Slide')).toBeInTheDocument();
    expect(screen.getByText(/Text placeholders found by name.*kicker/)).toBeInTheDocument();
  });
});

describe('the fields', () => {
  it('are listed, warn when the Word template lost the placeholder, and can be added and removed', async () => {
    renderPage();
    const fieldset = (await screen.findByText('{{classification}}', { selector: 'code' })).closest(
      'fieldset'
    );
    expect(within(fieldset).getByLabelText('Allowed values')).toHaveValue('public\ninternal');
    expect(within(fieldset).queryByText(/has no .* placeholder any more/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New field'), { target: { value: 'Doc ID' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    const added = screen.getByText('{{doc_id}}', { selector: 'code' }).closest('fieldset');
    // Not in the Word template: told so.
    expect(
      within(added).getByText(/has no \{\{doc_id\}\} placeholder any more|no \{\{doc_id\}\}/i)
    ).toBeInTheDocument();

    fireEvent.click(saveButton());
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    const saved = mockSave.mock.calls[0][1];
    expect(Object.keys(saved.fields)).toEqual(['classification', 'doc_id']);
    expect(saved.fields.doc_id).toEqual({});
    expect(saved.fields.classification).toEqual({
      required: true,
      options: ['public', 'internal']
    });

    fireEvent.click(within(added).getByRole('button', { name: 'Remove field' }));
    expect(screen.queryByText('{{doc_id}}', { selector: 'code' })).not.toBeInTheDocument();
  });

  it('refuse a built-in placeholder or a name that exists', async () => {
    renderPage();
    const input = await screen.findByLabelText('New field');
    fireEvent.change(input, { target: { value: 'title' } });
    expect(screen.getByRole('alert')).toHaveTextContent('built-in placeholder');
    expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'classification' } });
    expect(screen.getByRole('alert')).toHaveTextContent('exists already');
  });
});

describe('what is saved', () => {
  it('holds only the settings of the new model', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/^Enabled/));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    const body = mockSave.mock.calls[0][1];
    expect(Object.keys(body).sort()).toEqual(
      [
        'brand',
        'default',
        'description',
        'docx',
        'enabled',
        'fields',
        'id',
        'name',
        'pdf',
        'pptx'
      ].sort()
    );
    expect(body.docx).toEqual({ template: 'word-template.dotx' });
  });
});
