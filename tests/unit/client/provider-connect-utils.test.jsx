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
  connectionUrl,
  findTile,
  getAvailableTiles,
  initialConnectionForm,
  isDefaultChoiceValid,
  newProviderIdProblem,
  nextStep,
  planGroupUpdates,
  previousStep,
  regionProblem,
  resolveTarget,
  runConnectPlan,
  stepsForTile,
  suggestedIdPrefix,
  updateConnectionForm,
  wildcardModelGroups,
  defaultTokenModelGroups
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

  it('walks Bedrock through every step: its models are listed per region', () => {
    const tile = findTile('bedrock');
    expect(stepsForTile(tile)).toEqual([
      'vendor',
      'connection',
      'test',
      'models',
      'default',
      'access',
      'done'
    ]);
    expect(nextStep(tile, 'connection')).toBe('test');
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

  it('asks Bedrock for a valid region, preset to the stored one or the default', () => {
    const bedrock = formFor('bedrock');
    expect(bedrock.form.region).toBe('eu-central-1');
    expect(regionProblem(bedrock.tile, bedrock.form)).toBeNull();
    // The key may be stored or set on the server; the test says when it is missing.
    expect(canTestConnection(bedrock.tile, bedrock.form, bedrock.target, SHIPPED)).toBe(true);
    for (const [value, problem] of [
      ['', 'required'],
      ['eu central', 'invalid'],
      ['bedrock.evil.com', 'invalid']
    ]) {
      const form = updateConnectionForm(bedrock.form, 'region', value);
      expect(regionProblem(bedrock.tile, form)).toBe(problem);
      expect(canTestConnection(bedrock.tile, form, bedrock.target, SHIPPED)).toBe(false);
    }
    const stored = SHIPPED.map(p =>
      p.id === 'bedrock' ? { ...p, config: { region: 'us-west-2' } } : p
    );
    expect(formFor('bedrock', stored).form.region).toBe('us-west-2');
    expect(regionProblem(findTile('openai'), formFor('openai').form)).toBeNull();
  });

  it("presets Bedrock to the server's effective region when the provider names none", () => {
    // GET /admin/providers sends `effectiveRegion`: the provider's region, else AWS_REGION.
    const fromServer = SHIPPED.map(p =>
      p.id === 'bedrock' ? { ...p, effectiveRegion: 'eu-west-3' } : p
    );
    expect(formFor('bedrock', fromServer).form.region).toBe('eu-west-3');
    const both = SHIPPED.map(p =>
      p.id === 'bedrock'
        ? { ...p, config: { region: 'us-west-2' }, effectiveRegion: 'us-west-2' }
        : p
    );
    expect(formFor('bedrock', both).form.region).toBe('us-west-2');
  });

  it('shows the Bedrock control plane of the region as the tested URL', () => {
    const { tile, form } = formFor('bedrock');
    expect(connectionUrl(tile, form)).toBe('https://bedrock.eu-central-1.amazonaws.com');
    expect(connectionUrl(tile, updateConnectionForm(form, 'region', 'global'))).toBe(
      'https://bedrock.eu-central-1.amazonaws.com'
    );
    expect(connectionUrl(tile, updateConnectionForm(form, 'region', 'x'))).toBe('');
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
    expect(
      defaultTokenModelGroups({
        groups: {
          anonymous: { permissions: { models: ['@default'] } },
          both: { permissions: { models: ['*', '@default'] } },
          hr: { permissions: { models: ['x'] } }
        }
      })
    ).toEqual(['anonymous']);
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

  it('sets the provider region only when it has none, keeping the rest of its config', () => {
    const unset = SHIPPED.map(p =>
      p.id === 'bedrock'
        ? { ...p, apiKeySet: true, config: { other: 1 }, effectiveRegion: 'eu-central-1' }
        : p
    );
    const bedrockDiscovery = { apiType: 'bedrock', region: 'us-east-1', models: [] };
    const first = formFor('bedrock', unset, { region: 'us-east-1' });
    expect(buildProviderWrite(first.tile, first.form, first.target, bedrockDiscovery)).toEqual({
      method: 'PUT',
      path: '/admin/providers/bedrock',
      body: {
        id: 'bedrock',
        name: 'AWS Bedrock',
        category: 'llm',
        enabled: true,
        apiKey: '••••••••',
        config: { region: 'us-east-1', other: 1 }
      }
    });
  });

  it('leaves a set provider region alone on a run in another region', () => {
    // A second run must not move the Bedrock models imported before: they follow the
    // provider's region unless they carry their own.
    const providers = SHIPPED.map(p =>
      p.id === 'bedrock' ? { ...p, apiKeySet: true, config: { region: 'eu-west-1', other: 1 } } : p
    );
    const elsewhere = formFor('bedrock', providers, { region: 'us-east-1' });
    expect(
      buildProviderWrite(elsewhere.tile, elsewhere.form, elsewhere.target, {
        apiType: 'bedrock',
        region: 'us-east-1',
        models: []
      })
    ).toBeNull();
    // A new key is still written, without touching the region.
    const keyed = formFor('bedrock', providers, { region: 'us-east-1', apiKey: 'k2' });
    const write = buildProviderWrite(keyed.tile, keyed.form, keyed.target, {
      apiType: 'bedrock',
      region: 'us-east-1',
      models: []
    });
    expect(write.body.config).toEqual({ region: 'eu-west-1', other: 1 });
    expect(write.body.apiKey).toBe('k2');
    expect(write.body).not.toHaveProperty('effectiveRegion');
  });

  it('gives every imported Bedrock model the region it was listed in', () => {
    const configs = buildModelConfigs({
      discovery: {
        apiType: 'bedrock',
        region: 'us-east-1',
        modelsUrl: 'https://bedrock.us-east-1.amazonaws.com/foundation-models',
        models: []
      },
      picks: [
        { id: 'claude-us', model: { id: 'us.anthropic.claude-sonnet-4', type: 'chat' } },
        { id: 'nova-us', model: { id: 'us.amazon.nova-pro-v1:0', type: 'chat' } }
      ],
      providerId: 'bedrock',
      defaultId: null
    });
    expect(configs.map(c => c.config)).toEqual([{ region: 'us-east-1' }, { region: 'us-east-1' }]);
    // Other providers get no region.
    const [openaiConfig] = buildModelConfigs({
      discovery: { ...discovery, region: 'us-east-1' },
      picks: [{ id: 'gpt', model: { id: 'gpt-4o', type: 'chat' } }],
      providerId: 'openai',
      defaultId: null
    });
    expect(openaiConfig).not.toHaveProperty('config');
  });

  it('asks discovery for the Bedrock region instead of a URL and builds configs the adapter accepts', () => {
    const { tile, form, target } = formFor('bedrock', SHIPPED, { region: 'global', apiKey: 'k' });
    expect(buildDiscoveryRequest(tile, form, target)).toEqual({
      providerId: 'bedrock',
      region: 'global',
      apiKey: 'k'
    });
    const [config] = buildModelConfigs({
      discovery: {
        apiType: 'bedrock',
        modelsUrl: 'https://bedrock.eu-central-1.amazonaws.com/foundation-models',
        models: []
      },
      picks: [
        {
          id: 'global-claude',
          model: {
            id: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
            name: 'Global Claude Sonnet 4',
            type: 'chat',
            supportsVision: true
          }
        }
      ],
      providerId: 'bedrock',
      defaultId: 'global-claude'
    });
    expect(config).toMatchObject({
      id: 'global-claude',
      modelId: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
      provider: 'bedrock',
      supportsVision: true,
      default: true
    });
    expect(config.url).toBeUndefined();
    expect(config).not.toHaveProperty('providerId');
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

  it('plans the group writes again from the groups as they are now', async () => {
    const api = jest.fn().mockResolvedValue({ data: {} });
    // Another admin added "legal-model" to HR while the flow was open.
    const replanGroups = jest.fn(async created => ({
      updates: planGroupUpdates(
        { groups: { hr: { permissions: { models: ['old', 'legal-model'] } } } },
        { mode: 'groups', groupIds: ['hr'] },
        created
      ),
      revision: '"r1"'
    }));
    await runConnectPlan({
      api,
      errorMessage,
      providerWrite: null,
      modelConfigs: [{ id: 'a' }],
      groupUpdates: [{ groupId: 'hr', models: ['old', 'a'] }],
      replanGroups
    });
    expect(replanGroups).toHaveBeenCalledWith(['a']);
    const groupCall = api.mock.calls.find(([path]) => path === '/admin/groups/hr');
    expect(groupCall[1].body.permissions.models).toEqual(['old', 'legal-model', 'a']);
    // Guarded by the revision of that fresh read.
    expect(groupCall[1].headers).toEqual({ 'If-Match': '"r1"' });
  });

  it('falls back to the loaded plan when the groups cannot be read again', async () => {
    const api = jest.fn().mockResolvedValue({ data: {} });
    await runConnectPlan({
      api,
      errorMessage,
      providerWrite: null,
      modelConfigs: [{ id: 'a' }],
      groupUpdates: [{ groupId: 'hr', models: ['old', 'a'] }],
      replanGroups: async () => {
        throw new Error('offline');
      }
    });
    const groupCall = api.mock.calls.find(([path]) => path === '/admin/groups/hr');
    expect(groupCall[1].body.permissions.models).toEqual(['old', 'a']);
    // Nothing was read, so there is no revision to send.
    expect(groupCall[1].headers).toBeUndefined();
  });

  it('sends the ETag of the previous group write with the next one', async () => {
    const api = jest.fn(async path =>
      path === '/admin/groups/hr' ? { data: {}, headers: { etag: '"r2"' } } : { data: {} }
    );
    await runConnectPlan({
      api,
      errorMessage,
      providerWrite: null,
      modelConfigs: [{ id: 'a' }],
      groupUpdates: [{ groupId: 'hr', models: ['a'] }],
      replanGroups: async () => ({
        updates: [
          { groupId: 'hr', models: ['a'] },
          { groupId: 'it', models: ['a'] }
        ],
        revision: '"r1"'
      })
    });
    const headersOf = id => api.mock.calls.find(([path]) => path === `/admin/groups/${id}`)[1];
    expect(headersOf('hr').headers).toEqual({ 'If-Match': '"r1"' });
    expect(headersOf('it').headers).toEqual({ 'If-Match': '"r2"' });
  });

  it('on 412 reads the groups again and retries the write once from that read', async () => {
    const conflict = Object.assign(new Error('changed'), {
      response: { status: 412, data: { code: 'PRECONDITION_FAILED' } }
    });
    let groupWrites = 0;
    const api = jest.fn(async path => {
      if (path !== '/admin/groups/hr') return { data: {} };
      groupWrites += 1;
      if (groupWrites === 1) throw conflict;
      return { data: {}, headers: { etag: '"r3"' } };
    });
    // Between the first read and the write, another admin added "legal-model" to HR.
    const reads = [
      { groups: { hr: { permissions: { models: ['old'] } } } },
      { groups: { hr: { permissions: { models: ['old', 'legal-model'] } } } }
    ];
    const replanGroups = jest.fn(async created => {
      const index = replanGroups.mock.calls.length - 1;
      return {
        updates: planGroupUpdates(reads[index], { mode: 'groups', groupIds: ['hr'] }, created),
        revision: `"r${index + 1}"`
      };
    });

    const outcome = await runConnectPlan({
      api,
      errorMessage,
      providerWrite: null,
      modelConfigs: [{ id: 'a' }],
      groupUpdates: [{ groupId: 'hr', models: ['old', 'a'] }],
      replanGroups
    });

    expect(replanGroups).toHaveBeenCalledTimes(2);
    const groupCalls = api.mock.calls.filter(([path]) => path === '/admin/groups/hr');
    expect(groupCalls).toHaveLength(2);
    expect(groupCalls[0][1].headers).toEqual({ 'If-Match': '"r1"' });
    expect(groupCalls[1][1].headers).toEqual({ 'If-Match': '"r2"' });
    expect(groupCalls[1][1].body.permissions.models).toEqual(['old', 'legal-model', 'a']);
    expect(outcome.groups).toEqual([{ groupId: 'hr', ok: true }]);
  });

  it('reports the group as failed when the retry meets another conflict', async () => {
    const conflict = Object.assign(new Error('changed again'), {
      response: { status: 412, data: { code: 'PRECONDITION_FAILED' } }
    });
    const api = jest.fn(async path => {
      if (path === '/admin/groups/hr') throw conflict;
      return { data: {} };
    });
    const outcome = await runConnectPlan({
      api,
      errorMessage,
      providerWrite: null,
      modelConfigs: [{ id: 'a' }],
      groupUpdates: [{ groupId: 'hr', models: ['a'] }],
      replanGroups: async () => ({ updates: [{ groupId: 'hr', models: ['a'] }], revision: '"r"' })
    });
    expect(api.mock.calls.filter(([path]) => path === '/admin/groups/hr')).toHaveLength(2);
    expect(outcome.groups).toEqual([{ groupId: 'hr', ok: false, error: 'changed again' }]);
  });

  it('counts a group as done when the fresh read shows it already grants the models', async () => {
    const conflict = Object.assign(new Error('changed'), {
      response: { status: 412, data: { code: 'PRECONDITION_FAILED' } }
    });
    let reads = 0;
    const api = jest.fn(async path => {
      if (path === '/admin/groups/hr') throw conflict;
      return { data: {} };
    });
    const outcome = await runConnectPlan({
      api,
      errorMessage,
      providerWrite: null,
      modelConfigs: [{ id: 'a' }],
      groupUpdates: [{ groupId: 'hr', models: ['a'] }],
      replanGroups: async created => {
        reads += 1;
        const models = reads === 1 ? [] : ['*'];
        return {
          updates: planGroupUpdates(
            { groups: { hr: { permissions: { models } } } },
            { mode: 'groups', groupIds: ['hr'] },
            created
          ),
          revision: `"r${reads}"`
        };
      }
    });
    expect(api.mock.calls.filter(([path]) => path === '/admin/groups/hr')).toHaveLength(1);
    expect(outcome.groups).toEqual([{ groupId: 'hr', ok: true }]);
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
