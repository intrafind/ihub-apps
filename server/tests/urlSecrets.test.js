// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `redactUrlSecrets` masks credential query parameters and user info, and does
 * so in linear time on any input (Sonar S5843/S8786: it runs on admin-entered
 * URLs and on URLs written to logs).
 */

import { describe, test, expect } from '@jest/globals';

// A linear scan takes a few ms here even cold on a loaded CI runner; the
// quadratic regexes these replace took 700-1400 ms. 250 ms separates the two
// without depending on runner speed.
const LINEAR_TIME_LIMIT_MS = 250;

const { redactUrlSecrets } = await import('../utils/urlSecrets.js');

describe('redactUrlSecrets', () => {
  test.each([
    ['https://h/x?api_key=k', 'https://h/x?api_key=REDACTED'],
    ['https://h/x?api-key=k&apikey=k', 'https://h/x?api-key=REDACTED&apikey=REDACTED'],
    ['https://h/x?API_KEY=k', 'https://h/x?API_KEY=REDACTED'],
    ['https://h/x?Access-Token=k#top', 'https://h/x?Access-Token=REDACTED#top'],
    [
      'https://h/x?id_token=k&session-token=k',
      'https://h/x?id_token=REDACTED&session-token=REDACTED'
    ],
    ['https://h/x?refreshtoken=k', 'https://h/x?refreshtoken=REDACTED'],
    [
      'https://h/x?client_secret=k&subscription-key=k',
      'https://h/x?client_secret=REDACTED&subscription-key=REDACTED'
    ],
    [
      'https://h/x?code=k&sig=k&signature=k',
      'https://h/x?code=REDACTED&sig=REDACTED&signature=REDACTED'
    ],
    [
      'https://h/x?password=k&passwd=k&secret=k&auth=k',
      'https://h/x?password=REDACTED&passwd=REDACTED&secret=REDACTED&auth=REDACTED'
    ],
    [
      'https://h/x?X-Amz-Signature=a&X-Amz-Credential=b&x-amz-security-token=c',
      'https://h/x?X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED&x-amz-security-token=REDACTED'
    ],
    ['https://h/x?key=a b', 'https://h/x?key=REDACTED b'],
    ['https://h/x?key=', 'https://h/x?key=REDACTED'],
    ['https://h/x?foo=a?key=b', 'https://h/x?foo=a?key=REDACTED'],
    ['https://h/x?key=a?token=b', 'https://h/x?key=REDACTED'],
    ['https://h/x?keys=a&mykey=b&api__key=c', 'https://h/x?keys=a&mykey=b&api__key=c'],
    ['https://h/x?\u212Aey=a', 'https://h/x?\u212Aey=a'],
    ['https://user:pass@h/x?token=t', 'https://REDACTED@h/x?token=REDACTED'],
    // An @ in the query or fragment is not user info: the match stops at ? and #.
    ['https://h?token=prefix@suffix', 'https://h?token=REDACTED'],
    ['https://h#token=a@b', 'https://h#token=a@b'],
    ['https://h/x?next=//a@b', 'https://h/x?next=//REDACTED@b'],
    ['https://h/x', 'https://h/x']
  ])('%j becomes %j', (url, expected) => {
    expect(redactUrlSecrets(url)).toBe(expected);
  });

  test('a non-string is returned as it is', () => {
    expect(redactUrlSecrets(undefined)).toBeUndefined();
    expect(redactUrlSecrets(42)).toBe(42);
  });

  test.each([
    ['?'.repeat(50000)],
    ['&key'.repeat(12500)],
    [`?${'x-amz-security-'.repeat(3400)}`],
    [`?key=${'a'.repeat(50000)}`],
    ['//'.repeat(25000)]
  ])('a %#. adversarial 50k-character input finishes fast', url => {
    const start = performance.now();
    redactUrlSecrets(url);
    expect(performance.now() - start).toBeLessThan(LINEAR_TIME_LIMIT_MS);
  });
});
