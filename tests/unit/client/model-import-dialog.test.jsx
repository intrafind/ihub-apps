import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * "Import from URL" with a new provider: the provider can be created without
 * picking a model — for an endpoint that lists none, or to import its models
 * later. An existing provider still needs at least one model to import.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return Object.entries(options || {}).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.message || 'failed'
}));

const ModelImportDialog =
  require('../../../client/src/features/admin/components/ModelImportDialog').default;

const LLM_HUB = {
  id: 'llmhub',
  name: 'LLM Hub',
  category: 'llm',
  apiType: 'openai',
  baseUrl: 'https://hub.example/v1'
};

function mockApi({ providers = [], models = [] } = {}) {
  mockMakeAdminApiCall.mockImplementation(async (path, options = {}) => {
    if (path === '/admin/providers' && !options.method) return { data: providers };
    if (path === '/admin/models/_discover') {
      return {
        data: {
          apiType: 'openai',
          baseUrl: 'https://hub.example/v1',
          modelsUrl: 'https://hub.example/v1/models',
          models
        }
      };
    }
    return { data: {} };
  });
}

const calls = (path, method) =>
  mockMakeAdminApiCall.mock.calls.filter(
    ([p, options]) => p === path && (options?.method || 'GET') === method
  );

async function renderDialog(props = {}) {
  const onImported = jest.fn();
  await act(async () => {
    render(
      <ModelImportDialog
        onClose={() => {}}
        onImported={onImported}
        existingModelIds={[]}
        {...props}
      />
    );
  });
  return onImported;
}

async function loadModelsForNewProvider() {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'LLM Hub' } });
  fireEvent.change(screen.getByLabelText(/^Endpoint URL/), {
    target: { value: 'https://hub.example/v1' }
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
  });
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

test('a new provider is created without models when none is picked', async () => {
  mockApi({ models: [{ id: 'gpt-x', name: 'GPT X', type: 'chat' }] });
  const onImported = await renderDialog();
  await loadModelsForNewProvider();

  expect(screen.getByText(/or create the provider without models/)).toBeInTheDocument();
  const create = screen.getByRole('button', { name: 'Create provider without models' });
  expect(create).toBeEnabled();
  await act(async () => {
    fireEvent.click(create);
  });

  const [[, createProvider]] = calls('/admin/providers', 'POST');
  expect(createProvider.body).toMatchObject({
    id: 'llm-hub',
    name: 'LLM Hub',
    apiType: 'openai',
    baseUrl: 'https://hub.example/v1'
  });
  expect(calls('/admin/models', 'POST')).toHaveLength(0);
  expect(
    screen.getByText('The provider "LLM Hub" was created without models.')
  ).toBeInTheDocument();
  expect(onImported).toHaveBeenCalled();
});

test('an endpoint that lists no models still lets the new provider be created', async () => {
  mockApi({ models: [] });
  await renderDialog();
  await loadModelsForNewProvider();

  expect(screen.getByText('The endpoint lists no models.')).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create provider without models' }));
  });
  expect(calls('/admin/providers', 'POST')).toHaveLength(1);
});

test('picking a model imports it into the new provider, as before', async () => {
  mockApi({ models: [{ id: 'gpt-x', name: 'GPT X', type: 'chat' }] });
  await renderDialog();
  await loadModelsForNewProvider();

  fireEvent.click(screen.getByRole('checkbox', { name: 'GPT X' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 models' }));
  });
  expect(calls('/admin/providers', 'POST')).toHaveLength(1);
  const [[, createModel]] = calls('/admin/models', 'POST');
  expect(createModel.body).toMatchObject({ providerId: 'llm-hub' });
});

test('an existing provider still needs a model to import', async () => {
  mockApi({ providers: [LLM_HUB], models: [{ id: 'gpt-x', name: 'GPT X', type: 'chat' }] });
  await renderDialog({ initialProviderId: 'llmhub' });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
  });

  expect(screen.queryByText(/or create the provider without models/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Create provider without models' })
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Import 0 models' })).toBeDisabled();
});
