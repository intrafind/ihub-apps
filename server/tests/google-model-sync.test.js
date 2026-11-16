// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Importing and syncing the models of a Google provider, from the listing the
 * Gemini API returns to the model configs written (EU AI Act Art. 50(2)).
 *
 * What has to hold:
 *   - a Gemini model is imported with the marking Google declares for its
 *     output (SynthID); an image model also as an image generator;
 *   - a model imported before is updated to match: the sync offers the marking a
 *     model does not declare yet, and keeps one an admin chose;
 *   - what the Google listing does not say is not drift: image input, tool
 *     support, the adapter, and speech models (text-to-speech) that iHub runs;
 *   - a model Google no longer lists is offered for disabling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels } from '../services/ModelEndpointDiscovery.js';
import { computeGatewayDrift } from '../services/gatewayDrift.js';
import { applyGatewayDrift, itemKey } from '../services/gatewaySyncApply.js';
import { GOOGLE_SYNTHID_STATEMENT_REF } from '../services/provenance/providerMarking.js';
import { buildImportedModelConfig } from '../../shared/modelImportConfig.js';
import { supportsModelSync } from '../../shared/llmProviders.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS_URL = `${BASE}/models`;

const provider = { id: 'google', name: 'Google', description: 'Gemini API', baseUrl: BASE };

const LISTING = {
  models: [
    {
      name: 'models/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens']
    },
    {
      name: 'models/gemini-3-pro-image-preview',
      displayName: 'Nano Banana Pro',
      inputTokenLimit: 131072,
      outputTokenLimit: 32768,
      supportedGenerationMethods: ['generateContent', 'countTokens']
    },
    {
      name: 'models/gemini-3.8-flash-tts',
      displayName: 'Gemini 3.8 Flash TTS',
      supportedGenerationMethods: ['generateContent', 'countTokens']
    },
    {
      name: 'models/gemma-3-27b-it',
      displayName: 'Gemma 3 27B',
      inputTokenLimit: 131072,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ['generateContent']
    },
    {
      name: 'models/gemini-embedding-001',
      supportedGenerationMethods: ['embedContent']
    }
  ]
};

const SYNTHID = { by: 'provider', scheme: 'synthid', statementRef: GOOGLE_SYNTHID_STATEMENT_REF };

async function listing(body = LISTING) {
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  });
  return (await discoverModels({ url: BASE, provider: 'google', apiKey: 'k' }, { fetch })).models;
}

function drift(models, entries) {
  return computeGatewayDrift({ provider, models, entries, modelsUrl: MODELS_URL });
}

/** A model imported before this feature: the config the dialog used to build. */
function importedEarlier(entry, overrides = {}) {
  const config = buildImportedModelConfig(
    { ...entry, contentMarking: undefined, supportsImageGeneration: undefined },
    { id: `google-${entry.id}`, apiType: 'google', providerId: 'google', modelsUrl: MODELS_URL }
  );
  return { ...config, ...overrides };
}

test('a Google provider is one whose models can be synced; another API type is not', () => {
  assert.equal(supportsModelSync(provider), true);
  assert.equal(
    supportsModelSync({ ...provider, id: 'my-gemini', category: 'llm', apiType: 'google' }),
    true
  );
  assert.equal(supportsModelSync({ id: 'openai' }), false);
  assert.equal(supportsModelSync({ id: 'llmhub', category: 'llm', apiType: 'openai' }), false);
});

test('an import of a Gemini model declares the SynthID marking of its output', async () => {
  const entries = await listing();
  const flash = entries.find(e => e.id === 'gemini-2.5-flash');
  const config = buildImportedModelConfig(flash, {
    id: 'google-gemini-2.5-flash',
    apiType: 'google',
    providerId: 'google',
    modelsUrl: MODELS_URL
  });
  assert.deepEqual(config.contentMarking, { text: SYNTHID });
  assert.equal(config.supportsImageGeneration, undefined);
  assert.equal(config.provider, 'google');
});

test('an import of a Gemini image model also declares image marking and generation', async () => {
  const entries = await listing();
  const image = entries.find(e => e.id === 'gemini-3-pro-image-preview');
  const config = buildImportedModelConfig(image, {
    id: 'google-nano-banana-pro',
    apiType: 'google',
    providerId: 'google',
    modelsUrl: MODELS_URL
  });
  assert.deepEqual(config.contentMarking, { text: SYNTHID, image: SYNTHID });
  assert.equal(config.supportsImageGeneration, true);
});

test('nothing is declared for Gemma, speech or embeddings', async () => {
  const entries = await listing();
  for (const id of ['gemma-3-27b-it', 'gemini-3.8-flash-tts', 'gemini-embedding-001']) {
    const entry = entries.find(e => e.id === id);
    const config = buildImportedModelConfig(entry, {
      id: `google-${id}`,
      apiType: 'google',
      providerId: 'google',
      modelsUrl: MODELS_URL
    });
    assert.equal(config.contentMarking, undefined, id);
  }
});

test('two models imported from one listing do not share a marking object', async () => {
  const entries = await listing();
  const [a, b] = ['gemini-2.5-flash', 'gemini-3-pro-image-preview'].map(id =>
    buildImportedModelConfig(
      entries.find(e => e.id === id),
      {
        id: `google-${id}`,
        apiType: 'google',
        providerId: 'google',
        modelsUrl: MODELS_URL
      }
    )
  );
  a.contentMarking.text.scheme = 'changed';
  assert.equal(b.contentMarking.text.scheme, 'synthid');
});

test('a model imported before is offered the marking; nothing else is reported as drift', async () => {
  const entries = await listing();
  const flash = entries.find(e => e.id === 'gemini-2.5-flash');
  const tts = entries.find(e => e.id === 'gemini-3.8-flash-tts');
  const models = [
    // Migration V243 gave every chat model an explicit "none".
    importedEarlier(flash, {
      supportsVision: true,
      supportsTools: 'auto',
      contentMarking: { text: { by: 'none' } }
    }),
    importedEarlier(tts)
  ];

  const items = drift(models, entries).filter(item => item.kind !== 'added');
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].kind, 'changed');
  assert.equal(items[0].modelId, 'google-gemini-2.5-flash');
  assert.deepEqual(items[0].changes, [
    { field: 'contentMarking', from: { text: { by: 'none' } }, to: { text: SYNTHID } }
  ]);
});

test('a model with image input and a provider listing that does not report it is not drift', async () => {
  const entries = await listing();
  const flash = entries.find(e => e.id === 'gemini-2.5-flash');
  const models = [
    importedEarlier(flash, { supportsVision: true, contentMarking: { text: SYNTHID } })
  ];
  assert.deepEqual(
    drift(models, entries).filter(item => item.kind === 'changed'),
    []
  );
});

test('a marking an admin entered is kept, and a changed window is still reported', async () => {
  const entries = await listing();
  const flash = entries.find(e => e.id === 'gemini-2.5-flash');
  const own = { by: 'provider', scheme: 'synthid', statementRef: 'Contract 4711, annex 3' };
  const models = [importedEarlier(flash, { contextWindow: 32000, contentMarking: { text: own } })];
  const [item] = drift(models, entries).filter(i => i.kind === 'changed');
  assert.deepEqual(item.changes, [{ field: 'contextWindow', from: 32000, to: 1048576 }]);
});

test('an image marking is offered to a model that generates images, not to one that does not', async () => {
  const entries = await listing();
  const image = entries.find(e => e.id === 'gemini-3-pro-image-preview');
  const generator = importedEarlier(image, {
    id: 'google-nano-banana-pro',
    supportsImageGeneration: true,
    contentMarking: { text: SYNTHID }
  });
  const chatOnly = importedEarlier(image, {
    id: 'google-nano-banana-chat',
    contentMarking: { text: SYNTHID }
  });
  const changed = drift([generator, chatOnly], entries).filter(i => i.kind === 'changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].modelId, 'google-nano-banana-pro');
  assert.deepEqual(changed[0].changes, [
    {
      field: 'contentMarking',
      from: { text: SYNTHID },
      to: { text: SYNTHID, image: SYNTHID }
    }
  ]);
});

test('a model Google no longer lists is offered for disabling; a disabled one is left alone', async () => {
  const entries = await listing();
  const flash = entries.find(e => e.id === 'gemini-2.5-flash');
  const retired = importedEarlier(
    { ...flash, id: 'gemini-1.5-pro', url: `${BASE}/models/gemini-1.5-pro:streamGenerateContent` },
    { contentMarking: { text: SYNTHID } }
  );
  const disabled = { ...retired, id: 'google-old', modelId: 'gemini-1.0-pro', enabled: false };
  const items = drift([retired, disabled], entries).filter(i => i.kind === 'removed');
  assert.deepEqual(
    items.map(i => [i.modelId, i.reason]),
    [['google-gemini-1.5-pro', 'missing']]
  );
});

test('a listed Gemini model nobody imported is added with its marking; Gemma carries none', async () => {
  const entries = await listing();
  const added = drift([], entries).filter(i => i.kind === 'added');
  const byRemote = Object.fromEntries(added.map(i => [i.remoteId, i.model]));
  assert.deepEqual(byRemote['gemini-2.5-flash'].contentMarking, { text: SYNTHID });
  assert.deepEqual(byRemote['gemini-3-pro-image-preview'].contentMarking, {
    text: SYNTHID,
    image: SYNTHID
  });
  assert.equal(byRemote['gemma-3-27b-it'].contentMarking, undefined);
  // Embeddings cannot be run by iHub: never offered.
  assert.equal(byRemote['gemini-embedding-001'], undefined);
  // A text-to-speech model is offered, as a speech model.
  assert.equal(byRemote['gemini-3.8-flash-tts'].modelType, 'tts');
});

test('applying a pick writes the marking to the stored model and keeps its other fields', async () => {
  const entries = await listing();
  const flash = entries.find(e => e.id === 'gemini-2.5-flash');
  const model = importedEarlier(flash, {
    description: { en: 'My own description' },
    contentMarking: { text: { by: 'none' } }
  });
  const items = drift([model], entries).filter(i => i.kind === 'changed');
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
    results.map(r => [itemKey(r), r.status]),
    [['changed:google-gemini-2.5-flash', 'applied']]
  );
  const stored = files.get(model.id);
  assert.deepEqual(stored.contentMarking, { text: SYNTHID });
  assert.deepEqual(stored.description, { en: 'My own description' });
  assert.equal(stored.enabled, true);
});
