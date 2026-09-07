import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLocalizedString } from '../utils/localize.js';

describe('getLocalizedString', () => {
  it('returns a plain string as-is', () => {
    assert.strictEqual(getLocalizedString('hello', 'en'), 'hello');
  });

  it('returns the exact-language value when present', () => {
    assert.strictEqual(getLocalizedString({ en: 'Hello', de: 'Hallo' }, 'de'), 'Hallo');
  });

  it('falls back to the given fallback language when the requested one is missing', () => {
    assert.strictEqual(getLocalizedString({ en: 'Hello', fr: 'Bonjour' }, 'de', 'en'), 'Hello');
  });

  it('falls back to the first available string value when neither language matches', () => {
    assert.strictEqual(getLocalizedString({ fr: 'Bonjour' }, 'de', 'en'), 'Bonjour');
  });

  it('returns the explicit fallback value when nothing is resolvable', () => {
    assert.strictEqual(getLocalizedString(undefined, 'en', 'en', 'fallback-id'), 'fallback-id');
    assert.strictEqual(getLocalizedString({}, 'en', 'en', 'fallback-id'), 'fallback-id');
    assert.strictEqual(getLocalizedString(null, 'en', 'en', 'fallback-id'), 'fallback-id');
  });

  it('defaults the fallback value to an empty string', () => {
    assert.strictEqual(getLocalizedString(undefined, 'en'), '');
  });

  it('ignores non-string values when picking the first available entry', () => {
    assert.strictEqual(getLocalizedString({ count: 3, fr: 'Bonjour' }, 'de', 'en'), 'Bonjour');
  });
});
