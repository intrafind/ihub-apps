import { describe, it, expect } from '@jest/globals';
import { thinkingConfigToOptions } from '../../../../server/services/workflow/thinkingOptions.js';

describe('thinkingConfigToOptions', () => {
  it('returns an empty object when no thinking config is given (no override)', () => {
    expect(thinkingConfigToOptions(undefined)).toEqual({});
    expect(thinkingConfigToOptions(null)).toEqual({});
  });

  it('returns an empty object for non-object values', () => {
    expect(thinkingConfigToOptions('off')).toEqual({});
    expect(thinkingConfigToOptions(true)).toEqual({});
    expect(thinkingConfigToOptions(42)).toEqual({});
  });

  it('maps { enabled: false } to disable thinking for the node', () => {
    expect(thinkingConfigToOptions({ enabled: false })).toEqual({ thinkingEnabled: false });
  });

  it('maps { enabled: true } to enable thinking', () => {
    expect(thinkingConfigToOptions({ enabled: true })).toEqual({ thinkingEnabled: true });
  });

  it('maps the Gemini 3 level shape', () => {
    expect(thinkingConfigToOptions({ enabled: true, level: 'low' })).toEqual({
      thinkingEnabled: true,
      thinkingLevel: 'low'
    });
  });

  it('maps the Gemini 2.5 budget + thoughts shape', () => {
    expect(thinkingConfigToOptions({ enabled: true, budget: 512, thoughts: false })).toEqual({
      thinkingEnabled: true,
      thinkingBudget: 512,
      thinkingThoughts: false
    });
  });

  it('omits keys that are not provided (partial config)', () => {
    expect(thinkingConfigToOptions({ level: 'high' })).toEqual({ thinkingLevel: 'high' });
  });

  it('does not emit thinkingEnabled when enabled is not a boolean', () => {
    expect(thinkingConfigToOptions({ level: 'medium' })).not.toHaveProperty('thinkingEnabled');
  });
});
