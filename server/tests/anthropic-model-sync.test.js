// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Importing and syncing the models of an Anthropic provider, from the listing the
 * Claude API returns to the model configs written (EU AI Act Art. 50(2)).
 *
 * What has to hold:
 *   - a Claude model Anthropic names as watermarked is imported with the
 *     declaration; every other Claude model, and every Mistral model, is not;
 *   - a model imported before is offered the declaration, and a marking an
 *     admin entered stays;
 *   - Sonnet 4.6 is not offered it when the model sets a sampling parameter,
 *     because Anthropic says the watermark may not appear then;
 *   - a model configured with an alias (`claude-haiku-4-5`) that the listing names
 *     by its dated snapshot is not reported as gone: absence proves nothing there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels } from '../services/ModelEndpointDiscovery.js';
import { computeGatewayDrift } from '../services/gatewayDrift.js';
import { applyGatewayDrift } from '../services/gatewaySyncApply.js';
import { ANTHROPIC_WATERMARK_STATEMENT_REF } from '../services/provenance/providerMarking.js';
import { buildImportedModelConfig } from '../../shared/modelImportConfig.js';
import { supportsModelSync } from '../../shared/llmProviders.js';

const BASE = 'https://api.anthropic.com/v1';
const MODELS_URL = `${BASE}/models`;
const provider = { id: 'anthropic', name: 'Anthropic', baseUrl: BASE };

const WATERMARK = {
  by: 'provider',
  scheme: 'synthid-text',
  statementRef: ANTHROPIC_WATERMARK_STATEMENT_REF
};

/** One entry of `GET /v1/models`, as Anthropic answers it. */
const listed = (id, display_name) => ({
  type: 'model',
  id,
  display_name,
  created_at: '2026-09-21T00:00:00Z',
  lifecycle: 'active',
  capabilities: { image_input: { supported: true } }
});

const LISTING = {
  data: [
    listed('claude-opus-5-5', 'Claude Opus 5.5'),
    listed('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
    listed('claude-sonnet-4-6', 'Claude Sonnet 4.6'),
    listed('claude-opus-4-6', 'Claude Opus 4.6'),
    // Before the 4.6 generation the listing names the dated snapshot, not the alias.
    listed('claude-haiku-4-5-20251001', 'Claude Haiku 4.5'),
    listed('claude-opus-4-5-20251101', 'Claude Opus 4.5')
  ],
  has_more: false
};

async function entries() {
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(LISTING)
  });
  return (await discoverModels({ url: BASE, provider: 'anthropic', apiKey: 'k' }, { fetch }))
    .models;
}

const drift = (models, list) =>
  computeGatewayDrift({ provider, models, entries: list, modelsUrl: MODELS_URL });

/** A model imported before this feature. */
function importedEarlier(entry, overrides = {}) {
  const config = buildImportedModelConfig(
    { ...entry, contentMarking: undefined },
    {
      id: `anthropic-${entry.id}`,
      apiType: 'anthropic',
      providerId: 'anthropic',
      modelsUrl: MODELS_URL
    }
  );
  return { ...config, ...overrides };
}

test('model sync is offered for Anthropic, not for Mistral or an OpenAI endpoint', () => {
  assert.equal(supportsModelSync(provider), true);
  assert.equal(supportsModelSync({ id: 'my-claude', category: 'llm', apiType: 'anthropic' }), true);
  assert.equal(supportsModelSync({ id: 'mistral' }), false);
  assert.equal(supportsModelSync({ id: 'llmhub', category: 'llm', apiType: 'openai' }), false);
});

test('an import declares the watermark for the Claude models Anthropic names, and only those', async () => {
  const list = await entries();
  const config = id =>
    buildImportedModelConfig(
      list.find(e => e.id === id),
      {
        id: `anthropic-${id}`,
        apiType: 'anthropic',
        providerId: 'anthropic',
        modelsUrl: MODELS_URL
      }
    );

  for (const id of ['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-opus-4-6']) {
    assert.deepEqual(config(id).contentMarking, { text: WATERMARK }, id);
  }
  for (const id of ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101']) {
    assert.equal(config(id).contentMarking, undefined, id);
  }
  // The flag for Sonnet 4.6 is for the sync; it is not written to the model.
  assert.equal(config('claude-sonnet-4-6').markingNeedsDefaultSampling, undefined);
  assert.equal(config('claude-opus-5-5').url, `${BASE}/messages`);
});

test('a model imported before is offered the declaration; nothing else is reported as drift', async () => {
  const list = await entries();
  const opus = list.find(e => e.id === 'claude-opus-5-5');
  const models = [importedEarlier(opus, { contentMarking: { text: { by: 'none' } } })];
  const items = drift(models, list).filter(item => item.kind !== 'added');
  assert.deepEqual(items, [
    {
      kind: 'changed',
      remoteId: 'claude-opus-5-5',
      modelId: 'anthropic-claude-opus-5-5',
      changes: [
        { field: 'contentMarking', from: { text: { by: 'none' } }, to: { text: WATERMARK } }
      ]
    }
  ]);
});

test('a marking an admin entered is kept', async () => {
  const list = await entries();
  const opus = list.find(e => e.id === 'claude-opus-5-5');
  const own = { by: 'provider', scheme: 'synthid-text', statementRef: 'Contract 4711' };
  const models = [importedEarlier(opus, { contentMarking: { text: own } })];
  assert.deepEqual(
    drift(models, list).filter(item => item.kind !== 'added'),
    []
  );
});

test('Sonnet 4.6 is not offered the declaration when the model sets a sampling parameter', async () => {
  const list = await entries();
  const sonnet = list.find(e => e.id === 'claude-sonnet-4-6');
  const changedIds = models =>
    drift(models, list)
      .filter(item => item.kind === 'changed')
      .map(item => item.modelId);

  for (const sampling of [{ temperature: 0.2 }, { topP: 0.9 }, { topK: 40 }, { temperature: 0 }]) {
    assert.deepEqual(
      changedIds([importedEarlier(sonnet, { sampling })]),
      [],
      JSON.stringify(sampling)
    );
  }
  for (const overrides of [{}, { sampling: {} }]) {
    assert.deepEqual(
      changedIds([importedEarlier(sonnet, overrides)]),
      ['anthropic-claude-sonnet-4-6'],
      JSON.stringify(overrides)
    );
  }
  // A model that does not carry the caveat is offered it whatever its sampling.
  const opus = list.find(e => e.id === 'claude-opus-4-6');
  assert.deepEqual(changedIds([importedEarlier(opus, { sampling: { temperature: 0.2 } })]), [
    'anthropic-claude-opus-4-6'
  ]);
});

test('a model configured with an alias the listing does not name is not reported as gone', async () => {
  const list = await entries();
  const haiku = list.find(e => e.id === 'claude-haiku-4-5-20251001');
  // Configured as `claude-haiku-4-5` (the alias), as the marketplace ships it.
  const alias = importedEarlier({ ...haiku, id: 'claude-haiku-4-5' });
  const retired = importedEarlier({ ...haiku, id: 'claude-3-opus-20240229' });
  const items = drift([alias, retired], list);
  assert.deepEqual(
    items.filter(item => item.kind === 'removed'),
    [],
    'absence from an Anthropic listing proves nothing'
  );
});

test('a Claude model nobody imported is added, with the declaration when Anthropic names it', async () => {
  const list = await entries();
  const byRemote = Object.fromEntries(
    drift([], list)
      .filter(item => item.kind === 'added')
      .map(item => [item.remoteId, item.model])
  );
  assert.deepEqual(byRemote['claude-opus-5-5'].contentMarking, { text: WATERMARK });
  assert.equal(byRemote['claude-sonnet-5-5'].contentMarking, undefined);
  assert.equal(byRemote['claude-haiku-4-5-20251001'].contentMarking, undefined);
  assert.equal(byRemote['claude-opus-5-5'].provider, 'anthropic');
});

test('applying a pick writes the declaration to the stored model and keeps its other fields', async () => {
  const list = await entries();
  const opus = list.find(e => e.id === 'claude-opus-5-5');
  const model = importedEarlier(opus, {
    description: { en: 'My own description' },
    contentMarking: { text: { by: 'none' } }
  });
  const items = drift([model], list).filter(item => item.kind === 'changed');
  const files = new Map([[model.id, structuredClone(model)]]);
  const store = {
    read: async id => structuredClone(files.get(id) ?? null),
    write: async (id, value) => void files.set(id, structuredClone(value)),
    audit: async () => {},
    snapshot: async () => {}
  };
  const results = await applyGatewayDrift({
    picks: items.map(({ kind, remoteId, modelId }) => ({ kind, remoteId, modelId })),
    items,
    store
  });
  assert.deepEqual(
    results.map(r => r.status),
    ['applied']
  );
  const stored = files.get(model.id);
  assert.deepEqual(stored.contentMarking, { text: WATERMARK });
  assert.deepEqual(stored.description, { en: 'My own description' });
});

test('Mistral models are imported without any declaration', async () => {
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        data: [
          {
            id: 'mistral-large-2512',
            name: 'mistral-large-2512',
            max_context_length: 262144,
            aliases: ['mistral-large-latest'],
            capabilities: { completion_chat: true, vision: true }
          }
        ]
      })
  });
  const { models } = await discoverModels(
    { url: 'https://api.mistral.ai/v1', provider: 'mistral', apiKey: 'k' },
    { fetch }
  );
  const config = buildImportedModelConfig(models[0], {
    id: 'mistral-large-2512',
    apiType: 'mistral',
    providerId: 'mistral',
    modelsUrl: 'https://api.mistral.ai/v1/models'
  });
  assert.equal(config.contentMarking, undefined);
  assert.equal(config.supportsImageGeneration, undefined);
  assert.equal(config.provider, 'mistral');
});
