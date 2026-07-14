/**
 * Regression test for createSourceManager()'s singleton behavior.
 *
 * createSourceManager() caches a single SourceManager instance in module
 * scope and only honors the `config` argument on the very first call —
 * every later call, regardless of what it passes, receives the
 * already-constructed instance unchanged. This test locks in that
 * documented behavior so a future refactor can't silently start
 * reconfiguring (or silently keep dropping) per-call config without the
 * test suite noticing either way.
 *
 * See issue #1794.
 */

import { createSourceManager } from '../sources/index.js';

describe('createSourceManager singleton', () => {
  it('ignores config passed on calls after the first and always returns the same instance', () => {
    const first = createSourceManager();
    const defaultBasePath = first.getHandler('filesystem').basePath;

    const second = createSourceManager({
      filesystem: { basePath: '/tmp/should-be-ignored' }
    });

    expect(second).toBe(first);
    expect(second.getHandler('filesystem').basePath).toBe(defaultBasePath);
    expect(second.getHandler('filesystem').basePath).not.toBe('/tmp/should-be-ignored');
  });
});
