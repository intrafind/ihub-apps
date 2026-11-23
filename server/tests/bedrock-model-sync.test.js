// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Sync models" for the AWS Bedrock provider. Bedrock lists its models per region
 * and they have no URL, so the comparison reads the listing of one region and
 * looks only at the linked models of that region. The listing comes from the real
 * `discoverBedrockModels` with a stand-in for the AWS control plane.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverBedrockModels } from '../services/BedrockModelDiscovery.js';
import { computeGatewayDrift } from '../services/gatewayDrift.js';
import { buildImportedModelConfig } from '../../shared/modelImportConfig.js';
import { getLinkedModels, supportsModelSync } from '../../shared/llmProviders.js';

const provider = { id: 'bedrock', name: { en: 'AWS Bedrock' }, config: { region: 'eu-central-1' } };
const ARN = id => `arn:aws:bedrock:eu-central-1::foundation-model/${id}`;
const SONNET = 'anthropic.claude-sonnet-4-20250514-v1:0';

const FOUNDATION_MODELS = {
  modelSummaries: [
    {
      modelId: SONNET,
      modelName: 'Claude Sonnet 4',
      providerName: 'Anthropic',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['INFERENCE_PROFILE']
    },
    {
      modelId: 'mistral.mistral-large-2402-v1:0',
      modelName: 'Mistral Large (24.02)',
      providerName: 'Mistral AI',
      inputModalities: ['TEXT'],
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['ON_DEMAND']
    },
    {
      modelId: 'amazon.titan-embed-text-v2:0',
      modelName: 'Titan Text Embeddings V2',
      providerName: 'Amazon',
      inputModalities: ['TEXT'],
      outputModalities: ['EMBEDDING'],
      inferenceTypesSupported: ['ON_DEMAND']
    }
  ]
};

const PROFILES = {
  inferenceProfileSummaries: [
    {
      inferenceProfileId: `eu.${SONNET}`,
      inferenceProfileName: 'EU Claude Sonnet 4',
      status: 'ACTIVE',
      type: 'SYSTEM_DEFINED',
      models: [{ modelArn: ARN(SONNET) }]
    }
  ]
};

function jsonResponse(body) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

const fetch = async url =>
  jsonResponse(url.includes('/inference-profiles') ? PROFILES : FOUNDATION_MODELS);

async function listing(region = 'eu-central-1') {
  return discoverBedrockModels({ region, apiKey: 'k' }, { fetch });
}

/** A model imported from the listing of `region`, as the wizard stores it. */
function imported(entry, region, overrides = {}) {
  return {
    ...buildImportedModelConfig(entry, {
      id: `bedrock-${entry.id.replace(/[^a-z0-9-]/gi, '-')}`,
      apiType: 'bedrock',
      providerId: 'bedrock',
      region
    }),
    ...overrides
  };
}

const drift = (models, result) =>
  computeGatewayDrift({
    provider,
    models,
    entries: result.models,
    modelsUrl: result.modelsUrl,
    region: result.region
  });

const byId = (result, id) => result.models.find(entry => entry.id === id);

test('the AWS Bedrock provider offers model sync', () => {
  assert.equal(supportsModelSync(provider), true);
  assert.equal(supportsModelSync({ id: 'mistral' }), false);
});

test('a listed Bedrock chat model nobody imported is added with the listing region; embeddings are not', async () => {
  const result = await listing();
  const items = drift([], result);
  const added = items.filter(item => item.kind === 'added');
  assert.deepEqual(added.map(item => item.remoteId).sort(), [
    `eu.${SONNET}`,
    'mistral.mistral-large-2402-v1:0'
  ]);
  for (const item of added) {
    // The built-in Bedrock provider links its models by their API type, without `providerId`.
    assert.equal(item.model.provider, 'bedrock');
    assert.deepEqual(getLinkedModels('bedrock', [item.model]), [item.model]);
    assert.deepEqual(item.model.config, { region: 'eu-central-1' });
    assert.equal(item.model.url, undefined, 'a Bedrock model has no URL');
  }
});

test('an imported model of the region is not offered again and has no URL drift', async () => {
  const result = await listing();
  const models = [
    imported(byId(result, `eu.${SONNET}`), 'eu-central-1'),
    imported(byId(result, 'mistral.mistral-large-2402-v1:0'), 'eu-central-1')
  ];
  assert.deepEqual(drift(models, result), []);
});

test('a model without its own region counts as the listing region', async () => {
  const result = await listing();
  const entry = byId(result, 'mistral.mistral-large-2402-v1:0');
  const model = imported(entry, 'eu-central-1');
  delete model.config;
  const items = drift([model], result);
  assert.equal(
    items.some(item => item.remoteId === entry.id),
    false,
    'neither offered again nor changed'
  );
});

test('a model of another region is neither changed, nor gone, nor counted as imported', async () => {
  const result = await listing();
  const usSonnet = imported({ ...byId(result, `eu.${SONNET}`), id: `us.${SONNET}` }, 'us-east-1', {
    supportsVision: false
  });
  const euMistralInUs = imported(byId(result, 'mistral.mistral-large-2402-v1:0'), 'us-east-1');
  const items = drift([usSonnet, euMistralInUs], result);
  assert.equal(
    items.some(item => item.modelId === usSonnet.id || item.modelId === euMistralInUs.id),
    false
  );
  // The us-east-1 copy of Mistral does not make the eu-central-1 one imported.
  assert.ok(
    items.some(item => item.kind === 'added' && item.remoteId === 'mistral.mistral-large-2402-v1:0')
  );
});

test('a changed image input is reported for a model of the region', async () => {
  const result = await listing();
  const model = imported(byId(result, `eu.${SONNET}`), 'eu-central-1', { supportsVision: false });
  const items = drift([model], result);
  const changed = items.find(item => item.kind === 'changed');
  assert.ok(changed, JSON.stringify(items));
  assert.deepEqual(
    changed.changes.map(change => change.field),
    ['supportsVision']
  );
});

test('a model missing from the Bedrock listing is never reported as gone', async () => {
  const result = await listing();
  const custom = imported(
    {
      ...byId(result, 'mistral.mistral-large-2402-v1:0'),
      id: 'arn:aws:bedrock:eu-central-1:1:application-inference-profile/abc'
    },
    'eu-central-1',
    { id: 'bedrock-app-profile' }
  );
  const items = drift([custom], result);
  assert.equal(
    items.some(item => item.modelId === 'bedrock-app-profile'),
    false
  );
});

test('a model configured by hand for the region with the same id counts as imported', async () => {
  const result = await listing();
  const byHand = {
    id: 'my-mistral',
    modelId: 'mistral.mistral-large-2402-v1:0',
    provider: 'bedrock',
    config: { region: 'eu-central-1' },
    name: { en: 'Mistral' }
  };
  const items = drift([byHand], result);
  assert.equal(
    items.some(item => item.kind === 'added' && item.remoteId === byHand.modelId),
    false
  );
});
