// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Unit rules of `utils/redactedSecrets.js` and `utils/configRevision.js`: the
 * path walk (arrays keyed by name/id), save vs rollback restore, the marker
 * scan, and the revision hash.
 */

import { describe, test, expect } from '@jest/globals';

const {
  SECRET_MARKER,
  assertNoMarkers,
  isRedactedValue,
  maskUrlCredentials,
  redactForRead,
  restoreRedacted
} = await import('../utils/redactedSecrets.js');
const { revisionOf, parseIfMatch } = await import('../utils/configRevision.js');
const { createHash } = await import('node:crypto');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');

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

  test('is keyed: not the plain SHA-256 of the body, so it cannot be reproduced offline (R3)', () => {
    const body = { auth: { jwtSecret: 'Winter2026!' }, defaultLanguage: 'en' };
    const canonical = '{"auth":{"jwtSecret":"Winter2026!"},"defaultLanguage":"en"}';
    const unkeyed = createHash('sha256').update(canonical).digest('base64url');

    expect(revisionOf(body)).not.toBe(unkeyed);
    // A change of the secret alone still changes it.
    expect(revisionOf({ ...body, auth: { jwtSecret: 'Summer2026!' } })).not.toBe(revisionOf(body));
  });

  test('is derived from the encryption key, so every worker that shares it agrees (R3)', () => {
    const previous = tokenStorageService.encryptionKey;
    try {
      tokenStorageService.encryptionKey = 'a'.repeat(64);
      const first = revisionOf({ a: 1 });
      expect(revisionOf({ a: 1 })).toBe(first);
      tokenStorageService.encryptionKey = 'b'.repeat(64);
      expect(revisionOf({ a: 1 })).not.toBe(first);
      tokenStorageService.encryptionKey = 'a'.repeat(64);
      expect(revisionOf({ a: 1 })).toBe(first);
    } finally {
      tokenStorageService.encryptionKey = previous;
    }
  });

  test('orders keys by code unit, independent of locale', () => {
    // `localeCompare` puts "a" before "B"; code-unit order puts "B" first.
    // Either is stable; what matters is that insertion order never counts.
    expect(revisionOf({ a: 1, B: 2, é: 3, e: 4 })).toBe(revisionOf({ é: 3, e: 4, B: 2, a: 1 }));
  });

  test('parseIfMatch', () => {
    expect(parseIfMatch(null)).toBeNull();
    expect(parseIfMatch(42)).toBeNull();
    expect(parseIfMatch('  ')).toBeNull();
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch(' * ')).toBe('*');
    expect(parseIfMatch('"a", W/"b"')).toEqual(['a', 'b']);
  });
});

describe('URL credentials (R2)', () => {
  test.each([
    ['https://fn.azurewebsites.net/api/jwks?code=SUPERSECRETKEY', 'code'],
    ['https://acct.blob.core.windows.net/k/jwks.json?sv=2024&sig=abc%2Bdef', 'sig'],
    ['https://apim.example.com/jwks?subscription-key=abc123', 'subscription-key'],
    ['https://s3.example.com/jwks?X-Amz-Credential=AK&X-Amz-Signature=deadbeef', 'X-Amz-Signature'],
    ['https://idp.example.com/jwks?apiKey=abc123', 'apiKey'],
    ['https://idp.example.com/jwks?auth=abc123', 'auth'],
    ['https://idp.example.com/jwks?refresh_token=abc123', 'refresh_token']
  ])('%s: the %s value is masked on read', (url, param) => {
    const masked = maskUrlCredentials(url);
    expect(masked).toContain(`${param}=REDACTED`);
    expect(masked).not.toMatch(/SUPERSECRETKEY|abc%2Bdef|abc123|deadbeef/);
    expect(isRedactedValue(masked)).toBe(true);
  });

  test('keeps the address and non-secret parameters as stored', () => {
    expect(maskUrlCredentials('https://idp.example.com/jwks?tenant=acme&sv=2024')).toBe(
      'https://idp.example.com/jwks?tenant=acme&sv=2024'
    );
  });

  test('a masked URL sent back restores the stored one; a changed one is kept', () => {
    const stored = { providers: [{ id: 'p1', url: 'https://fn.example.net/jwks?code=K&x=1' }] };
    const read = redactForRead(stored, PATHS);
    expect(read.providers[0].url).toBe('https://fn.example.net/jwks?code=REDACTED&x=1');

    const unchanged = restoreRedacted(structuredClone(read), stored, PATHS);
    expect(unchanged.providers[0].url).toBe('https://fn.example.net/jwks?code=K&x=1');

    const edited = structuredClone(read);
    edited.providers[0].url = 'https://fn.example.net/jwks?code=NEW';
    expect(restoreRedacted(edited, stored, PATHS).providers[0].url).toBe(
      'https://fn.example.net/jwks?code=NEW'
    );
  });
});

describe('assertNoMarkers with the stored value (R8)', () => {
  test('a marker equal to the stored value at the same place passes; a new one is refused', () => {
    const stored = { vars: { a: '[REDACTED]' }, list: ['[redacted]'] };
    expect(() =>
      assertNoMarkers({ vars: { a: '[REDACTED]' }, list: ['[redacted]'] }, [], { stored })
    ).not.toThrow();

    let error;
    try {
      assertNoMarkers({ vars: { a: '[REDACTED]', b: '[REDACTED]' }, list: ['[redacted]'] }, [], {
        stored
      });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe('VALIDATION_FAILED');
    expect(error.details.issues.map(issue => issue.path.join('.'))).toEqual(['vars.b']);
  });

  test('without the stored value every marker is refused, as before', () => {
    expect(() => assertNoMarkers({ a: '[REDACTED]' })).toThrow();
  });
});

/** Milliseconds `fn` takes for one call. */
function timeOf(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('URL masks are found in linear time (Sonar S8786)', () => {
  test.each([
    ['https://h/x?token=REDACTED', true],
    ['https://h/x?a=1&token=REDACTED', true],
    ['https://h/x?token=REDACTED#frag', true],
    ['https://h/x?token=REDACTED&b=2', true],
    ['https://REDACTED@h/x', true],
    ['https://h/x?next=https://REDACTED@h2/', true],
    ['a?b?c=REDACTED', true],
    ['&?=REDACTED', true],
    ['?=REDACTED', false],
    ['&&=REDACTED', false],
    ['?a#b=REDACTED', false],
    ['?a=b=REDACTED', false],
    ['?token=REDACTEDX', false],
    ['token=REDACTED', false],
    ['?x=REDACTEDREDACTED&y=REDACTED', true],
    ['Notice: [redacted] text', false],
    ['[redacted]', true]
  ])('isRedactedValue(%j) is %s', (value, expected) => {
    expect(isRedactedValue(value)).toBe(expected);
  });

  test.each([
    ['https://h/x?token=abc&tenant=acme', 'https://h/x?token=REDACTED&tenant=acme'],
    ['https://h/x?tenant=acme&clientSecret=s3', 'https://h/x?tenant=acme&clientSecret=REDACTED'],
    ['https://h/x?a?apiKey=k', 'https://h/x?a?apiKey=REDACTED'],
    ['https://h/x?foo=a?apiKey=k', 'https://h/x?foo=a?apiKey=REDACTED'],
    ['https://h/x?foo&apiKey=k#apiKey=z', 'https://h/x?foo&apiKey=REDACTED#apiKey=z'],
    ['https://h/x?access%5Ftoken=k', 'https://h/x?access%5Ftoken=REDACTED'],
    ['https://h/x?bad%E0=k', 'https://h/x?bad%E0=k'],
    ['https://h/x?=k&&apiKey= z', 'https://h/x?=k&&apiKey=REDACTED z'],
    ['no query at all', 'no query at all']
  ])('maskUrlCredentials(%j)', (url, expected) => {
    expect(maskUrlCredentials(url)).toBe(expected);
  });

  test.each([
    ['?'.repeat(50000)],
    ['&a'.repeat(25000)],
    [`?${'a?'.repeat(25000)}`],
    ['=REDACTED'.repeat(5000)],
    [`?${'?='.repeat(25000)}REDACTEDx`],
    [`?${' '.repeat(50000)}`]
  ])('a %#. adversarial 50k-character input finishes fast', value => {
    expect(timeOf(() => isRedactedValue(value))).toBeLessThan(50);
    expect(timeOf(() => maskUrlCredentials(value))).toBeLessThan(50);
  });
});
