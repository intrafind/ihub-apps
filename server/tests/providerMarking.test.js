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
  for (const apiType of ['openai', 'anthropic', 'mistral', 'local', 'openai-responses']) {
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
