// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Image marking (#3328): an image-generating model can declare what the provider embeds in its
 * images (`contentMarking.image`: `by`, `scheme`, `statementRef`). The fields appear only for a
 * model with image generation, `none` saves no `contentMarking.image` at all, and the text
 * marking the model already declares is left alone.
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

describe('image marking fields', () => {
  const IMAGE_MODEL = { ...MODEL, supportsImageGeneration: true };
  const imageBy = () => document.getElementById('contentMarking.image.by');

  test('is not offered for a model without image generation', async () => {
    await loadModel(MODEL);
    expect(imageBy()).toBeNull();
  });

  test('offers the choice, Not marked by default, and no further fields', async () => {
    await loadModel(IMAGE_MODEL);
    expect(imageBy()).toHaveValue('none');
    expect(document.getElementById('contentMarking.image.scheme')).toBeNull();
  });

  test('saves the declared mark with scheme and statement reference', async () => {
    await loadModel(IMAGE_MODEL);
    fireEvent.change(imageBy(), { target: { value: 'provider' } });
    fireEvent.change(document.getElementById('contentMarking.image.scheme'), {
      target: { value: 'synthid' }
    });
    fireEvent.change(document.getElementById('contentMarking.image.statementRef'), {
      target: { value: 'Provider DPA, annex 3' }
    });
    fireEvent.click(saveButton());
    expect((await savedBody()).contentMarking).toEqual({
      image: { by: 'provider', scheme: 'synthid', statementRef: 'Provider DPA, annex 3' }
    });
  });

  test('drops empty optional fields and keeps the text marking', async () => {
    await loadModel({
      ...IMAGE_MODEL,
      contentMarking: { text: { by: 'provider', scheme: 'synthid' } }
    });
    fireEvent.change(imageBy(), { target: { value: 'provider' } });
    fireEvent.click(saveButton());
    expect((await savedBody()).contentMarking).toEqual({
      text: { by: 'provider', scheme: 'synthid' },
      image: { by: 'provider' }
    });
  });

  test('choosing Not marked again removes the image member, and an empty block', async () => {
    await loadModel({
      ...IMAGE_MODEL,
      contentMarking: { image: { by: 'provider', scheme: 'synthid' } }
    });
    expect(imageBy()).toHaveValue('provider');
    fireEvent.change(imageBy(), { target: { value: 'none' } });
    fireEvent.click(saveButton());
    expect(await savedBody()).not.toHaveProperty('contentMarking');
  });
});
