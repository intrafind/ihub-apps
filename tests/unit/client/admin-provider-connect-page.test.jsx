// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Connect a model provider" end to end against a mocked admin API: tile,
 * connection, test, models, default, access, then one save that creates the
 * provider, its linked models (no key of their own, one default) and the
 * group grant. A failed test explains its cause and points at the fix.
 */
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.detail || err?.message || 'error'
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: { admin: { pages: {} } } })
}));

const mockT = (key, defaultOrOptions, options) => {
  if (typeof defaultOrOptions !== 'string') return key;
  return defaultOrOptions.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const AdminProviderConnectPage =
  require('../../../client/src/features/admin/pages/AdminProviderConnectPage').default;

const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKeySet: true
  },
  { id: 'bedrock', name: 'AWS Bedrock', category: 'llm', enabled: true, apiKeySet: false }
];
const EXISTING_MODELS = [
  { id: 'gpt-4o', name: { en: 'GPT-4o' }, provider: 'openai', enabled: true, default: true }
];
const GROUPS = {
  groups: {
    admins: { name: 'Admins', permissions: { models: ['*'] } },
    authenticated: { name: 'Authenticated', permissions: { models: ['gpt-4o'] } },
    hr: { name: 'HR', permissions: { models: [] } },
    anonymous: { name: 'Anonymous', permissions: { models: ['@default'] } }
  }
};
const DISCOVERY = {
  apiType: 'openai',
  baseUrl: 'https://hub.example/v1',
  modelsUrl: 'https://hub.example/v1/models',
  azure: false,
  gateway: null,
  models: [
    {
      id: 'llama-3',
      name: 'Llama 3',
      type: 'chat',
      url: 'https://hub.example/v1/chat/completions',
      contextWindow: 131072,
      supportsTools: true
    },
    {
      id: 'qwen',
      name: 'Qwen',
      type: 'chat',
      url: 'https://hub.example/v1/chat/completions',
      supportsVision: true
    },
    {
      id: 'embed',
      name: 'Embed',
      type: 'embedding',
      url: 'https://hub.example/v1/chat/completions',
      unsupported: true
    }
  ]
};

function mockApi({ discover } = {}) {
  mockMakeAdminApiCall.mockImplementation(async (path, options = {}) => {
    const method = options.method || 'GET';
    if (path === '/admin/providers' && method === 'GET') return { data: { items: PROVIDERS } };
    if (path === '/admin/models' && method === 'GET') return { data: { items: EXISTING_MODELS } };
    if (path === '/admin/groups' && method === 'GET') return { data: GROUPS };
    if (path === '/admin/models/_discover') {
      if (discover) return discover(options.body);
      return { data: DISCOVERY };
    }
    return { data: {} };
  });
}

const calls = (path, method) =>
  mockMakeAdminApiCall.mock.calls.filter(
    ([p, options]) => p === path && (options?.method || 'GET') === method
  );

function Location() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function renderPage(url = '/admin/providers/connect') {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/admin/providers/connect" element={<AdminProviderConnectPage />} />
          <Route path="*" element={<Location />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

const next = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('connect-next'));
  });
};

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

test('connects an OpenAI-compatible gateway with two models, an explicit default and a group', async () => {
  mockApi();
  await renderPage();

  fireEvent.click(screen.getByTestId('connect-tile-openai-compatible'));
  await next();

  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'LLM Hub' } });
  expect(screen.getByLabelText(/^ID/)).toHaveValue('llm-hub');
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: 'https://hub.example/v1' }
  });
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'secret' } });
  // A new provider's test reads no environment variable, so the hint is not offered.
  expect(screen.queryByText(/LLM_HUB_API_KEY/)).not.toBeInTheDocument();
  await next();

  // Step 3: the test ran on entering and shows host and model count.
  const success = await screen.findByTestId('connect-test-success');
  expect(within(success).getByText('hub.example')).toBeInTheDocument();
  expect(within(success).getByText('3 listed, 2 chat models')).toBeInTheDocument();
  expect(calls('/admin/models/_discover', 'POST')[0][1].body).toEqual({
    url: 'https://hub.example/v1',
    apiType: 'openai',
    apiKey: 'secret'
  });
  await next();

  // Step 4: the import list with detected capabilities; nothing picked yet.
  expect(screen.getByTestId('connect-next')).toBeDisabled();
  expect(screen.getByText('Tools')).toBeInTheDocument();
  expect(screen.getByText('Vision')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Select all chat models'));
  expect(screen.getByText('2 of 3 models picked')).toBeInTheDocument();
  expect(screen.getByLabelText('iHub model ID for Llama 3')).toHaveValue('llm-hub-llama-3');
  await next();

  // Step 5: explicit default — nothing is preselected.
  expect(screen.getByTestId('connect-next')).toBeDisabled();
  expect(screen.getByLabelText(/Keep GPT-4o/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/llm-hub-qwen/));
  await next();

  // Step 6: groups; the wildcard group is named, and so are the groups that
  // grant "the default model", since one of the new models becomes the default.
  const [wildcardNote, defaultNote] = screen.getAllByRole('note');
  expect(wildcardNote).toHaveTextContent('Admins');
  expect(defaultNote).toHaveAttribute('data-testid', 'connect-default-token-note');
  expect(defaultNote).toHaveTextContent('Anonymous');
  fireEvent.click(screen.getByLabelText('Only the groups I pick'));
  expect(screen.getByTestId('connect-next')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('HR'));
  expect(screen.getByTestId('connect-next')).toHaveTextContent('Connect and add 2 models');
  await next();

  const [[, providerCall]] = calls('/admin/providers', 'POST');
  expect(providerCall.body).toEqual({
    id: 'llm-hub',
    name: 'LLM Hub',
    description: '',
    category: 'llm',
    apiType: 'openai',
    enabled: true,
    baseUrl: 'https://hub.example/v1',
    apiKey: 'secret'
  });
  const modelBodies = calls('/admin/models', 'POST').map(([, options]) => options.body);
  expect(modelBodies.map(b => [b.id, b.providerId, b.default, b.enabled])).toEqual([
    ['llm-hub-llama-3', 'llm-hub', false, true],
    ['llm-hub-qwen', 'llm-hub', true, true]
  ]);
  expect(modelBodies.every(b => !('apiKey' in b))).toBe(true);
  const [[, groupCall]] = calls('/admin/groups/hr', 'PUT');
  expect(groupCall.body).toEqual({ permissions: { models: ['llm-hub-llama-3', 'llm-hub-qwen'] } });

  const done = await screen.findByTestId('connect-done');
  expect(done).toHaveTextContent('2 models connected through LLM Hub');
  expect(done).toHaveTextContent('llm-hub-qwen is the default model.');
  expect(within(done).getByRole('link', { name: 'Create an app with this model' })).toHaveAttribute(
    'href',
    '/admin/apps/new'
  );
  expect(within(done).getByRole('link', { name: 'Open the provider' })).toHaveAttribute(
    'href',
    '/admin/providers/llm-hub'
  );

  // One-prompt smoke test on the new default.
  mockMakeAdminApiCall.mockResolvedValueOnce({ data: { response: 'Hello!' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('connect-smoke-test'));
  });
  expect(mockMakeAdminApiCall).toHaveBeenLastCalledWith('/admin/models/llm-hub-qwen/_test', {
    method: 'POST'
  });
  expect(await screen.findByText('Hello!')).toBeInTheDocument();
});

test('a shipped provider with a stored key starts at the connection from ?vendor= and is not rewritten', async () => {
  mockApi();
  await renderPage('/admin/providers/connect?vendor=openai');

  expect(screen.getByRole('heading', { name: 'Connect OpenAI' })).toBeInTheDocument();
  expect(screen.getByLabelText(/Endpoint URL/)).toHaveAttribute('readonly');
  expect(screen.getByText(/A key is already stored on this provider/)).toBeInTheDocument();
  expect(screen.getByText(/OPENAI_API_KEY/)).toBeInTheDocument();
  await next();
  expect(calls('/admin/models/_discover', 'POST')[0][1].body).toEqual({
    url: 'https://api.openai.com/v1',
    providerId: 'openai'
  });
  await screen.findByTestId('connect-test-success');
  await next();
  fireEvent.click(screen.getByLabelText('Llama 3'));
  // Shipped vendor provider: model ids carry no prefix.
  expect(screen.getByLabelText('iHub model ID for Llama 3')).toHaveValue('llama-3');
  await next();
  fireEvent.click(screen.getByLabelText(/Keep GPT-4o/));
  await next();
  // The default stays where it is: no note about "the default model".
  expect(screen.queryByTestId('connect-default-token-note')).not.toBeInTheDocument();
  await next();

  expect(calls('/admin/providers/openai', 'PUT')).toHaveLength(0);
  const [[, modelCall]] = calls('/admin/models', 'POST');
  expect(modelCall.body).toMatchObject({ id: 'llama-3', provider: 'openai', default: false });
  expect(modelCall.body).not.toHaveProperty('providerId');
  // "Everyone": granted through the authenticated group.
  expect(calls('/admin/groups/authenticated', 'PUT')[0][1].body).toEqual({
    permissions: { models: ['gpt-4o', 'llama-3'] }
  });
});

test('a certificate failure explains the private CA and links to the SSL whitelist', async () => {
  mockApi({
    discover: () => {
      const err = new Error('Request failed');
      err.response = {
        data: {
          detail: 'Network error',
          details: {
            messageKey: 'networkError',
            remediation:
              'request to https://hub.internal/v1/models failed, reason: unable to verify the first certificate'
          }
        }
      };
      throw err;
    }
  });
  await renderPage('/admin/providers/connect?vendor=self-hosted');
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: 'https://hub.internal/v1' }
  });
  await next();

  const alert = await screen.findByTestId('connect-test-error');
  expect(alert).toHaveTextContent(/private CA/);
  expect(within(alert).getByRole('link', { name: 'Open the SSL whitelist' })).toHaveAttribute(
    'href',
    '/admin/security'
  );
  expect(screen.getByTestId('connect-next')).toBeDisabled();
});

test('a rejected key sends the admin back to the key', async () => {
  mockApi({
    discover: () => {
      const err = new Error('Request failed');
      err.response = {
        data: {
          detail: 'The endpoint rejected the API key',
          details: { messageKey: 'authenticationFailed', upstreamStatus: 401 }
        }
      };
      throw err;
    }
  });
  await renderPage('/admin/providers/connect?vendor=openai');
  await next();
  const alert = await screen.findByTestId('connect-test-error');
  expect(alert).toHaveTextContent('The endpoint rejected the key.');
  fireEvent.click(within(alert).getByRole('button', { name: 'Change the key' }));
  expect(screen.getByRole('heading', { name: 'Connect OpenAI' })).toBeInTheDocument();
});

const BEDROCK_DISCOVERY = {
  apiType: 'bedrock',
  baseUrl: 'https://bedrock.us-east-1.amazonaws.com',
  modelsUrl: 'https://bedrock.us-east-1.amazonaws.com/foundation-models',
  azure: false,
  gateway: null,
  region: 'us-east-1',
  models: [
    {
      id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      name: 'US Claude Sonnet 4',
      ownedBy: 'Anthropic',
      type: 'chat',
      supportsVision: true,
      foundationModelId: 'anthropic.claude-sonnet-4-20250514-v1:0'
    },
    {
      id: 'amazon.titan-embed-text-v2:0',
      name: 'Titan Text Embeddings V2',
      type: 'embedding',
      unsupported: true
    }
  ]
};

test('Bedrock asks for the region, lists its models and walks the whole flow', async () => {
  mockApi({ discover: () => ({ data: BEDROCK_DISCOVERY }) });
  await renderPage();
  fireEvent.click(screen.getByTestId('connect-tile-bedrock'));
  await next();

  // Connection: a region instead of a URL, preset to the default; the key is optional
  // (stored, typed or BEDROCK_API_KEY on the server).
  expect(screen.queryByLabelText(/Endpoint URL/)).not.toBeInTheDocument();
  const region = screen.getByLabelText(/AWS region/);
  expect(region).toHaveValue('eu-central-1');
  expect(screen.getByText(/BEDROCK_API_KEY/)).toBeInTheDocument();

  fireEvent.change(region, { target: { value: 'eu central' } });
  expect(
    screen.getByText('Enter an AWS region code such as eu-central-1, or global.')
  ).toBeInTheDocument();
  expect(screen.getByTestId('connect-next')).toBeDisabled();

  fireEvent.change(region, { target: { value: 'us-east-1' } });
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'bedrock-key' } });
  expect(screen.getByTestId('connect-next')).toHaveTextContent('Test connection');
  await next();

  // Test: the region is sent instead of a URL.
  const success = await screen.findByTestId('connect-test-success');
  expect(within(success).getByText('bedrock.us-east-1.amazonaws.com')).toBeInTheDocument();
  expect(within(success).getByText('us-east-1')).toBeInTheDocument();
  expect(within(success).getByText('AWS Bedrock')).toBeInTheDocument();
  expect(calls('/admin/models/_discover', 'POST')[0][1].body).toEqual({
    providerId: 'bedrock',
    region: 'us-east-1',
    apiKey: 'bedrock-key'
  });
  await next();

  // Models: the embedding model cannot be picked.
  expect(screen.getByLabelText('Titan Text Embeddings V2')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('US Claude Sonnet 4'));
  expect(screen.getByLabelText('iHub model ID for US Claude Sonnet 4')).toHaveValue(
    'us.anthropic.claude-sonnet-4-20250514-v1-0'
  );
  await next();

  fireEvent.click(screen.getByLabelText(/Keep GPT-4o/));
  await next();
  await next();

  // Save: key and region on the provider, a Bedrock model config the adapter accepts.
  const [[, put]] = calls('/admin/providers/bedrock', 'PUT');
  expect(put.body).toMatchObject({
    id: 'bedrock',
    apiKey: 'bedrock-key',
    enabled: true,
    config: { region: 'us-east-1' }
  });
  const [[, modelCall]] = calls('/admin/models', 'POST');
  expect(modelCall.body).toMatchObject({
    id: 'us.anthropic.claude-sonnet-4-20250514-v1-0',
    modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    provider: 'bedrock',
    supportsVision: true,
    default: false,
    enabled: true
  });
  expect(modelCall.body).not.toHaveProperty('url');
  expect(modelCall.body).not.toHaveProperty('providerId');
  expect(modelCall.body).not.toHaveProperty('apiKey');

  const done = await screen.findByTestId('connect-done');
  expect(done).toHaveTextContent('1 models connected through AWS Bedrock');
  expect(screen.queryByRole('link', { name: /Marketplace/ })).not.toBeInTheDocument();
});

test('Bedrock with an unchanged region and a stored key writes no provider update', async () => {
  const providers = PROVIDERS.map(p =>
    p.id === 'bedrock' ? { ...p, apiKeySet: true, config: { region: 'us-east-1' } } : p
  );
  mockMakeAdminApiCall.mockImplementation(async (path, options = {}) => {
    const method = options.method || 'GET';
    if (path === '/admin/providers' && method === 'GET') return { data: { items: providers } };
    if (path === '/admin/models' && method === 'GET') return { data: { items: EXISTING_MODELS } };
    if (path === '/admin/groups' && method === 'GET') return { data: GROUPS };
    if (path === '/admin/models/_discover') return { data: BEDROCK_DISCOVERY };
    return { data: {} };
  });
  await renderPage('/admin/providers/connect?vendor=bedrock');

  expect(screen.getByLabelText(/AWS region/)).toHaveValue('us-east-1');
  await next();
  await screen.findByTestId('connect-test-success');
  expect(calls('/admin/models/_discover', 'POST')[0][1].body).toEqual({
    providerId: 'bedrock',
    region: 'us-east-1'
  });
  await next();
  fireEvent.click(screen.getByLabelText('US Claude Sonnet 4'));
  await next();
  fireEvent.click(screen.getByLabelText(/Keep GPT-4o/));
  await next();
  await next();

  expect(calls('/admin/providers/bedrock', 'PUT')).toHaveLength(0);
  expect(calls('/admin/models', 'POST')).toHaveLength(1);
});

test('Bedrock: an AWS refusal of the key sends the admin back to the key', async () => {
  mockApi({
    discover: () => {
      const err = new Error('Request failed');
      err.response = {
        data: {
          detail: 'AWS did not accept the Bedrock API key',
          details: {
            messageKey: 'authenticationFailed',
            upstreamStatus: 403,
            remediation: 'HTTP 403. Check that the key is complete and has not expired.'
          }
        }
      };
      throw err;
    }
  });
  await renderPage('/admin/providers/connect?vendor=bedrock');
  await next();
  const alert = await screen.findByTestId('connect-test-error');
  expect(alert).toHaveTextContent('The endpoint rejected the key.');
  expect(alert).toHaveTextContent('Check that the key is complete');
  expect(screen.getByTestId('connect-next')).toBeDisabled();
});

test('an answer for a connection the admin has since changed is dropped', async () => {
  let resolveFirst;
  const bodies = [];
  mockApi({
    discover: body => {
      bodies.push(body);
      if (bodies.length === 1) {
        return new Promise(resolve => {
          resolveFirst = resolve;
        });
      }
      return { data: { ...DISCOVERY, baseUrl: 'https://b.example/v1' } };
    }
  });
  await renderPage();
  fireEvent.click(screen.getByTestId('connect-tile-openai-compatible'));
  await next();
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Hub' } });
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: 'https://a.example/v1' }
  });
  await next();
  expect(bodies[0].url).toBe('https://a.example/v1');

  // Back while the test of A runs, change the URL to B, then A answers.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.change(screen.getByLabelText(/Endpoint URL/), {
    target: { value: 'https://b.example/v1' }
  });
  await act(async () => {
    resolveFirst({ data: DISCOVERY });
  });

  // Entering the test step again tests B; A's answer was not kept.
  await next();
  await screen.findByTestId('connect-test-success');
  expect(bodies).toHaveLength(2);
  expect(bodies[1].url).toBe('https://b.example/v1');
});
