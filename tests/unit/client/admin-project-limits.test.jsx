// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The limits of user projects on Admin → Projects → Project settings (#3523):
 * bytes shown in MB, and the values a save sends.
 */
import {
  MB,
  limitInputsOf,
  limitToInput,
  parseLimits
} from '../../../client/src/features/admin/utils/projectLimits';

const STORED = {
  maxFiles: 25,
  maxFileBytes: 20 * MB,
  maxProjectBytes: 209715201,
  maxProjectsPerUser: 20
};

describe('project limits', () => {
  test('shows bytes as MB, at most two decimals', () => {
    expect(limitToInput(20 * MB, MB)).toBe('20');
    expect(limitToInput(1.5 * MB, MB)).toBe('1.5');
    expect(limitToInput(209715201, MB)).toBe('200');
    expect(limitToInput(undefined, MB)).toBe('');
    expect(limitInputsOf(STORED)).toEqual({
      maxFiles: '25',
      maxFileBytes: '20',
      maxProjectBytes: '200',
      maxProjectsPerUser: '20'
    });
  });

  test('keeps an untouched odd byte count instead of rounding it', () => {
    const { values, invalid } = parseLimits(limitInputsOf(STORED), STORED, 200);
    expect(invalid).toEqual([]);
    expect(values).toEqual(STORED);
  });

  test('turns MB into bytes and accepts 0 projects per user as no cap', () => {
    const { values, invalid } = parseLimits(
      { maxFiles: '200', maxFileBytes: '2.5', maxProjectBytes: '1024', maxProjectsPerUser: '0' },
      STORED,
      200
    );
    expect(invalid).toEqual([]);
    expect(values).toEqual({
      maxFiles: 200,
      maxFileBytes: Math.round(2.5 * MB),
      maxProjectBytes: 1024 * MB,
      maxProjectsPerUser: 0
    });
  });

  test('flags what the server would refuse', () => {
    const { invalid } = parseLimits(
      { maxFiles: '201', maxFileBytes: '0', maxProjectBytes: '', maxProjectsPerUser: '1.5' },
      STORED,
      200
    );
    expect(invalid).toEqual(['maxFiles', 'maxFileBytes', 'maxProjectBytes', 'maxProjectsPerUser']);
    expect(parseLimits({ ...limitInputsOf(STORED), maxFiles: '0' }, STORED, 200).invalid).toEqual([
      'maxFiles'
    ]);
    expect(parseLimits({ ...limitInputsOf(STORED), maxFiles: '2.5' }, STORED, 200).invalid).toEqual(
      ['maxFiles']
    );
    // The server's cap on projects per user.
    const perUser = value =>
      parseLimits({ ...limitInputsOf(STORED), maxProjectsPerUser: value }, STORED, 200).invalid;
    expect(perUser('100000')).toEqual([]);
    expect(perUser('100001')).toEqual(['maxProjectsPerUser']);
  });
});
