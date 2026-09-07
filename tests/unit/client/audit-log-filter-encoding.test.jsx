import { describe, it, expect } from '@jest/globals';
import {
  MAX_FILTER_VALUES,
  encodeSelection
} from '../../../client/src/features/admin/utils/auditLogFilters';

const options = values => values.map(value => ({ value, count: 1 }));

describe('encodeSelection', () => {
  it('clears both parameters when everything is selected', () => {
    expect(encodeSelection('action', options(['a', 'b']), ['a', 'b'])).toEqual({
      action: null,
      actionExclude: null
    });
  });

  it('writes the wildcard exclusion when nothing is selected', () => {
    expect(encodeSelection('action', options(['a', 'b']), [])).toEqual({
      action: null,
      actionExclude: '*'
    });
  });

  it('writes the exclusion form for a partial selection', () => {
    expect(encodeSelection('action', options(['a', 'b', 'c']), ['a'])).toEqual({
      action: null,
      actionExclude: 'b,c'
    });
  });

  it('writes repeated values for the actor field, which is never comma-split', () => {
    expect(encodeSelection('actor', options(['Doe, John', 'alice', 'bob']), ['bob'])).toEqual({
      actor: null,
      actorExclude: ['Doe, John', 'alice']
    });
  });

  it('handles an empty option list without excluding everything', () => {
    expect(encodeSelection('action', [], [])).toEqual({ action: null, actionExclude: null });
  });
});

describe('encodeSelection against the server cap', () => {
  // One value ticked out of more options than the cap: the exclusion form
  // would be rejected by the server as too many values, so the inclusion form
  // is written instead. Without this the UI's own request 400s.
  const many = options(Array.from({ length: MAX_FILTER_VALUES + 2 }, (_, i) => `actor-${i}`));

  it('falls back to the inclusion form when the exclusion list is over the cap', () => {
    const encoded = encodeSelection('actor', many, ['actor-0']);
    expect(encoded.actorExclude).toBeNull();
    expect(encoded.actor).toEqual(['actor-0']);
  });

  it('never emits more than the cap allows for either form', () => {
    for (const selectedCount of [1, 2, MAX_FILTER_VALUES, MAX_FILTER_VALUES + 1]) {
      const selected = many.slice(0, selectedCount).map(o => o.value);
      const encoded = encodeSelection('actor', many, selected);
      const emitted = encoded.actor ?? encoded.actorExclude;
      if (Array.isArray(emitted)) expect(emitted.length).toBeLessThanOrEqual(MAX_FILTER_VALUES);
    }
  });

  it('still prefers the exclusion form whenever it fits', () => {
    // Exclusion is what keeps values added by a later release visible in a
    // bookmarked view, so it wins unless it cannot be expressed.
    const fits = options(Array.from({ length: MAX_FILTER_VALUES }, (_, i) => `actor-${i}`));
    const encoded = encodeSelection('actor', fits, ['actor-0']);
    expect(encoded.actor).toBeNull();
    expect(encoded.actorExclude).toHaveLength(MAX_FILTER_VALUES - 1);
  });
});
