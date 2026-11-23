// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * vLLM reasoning token budget in the model editor: off by default, a checkbox
 * turns it on (`thinking.tokenBudget`), and only then the budget number is
 * offered. Unchecking removes both. Only for provider `local`.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  // Always dirty: the page's save bar is shown only for unsaved changes.
  useUnsavedChanges: () => ({
    blocker: { state: 'unblocked' },
    markSaved: () => {},
    isDirty: true
  })
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
// The save bar's primary button is its last one (Discard comes first).
const saveButton = () => {
  const buttons = within(screen.getByRole('region')).getAllByRole('button');
  return buttons[buttons.length - 1];
};

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

const VLLM = {
  ...MODEL,
  provider: 'local',
  thinking: { enabled: true, level: 'low' }
};

describe('vLLM reasoning token budget', () => {
  test('is off by default; the budget number appears only once turned on', async () => {
    await loadModel(VLLM);

    expect(field('Limit reasoning in tokens')).not.toBeChecked();
    expect(screen.queryByLabelText('Reasoning budget')).not.toBeInTheDocument();

    fireEvent.click(field('Limit reasoning in tokens'));
    fireEvent.change(field('Reasoning budget'), { target: { value: '4000' } });
    fireEvent.click(saveButton());

    expect((await savedBody()).thinking).toEqual({
      enabled: true,
      level: 'low',
      tokenBudget: true,
      budgetTokens: 4000
    });
  });

  test('turned on without a number saves just the switch', async () => {
    await loadModel(VLLM);

    fireEvent.click(field('Limit reasoning in tokens'));
    fireEvent.click(saveButton());

    expect((await savedBody()).thinking).toEqual({
      enabled: true,
      level: 'low',
      tokenBudget: true
    });
  });

  test('turning it off removes the switch and the number', async () => {
    await loadModel({ ...VLLM, thinking: { ...VLLM.thinking, budgetTokens: 3000 } });

    expect(field('Limit reasoning in tokens')).toBeChecked();
    expect(field('Reasoning budget')).toHaveValue(3000);
    fireEvent.click(field('Limit reasoning in tokens'));
    fireEvent.click(saveButton());

    expect((await savedBody()).thinking).toEqual({ enabled: true, level: 'low' });
  });

  test('emptying the number keeps the budget on, from the level', async () => {
    await loadModel({ ...VLLM, thinking: { ...VLLM.thinking, budgetTokens: 3000 } });

    fireEvent.change(field('Reasoning budget'), { target: { value: '' } });
    expect(field('Limit reasoning in tokens')).toBeChecked();
    fireEvent.click(saveButton());

    expect((await savedBody()).thinking).toEqual({
      enabled: true,
      level: 'low',
      tokenBudget: true
    });
  });

  test('is not offered for other providers', async () => {
    await loadModel({ ...VLLM, provider: 'openai' });

    expect(screen.queryByLabelText('Limit reasoning in tokens')).not.toBeInTheDocument();
  });
});
