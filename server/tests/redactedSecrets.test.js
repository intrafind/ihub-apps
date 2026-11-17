// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Unit rules of `utils/redactedSecrets.js` and `utils/configRevision.js`: the
 * path walk (arrays keyed by name/id), save vs rollback restore, the marker
 * scan, and the revision hash.
 */

import { describe, test, expect } from '@jest/globals';

const { SECRET_MARKER, assertNoMarkers, isRedactedValue, redactForRead, restoreRedacted } =
  await import('../utils/redactedSecrets.js');
const { revisionOf, parseIfMatch } = await import('../utils/configRevision.js');

const PATHS = [
  { path: 'auth.jwtSecret' },
  { path: 'providers[].clientSecret' },
  { path: 'providers[].url', kind: 'url' }
];

describe('redactForRead', () => {
  test('masks secrets and URL credentials, keeps ${ENV} placeholders, drops empty secrets', () => {
    const stored = {
      auth: { jwtSecret: '${JWT_SECRET}' },
      providers: [
        { id: 'p1', clientSecret: 's1', url: 'https://u:p@h/x?token=t' },
        { id: 'p2', clientSecret: '' }
      ]
    };
    expect(redactForRead(stored, PATHS)).toEqual({
      auth: { jwtSecret: '${JWT_SECRET}' },
      providers: [
        { id: 'p1', clientSecret: SECRET_MARKER, url: 'https://REDACTED@h/x?token=REDACTED' },
        { id: 'p2' }
      ]
    });
    expect(stored.providers[0].clientSecret).toBe('s1');
  });
});

describe('restoreRedacted', () => {
  const stored = {
    auth: { jwtSecret: 'current' },
    providers: [
      { id: 'p1', clientSecret: 's1', url: 'https://u:p@h/x' },
      { id: 'p2', clientSecret: 's2' }
    ]
  };

  test('save: marker and omission keep, null clears, new value wins; arrays matched by id', () => {
    const next = {
      auth: { jwtSecret: null },
      providers: [
        { id: 'p2', clientSecret: SECRET_MARKER },
        { id: 'p1', url: 'https://REDACTED@h/x' },
        { id: 'p3', clientSecret: 'new' }
      ]
    };
    expect(restoreRedacted(next, stored, PATHS)).toEqual({
      auth: {},
      providers: [
        { id: 'p2', clientSecret: 's2' },
        { id: 'p1', clientSecret: 's1', url: 'https://u:p@h/x' },
        { id: 'p3', clientSecret: 'new' }
      ]
    });
  });

  test('save: an absent enclosing object is not created', () => {
    expect(restoreRedacted({}, stored, PATHS)).toEqual({});
  });

  test('rollback: the current secret always wins; a secret the current file lacks is dropped', () => {
    const snapshot = {
      auth: { jwtSecret: 'old-leaked' },
      providers: [
        { id: 'p1', clientSecret: SECRET_MARKER, url: 'https://old/url' },
        { id: 'gone', clientSecret: 'old' }
      ]
    };
    expect(restoreRedacted(snapshot, stored, PATHS, { mode: 'rollback' })).toEqual({
      auth: { jwtSecret: 'current' },
      providers: [{ id: 'p1', clientSecret: 's1', url: 'https://old/url' }, { id: 'gone' }]
    });
  });
});

describe('assertNoMarkers', () => {
  test('names every field that holds a marker', () => {
    expect.assertions(3);
    try {
      assertNoMarkers({ a: SECRET_MARKER, b: [{ c: '[redacted]' }], d: 'quoted [redacted] text' });
    } catch (error) {
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.status).toBe(400);
      expect(error.details.issues.map(issue => issue.path.join('.'))).toEqual(['a', 'b.0.c']);
    }
  });

  test('recognizes masked URLs only where the mask is the whole credential', () => {
    expect(isRedactedValue('https://REDACTED@host/x')).toBe(true);
    expect(isRedactedValue('https://host/x?api_key=REDACTED&a=1')).toBe(true);
    expect(isRedactedValue('https://host/REDACTED/x')).toBe(false);
  });
});

describe('configRevision', () => {
  test('key order does not change the revision; a value does; missing equals {}', () => {
    expect(revisionOf({ a: 1, b: { c: 2, d: 3 } })).toBe(revisionOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(revisionOf({ a: 1 })).not.toBe(revisionOf({ a: 2 }));
    expect(revisionOf(null)).toBe(revisionOf({}));
    expect(revisionOf({})).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('parseIfMatch', () => {
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch(' * ')).toBe('*');
    expect(parseIfMatch('"a", W/"b"')).toEqual(['a', 'W/"b"']);
  });
});
