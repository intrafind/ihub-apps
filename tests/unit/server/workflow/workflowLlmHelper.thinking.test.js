import { describe, it, expect } from '@jest/globals';
import {
  VALID_ADAPTER_OPTIONS,
  filterAdapterOptions
} from '../../../../server/services/workflow/adapterOptions.js';

describe('workflow adapterOptions — per-node thinking', () => {
  it('includes the thinking keys in the allowlist', () => {
    expect(VALID_ADAPTER_OPTIONS).toEqual(
      expect.arrayContaining([
        'thinkingEnabled',
        'thinkingLevel',
        'thinkingBudget',
        'thinkingThoughts'
      ])
    );
  });

  it('preserves per-node thinking options through the allowlist', () => {
    const filtered = filterAdapterOptions({
      temperature: 0.1,
      maxTokens: 1000,
      thinkingEnabled: false,
      thinkingLevel: 'low',
      thinkingBudget: 512,
      thinkingThoughts: false
    });
    expect(filtered).toMatchObject({
      thinkingEnabled: false,
      thinkingLevel: 'low',
      thinkingBudget: 512,
      thinkingThoughts: false
    });
  });

  it('keeps the original adapter options (temperature, maxTokens, responseSchema)', () => {
    const filtered = filterAdapterOptions({
      temperature: 0.5,
      maxTokens: 2048,
      responseSchema: { type: 'object' }
    });
    expect(filtered).toEqual({
      temperature: 0.5,
      maxTokens: 2048,
      responseSchema: { type: 'object' }
    });
  });

  it('strips unknown options', () => {
    const filtered = filterAdapterOptions({ temperature: 0.5, bogusOption: 'x' });
    expect(filtered).not.toHaveProperty('bogusOption');
    expect(filtered).toHaveProperty('temperature', 0.5);
  });
});
