// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * An admin configures a model's `hint` in the model editor (#3811): on/off,
 * level, dismissible (hint/info only) and a localized message. Empty
 * languages are not saved; turning the hint off removes the key.
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
  await screen.findByLabelText('Show a hint for this model');
};

beforeEach(() => {
  mockApi.makeAdminApiCall.mockReset();
  mockApi.fetchMarketplaceInstallations.mockReset().mockResolvedValue({});
});

const ALERT_HINT = {
  message: { en: 'EXPERIMENTAL MODEL', de: 'EXPERIMENTELLES MODELL' },
  level: 'alert',
  dismissible: false
};

describe('model hint in the admin model editor', () => {
  test('is off for a model without a hint, and none is saved', async () => {
    await loadModel(MODEL);

    expect(field('Show a hint for this model')).not.toBeChecked();
    expect(screen.queryByLabelText('Level')).not.toBeInTheDocument();
    fireEvent.click(saveButton());

    expect(await savedBody()).not.toHaveProperty('hint');
  });

  test('shows and keeps an existing hint', async () => {
    await loadModel({ ...MODEL, hint: ALERT_HINT });

    expect(field('Show a hint for this model')).toBeChecked();
    expect(field('Level')).toHaveValue('alert');
    // Warning and alert hints cannot be dismissed: no checkbox for it.
    expect(screen.queryByLabelText('Users can dismiss it')).not.toBeInTheDocument();
    fireEvent.click(saveButton());

    expect((await savedBody()).hint).toEqual({
      message: { en: 'EXPERIMENTAL MODEL', de: 'EXPERIMENTELLES MODELL' },
      level: 'alert'
    });
  });

  test('saves a new info hint with its message and dismissible flag', async () => {
    await loadModel(MODEL);

    fireEvent.click(field('Show a hint for this model'));
    expect(field('Level')).toHaveValue('info');
    expect(field('Users can dismiss it')).toBeChecked();
    fireEvent.click(field('Users can dismiss it'));
    const message = document.getElementById('hint.message.en');
    fireEvent.change(message, { target: { value: 'Recommended for analysis.' } });
    fireEvent.click(saveButton());

    expect((await savedBody()).hint).toEqual({
      message: { en: 'Recommended for analysis.' },
      level: 'info',
      dismissible: false
    });
  });

  test('turning the hint off removes it from the saved model', async () => {
    await loadModel({ ...MODEL, hint: ALERT_HINT });

    fireEvent.click(field('Show a hint for this model'));
    fireEvent.click(saveButton());

    expect(await savedBody()).not.toHaveProperty('hint');
  });

  test('saves a hint written only in German', async () => {
    await loadModel({
      ...MODEL,
      hint: { message: { en: '', de: 'Nur Deutsch' }, level: 'warning' }
    });

    // An empty English field does not block the save.
    expect(document.getElementById('hint.message.en')).not.toBeRequired();
    fireEvent.click(saveButton());

    expect((await savedBody()).hint).toEqual({ message: { de: 'Nur Deutsch' }, level: 'warning' });
  });
});
