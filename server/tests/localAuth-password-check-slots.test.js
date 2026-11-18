// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * At most two bcrypt password checks run at once per process; the rest wait
 * their turn, so a sign-in flood cannot interleave hundreds of them on the
 * event loop. Native ESM: `jest.unstable_mockModule` + dynamic import.
 */
import { jest } from '@jest/globals';

let running = 0;
let peak = 0;
jest.unstable_mockModule('bcryptjs', () => ({
  default: {
    compare: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return true;
    }
  }
}));

const { verifyPasswordWithUserId } = await import('../middleware/localAuth.js');

test('runs at most two password checks at once, and all of them', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => verifyPasswordWithUserId('pw', `u${i}`, 'hash'))
  );
  expect(results).toEqual(Array(20).fill(true));
  expect(peak).toBe(2);
  expect(running).toBe(0);
});
