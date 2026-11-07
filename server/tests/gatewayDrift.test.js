// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Drift between an iFinder Model Gateway and the models imported from it.
 *
 * What has to hold:
 *   - a model the gateway lists and nobody imported is `added`, with the model
 *     config the import dialog would build and an id nothing else has;
 *   - an imported model that differs from the gateway is `changed`, per field;
 *   - an enabled imported model the gateway dropped, or now lists as something
 *     iHub cannot run, is `removed`; a disabled one is left alone;
 *   - nothing is reported for what is not drift: models iHub cannot run, models
 *     configured by hand for the same endpoint, an OpenAI-dialect model that
 *     runs on the vLLM adapter instead of the OpenAI one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGatewayEntry, buildGatewayTarget } from '../services/ModelEndpointDiscovery.js';
import { computeGatewayDrift } from '../services/gatewayDrift.js';

const PROXY = 'https://gw.example.com:9614/v1/gateway/proxy';
const MODELS_URL = 'https://gw.example.com:9614/v1/gateway/models';

const provider = {
  id: 'ifinder-gw',
  name: 'iFinder gateway',
  category: 'llm',
  apiType: 'openai',
  gateway: 'ifinder-model-gateway',
  baseUrl: 'https://gw.example.com:9614'
};

/** A listed model as `discoverModels` returns it: normalized, with its target. */
function listed(raw, apiType = 'openai') {
  const entry = normalizeGatewayEntry(raw);
  return { ...entry, ...buildGatewayTarget(PROXY, apiType, entry) };
}

const CHAT = { id: 'qwen3-vl', api_type: 'OPENAI', max_model_len: 32768, endpoints: ['CHAT'] };
const MISTRAL = {
  id: 'mistral-large-3',
  api_type: 'MISTRAL',
  max_model_len: 131072,
  endpoints: ['CHAT']
};

/** A model imported from `raw`, as the import dialog configures it. */
function imported(raw, overrides = {}) {
  const entry = listed(raw);
  return {
    id: `ifinder-gw-${raw.id}`,
    modelId: raw.id,
    name: { en: raw.id },
    description: { en: 'Imported' },
    url: entry.url,
    provider: entry.modelProvider,
    providerId: 'ifinder-gw',
    enabled: true,
    contextWindow: entry.contextWindow,
    ...overrides
  };
}

function drift(models, entries) {
  return computeGatewayDrift({ provider, models, entries, modelsUrl: MODELS_URL });
}

test('nothing is reported when the imported models match the gateway', () => {
  const items = drift([imported(CHAT), imported(MISTRAL)], [listed(CHAT), listed(MISTRAL)]);
  assert.deepEqual(items, []);
});

test('a listed model nobody imported is added with the config to create', () => {
  const items = drift([], [listed(CHAT)]);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, 'added');
  assert.equal(item.remoteId, 'qwen3-vl');
  assert.deepEqual(
    {
      id: item.model.id,
      modelId: item.model.modelId,
      provider: item.model.provider,
      providerId: item.model.providerId,
      url: item.model.url,
      contextWindow: item.model.contextWindow,
      enabled: item.model.enabled
    },
    {
      id: 'ifinder-gw-qwen3-vl',
      modelId: 'qwen3-vl',
      provider: 'openai',
      providerId: 'ifinder-gw',
      url: `${PROXY}/chat/completions`,
      contextWindow: 32768,
      enabled: true
    }
  );
  assert.equal(item.model.supportsTools, 'none', 'the gateway has no tool calling yet');
});

test('an added model gets an id nothing else has', () => {
  const taken = { ...imported(CHAT), id: 'ifinder-gw-new-model', modelId: 'other', providerId: '' };
  delete taken.providerId;
  const entries = [
    listed({ ...CHAT, id: 'new-model' }),
    listed({ ...CHAT, id: 'New Model' }) // slugs to the same id
  ];
  const ids = drift([taken], entries).map(item => item.model.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every(id => id !== 'ifinder-gw-new-model'));
  assert.ok(ids.every(id => /^[a-z0-9._-]+$/.test(id)));
});

test('a Mistral-dialect model is added on the mistral adapter', () => {
  const [item] = drift([], [listed(MISTRAL)]);
  assert.equal(item.model.provider, 'mistral');
});

test('models iHub cannot run are not added', () => {
  const entries = [
    listed({ id: 'e5', api_type: 'OPENAI', endpoints: ['EMBEDDING'] }),
    listed({ id: 'ner', api_type: 'OPENAI', endpoints: ['NER'] }),
    listed({ id: 'azure-rt', api_type: 'AZURE_OPENAI', endpoints: ['REALTIME'] })
  ];
  assert.deepEqual(drift([], entries), []);
});

test('a realtime model is added as a transcription model', () => {
  const [item] = drift(
    [],
    [listed({ id: 'voxtral', api_type: 'OPENAI', endpoints: ['REALTIME'] })]
  );
  assert.equal(item.kind, 'added');
  assert.equal(item.model.modelType, 'transcription');
  assert.equal(item.model.provider, 'vllm-realtime');
  assert.match(item.model.url, /^wss:\/\/.*\/realtime\?model=voxtral$/);
});

test('a model configured by hand for the same endpoint counts as imported', () => {
  const byHand = {
    id: 'my-qwen',
    modelId: 'qwen3-vl',
    url: `${PROXY}/chat/completions/`,
    provider: 'openai'
  };
  assert.deepEqual(drift([byHand], [listed(CHAT)]), []);
});

test('a changed context window, vision support, URL or dialect is reported per field', () => {
  const entry = listed({ ...CHAT, max_model_len: 65536, modalities: ['VISION'] });
  const model = imported(CHAT, { url: 'https://gw.example.com:9614/old/chat/completions' });
  const [item] = drift([model], [entry]);
  assert.equal(item.kind, 'changed');
  assert.equal(item.modelId, 'ifinder-gw-qwen3-vl');
  assert.deepEqual(
    item.changes.sort((a, b) => a.field.localeCompare(b.field)),
    [
      { field: 'contextWindow', from: 32768, to: 65536 },
      { field: 'supportsVision', from: false, to: true },
      {
        field: 'url',
        from: 'https://gw.example.com:9614/old/chat/completions',
        to: `${PROXY}/chat/completions`
      }
    ]
  );

  const moved = drift([imported(MISTRAL, { provider: 'openai' })], [listed(MISTRAL)]);
  assert.deepEqual(moved[0].changes, [{ field: 'provider', from: 'openai', to: 'mistral' }]);
});

test('vision the gateway no longer reports is a change too', () => {
  const [item] = drift([imported(CHAT, { supportsVision: true })], [listed(CHAT)]);
  assert.deepEqual(item.changes, [{ field: 'supportsVision', from: true, to: false }]);
});

test('an OpenAI-dialect model on the vLLM adapter is not drift', () => {
  assert.deepEqual(drift([imported(CHAT, { provider: 'local' })], [listed(CHAT)]), []);
  assert.deepEqual(drift([imported(CHAT)], [listed(CHAT, 'local')]), []);
});

test('an unreported context window leaves the admin setting alone', () => {
  const noWindow = listed({ id: 'qwen3-vl', api_type: 'OPENAI', endpoints: ['CHAT'] });
  assert.deepEqual(drift([imported(CHAT, { contextWindow: 8000 })], [noWindow]), []);
});

test('an enabled model the gateway dropped is removed; a disabled one is left alone', () => {
  const gone = imported(MISTRAL);
  const off = imported(CHAT, { enabled: false });
  const items = drift([gone, off], []);
  assert.deepEqual(items, [
    { kind: 'removed', remoteId: 'mistral-large-3', modelId: gone.id, reason: 'missing' }
  ]);
});

test('a model the gateway now lists as something iHub cannot run is removed as unsupported', () => {
  const embeddingNow = listed({ id: 'qwen3-vl', api_type: 'OPENAI', endpoints: ['EMBEDDING'] });
  const items = drift([imported(CHAT)], [embeddingNow]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'removed');
  assert.equal(items[0].reason, 'unsupported');
});

test('a chat model the gateway now lists as realtime-only is removed as unsupported', () => {
  const asSpeech = listed({ id: 'qwen3-vl', api_type: 'OPENAI', endpoints: ['REALTIME'] });
  const [item] = drift([imported(CHAT)], [asSpeech]);
  assert.equal(item.kind, 'removed');
  assert.equal(item.reason, 'unsupported');
});

test('models of other providers are never touched', () => {
  const other = { ...imported(CHAT), id: 'other-qwen', providerId: 'llmhub' };
  const items = drift([other], [listed(MISTRAL)]);
  assert.deepEqual(
    items.map(item => [item.kind, item.remoteId]),
    [['added', 'mistral-large-3']]
  );
});

test('items come out changed, added, removed, each by remote id', () => {
  const models = [
    imported(CHAT, { contextWindow: 1 }),
    imported({ ...MISTRAL, id: 'zz-gone' }),
    imported({ ...MISTRAL, id: 'aa-gone' })
  ];
  const items = drift(models, [listed(CHAT), listed({ ...MISTRAL, id: 'new-one' })]);
  assert.deepEqual(
    items.map(item => `${item.kind}:${item.remoteId}`),
    ['changed:qwen3-vl', 'added:new-one', 'removed:aa-gone', 'removed:zz-gone']
  );
});

test('a clone of an imported model is reported on its own', () => {
  const original = imported(CHAT, { contextWindow: 1 });
  const clone = { ...original, id: 'ifinder-gw-qwen3-vl-copy' }; // Clone keeps modelId and provider
  const changed = drift([original, clone], [listed(CHAT)]);
  assert.deepEqual(
    changed.map(item => [item.kind, item.modelId]),
    [
      ['changed', 'ifinder-gw-qwen3-vl'],
      ['changed', 'ifinder-gw-qwen3-vl-copy']
    ]
  );

  const gone = drift([original, clone], []);
  assert.deepEqual(
    gone.map(item => [item.kind, item.modelId]),
    [
      ['removed', 'ifinder-gw-qwen3-vl'],
      ['removed', 'ifinder-gw-qwen3-vl-copy']
    ]
  );
});
