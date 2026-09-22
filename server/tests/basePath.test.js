/**
 * Regression tests for the request-scoped base path detection.
 *
 * getBasePath() used to read a process-wide `global.currentRequest` set by
 * basePathDetectionMiddleware, so any await between the middleware and a
 * later handler building a URL let a concurrent request overwrite the
 * global — leaking one request's (possibly attacker-supplied)
 * X-Forwarded-Prefix into another request's response. It now reads from the
 * per-request AsyncLocalStorage context (requestContext.js) instead.
 */

import { runWithContext } from '../utils/requestContext.js';
import { getBasePath, basePathDetectionMiddleware } from '../utils/basePath.js';

function runRequest(prefix) {
  return new Promise(resolve => {
    runWithContext({}, () => {
      const req = { headers: prefix ? { 'x-forwarded-prefix': prefix } : {} };
      basePathDetectionMiddleware(req, {}, async () => {
        // Simulate async work happening between middleware and handler,
        // giving a concurrent request the chance to interleave.
        await new Promise(r => setImmediate(r));
        resolve(getBasePath());
      });
    });
  });
}

describe('getBasePath request isolation', () => {
  test('returns the detected prefix for a single request', async () => {
    await expect(runRequest('/ihub')).resolves.toBe('/ihub');
  });

  test('returns empty string when no header is present', async () => {
    await expect(runRequest(undefined)).resolves.toBe('');
  });

  test('does not leak a prefix across concurrent requests', async () => {
    const [a, b] = await Promise.all([runRequest('/tenant-a'), runRequest('/tenant-b')]);
    expect(a).toBe('/tenant-a');
    expect(b).toBe('/tenant-b');
  });

  test('returns empty string when called outside any request context', () => {
    expect(getBasePath()).toBe('');
  });

  test('ignores an invalid/dangerous prefix', async () => {
    await expect(runRequest('/../etc')).resolves.toBe('');
  });
});
