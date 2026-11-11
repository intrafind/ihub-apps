// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `planTextWatermark` (#3331): the server-owned decision to mark a text request.
 */
import { describe, test, expect } from '@jest/globals';
import {
  planTextWatermark,
  combinePlans,
  isGreedy
} from '../services/provenance/watermark/watermarkPlan.js';

const ihub = (extra = {}) => ({
  provider: 'local',
  contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } },
  ...extra
});

describe('planTextWatermark', () => {
  test('is null unless the model is marked by iHub', () => {
    expect(planTextWatermark({ provider: 'local' }, {}, {}, 'wm-2026-1')).toBeNull();
    expect(
      planTextWatermark(
        { provider: 'local', contentMarking: { text: { by: 'provider' } } },
        {},
        {},
        'wm-2026-1'
      )
    ).toBeNull();
    expect(
      planTextWatermark(
        { provider: 'local', contentMarking: { text: { by: 'none' } } },
        {},
        {},
        'wm-2026-1'
      )
    ).toBeNull();
  });

  test('never plans for a hosted provider, even if the file says ihub', () => {
    for (const provider of ['anthropic', 'google', 'mistral', 'bedrock']) {
      expect(planTextWatermark(ihub({ provider }), {}, {}, 'wm-2026-1')).toBeNull();
    }
  });

  test('applied with the active key id for a sampled request; openai pointed at vLLM too', () => {
    for (const provider of ['local', 'openai']) {
      expect(planTextWatermark(ihub({ provider }), { temperature: 0.7 }, {}, 'wm-2026-1')).toEqual({
        by: 'ihub',
        scheme: 'vllm-gumbel',
        applied: true,
        keyId: 'wm-2026-1'
      });
    }
    // An unset temperature is not greedy as far as iHub can see.
    expect(planTextWatermark(ihub(), {}, {}, 'wm-2026-1').applied).toBe(true);
  });

  test.each([
    ['temperature 0', { temperature: 0 }],
    ['temperature 1e-6', { temperature: 1e-6 }],
    ['topK 1', { topK: 1 }]
  ])('greedy (%s) is not claimed', (_name, sampling) => {
    expect(isGreedy(sampling)).toBe(true);
    const plan = planTextWatermark(ihub(), sampling, {}, 'wm-2026-1');
    expect(plan).toMatchObject({ applied: false, reason: 'greedy' });
    expect(plan.keyId).toBeUndefined();
  });

  test('a model that ignores sampling parameters is not claimed greedy', () => {
    // resolveSampling returns {} when supportsTemperature is false
    expect(
      planTextWatermark(ihub({ supportsTemperature: false }), {}, {}, 'wm-2026-1').applied
    ).toBe(true);
  });

  test('structured output and a missing key are not claimed', () => {
    expect(
      planTextWatermark(ihub(), {}, { responseSchema: { type: 'object' } }, 'k')
    ).toMatchObject({
      applied: false,
      reason: 'structured_output'
    });
    expect(planTextWatermark(ihub(), {}, { responseFormat: 'json' }, 'k')).toMatchObject({
      reason: 'structured_output'
    });
    expect(planTextWatermark(ihub(), {}, {}, null)).toMatchObject({
      applied: false,
      reason: 'no_active_key'
    });
  });
});

describe('combinePlans', () => {
  const ok = { by: 'ihub', applied: true, keyId: 'k' };
  const bad = { by: 'ihub', applied: false, reason: 'greedy' };
  test('a turn is applied only if every text step was', () => {
    expect(combinePlans([ok, ok])).toBe(ok);
    expect(combinePlans([ok, bad, ok])).toBe(bad);
    expect(combinePlans([null, undefined])).toBeNull();
  });
});
