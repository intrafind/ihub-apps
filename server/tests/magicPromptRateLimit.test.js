/**
 * Regression test for the magic-prompt singular/plural path mismatch: the
 * public rate limiter is mounted via buildApiPath, while the route itself is
 * registered via buildServerPath. Both must resolve to the same path or the
 * limiter silently never applies to the route (Express app.use() prefix
 * matching won't bridge a plural/singular mismatch).
 */
import { buildApiPath, buildServerPath } from '../utils/basePath.js';

describe('magic-prompt rate limiter path coverage', () => {
  test('the rate limiter mount path matches the actual route path', () => {
    expect(buildApiPath('/magic-prompt')).toBe(buildServerPath('/api/magic-prompt'));
  });
});
