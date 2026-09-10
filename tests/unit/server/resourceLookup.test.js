import { describe, it, expect } from '@jest/globals';
import {
  findByIdCaseInsensitive,
  hasIdCaseInsensitive
} from '../../../server/utils/resourceLookup.js';

describe('findByIdCaseInsensitive', () => {
  const list = [{ id: 'gpt-4o' }, { id: 'claude-sonnet' }];

  it('finds an exact-case match', () => {
    expect(findByIdCaseInsensitive(list, 'gpt-4o')).toBe(list[0]);
  });

  it('finds a match regardless of casing', () => {
    expect(findByIdCaseInsensitive(list, 'GPT-4O')).toBe(list[0]);
    expect(findByIdCaseInsensitive(list, 'Claude-Sonnet')).toBe(list[1]);
  });

  it('returns undefined when nothing matches', () => {
    expect(findByIdCaseInsensitive(list, 'unknown')).toBeUndefined();
  });

  it('returns undefined for non-array input', () => {
    expect(findByIdCaseInsensitive(null, 'gpt-4o')).toBeUndefined();
    expect(findByIdCaseInsensitive(undefined, 'gpt-4o')).toBeUndefined();
  });

  it('returns undefined for a non-string id', () => {
    expect(findByIdCaseInsensitive(list, undefined)).toBeUndefined();
    expect(findByIdCaseInsensitive(list, 42)).toBeUndefined();
  });

  it('ignores items without a string id', () => {
    const mixedList = [{ id: 42 }, { name: 'no id' }, { id: 'valid-id' }];
    expect(findByIdCaseInsensitive(mixedList, 'VALID-ID')).toBe(mixedList[2]);
  });
});

describe('hasIdCaseInsensitive', () => {
  it('matches exact case', () => {
    expect(hasIdCaseInsensitive(new Set(['gpt-4o']), 'gpt-4o')).toBe(true);
  });

  it('matches regardless of casing', () => {
    expect(hasIdCaseInsensitive(new Set(['gpt-4o']), 'GPT-4O')).toBe(true);
    expect(hasIdCaseInsensitive(new Set(['Translator']), 'translator')).toBe(true);
  });

  it('returns false when the set does not contain the id', () => {
    expect(hasIdCaseInsensitive(new Set(['gpt-4o']), 'claude')).toBe(false);
  });

  it('returns false for a missing set or non-string id', () => {
    expect(hasIdCaseInsensitive(null, 'gpt-4o')).toBe(false);
    expect(hasIdCaseInsensitive(new Set(['gpt-4o']), undefined)).toBe(false);
  });

  it('ignores non-string entries in the set', () => {
    expect(hasIdCaseInsensitive(new Set([42, 'gpt-4o']), 'GPT-4O')).toBe(true);
  });
});
