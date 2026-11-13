// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cache settings on Admin → Projects → Project settings (#3650): the heap
 * share is typed as a percentage, empty meaning the built-in budget.
 */
import {
  parsePercentShare,
  shareToPercentText
} from '../../../client/src/features/admin/utils/cacheSettings';

describe('shareToPercentText', () => {
  test('shows a share as a percentage, null as empty', () => {
    expect(shareToPercentText(0.1)).toBe('10');
    expect(shareToPercentText(0.065)).toBe('6.5');
    expect(shareToPercentText(0.5)).toBe('50');
    expect(shareToPercentText(null)).toBe('');
    expect(shareToPercentText(undefined)).toBe('');
  });
});

describe('parsePercentShare', () => {
  test('turns percent text into a share', () => {
    expect(parsePercentShare('10')).toEqual({ valid: true, share: 0.1 });
    expect(parsePercentShare(' 6.5 ')).toEqual({ valid: true, share: 0.065 });
    expect(parsePercentShare('1')).toEqual({ valid: true, share: 0.01 });
    expect(parsePercentShare('50')).toEqual({ valid: true, share: 0.5 });
  });

  test('an empty field is the built-in budget', () => {
    expect(parsePercentShare('')).toEqual({ valid: true, share: null });
    expect(parsePercentShare('  ')).toEqual({ valid: true, share: null });
  });

  test('refuses what the server would refuse', () => {
    for (const text of ['0', '0.5', '51', '-3', 'abc', '1e9']) {
      expect(parsePercentShare(text).valid).toBe(false);
    }
  });

  test('round-trips with shareToPercentText', () => {
    for (const share of [0.01, 0.06, 0.1, 0.25, 0.5]) {
      expect(parsePercentShare(shareToPercentText(share)).share).toBe(share);
    }
  });
});
