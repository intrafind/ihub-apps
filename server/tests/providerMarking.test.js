// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a provider declares about marking its models' output, applied to an
 * import (EU AI Act Art. 50(2)).
 *
 * What has to hold:
 *   - a Gemini chat model is declared marked by Google (SynthID) for text; a
 *     Gemini image model also for images and as an image generator;
 *   - nothing is declared for what is not Gemini output: Gemma and other open
 *     models, embeddings, speech, Imagen (which iHub cannot run), or any other
 *     provider;
 *   - every declaration is a fresh object, so models imported together do not
 *     share one;
 *   - the declaration passes the model schema as it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_MARKED_MODELS,
  ANTHROPIC_WATERMARK_STATEMENT_REF,
  GOOGLE_SYNTHID_STATEMENT_REF,
  providerMarkingFacts
} from '../services/provenance/providerMarking.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';

const SYNTHID = { by: 'provider', scheme: 'synthid', statementRef: GOOGLE_SYNTHID_STATEMENT_REF };

test('a Gemini chat model is declared SynthID-marked for text only', () => {
  assert.deepEqual(providerMarkingFacts('google', { id: 'gemini-2.5-flash', type: 'chat' }), {
    contentMarking: { text: SYNTHID }
  });
});

test('a Gemini image model is declared marked for text and images and generates images', () => {
  for (const id of ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-image-x']) {
    assert.deepEqual(
      providerMarkingFacts('google', { id, type: 'chat' }),
      { supportsImageGeneration: true, contentMarking: { text: SYNTHID, image: SYNTHID } },
      id
    );
  }
});

test('"image" inside another word does not make a model an image generator', () => {
  for (const id of ['gemini-2.5-flash-imaging', 'gemini-imagination-1', 'gemini-2.5-pro']) {
    const facts = providerMarkingFacts('google', { id, type: 'chat' });
    assert.equal(facts.supportsImageGeneration, undefined, id);
    assert.equal(facts.contentMarking.image, undefined, id);
  }
});

test('nothing is declared for open models, speech, embeddings or Imagen', () => {
  const cases = [
    { id: 'gemma-3-27b-it', type: 'chat' },
    { id: 'gemini-embedding-001', type: 'embedding' },
    { id: 'gemini-3.8-flash-tts', type: 'tts' },
    { id: 'gemini-3.5-transcribe', type: 'transcription' },
    { id: 'imagen-4.0-generate-001', type: 'image' }
  ];
  for (const entry of cases) {
    assert.deepEqual(providerMarkingFacts('google', entry), {}, entry.id);
  }
});

test('nothing is declared for a provider that makes no claim', () => {
  for (const apiType of ['openai', 'mistral', 'local', 'openai-responses']) {
    assert.deepEqual(providerMarkingFacts(apiType, { id: 'gemini-2.5-flash', type: 'chat' }), {});
  }
});

test('each call returns objects of its own', () => {
  const a = providerMarkingFacts('google', { id: 'gemini-2.5-flash-image', type: 'chat' });
  const b = providerMarkingFacts('google', { id: 'gemini-2.5-flash-image', type: 'chat' });
  a.contentMarking.text.scheme = 'changed';
  a.contentMarking.image.by = 'none';
  assert.equal(b.contentMarking.text.scheme, 'synthid');
  assert.equal(b.contentMarking.image.by, 'provider');
});

test('the declaration is a valid model config as it stands', () => {
  const facts = providerMarkingFacts('google', { id: 'gemini-3-pro-image-preview', type: 'chat' });
  const result = modelConfigSchema.safeParse({
    id: 'google-gemini-3-pro-image-preview',
    modelId: 'gemini-3-pro-image-preview',
    name: { en: 'Nano Banana Pro' },
    description: { en: 'Imported' },
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:streamGenerateContent',
    provider: 'google',
    ...facts
  });
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('the reference names Google’s statement, not a generic claim', () => {
  assert.match(
    GOOGLE_SYNTHID_STATEMENT_REF,
    /^Google DeepMind, SynthID: https:\/\/deepmind\.google\//
  );
  assert.ok(GOOGLE_SYNTHID_STATEMENT_REF.length <= 500, 'fits statementRef');
});

const WATERMARK = {
  by: 'provider',
  scheme: 'synthid-text',
  statementRef: ANTHROPIC_WATERMARK_STATEMENT_REF
};

const FIRST_PARTY = { baseUrl: 'https://api.anthropic.com/v1' };

/** The models Anthropic's page marks for first-party text, as (name, API id). */
const PAGE_LIST = [
  ['Claude Fable 5.2', 'claude-fable-5-2'],
  ['Claude Fable 5.1', 'claude-fable-5-1'],
  ['Claude Fable 5', 'claude-fable-5'],
  ['Claude Mythos 5.2', 'claude-mythos-5-2'],
  ['Claude Mythos 5.1', 'claude-mythos-5-1'],
  ['Claude Mythos 5', 'claude-mythos-5'],
  ['Claude Opus 5.5', 'claude-opus-5-5'],
  ['Claude Opus 5', 'claude-opus-5'],
  ['Claude Opus 4.8', 'claude-opus-4-8'],
  ['Claude Opus 4.7', 'claude-opus-4-7'],
  ['Claude Opus 4.6', 'claude-opus-4-6'],
  ['Claude Opus 4.5', 'claude-opus-4-5'],
  ['Claude Sonnet 5.5', 'claude-sonnet-5-5'],
  ['Claude Sonnet 5', 'claude-sonnet-5'],
  ['Claude Sonnet 4.6', 'claude-sonnet-4-6'],
  ['Claude Sonnet 4.5', 'claude-sonnet-4-5'],
  ['Claude Haiku 5.5', 'claude-haiku-5-5'],
  ['Claude Haiku 4.5', 'claude-haiku-4-5']
];

/** Listed for first-party text only: Anthropic's page has no cloud-partner mark for them. */
const FIRST_PARTY_ONLY = [
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5'
];

test('the list is the one of Anthropic\u2019s page, no more and no less', () => {
  assert.deepEqual(
    ANTHROPIC_MARKED_MODELS.map(m => [m.name, m.id]),
    PAGE_LIST
  );
  assert.deepEqual(
    ANTHROPIC_MARKED_MODELS.filter(m => m.firstPartyOnly).map(m => m.id),
    FIRST_PARTY_ONLY
  );
});

test('every Claude model Anthropic names is declared watermarked for its text on its own API', () => {
  for (const [name, id] of PAGE_LIST) {
    const facts = providerMarkingFacts('anthropic', { id, name, type: 'chat' }, FIRST_PARTY);
    assert.deepEqual(facts.contentMarking, { text: WATERMARK }, id);
  }
});

test('a model before the 4.6 generation is found by its dated snapshot as well', () => {
  const snapshots = [
    'claude-haiku-4-5-20251001',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929'
  ];
  for (const id of snapshots) {
    // By id alone, so a listing without display names still finds it.
    const facts = providerMarkingFacts('anthropic', { id, name: id, type: 'chat' }, FIRST_PARTY);
    assert.deepEqual(facts.contentMarking, { text: WATERMARK }, id);
  }
});

test('four models carry the mark on Anthropic\u2019s own API only, not through a cloud partner', () => {
  const elsewhere = [
    { baseUrl: 'https://my-resource.services.ai.azure.com/anthropic/v1' },
    { baseUrl: 'https://llm-proxy.example.com/v1' },
    { baseUrl: 'not a url' },
    {}
  ];
  for (const [name, id] of PAGE_LIST) {
    const entry = { id, name, type: 'chat' };
    for (const context of elsewhere) {
      const declared = providerMarkingFacts('anthropic', entry, context).contentMarking;
      if (FIRST_PARTY_ONLY.includes(id)) {
        assert.equal(declared, undefined, `${id} via ${context.baseUrl}`);
      } else {
        assert.deepEqual(declared, { text: WATERMARK }, `${id} via ${context.baseUrl}`);
      }
    }
  }
});

test('a Claude model is found by its display name when the id is not the known one', () => {
  const facts = providerMarkingFacts(
    'anthropic',
    { id: 'some-proxy-id', name: 'Claude Opus 5.5', type: 'chat' },
    FIRST_PARTY
  );
  assert.deepEqual(facts.contentMarking, { text: WATERMARK });
});

test('Sonnet 4.6 is declared, and flagged as marked only under default sampling', () => {
  assert.deepEqual(
    providerMarkingFacts(
      'anthropic',
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', type: 'chat' },
      FIRST_PARTY
    ),
    { contentMarking: { text: WATERMARK }, markingNeedsDefaultSampling: true }
  );
  // No other model carries the flag.
  const flagged = ANTHROPIC_MARKED_MODELS.filter(m => m.defaultSamplingOnly);
  assert.deepEqual(
    flagged.map(m => m.id),
    ['claude-sonnet-4-6']
  );
});

test('no claim for a Claude model that is not named, however similar', () => {
  const unnamed = [
    ['claude-opus-4-1-20250805', 'Claude Opus 4.1'],
    ['claude-sonnet-4-20250514', 'Claude Sonnet 4'],
    ['claude-3-7-sonnet-20250219', 'Claude Sonnet 3.7'],
    ['claude-opus-5-5-preview', 'Claude Opus 5.5 Preview'],
    ['claude-opus-4-60', 'Claude Opus 4.60'],
    ['claude-haiku-4-5-2025100', 'Claude Haiku 4.5 (7-digit date)'],
    ['claude-fable-5-3', 'Claude Fable 5.3'],
    ['claude-mythos-6', 'Claude Mythos 6']
  ];
  for (const [id, name] of unnamed) {
    assert.deepEqual(
      providerMarkingFacts('anthropic', { id, name, type: 'chat' }, FIRST_PARTY),
      {},
      id
    );
  }
});

test('Anthropic declares text only: never an image mark or image generation', () => {
  const facts = providerMarkingFacts(
    'anthropic',
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', type: 'chat' },
    FIRST_PARTY
  );
  assert.equal(facts.contentMarking.image, undefined);
  assert.equal(facts.supportsImageGeneration, undefined);
});

test('Mistral declares nothing: it publishes no technical description of a mark', () => {
  const entries = [
    { id: 'mistral-large-latest', name: 'Mistral Large', type: 'chat' },
    { id: 'mistral-small-2603', name: 'Mistral Small', type: 'chat' },
    { id: 'pixtral-large-latest', name: 'Pixtral Large', type: 'chat' },
    { id: 'codestral-latest', name: 'Codestral', type: 'chat' }
  ];
  for (const entry of entries) {
    assert.deepEqual(providerMarkingFacts('mistral', entry), {}, entry.id);
  }
});

test('the Anthropic declaration is a valid model config as it stands', () => {
  const facts = providerMarkingFacts(
    'anthropic',
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', type: 'chat' },
    FIRST_PARTY
  );
  const result = modelConfigSchema.safeParse({
    id: 'anthropic-claude-opus-5-5',
    modelId: 'claude-opus-5-5',
    name: { en: 'Claude Opus 5.5' },
    description: { en: 'Imported' },
    url: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic',
    ...facts
  });
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
  assert.ok(ANTHROPIC_WATERMARK_STATEMENT_REF.length <= 500, 'fits statementRef');
});
