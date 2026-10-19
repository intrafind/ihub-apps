/**
 * A model can carry optional sampling overrides (`sampling.temperature`,
 * `topP`, `topK`) — the only place a temperature comes from now that apps,
 * prompts, workflows and agents do not set one. The model editor offers the
 * three fields; a field left empty is not sent, and a model with none set is
 * saved without a `sampling` key at all.
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/models/gpt-x']}>
      <Routes>
        <Route path="/admin/models/:modelId" element={<AdminModelEditPage />} />
        <Route path="/admin/models" element={<div>models list</div>} />
      </Routes>
    </MemoryRouter>
  );

const field = name => screen.getByLabelText(name);
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

describe('model sampling fields', () => {
  test('offers Temperature, Top P and Top K, empty for a model that sets none', async () => {
    await loadModel(MODEL);

    expect(field('Temperature')).toHaveValue(null);
    expect(field('Top P')).toHaveValue(null);
    expect(field('Top K')).toHaveValue(null);
    // Empty means the provider's own default, and the form says so.
    expect(field('Temperature')).toHaveAttribute('placeholder', 'Provider default');
    expect(screen.getByText(/own default; nothing is sent for it/)).toBeInTheDocument();
  });

  test('shows the values a model already sets, 0 included', async () => {
    await loadModel({ ...MODEL, sampling: { temperature: 0, topP: 0.9, topK: 40 } });

    expect(field('Temperature')).toHaveValue(0);
    expect(field('Top P')).toHaveValue(0.9);
    expect(field('Top K')).toHaveValue(40);
  });

  test('saves what was entered as numbers', async () => {
    await loadModel(MODEL);

    fireEvent.change(field('Temperature'), { target: { value: '0.3' } });
    fireEvent.change(field('Top P'), { target: { value: '0.95' } });
    fireEvent.change(field('Top K'), { target: { value: '40' } });
    fireEvent.click(saveButton());

    expect((await savedBody()).sampling).toEqual({ temperature: 0.3, topP: 0.95, topK: 40 });
  });

  test('saves a temperature of 0, which is a real setting', async () => {
    await loadModel(MODEL);

    fireEvent.change(field('Temperature'), { target: { value: '0' } });
    fireEvent.click(saveButton());

    expect((await savedBody()).sampling).toEqual({ temperature: 0 });
  });

  test('leaves out a field that was emptied, and keeps the others', async () => {
    await loadModel({ ...MODEL, sampling: { temperature: 0.7, topP: 0.9 } });

    fireEvent.change(field('Temperature'), { target: { value: '' } });
    fireEvent.click(saveButton());

    expect((await savedBody()).sampling).toEqual({ topP: 0.9 });
  });

  test('saves no `sampling` key once every field is emptied', async () => {
    await loadModel({ ...MODEL, sampling: { temperature: 0.7 } });

    fireEvent.change(field('Temperature'), { target: { value: '' } });
    fireEvent.click(saveButton());

    const body = await savedBody();
    expect(body).not.toHaveProperty('sampling');
    // Nothing else changed.
    expect(body.contextWindow).toBe(128000);
  });

  test('saves no `sampling` key for a model that never set any', async () => {
    await loadModel(MODEL);

    fireEvent.click(saveButton());

    expect(await savedBody()).not.toHaveProperty('sampling');
  });

  test('is not offered for a model that does not chat, and is not saved for one', async () => {
    mockApi.makeAdminApiCall.mockImplementation(async path =>
      path === '/admin/models/gpt-x'
        ? { data: { ...MODEL, modelType: 'tts', sampling: { temperature: 0.7 } } }
        : { data: [] }
    );
    renderPage();
    // The form is up once the model's own fields are filled in.
    await screen.findAllByDisplayValue('gpt-x');

    expect(screen.queryByLabelText('Top P')).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(await savedBody()).not.toHaveProperty('sampling');
  });
});
