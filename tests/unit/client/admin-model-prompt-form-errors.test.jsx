// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model and prompt editors do not open in an error state (AI-B16 / AI-UX5
 * of the admin UI review). A blank new form shows no error box and no red
 * field; a field says what is wrong once the admin has left it; the first save
 * attempt shows every problem in one summary, in plain words of the admin's
 * language; a required label carries one asterisk; a taken ID is named before
 * the save.
 *
 * Runs the real pages, the real DualModeEditor (only Monaco is replaced) and
 * the real JSON schemas the server exports.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  makeAdminApiCall: jest.fn(),
  fetchMarketplaceInstallations: jest.fn(),
  fetchAdminPrompts: jest.fn(),
  createPrompt: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: err => err?.message || 'error',
  fetchMarketplaceInstallations: (...args) => mockApi.fetchMarketplaceInstallations(...args),
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args),
  fetchAdminPrompts: (...args) => mockApi.fetchAdminPrompts(...args),
  fetchAdminApps: async () => [],
  createPrompt: (...args) => mockApi.createPrompt(...args),
  updatePrompt: async () => ({}),
  translateText: async () => ({ translation: '' })
}));

// The UI language of a test: 'en' or 'de'.
let mockLanguage = 'en';
jest.mock('react-i18next', () => {
  const { enT, deT } = require('./helpers/i18nMock');
  const translations = {
    en: { t: enT, i18n: { language: 'en' } },
    de: { t: deT, i18n: { language: 'de' } }
  };
  return { useTranslation: () => translations[mockLanguage] };
});

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));
jest.mock('../../../client/src/shared/components/MonacoJsonEditor', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/ContentAccessSection', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api', () => ({
  clearApiCache: () => {},
  fetchUIConfig: async () => ({})
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: {} })
}));
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ blocker: { state: 'unblocked' }, markSaved: () => {} })
}));

const mockSchemas = {};
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(async type => mockSchemas[type])
}));

const {
  getModelJsonSchema,
  getPromptJsonSchema,
  getGroupJsonSchema,
  getUserJsonSchema
} = require('../../../server/utils/schemaExport.js');
mockSchemas.model = getModelJsonSchema();
mockSchemas.prompt = getPromptJsonSchema();

const AdminModelEditPage =
  require('../../../client/src/features/admin/pages/AdminModelEditPage').default;
const AdminPromptEditPage =
  require('../../../client/src/features/admin/pages/AdminPromptEditPage').default;
const { RULE_KEYS, FIELD_KEYS } = require('../../../client/src/features/admin/utils/fieldErrors');

const en = require('../../../shared/i18n/en.json');
const de = require('../../../shared/i18n/de.json');

const renderAt = path =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/models/:modelId" element={<AdminModelEditPage />} />
        <Route path="/admin/models" element={<div>models list</div>} />
        <Route path="/admin/prompts/:promptId" element={<AdminPromptEditPage />} />
        <Route path="/admin/prompts" element={<div>prompts list</div>} />
      </Routes>
    </MemoryRouter>
  );

/** Waits until the schema arrived, i.e. the form validates. */
const settle = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const submit = () => {
  // The save button is the form's only submit button.
  fireEvent.click(document.querySelector('form button[type="submit"]'));
};

/**
 * The error summaries on the page: alerts with the summary heading. (A localized
 * field's own message is an alert too, without the heading.)
 */
const findSummaries = async title => {
  const alerts = await screen.findAllByRole('alert');
  return alerts.filter(alert => alert.querySelector('h3')?.textContent.includes(title));
};

/** Raw Ajv/schema wording that must never reach the admin. */
const RAW_SCHEMA_TEXT =
  /must be at least \d+ characters|must be one of|must NOT have|format is invalid|\b(?:id|username|modelId|name|description|provider|prompt)(?:\.\w+)? is required/;

beforeEach(() => {
  mockLanguage = 'en';
  mockApi.makeAdminApiCall
    .mockReset()
    .mockImplementation(async path =>
      path === '/admin/models' ? { data: { items: [{ id: 'gpt-4' }] } } : { data: [] }
    );
  mockApi.fetchMarketplaceInstallations.mockReset().mockResolvedValue({});
  mockApi.fetchAdminPrompts.mockReset().mockResolvedValue([{ id: 'summarize' }]);
  mockApi.createPrompt.mockReset().mockResolvedValue({});
});

describe('new model form', () => {
  test('opens without an error box, error mark or red field', async () => {
    renderAt('/admin/models/new');
    await screen.findByLabelText(/^Model ID/);
    await settle();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(en.admin.editor.validationErrors)).not.toBeInTheDocument();
    expect(screen.queryByText(en.admin.formErrors.field.idRequired)).not.toBeInTheDocument();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(document.querySelector('.admin-form-error-field')).toBeNull();
    expect(document.body.textContent).not.toMatch(RAW_SCHEMA_TEXT);
  });

  test('a touched empty required field says what to enter, without the summary', async () => {
    renderAt('/admin/models/new');
    const id = await screen.findByLabelText(/^Model ID/);
    await settle();

    fireEvent.focus(id);
    fireEvent.blur(id);

    expect(await screen.findByText(en.admin.formErrors.field.idRequired)).toBeInTheDocument();
    expect(id).toHaveAttribute('aria-invalid', 'true');
    // Other fields stay quiet, and there is no summary before a save attempt.
    expect(screen.queryByText(en.admin.formErrors.field.nameRequired)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a save attempt shows one summary with plain, translated messages and saves nothing', async () => {
    renderAt('/admin/models/new');
    await screen.findByLabelText(/^Model ID/);
    await settle();

    submit();

    const summaries = await findSummaries(en.admin.formErrors.title);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    const text = summary.textContent;
    expect(text).toContain(`Model ID: ${en.admin.formErrors.field.idRequired}`);
    expect(text).toContain(`Name: ${en.admin.formErrors.field.nameRequired}`);
    expect(text).toContain(`Description: ${en.admin.formErrors.field.descriptionRequired}`);
    expect(text).toContain(`API Model ID: ${en.admin.formErrors.field.modelIdRequired}`);
    expect(text).toContain(`Provider: ${en.admin.formErrors.field.providerRequired}`);
    expect(text).not.toMatch(RAW_SCHEMA_TEXT);
    // In the order of the form, the ID first.
    expect(text.indexOf('Model ID:')).toBeLessThan(text.indexOf('Name:'));
    // The editor's own list of errors (the second box) is gone.
    expect(screen.queryByText(en.admin.editor.validationSummary)).not.toBeInTheDocument();
    // Each entry links to its field.
    expect(within(summary).getByRole('button', { name: 'Model ID' })).toBeInTheDocument();
    // The summary takes the focus.
    expect(summary).toHaveFocus();
    expect(mockApi.makeAdminApiCall).not.toHaveBeenCalledWith(
      '/admin/models',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('an ID in the wrong format and a taken ID are named at the field', async () => {
    renderAt('/admin/models/new');
    const id = await screen.findByLabelText(/^Model ID/);
    await settle();

    fireEvent.change(id, { target: { value: 'My Model' } });
    expect(await screen.findByText(en.admin.formErrors.field.idFormat)).toBeInTheDocument();

    await waitFor(() => expect(mockApi.makeAdminApiCall).toHaveBeenCalledWith('/admin/models'));
    fireEvent.change(id, { target: { value: 'gpt-4' } });
    expect(await screen.findByText(en.admin.formErrors.field.idTaken)).toBeInTheDocument();
  });

  test('required labels carry exactly one asterisk', async () => {
    renderAt('/admin/models/new');
    await screen.findByLabelText(/^Model ID/);
    await settle();

    const nameLabel = screen.getByText('Name', { selector: 'label, span' }).closest('label, span');
    expect(nameLabel.textContent.match(/\*/g)).toHaveLength(1);
    const descriptionLabel = screen
      .getByText('Description', { selector: 'label, span' })
      .closest('label, span');
    expect(descriptionLabel.textContent.match(/\*/g)).toHaveLength(1);
    const idLabel = document.querySelector('label[for="id"]');
    expect(idLabel.textContent.match(/\*/g)).toHaveLength(1);
  });

  test('speaks German in the German UI', async () => {
    mockLanguage = 'de';
    renderAt('/admin/models/new');
    await screen.findByLabelText(/^Modell-ID/);
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    submit();

    const summaries = await findSummaries(de.admin.formErrors.title);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary.textContent).toContain(`Modell-ID: ${de.admin.formErrors.field.idRequired}`);
    expect(summary.textContent).toContain(`Name: ${de.admin.formErrors.field.nameRequired}`);
    expect(summary.textContent).not.toMatch(RAW_SCHEMA_TEXT);
  });
});

describe('new prompt form', () => {
  test('opens without an error box, error mark or red field', async () => {
    renderAt('/admin/prompts/new');
    await screen.findByLabelText(/^ID/);
    await settle();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(en.admin.editor.validationErrors)).not.toBeInTheDocument();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(RAW_SCHEMA_TEXT);
  });

  test('a save attempt lists every problem once, Description included, and saves nothing', async () => {
    renderAt('/admin/prompts/new');
    await screen.findByLabelText(/^ID/);
    await settle();

    submit();

    const summaries = await findSummaries(en.admin.formErrors.title);
    expect(summaries).toHaveLength(1);
    const text = summaries[0].textContent;
    expect(text).toContain(`Prompt ID: ${en.admin.formErrors.field.idRequired}`);
    expect(text).toContain(`Name: ${en.admin.formErrors.field.nameRequired}`);
    expect(text).toContain(`Description: ${en.admin.formErrors.field.descriptionRequired}`);
    expect(text).toContain(`Prompt: ${en.admin.formErrors.field.promptRequired}`);
    expect(text).not.toMatch(RAW_SCHEMA_TEXT);
    expect(mockApi.createPrompt).not.toHaveBeenCalled();
  });

  test('Description is marked required, with one asterisk like Name', async () => {
    renderAt('/admin/prompts/new');
    await screen.findByLabelText(/^ID/);
    await settle();

    for (const label of ['Name', 'Description', 'Prompt']) {
      const element = screen.getByText(label, { selector: 'label, span' }).closest('label, span');
      expect(element.textContent.match(/\*/g)).toHaveLength(1);
    }
  });

  test('a filled prompt saves', async () => {
    renderAt('/admin/prompts/new');
    const id = await screen.findByLabelText(/^ID/);
    await settle();

    fireEvent.change(id, { target: { value: 'my-prompt' } });
    fireEvent.change(document.getElementById('name.en'), { target: { value: 'My prompt' } });
    fireEvent.change(document.getElementById('description.en'), {
      target: { value: 'What it does' }
    });
    fireEvent.change(document.getElementById('prompt.en'), { target: { value: 'Do it' } });
    submit();

    await waitFor(() => expect(mockApi.createPrompt).toHaveBeenCalled());
    expect(mockApi.createPrompt.mock.calls[0][0]).toMatchObject({ id: 'my-prompt' });
  });

  test('a taken ID is named at the ID field before the save', async () => {
    renderAt('/admin/prompts/new');
    const id = await screen.findByLabelText(/^ID/);
    await settle();

    fireEvent.change(id, { target: { value: 'summarize' } });
    expect(await screen.findByText(en.admin.formErrors.field.idTaken)).toBeInTheDocument();
  });

  test('the server refusing a taken ID shows it at the ID field', async () => {
    mockApi.fetchAdminPrompts.mockResolvedValue([]);
    mockApi.createPrompt.mockRejectedValue(
      Object.assign(new Error('Prompt with this ID already exists'), {
        response: { status: 409 }
      })
    );
    renderAt('/admin/prompts/new');
    const id = await screen.findByLabelText(/^ID/);
    await settle();

    fireEvent.change(id, { target: { value: 'other' } });
    fireEvent.change(document.getElementById('name.en'), { target: { value: 'N' } });
    fireEvent.change(document.getElementById('description.en'), { target: { value: 'D' } });
    fireEvent.change(document.getElementById('prompt.en'), { target: { value: 'P' } });
    submit();

    expect(await screen.findAllByText(en.admin.formErrors.field.idTaken)).not.toHaveLength(0);
    expect(screen.queryByText('Prompt with this ID already exists')).not.toBeInTheDocument();
  });
});

// Group and user editors use the same shared pieces (summary, DualModeEditor, the
// rule texts) and behave the same way.
const GroupFormEditor =
  require('../../../client/src/features/admin/components/GroupFormEditor').default;
const UserFormEditor =
  require('../../../client/src/features/admin/components/UserFormEditor').default;

const BLANK_GROUP = {
  id: '',
  name: '',
  description: '',
  permissions: {},
  mappings: [],
  inherits: []
};
const BLANK_USER = {
  id: 'user_1',
  username: '',
  email: null,
  name: '',
  password: '',
  internalGroups: [],
  authMethods: ['local'],
  enabled: true
};

describe.each([
  ['group', GroupFormEditor, BLANK_GROUP, () => getGroupJsonSchema(), { isNewGroup: true }],
  ['user', UserFormEditor, BLANK_USER, () => getUserJsonSchema(), { isNewUser: true }]
])('new %s form', (kind, Form, blank, schema, extra) => {
  test('opens without errors and lists them after a save attempt', () => {
    const onValidationChange = jest.fn();
    const props = { value: blank, onChange: () => {}, jsonSchema: schema(), ...extra };
    const { rerender } = render(<Form {...props} onValidationChange={onValidationChange} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(onValidationChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isValid: false, displayed: false })
    );

    rerender(<Form {...props} onValidationChange={onValidationChange} showAllErrors />);

    const summary = screen.getByRole('alert');
    expect(summary.textContent).toContain(en.admin.formErrors.title);
    expect(summary.textContent).not.toMatch(RAW_SCHEMA_TEXT);
    expect(onValidationChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isValid: false, displayed: true })
    );
  });
});

describe('message keys', () => {
  test('every key of the maps is a text in English and German', () => {
    const lookup = (dictionary, key) =>
      key.split('.').reduce((node, part) => node?.[part], dictionary);
    for (const key of [...Object.values(RULE_KEYS), ...Object.values(FIELD_KEYS)]) {
      expect(typeof lookup(en, key)).toBe('string');
      expect(typeof lookup(de, key)).toBe('string');
    }
  });
});
