// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Step rules of "Connect a model provider" (utils/providerConnect.js): which
 * tiles are offered, where the key goes, how a failed test is explained, and
 * what the final save writes — provider, linked models, default, groups.
 */
import { describe, it, expect, jest } from '@jest/globals';
import {
  CONNECT_TILES,
  KEEP_DEFAULT,
  buildDiscoveryRequest,
  buildModelConfigs,
  buildProviderWrite,
  canTestConnection,
  classifyConnectionError,
  findTile,
  getAvailableTiles,
  initialConnectionForm,
  isDefaultChoiceValid,
  newProviderIdProblem,
  nextStep,
  planGroupUpdates,
  previousStep,
  resolveTarget,
  runConnectPlan,
  stepsForTile,
  suggestedIdPrefix,
  updateConnectionForm,
  wildcardModelGroups
} from '../../../client/src/features/admin/utils/providerConnect';
import { CUSTOM_PROVIDER_API_TYPES } from '../../../shared/llmProviders.js';

const SHIPPED = [
  {
    id: 'openai',
    name: 'OpenAI',
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKeySet: true
  },
  { id: 'anthropic', name: 'Anthropic', enabled: true, apiKeySet: false },
  { id: 'bedrock', name: 'AWS Bedrock', category: 'llm', enabled: true, apiKeySet: false },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'llm',
    apiType: 'openai',
    enabled: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeySet: false
  }
];

const formFor = (tileId, providers = SHIPPED, changes = {}) => {
  const tile = findTile(tileId);
  let form = initialConnectionForm(tile, resolveTarget(tile, providers).provider);
  for (const [field, value] of Object.entries(changes)) {
    form = updateConnectionForm(form, field, value);
  }
  return { tile, form, target: resolveTarget(tile, providers) };
};

describe('tiles', () => {
  it('offers only API types the adapters and discovery support', () => {
    for (const tile of CONNECT_TILES) {
      expect([...CUSTOM_PROVIDER_API_TYPES, 'bedrock']).toContain(tile.apiType);
    }
  });

  it('names Azure, OpenRouter, self-hosted and the iFinder gateway as tiles of their own', () => {
    const ids = getAvailableTiles(SHIPPED).map(tile => tile.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'openai',
        'azure-openai',
        'anthropic',
        'google',
        'mistral',
        'bedrock',
        'openrouter',
        'openai-compatible',
        'self-hosted',
        'ifinder-gateway'
      ])
    );
  });

  it('hides Bedrock when its shipped provider is gone, since the flow never creates it', () => {
    const ids = getAvailableTiles(SHIPPED.filter(p => p.id !== 'bedrock')).map(t => t.id);
    expect(ids).not.toContain('bedrock');
  });
});

describe('steps', () => {
  it('walks the six steps and ends on done', () => {
    const tile = findTile('openai');
    expect(stepsForTile(tile)).toEqual([
      'vendor',
      'connection',
      'test',
      'models',
      'default',
      'access',
      'done'
    ]);
    expect(nextStep(tile, 'access')).toBe('done');
    expect(previousStep(tile, 'test')).toBe('connection');
    expect(previousStep(tile, 'vendor')).toBe('vendor');
  });

  it('stops Bedrock after the connection: there is no listing to test or pick from', () => {
    const tile = findTile('bedrock');
    expect(stepsForTile(tile)).toEqual(['vendor', 'connection', 'done']);
    expect(nextStep(tile, 'connection')).toBe('done');
  });
});

describe('connection form', () => {
  it('reuses a shipped provider and its endpoint', () => {
    const { form, target } = formFor('openai');
    expect(target).toEqual({ mode: 'existing', provider: SHIPPED[0] });
    expect(form.url).toBe('https://api.openai.com/v1');
  });

  it('creates a new provider when the shipped one was deleted', () => {
    const { target, form } = formFor('openrouter', []);
    expect(target.mode).toBe('new');
    expect(form.id).toBe('openrouter');
    expect(form.url).toBe('https://openrouter.ai/api/v1');
  });

  it('lets the id follow the name until it is edited', () => {
    const { form } = formFor('openai-compatible', SHIPPED, { name: 'T-Systems LLM Hub' });
    expect(form.id).toBe('t-systems-llm-hub');
    const edited = updateConnectionForm(updateConnectionForm(form, 'id', 'hub'), 'name', 'Other');
    expect(edited.id).toBe('hub');
  });

  it('switches the API type with the self-hosted server kind', () => {
    const { form } = formFor('self-hosted');
    expect(form.apiType).toBe('local');
    const lmStudio = updateConnectionForm(form, 'serverKind', 'lm-studio');
    expect(lmStudio).toMatchObject({ apiType: 'openai', id: 'lm-studio', name: 'LM Studio' });
  });

  it('explains why a new provider id cannot be used', () => {
    expect(newProviderIdProblem('', SHIPPED)).toBe('required');
    expect(newProviderIdProblem('Bad Id', SHIPPED)).toBe('invalid');
    expect(newProviderIdProblem('openai-responses', SHIPPED)).toBe('reserved');
    expect(newProviderIdProblem('openrouter', SHIPPED)).toBe('exists');
    expect(newProviderIdProblem('azure-openai', SHIPPED)).toBeNull();
  });

  it('needs a URL, and a name and free id for a new provider, before the test', () => {
    const azure = formFor('azure-openai');
    expect(canTestConnection(azure.tile, azure.form, azure.target, SHIPPED)).toBe(false);
    const filled = updateConnectionForm(azure.form, 'url', 'https://r.openai.azure.com/openai/v1');
    expect(canTestConnection(azure.tile, filled, azure.target, SHIPPED)).toBe(true);
    const taken = updateConnectionForm(filled, 'id', 'openrouter');
    expect(canTestConnection(azure.tile, taken, azure.target, SHIPPED)).toBe(false);
  });

  it('asks Bedrock for a key unless one is stored', () => {
    const bedrock = formFor('bedrock');
    expect(canTestConnection(bedrock.tile, bedrock.form, bedrock.target, SHIPPED)).toBe(false);
    const keyed = updateConnectionForm(bedrock.form, 'apiKey', 'abc');
    expect(canTestConnection(bedrock.tile, keyed, bedrock.target, SHIPPED)).toBe(true);
  });
});

describe('discovery request', () => {
  it('lets the server use the stored key of an existing provider', () => {
    const { tile, form, target } = formFor('openai');
    expect(buildDiscoveryRequest(tile, form, target)).toEqual({
      url: 'https://api.openai.com/v1',
      providerId: 'openai'
    });
  });

  it('describes a new endpoint by API type, key and gateway kind', () => {
    const { tile, form, target } = formFor('ifinder-gateway', SHIPPED, {
      url: 'https://gw:9614',
      apiKey: ' secret '
    });
    expect(buildDiscoveryRequest(tile, form, target)).toEqual({
      url: 'https://gw:9614',
      apiType: 'openai',
      apiKey: 'secret',
      gateway: 'ifinder-model-gateway'
    });
  });
});

describe('classifyConnectionError', () => {
  it.each([
    ['hostNotFound', undefined, undefined, 'unreachable'],
    ['connectionRefused', undefined, undefined, 'unreachable'],
    ['timeout', undefined, undefined, 'unreachable'],
    ['networkError', 'unable to verify the first certificate', undefined, 'tls'],
    ['certificateUntrusted', undefined, undefined, 'tls'],
    ['networkError', 'socket hang up', undefined, 'unreachable'],
    ['apiKeyRequired', undefined, 401, 'auth'],
    ['authenticationFailed', undefined, 401, 'auth'],
    ['accessDenied', undefined, 403, 'auth'],
    ['notFound', undefined, 404, 'path'],
    ['invalidResponse', undefined, undefined, 'path'],
    [undefined, undefined, 404, 'path'],
    ['upstreamError', undefined, 500, 'other']
  ])('%s / %s / %s → %s', (key, remediation, status, expected) => {
    expect(classifyConnectionError(key, remediation, status)).toBe(expected);
  });
});

describe('ids and default', () => {
  it('prefixes model ids with the provider id except for a shipped vendor provider', () => {
    expect(suggestedIdPrefix(formFor('openai').target, {})).toBe('');
    const gw = formFor('openai-compatible', SHIPPED, { name: 'Hub' });
    expect(suggestedIdPrefix(gw.target, gw.form)).toBe('hub-');
    expect(suggestedIdPrefix(formFor('openrouter').target, {})).toBe('openrouter-');
  });

  it('demands an explicit default', () => {
    const candidates = [{ id: 'a' }, { id: 'b' }];
    expect(isDefaultChoiceValid(null, candidates, null)).toBe(false);
    expect(isDefaultChoiceValid('a', candidates, null)).toBe(true);
    expect(isDefaultChoiceValid(KEEP_DEFAULT, candidates, null)).toBe(false);
    expect(isDefaultChoiceValid(KEEP_DEFAULT, candidates, { id: 'old' })).toBe(true);
    expect(isDefaultChoiceValid(null, [], null)).toBe(true);
  });
});

describe('groups', () => {
  const groupsFile = {
    groups: {
      admins: { permissions: { models: ['*'] } },
      authenticated: { permissions: { models: ['gpt'] } },
      hr: { permissions: { models: [] } },
      users: { permissions: { models: ['*'] } }
    }
  };

  it('names the groups that see every model anyway', () => {
    expect(wildcardModelGroups(groupsFile)).toEqual(['admins', 'users']);
  });

  it('grants "everyone" through the authenticated group', () => {
    expect(planGroupUpdates(groupsFile, { mode: 'everyone' }, ['hub-a'])).toEqual([
      { groupId: 'authenticated', models: ['gpt', 'hub-a'] }
    ]);
  });

  it('grants picked groups and leaves wildcard groups alone', () => {
    expect(
      planGroupUpdates(groupsFile, { mode: 'groups', groupIds: ['hr', 'users', 'gone'] }, ['x'])
    ).toEqual([{ groupId: 'hr', models: ['x'] }]);
  });
});

describe('save', () => {
  const discovery = {
    apiType: 'openai',
    baseUrl: 'http://gpu01:1234/v1',
    modelsUrl: 'http://gpu01:1234/v1/models',
    models: [
      {
        id: 'qwen3',
        name: 'Qwen3',
        type: 'chat',
        url: 'http://gpu01:1234/v1/chat/completions',
        contextWindow: 32768,
        supportsTools: true
      }
    ]
  };

  it('creates a keyless self-hosted provider with the endpoint the test resolved', () => {
    const { tile, form, target } = formFor('self-hosted', SHIPPED, {
      serverKind: 'lm-studio',
      url: 'http://gpu01:1234'
    });
    expect(buildProviderWrite(tile, form, target, discovery)).toEqual({
      method: 'POST',
      path: '/admin/providers',
      body: {
        id: 'lm-studio',
        name: 'LM Studio',
        description: '',
        category: 'llm',
        apiType: 'openai',
        enabled: true,
        baseUrl: 'http://gpu01:1234/v1',
        requiresApiKey: false
      }
    });
  });

  it('stores a new key on a shipped provider and leaves a keyed, enabled one alone', () => {
    const anthropic = formFor('anthropic', SHIPPED, { apiKey: 'sk-ant' });
    expect(buildProviderWrite(anthropic.tile, anthropic.form, anthropic.target, discovery)).toEqual(
      {
        method: 'PUT',
        path: '/admin/providers/anthropic',
        body: { id: 'anthropic', name: 'Anthropic', enabled: true, apiKey: 'sk-ant' }
      }
    );
    const openai = formFor('openai');
    expect(buildProviderWrite(openai.tile, openai.form, openai.target, discovery)).toBeNull();
  });

  it('marks a gateway that passed the test without a key as keyless, and one with a key not', () => {
    const open = formFor('openai-compatible', SHIPPED, {
      name: 'LiteLLM',
      url: 'https://litellm.example/v1'
    });
    expect(buildProviderWrite(open.tile, open.form, open.target, discovery).body).toMatchObject({
      requiresApiKey: false
    });
    const keyed = formFor('openai-compatible', SHIPPED, {
      name: 'Hub',
      url: 'https://hub.example/v1',
      apiKey: 'secret'
    });
    expect(
      buildProviderWrite(keyed.tile, keyed.form, keyed.target, discovery).body
    ).not.toHaveProperty('requiresApiKey');
  });

  it('keeps the stored key (masked placeholder) when only enabling a provider', () => {
    const providers = [{ ...SHIPPED[0], enabled: false }];
    const { tile, form, target } = formFor('openai', providers);
    expect(buildProviderWrite(tile, form, target, discovery).body).toMatchObject({
      enabled: true,
      apiKey: '••••••••'
    });
  });

  it('links each model to the provider without a key of its own and marks the chosen default', () => {
    const [config] = buildModelConfigs({
      discovery,
      picks: [{ model: discovery.models[0], id: 'lm-studio-qwen3' }],
      providerId: 'lm-studio',
      defaultId: 'lm-studio-qwen3'
    });
    expect(config).toMatchObject({
      id: 'lm-studio-qwen3',
      modelId: 'qwen3',
      provider: 'openai',
      providerId: 'lm-studio',
      url: 'http://gpu01:1234/v1/chat/completions',
      contextWindow: 32768,
      supportsTools: 'auto',
      enabled: true,
      default: true
    });
    expect(config).not.toHaveProperty('apiKey');
  });

  it('sends the Azure deployment name as the model name', () => {
    const [config] = buildModelConfigs({
      discovery: { ...discovery, azure: true },
      picks: [{ model: discovery.models[0], id: 'az-qwen', deployment: 'my-deployment' }],
      providerId: 'azure-openai',
      defaultId: null
    });
    expect(config.modelId).toBe('my-deployment');
    expect(config.default).toBe(false);
  });
});

describe('runConnectPlan', () => {
  const errorMessage = err => err.message;

  it('writes provider, models and groups in that order', async () => {
    const api = jest.fn().mockResolvedValue({ data: {} });
    const outcome = await runConnectPlan({
      api,
      errorMessage,
      providerWrite: { method: 'POST', path: '/admin/providers', body: { id: 'p' } },
      modelConfigs: [{ id: 'a' }, { id: 'b' }],
      groupUpdates: [{ groupId: 'hr', models: ['a', 'b'] }]
    });
    expect(api.mock.calls.map(([path, options]) => `${options.method} ${path}`)).toEqual([
      'POST /admin/providers',
      'POST /admin/models',
      'POST /admin/models',
      'PUT /admin/groups/hr'
    ]);
    expect(api.mock.calls[3][1].body).toEqual({ permissions: { models: ['a', 'b'] } });
    expect(outcome).toEqual({
      providerError: null,
      models: [
        { id: 'a', ok: true },
        { id: 'b', ok: true }
      ],
      groups: [{ groupId: 'hr', ok: true }]
    });
  });

  it('creates no model when the provider cannot be written', async () => {
    const api = jest.fn().mockRejectedValue(new Error('exists'));
    const outcome = await runConnectPlan({
      api,
      errorMessage,
      providerWrite: { method: 'POST', path: '/admin/providers', body: {} },
      modelConfigs: [{ id: 'a' }],
      groupUpdates: []
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(outcome.providerError).toBe('exists');
    expect(outcome.models).toEqual([]);
  });

  it('does not grant a model that failed to be created', async () => {
    const api = jest.fn(async (path, options) => {
      if (path === '/admin/models' && options.body.id === 'b') throw new Error('conflict');
      return { data: {} };
    });
    const outcome = await runConnectPlan({
      api,
      errorMessage,
      providerWrite: null,
      modelConfigs: [{ id: 'a' }, { id: 'b' }],
      groupUpdates: [{ groupId: 'hr', models: ['old', 'a', 'b'] }]
    });
    expect(outcome.models[1]).toEqual({ id: 'b', ok: false, error: 'conflict' });
    const groupCall = api.mock.calls.find(([path]) => path === '/admin/groups/hr');
    expect(groupCall[1].body.permissions.models).toEqual(['old', 'a']);
  });
});
