// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A model can be taken out of the feature "Read-only tool calls side by side"
 * (#2485): the checkbox of that name in the model editor, stored as the boolean
 * `parallelToolCalls` of the model file. Only `false` is the opt-out, so the
 * checkbox is on for a model that never set the field, and what it saves is a
 * boolean under that exact key (the server's model schema refuses anything else).
 *
 * Runs the real model edit page and the real form; only the dual-mode
 * (form/JSON) wrapper is replaced by a thin stand-in that renders the form.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockApi = {
  makeAdminApiCall: jest.fn(),
  fetchMarketplaceInstallations: jest.fn()
};
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  getAdminApiErrorMessage: () => 'error',
  fetchMarketplaceInstallations: (...args) => mockApi.fetchMarketplaceInstallations(...args),
  makeAdminApiCall: (...args) => mockApi.makeAdminApiCall(...args)
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: path => path,
  buildAssetUrl: path => path
}));

// The form/JSON switcher is not under test: render the form it would show.
jest.mock('../../../client/src/shared/components/DualModeEditor', () => ({
  __esModule: true,
  default: ({ value, onChange, formComponent: Form, formProps }) => (
    <Form value={value} onChange={onChange} {...formProps} />
  )
}));
jest.mock('../../../client/src/features/admin/components/ChangeHistoryDrawer', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/admin/components/AdminBreadcrumb', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/utils/schemaService', () => ({
  fetchJsonSchema: jest.fn(async () => null)
}));
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ blocker: { state: 'unblocked' }, markSaved: () => {} })
}));

const AdminModelEditPage =
  require('../../../client/src/features/admin/pages/AdminModelEditPage').default;
const en = require('../../../shared/i18n/en.json');
const de = require('../../../shared/i18n/de.json');

const MODEL = {
  id: 'gpt-x',
  modelId: 'gpt-x',
  name: { en: 'GPT X' },
  description: { en: 'A model' },
  url: 'https://api.example.com/v1/chat/completions',
  provider: 'openai',
  contextWindow: 128000,
  enabled: true
};

const LABEL = 'Read-only tool calls side by side';

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/models/gpt-x']}>
      <Routes>
        <Route path="/admin/models/:modelId" element={<AdminModelEditPage />} />
        <Route path="/admin/models" element={<div>models list</div>} />
      </Routes>
    </MemoryRouter>
  );

const saveButton = () => screen.getByRole('button', { name: 'admin.models.edit.saveChanges' });

/** The body of the PUT the page sent when saved. */
const savedBody = async () => {
  await waitFor(() =>
    expect(mockApi.makeAdminApiCall).toHaveBeenCalledWith(
      '/admin/models/gpt-x',
      expect.objectContaining({ method: 'PUT' })
    )
  );
  return mockApi.makeAdminApiCall.mock.calls.find(([, options]) => options?.method === 'PUT')[1]
    .body;
};

const loadModel = async model => {
  mockApi.makeAdminApiCall.mockImplementation(async path =>
    path === '/admin/models/gpt-x' ? { data: model } : { data: [] }
  );
  renderPage();
  await screen.findByLabelText('Temperature');
};

beforeEach(() => {
  mockApi.makeAdminApiCall.mockReset();
  mockApi.fetchMarketplaceInstallations.mockReset().mockResolvedValue({});
});

describe('the opt-out of a model from read-only tool calls side by side', () => {
  test('is on for a model that never set the field', async () => {
    await loadModel(MODEL);
    expect(screen.getByLabelText(LABEL)).toBeChecked();
  });

  test('is on for a model that set true', async () => {
    await loadModel({ ...MODEL, parallelToolCalls: true });
    expect(screen.getByLabelText(LABEL)).toBeChecked();
  });

  test('is off for a model that opted out', async () => {
    await loadModel({ ...MODEL, parallelToolCalls: false });
    expect(screen.getByLabelText(LABEL)).not.toBeChecked();
  });

  test('saving without touching it stores nothing for a model that never set it', async () => {
    await loadModel(MODEL);
    fireEvent.click(saveButton());
    expect(await savedBody()).not.toHaveProperty('parallelToolCalls');
  });

  test('clearing it saves the boolean false under the key the server reads', async () => {
    await loadModel(MODEL);
    fireEvent.click(screen.getByLabelText(LABEL));
    expect(screen.getByLabelText(LABEL)).not.toBeChecked();
    fireEvent.click(saveButton());
    const body = await savedBody();
    expect(body.parallelToolCalls).toBe(false);
    // Nothing else changed.
    expect(body.contextWindow).toBe(128000);
  });

  test('setting it again saves the boolean true', async () => {
    await loadModel({ ...MODEL, parallelToolCalls: false });
    fireEvent.click(screen.getByLabelText(LABEL));
    fireEvent.click(saveButton());
    expect((await savedBody()).parallelToolCalls).toBe(true);
  });

  test('says what it does: the calls run one after the other, in both languages', async () => {
    await loadModel(MODEL);
    // The hint is tied to the checkbox for a screen reader.
    const help = document.getElementById(
      screen.getByLabelText(LABEL).getAttribute('aria-describedby')
    );
    const hint = en.admin.models.hints.parallelToolCalls;
    expect(help).toHaveTextContent(hint);
    expect(en.admin.models.fields.parallelToolCalls).toBe(LABEL);
    // The option changes how the calls run, never what the model is sent: with it
    // on or off the model gets every result of a step together, in call order.
    expect(hint).toMatch(/tool calls should run one after the other/);
    expect(hint).not.toMatch(/results/i);
    expect(de.admin.models.hints.parallelToolCalls).toMatch(
      /Tool-Aufrufe nacheinander ausgeführt werden sollen/
    );
    expect(de.admin.models.hints.parallelToolCalls).not.toMatch(/Ergebnisse/);
  });

  test('is not offered for a model that does not chat', async () => {
    mockApi.makeAdminApiCall.mockImplementation(async path =>
      path === '/admin/models/gpt-x'
        ? { data: { ...MODEL, modelType: 'transcription' } }
        : { data: [] }
    );
    renderPage();
    // The form is up once the model's own fields are filled in.
    await screen.findAllByDisplayValue('gpt-x');
    expect(screen.queryByLabelText(LABEL)).not.toBeInTheDocument();
  });
});
