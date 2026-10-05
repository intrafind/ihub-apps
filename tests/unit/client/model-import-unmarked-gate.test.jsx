/**
 * Importing models from a URL with "Enable imported models" on goes through
 * the EU AI Act gate (issue #2565): a model that does not mark its output is
 * enabled only with a justification, asked once for all such models.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
      }
    }
    return str;
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.error || err?.message || 'failed'
}));

const ModelImportDialog =
  require('../../../client/src/features/admin/components/ModelImportDialog').default;

const PROVIDER = {
  id: 'llmhub',
  category: 'llm',
  apiType: 'openai',
  name: { en: 'LLM Hub' },
  baseUrl: 'https://llm.example/v1'
};
const DISCOVERY = {
  apiType: 'openai',
  modelsUrl: 'https://llm.example/v1/models',
  models: [
    { id: 'alpha', name: 'alpha', type: 'chat' },
    { id: 'beta', name: 'beta', type: 'chat' }
  ]
};
const gate = models =>
  Object.assign(new Error('409'), {
    response: {
      status: 409,
      data: { code: 'UNMARKED_MODEL_ACKNOWLEDGEMENT_REQUIRED', models, error: 'Needs a reason' }
    }
  });

/** Route the admin API: providers, discovery and model creation. */
function mockApi(createModel) {
  mockMakeAdminApiCall.mockImplementation((path, options = {}) => {
    if (path === '/admin/providers') return Promise.resolve({ data: [PROVIDER] });
    if (path === '/admin/models/_discover') return Promise.resolve({ data: DISCOVERY });
    if (path === '/admin/models' && options.method === 'POST') return createModel(options.body);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

const modelPosts = () =>
  mockMakeAdminApiCall.mock.calls
    .filter(([path, options]) => path === '/admin/models' && options?.method === 'POST')
    .map(([, options]) => options.body);

async function importBoth() {
  const onImported = jest.fn();
  render(
    <ModelImportDialog
      initialProviderId="llmhub"
      existingModelIds={[]}
      onImported={onImported}
      onClose={() => {}}
    />
  );
  const load = await screen.findByRole('button', { name: 'Load models' });
  await waitFor(() => expect(load).toBeEnabled());
  fireEvent.click(load);
  fireEvent.click(await screen.findByLabelText('alpha'));
  fireEvent.click(screen.getByLabelText('beta'));
  fireEvent.click(screen.getByRole('button', { name: 'Import 2 models' }));
  return onImported;
}

beforeEach(() => mockMakeAdminApiCall.mockReset());

describe('model import and the unmarked-model gate', () => {
  test('asks once for a justification and imports the gated models with it', async () => {
    mockApi(body =>
      body.aiTransparencyJustification
        ? Promise.resolve({ data: {} })
        : Promise.reject(gate([body.id]))
    );
    const onImported = await importBoth();

    const dialog = await screen.findByRole('dialog', {
      name: 'Enable a model that does not mark its output?'
    });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map(li => li.textContent)
    ).toEqual(['llmhub-alpha', 'llmhub-beta']);
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Needed until the watermarked model ships' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable anyway' }));

    expect(await screen.findByText('Imported 2 of 2 models into LLM Hub.')).toBeInTheDocument();
    const posts = modelPosts();
    expect(posts).toHaveLength(4);
    expect(posts.slice(2).map(b => [b.id, b.enabled, b.aiTransparencyJustification])).toEqual([
      ['llmhub-alpha', true, 'Needed until the watermarked model ships'],
      ['llmhub-beta', true, 'Needed until the watermarked model ships']
    ]);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  test('a cancelled justification leaves the gated models out and says why', async () => {
    mockApi(body =>
      body.id === 'llmhub-alpha' ? Promise.resolve({ data: {} }) : Promise.reject(gate([body.id]))
    );
    await importBoth();

    const dialog = await screen.findByRole('dialog', {
      name: 'Enable a model that does not mark its output?'
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(await screen.findByText('Imported 1 of 2 models into LLM Hub.')).toBeInTheDocument();
    expect(
      screen.getByText(/Not imported: enabling a model that does not mark its output/)
    ).toBeInTheDocument();
    expect(modelPosts()).toHaveLength(2);
  });
});
