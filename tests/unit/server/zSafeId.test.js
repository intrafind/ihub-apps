import { describe, expect, test } from '@jest/globals';
import { zSafeId } from '../../../server/validators/index.js';
import { SAFE_ID_PATTERN, isValidId } from '../../../server/utils/pathSecurity.js';

describe('zSafeId', () => {
  test.each(['abc', 'tool_1', 'model-2.5', 'A_B-C.1'])(
    'accepts IDs allowed by SAFE_ID_PATTERN: %s',
    value => {
      expect(SAFE_ID_PATTERN.test(value)).toBe(true);
      expect(zSafeId.safeParse(value).success).toBe(true);
    }
  );

  test.each(['has space', 'bad/id', 'bad@id'])('rejects invalid IDs: %s', value => {
    expect(SAFE_ID_PATTERN.test(value)).toBe(false);
    expect(zSafeId.safeParse(value).success).toBe(false);
  });

  test('route-level validation remains stricter than regex-only schema', () => {
    expect(zSafeId.safeParse('version..1').success).toBe(true);
    expect(isValidId('version..1')).toBe(false);
  });
});
