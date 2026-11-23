// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model and prompt editors do not open in an error state (AI-B16 / AI-UX5
 * of the admin UI review). A blank new form shows no error box and no red
 * field; a field says what is wrong once the admin has left it; the first save
 * attempt shows every problem in one summary, in plain words of the admin's
 * language; a required label carries one asterisk; a taken ID is named before
 * the save; the summary lists the fields in the order of the form and is the
 * only alert (a field's own message is tied to its input, not announced); a
 * clone proposes `<id>-copy`.
 *
 * Runs the real pages, the real DualModeEditor (only Monaco is replaced) and
 * the real JSON schemas the server exports.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

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
  // Always dirty: the page's save bar is shown only for unsaved changes.
  useUnsavedChanges: () => ({
    blocker: { state: 'unblocked' },
    markSaved: () => {},
    isDirty: true
  })
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
    // A path, or a location with history state (a clone from the list).
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
  // The save bar's primary button submits the form (its last button; Discard comes first).
  const labels = mockLanguage === 'de' ? de : en;
  const bar = screen.getByRole('region', { name: labels.admin.ui.saveBar.label });
  const buttons = within(bar).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]);
};

/** The error summaries on the page: alerts with the summary heading. */
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
    // In the order of the form (not of the schema): ID, Name, Description, Provider,
    // then the API Model ID.
    const order = ['Model ID:', 'Name:', 'Description:', 'Provider:', 'API Model ID:'].map(label =>
      text.indexOf(label)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The summary is the only alert: the inline messages of Name and Description are
    // tied to their inputs instead of being announced on their own.
    expect(screen.getAllByRole('alert')).toEqual([summary]);
    const nameInput = document.getElementById('name.en');
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput.getAttribute('aria-describedby')).toContain('name-error');
    expect(document.getElementById('name-error')).toHaveTextContent(
      en.admin.formErrors.field.nameRequired
    );
    expect(document.getElementById('name-error')).not.toHaveAttribute('role');
    const modelIdInput = document.getElementById('modelId');
    expect(modelIdInput).toHaveAttribute('aria-describedby', 'modelId-error');
    expect(document.getElementById('modelId-error')).toHaveTextContent(
      en.admin.formErrors.field.modelIdRequired
    );
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
    // In the order of the form.
    const order = ['Prompt ID:', 'Name:', 'Description:', 'Prompt:'].map(label =>
      text.indexOf(label)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(screen.getAllByRole('alert')).toEqual([summaries[0]]);
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

describe('user form wording', () => {
  test('the user form says what to do, in English and German', () => {
    const props = {
      value: BLANK_USER,
      onChange: () => {},
      jsonSchema: getUserJsonSchema(),
      isNewUser: true,
      showAllErrors: true
    };
    const { rerender } = render(<UserFormEditor {...props} />);
    const summary = screen.getByRole('alert');
    expect(summary.textContent).toContain(en.admin.formErrors.field.usernameRequired);
    expect(summary.textContent).toContain(en.admin.formErrors.field.passwordRequired);
    // Username before Password, as in the form.
    expect(summary.textContent.indexOf('Username')).toBeLessThan(
      summary.textContent.indexOf('Password')
    );
    // The inline message is tied to its input.
    const username = document.querySelector('input[name="username"]');
    expect(username).toHaveAttribute('aria-invalid', 'true');
    expect(username).toHaveAttribute('aria-describedby', 'username-error');
    expect(document.getElementById('username-error')).toHaveTextContent(
      en.admin.formErrors.field.usernameRequired
    );

    rerender(<UserFormEditor {...props} value={{ ...BLANK_USER, password: 'abc' }} />);
    expect(screen.getByRole('alert').textContent).toContain(
      en.admin.formErrors.field.passwordMinLength.replace('{{min}}', '6')
    );

    rerender(<UserFormEditor {...props} value={{ ...BLANK_USER, password: 'abcdefgh' }} />);
    expect(screen.getByRole('alert').textContent).toContain(
      en.admin.formErrors.field.passwordMismatch
    );

    mockLanguage = 'de';
    rerender(<UserFormEditor {...props} />);
    expect(screen.getByRole('alert').textContent).toContain(
      de.admin.formErrors.field.usernameRequired
    );
    expect(screen.getByRole('alert').textContent).not.toMatch(/erforderlich/);
  });
});

describe('summary order', () => {
  const AdminFormErrorSummary =
    require('../../../client/src/features/admin/components/AdminFormErrorSummary').default;

  test('lists the fields in the order of the form, unknown fields last', () => {
    render(
      <form>
        <AdminFormErrorSummary
          errors={{ beta: 'B wrong.', ghost: 'No field.', alpha: 'A wrong.', gamma: 'C wrong.' }}
          labels={{ alpha: 'Alpha', beta: 'Beta', gamma: 'Gamma', ghost: 'Ghost' }}
        />
        <input name="gamma" aria-label="Gamma" />
        <input name="alpha" aria-label="Alpha" />
        <input name="beta" aria-label="Beta" />
      </form>
    );
    const items = within(screen.getByRole('alert'))
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(items).toEqual([
      'Gamma: C wrong.',
      'Alpha: A wrong.',
      'Beta: B wrong.',
      'Ghost: No field.'
    ]);
  });
});

describe('localized field messages', () => {
  const DynamicLanguageEditor =
    require('../../../client/src/shared/components/DynamicLanguageEditor').default;

  test('are tied to the input and not announced by themselves', () => {
    render(
      <DynamicLanguageEditor
        label="Name"
        name="name"
        value={{ en: '' }}
        onChange={() => {}}
        error="Enter a name."
      />
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const input = document.getElementById('name.en');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby').split(' ')).toContain('name-error');
    expect(document.getElementById('name-error')).toHaveTextContent('Enter a name.');
  });

  test('a form without a summary can have the message announced', () => {
    render(
      <DynamicLanguageEditor
        label="Name"
        value={{ en: '' }}
        onChange={() => {}}
        error="A name is required."
        announceError
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('A name is required.');
    // Without a field name the message still has an id the input points to.
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-describedby').split(' ')).toContain(alert.id);
  });

  test('without a message the input points to no message', () => {
    render(
      <DynamicLanguageEditor label="Name" name="name" value={{ en: '' }} onChange={() => {}} />
    );
    expect(document.getElementById('name.en')).not.toHaveAttribute('aria-describedby');
  });
});

describe('clone ID', () => {
  const { copyId } = require('../../../client/src/features/admin/utils/copyId');

  test('proposes <id>-copy, then the next free number', () => {
    expect(copyId('gpt-4', [])).toBe('gpt-4-copy');
    expect(copyId('gpt-4', ['gpt-4', 'gpt-4-copy'])).toBe('gpt-4-copy-2');
    expect(copyId('gpt-4', ['gpt-4-copy', 'gpt-4-copy-2', 'gpt-4-copy-3'])).toBe('gpt-4-copy-4');
    expect(copyId('gpt-4', ['gpt-4-copy-2'])).toBe('gpt-4-copy');
  });

  const TEMPLATE_MODEL = {
    id: 'gpt-4',
    modelId: 'gpt-4',
    name: { en: 'GPT-4' },
    description: { en: 'A model' },
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    enabled: true
  };

  test('a cloned model opens with the proposed ID', async () => {
    renderAt({
      pathname: '/admin/models/new',
      state: { templateModel: TEMPLATE_MODEL, cloneId: 'gpt-4-copy' }
    });
    const id = await screen.findByLabelText(/^Model ID/);
    expect(id).toHaveValue('gpt-4-copy');
  });

  test('a cloned prompt opens with the proposed ID', async () => {
    renderAt({
      pathname: '/admin/prompts/new',
      state: {
        templatePrompt: { id: 'summarize', name: { en: 'Summarize' } },
        cloneId: 'summarize-copy-2'
      }
    });
    const id = await screen.findByLabelText(/^ID/);
    expect(id).toHaveValue('summarize-copy-2');
  });

  test('a model save the server refuses is shown on the page, not thrown', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    mockApi.makeAdminApiCall.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') throw new Error('The provider is not reachable.');
      return path === '/admin/models' ? { data: { items: [{ id: 'gpt-4' }] } } : { data: [] };
    });
    try {
      renderAt({
        pathname: '/admin/models/new',
        state: { templateModel: TEMPLATE_MODEL, cloneId: 'gpt-4-copy' }
      });
      await screen.findByLabelText(/^Model ID/);
      await settle();

      submit();

      expect(await screen.findByText('The provider is not reachable.')).toBeInTheDocument();
      expect(screen.queryByText('models list')).not.toBeInTheDocument();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('useAdminFormErrors', () => {
  const useAdminFormErrors =
    require('../../../client/src/features/admin/hooks/useAdminFormErrors').default;
  const {
    validationReport
  } = require('../../../client/src/features/admin/hooks/useAdminFormErrors');

  test('validationReport lists every problem', () => {
    expect(validationReport({}, false)).toEqual({ isValid: true, errors: [], displayed: false });
    expect(validationReport({ id: 'Enter an ID.' }, true)).toEqual({
      isValid: false,
      errors: [{ field: 'id', message: 'Enter an ID.', severity: 'error' }],
      displayed: true
    });
  });

  function Probe({ allErrors, showAll, extraErrors, onValidationChange }) {
    const { errors, controlHandlers } = useAdminFormErrors(allErrors, {
      showAll,
      extraErrors,
      onValidationChange
    });
    return (
      <div {...controlHandlers}>
        <input name="id" aria-label="ID" />
        <output data-testid="errors">{JSON.stringify(errors)}</output>
      </div>
    );
  }

  test('shows touched fields, all after a save attempt, and reports each change', () => {
    const allErrors = { id: 'Enter an ID.', name: 'Enter a name.' };
    const onValidationChange = jest.fn();
    const { rerender } = render(
      <Probe allErrors={allErrors} onValidationChange={onValidationChange} />
    );
    const shown = () => JSON.parse(screen.getByTestId('errors').textContent);

    expect(shown()).toEqual({});
    expect(onValidationChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isValid: false, displayed: false })
    );

    fireEvent.blur(screen.getByLabelText('ID'));
    expect(shown()).toEqual({ id: 'Enter an ID.' });
    expect(onValidationChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ displayed: true })
    );

    rerender(
      <Probe
        allErrors={allErrors}
        showAll
        extraErrors={{ url: 'From the server.' }}
        onValidationChange={onValidationChange}
      />
    );
    expect(shown()).toEqual({ ...allErrors, url: 'From the server.' });
  });
});

describe('save attempts and refusals per resource', () => {
  /** Moves the router to another path, as a link in the sidebar would. */
  function GoTo({ path }) {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate(path)}>
        go to {path}
      </button>
    );
  }

  test('another resource opens without the errors of a refused save', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/prompts/new']}>
        <GoTo path="/admin/prompts/summarize" />
        <Routes>
          <Route path="/admin/prompts/:promptId" element={<AdminPromptEditPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByLabelText(/^ID/);
    await settle();
    submit();
    expect(await findSummaries(en.admin.formErrors.title)).toHaveLength(1);

    // The stored prompt has no texts, so its form has problems; they stay hidden.
    fireEvent.click(screen.getByRole('button', { name: 'go to /admin/prompts/summarize' }));
    await waitFor(() => expect(screen.getByLabelText(/^ID/)).toHaveValue('summarize'));
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // A refused save of this prompt shows the summary again.
    submit();
    expect(await findSummaries(en.admin.formErrors.title)).toHaveLength(1);
  });

  test('coming back to a blank form does not bring back its refused save', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/prompts/new']}>
        <GoTo path="/admin/prompts/summarize" />
        <GoTo path="/admin/prompts/new" />
        <Routes>
          <Route path="/admin/prompts/:promptId" element={<AdminPromptEditPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByLabelText(/^ID/);
    await settle();
    submit();
    expect(await findSummaries(en.admin.formErrors.title)).toHaveLength(1);

    // Away to a stored prompt, without saving it, and back to the blank form.
    fireEvent.click(screen.getByRole('button', { name: 'go to /admin/prompts/summarize' }));
    await waitFor(() => expect(screen.getByLabelText(/^ID/)).toHaveValue('summarize'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'go to /admin/prompts/new' }));
    await waitFor(() => expect(screen.getByLabelText(/^ID/)).toHaveValue(''));
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a taken ID refused in the JSON mode is said on the page', async () => {
    mockApi.fetchAdminPrompts.mockResolvedValue([]);
    mockApi.createPrompt.mockRejectedValue(
      Object.assign(new Error('Prompt with this ID already exists'), {
        response: { status: 409 }
      })
    );
    renderAt('/admin/prompts/new');
    await screen.findByLabelText(/^ID/);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: en.admin.editor.jsonMode }));
    submit();

    expect(await screen.findByText(en.admin.formErrors.field.idTaken)).toBeInTheDocument();
  });
});

describe('the parts a model save drops never block it', () => {
  const { withoutDroppedParts } = require('../../../client/src/features/admin/utils/modelPayload');
  const {
    modelFieldErrors
  } = require('../../../client/src/features/admin/components/ModelFormEditor');
  const passKey = key => key;

  /** The part of the model schema these cases touch: non-empty texts and voices. */
  const SCHEMA = {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1 },
      hint: {
        type: 'object',
        properties: {
          message: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } }
        }
      },
      tts: {
        type: 'object',
        properties: {
          voices: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } }
        }
      }
    }
  };

  const base = { id: 'gpt', provider: 'openai', url: 'https://api.example.com', modelType: 'chat' };

  describe('withoutDroppedParts', () => {
    test('drops the tts block of a model that is not text-to-speech', () => {
      expect(withoutDroppedParts({ ...base, tts: { voices: { de: '' } } })).not.toHaveProperty(
        'tts'
      );
    });

    test('drops voices without an ID, and the voices when none is left', () => {
      const tts = { ...base, modelType: 'tts', tts: { voices: { de: '', en: 'alloy' } } };
      expect(withoutDroppedParts(tts).tts.voices).toEqual({ en: 'alloy' });
      const empty = { ...base, modelType: 'tts', tts: { voices: { de: '' } } };
      expect(withoutDroppedParts(empty).tts).toEqual({});
    });

    test('drops hint languages without text, and the hint without any text', () => {
      const hint = { message: { en: 'Use for drafts', de: '' }, level: 'info' };
      expect(withoutDroppedParts({ ...base, hint }).hint.message).toEqual({ en: 'Use for drafts' });
      expect(withoutDroppedParts({ ...base, hint: { message: { en: '' } } })).not.toHaveProperty(
        'hint'
      );
    });

    test('leaves the form state unchanged', () => {
      const model = { ...base, hint: { message: { en: 'x', de: '' } } };
      withoutDroppedParts(model);
      expect(model.hint.message).toEqual({ en: 'x', de: '' });
    });
  });

  describe('modelFieldErrors validates what the save sends', () => {
    const options = { isNewModel: false, takenIds: [] };

    test('an English hint with an added, empty German language does not block the save', () => {
      const model = { ...base, hint: { message: { en: 'Use for drafts', de: '' }, level: 'info' } };
      expect(modelFieldErrors(model, SCHEMA, passKey, options)).toEqual({});
    });

    test('a leftover empty voice on a chat model does not block the save', () => {
      const model = { ...base, tts: { voices: { de: '' } } };
      expect(modelFieldErrors(model, SCHEMA, passKey, options)).toEqual({});
    });

    test('a real error still blocks it', () => {
      expect(
        Object.keys(modelFieldErrors({ ...base, id: '' }, SCHEMA, passKey, options))
      ).toContain('id');
    });
  });
});
