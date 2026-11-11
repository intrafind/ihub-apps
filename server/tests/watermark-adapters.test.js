// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The vLLM and OpenAI adapters add `watermarking: true` only for a model marked
 * `by: "ihub"` (#3331); the plan rides on `request.marking`, off the wire.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import vllm from '../adapters/vllm.js';
import openai from '../adapters/openai.js';
import { setActiveKeyIdSnapshot } from '../services/provenance/watermark/activeKeySnapshot.js';

const messages = [{ role: 'user', content: 'Hello' }];
const base = { url: 'http://vllm.internal/v1/chat/completions', modelId: 'm', id: 'm' };

beforeEach(() => setActiveKeyIdSnapshot('wm-2026-1'));
afterEach(() => setActiveKeyIdSnapshot(null));

for (const [name, adapter, provider] of [
  ['vllm adapter', vllm, 'local'],
  ['openai adapter (pointed at vLLM)', openai, 'openai']
]) {
  describe(name, () => {
    const ihub = {
      ...base,
      provider,
      contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } }
    };

    test('sends watermarking:true and reports the plan for by:"ihub"', async () => {
      const request = await adapter.createCompletionRequest(
        { ...ihub, sampling: { temperature: 0.8 } },
        messages,
        'key',
        { stream: false }
      );
      expect(request.body.watermarking).toBe(true);
      expect(request.marking).toEqual({
        text: { by: 'ihub', scheme: 'vllm-gumbel', applied: true, keyId: 'wm-2026-1' }
      });
      expect(JSON.stringify(request.body)).not.toContain('"marking":');
      expect(JSON.stringify(request.body)).not.toContain('wm-2026-1');
    });

    test('a greedy model still sends the flag but reports applied:false', async () => {
      const request = await adapter.createCompletionRequest(
        { ...ihub, sampling: { temperature: 0 } },
        messages,
        'key',
        { stream: false }
      );
      expect(request.body.watermarking).toBe(true);
      expect(request.marking.text).toMatchObject({ applied: false, reason: 'greedy' });
    });

    test.each([
      ['none', { by: 'none' }],
      ['provider', { by: 'provider' }],
      ['unset', undefined]
    ])('adds nothing for %s', async (_n, text) => {
      const model = { ...base, provider, ...(text ? { contentMarking: { text } } : {}) };
      const request = await adapter.createCompletionRequest(model, messages, 'key', {
        stream: false
      });
      expect('watermarking' in request.body).toBe(false);
      expect(request.marking).toBeUndefined();
    });
  });
}
