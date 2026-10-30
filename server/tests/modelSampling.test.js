// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sampling parameters come from the model config only (issue #2883).
 *
 * Apps, prompts, workflows and agents carry no temperature, so a request
 * carries `temperature` / `top_p` / `top_k` only when `model.sampling` sets
 * them. Whatever a caller passes in the call options is ignored, and a model
 * with `supportsTemperature: false` never gets any of them.
 *
 * Run with: node --test server/tests/modelSampling.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Through the registry: openai.js pulls in ModelDiscoveryService, which imports
// the registry, so loading the adapter file first trips a circular import.
import { getAdapter } from '../adapters/index.js';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';

const messages = [{ role: 'user', content: 'test' }];
const sampling = { temperature: 0.6, topP: 0.8, topK: 20 };

/** Provider → model config, request body keys for each sampling parameter. */
const CASES = [
  {
    provider: 'openai',
    model: { modelId: 'gpt-4', url: 'https://api.openai.com/v1/chat/completions' },
    read: body => ({ temperature: body.temperature, topP: body.top_p, topK: body.top_k }),
    sends: ['temperature', 'topP']
  },
  {
    provider: 'local',
    model: { modelId: 'qwen', url: 'http://localhost:8000/v1/chat/completions' },
    read: body => ({ temperature: body.temperature, topP: body.top_p, topK: body.top_k }),
    sends: ['temperature', 'topP', 'topK']
  },
  {
    provider: 'mistral',
    model: { modelId: 'mistral-small', url: 'https://api.mistral.ai/v1/chat/completions' },
    read: body => ({ temperature: body.temperature, topP: body.top_p, topK: body.top_k }),
    sends: ['temperature', 'topP']
  },
  {
    provider: 'anthropic',
    model: { modelId: 'claude-sonnet-4', url: 'https://api.anthropic.com/v1/messages' },
    read: body => ({ temperature: body.temperature, topP: body.top_p, topK: body.top_k }),
    sends: ['temperature', 'topP', 'topK']
  },
  {
    provider: 'google',
    model: {
      modelId: 'gemini-flash',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:streamGenerateContent'
    },
    read: body => ({
      temperature: body.generationConfig.temperature,
      topP: body.generationConfig.topP,
      topK: body.generationConfig.topK
    }),
    sends: ['temperature', 'topP', 'topK']
  },
  {
    provider: 'bedrock',
    model: { modelId: 'anthropic.claude-sonnet-4', config: { region: 'eu-central-1' } },
    read: body => ({
      temperature: body.inferenceConfig.temperature,
      topP: body.inferenceConfig.topP,
      topK: undefined
    }),
    sends: ['temperature', 'topP']
  }
];

const request = (provider, model, options = {}) =>
  getAdapter(provider).createCompletionRequest({ ...model, provider }, messages, 'key', options);

for (const { provider, model, read, sends } of CASES) {
  describe(`${provider} adapter sampling`, () => {
    it('sends no sampling parameter when the model sets none, whatever the caller passes', async () => {
      const { body } = await request(provider, model, { temperature: 0.4, topP: 0.5 });
      assert.deepEqual(read(body), { temperature: undefined, topP: undefined, topK: undefined });
    });

    it('sends what the model config sets, and only what the provider accepts', async () => {
      const { body } = await request(provider, { ...model, sampling });
      const sent = read(body);
      for (const key of ['temperature', 'topP', 'topK']) {
        assert.equal(sent[key], sends.includes(key) ? sampling[key] : undefined, key);
      }
    });

    it('sends only the keys that are set', async () => {
      const { body } = await request(provider, { ...model, sampling: { temperature: 0 } });
      assert.equal(read(body).temperature, 0, 'a temperature of 0 is a value, not "unset"');
      assert.equal(read(body).topP, undefined);
    });

    it('ignores sampling for a model that rejects it', async () => {
      const { body } = await request(provider, { ...model, sampling, supportsTemperature: false });
      assert.deepEqual(read(body), { temperature: undefined, topP: undefined, topK: undefined });
    });

    it('never serializes an unset parameter as null', async () => {
      const { body } = await request(provider, model);
      assert.ok(!JSON.stringify(body).includes('"temperature":null'));
    });
  });
}

describe('openai-responses adapter', () => {
  it('sends no sampling parameter, even when the model config sets some', async () => {
    const { body } = await request(
      'openai-responses',
      { modelId: 'gpt-5', url: 'https://api.openai.com/v1/responses', sampling },
      { temperature: 0.4 }
    );
    for (const key of ['temperature', 'top_p', 'top_k']) assert.ok(!(key in body), key);
  });
});

describe('modelConfigSchema sampling', () => {
  const base = {
    id: 'm',
    modelId: 'm',
    name: { en: 'M' },
    description: { en: 'M' },
    url: 'https://example.com/v1/chat/completions',
    provider: 'openai'
  };

  it('is optional', () => {
    assert.equal(modelConfigSchema.parse(base).sampling, undefined);
  });

  it('accepts temperature, topP and topK, each optional', () => {
    assert.deepEqual(modelConfigSchema.parse({ ...base, sampling }).sampling, sampling);
    assert.deepEqual(modelConfigSchema.parse({ ...base, sampling: {} }).sampling, {});
    assert.deepEqual(modelConfigSchema.parse({ ...base, sampling: { topP: 1 } }).sampling, {
      topP: 1
    });
  });

  it('rejects out-of-range and unknown values', () => {
    for (const bad of [
      { temperature: 2.1 },
      { temperature: -0.1 },
      { topP: 1.1 },
      { topK: 0 },
      { topK: 1.5 },
      { frequencyPenalty: 0.5 }
    ]) {
      assert.equal(
        modelConfigSchema.safeParse({ ...base, sampling: bad }).success,
        false,
        JSON.stringify(bad)
      );
    }
  });
});
