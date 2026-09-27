import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * The `a2aClientManager` config reload hook in cluster mode. The worker that
 * serves an admin save re-applies inline and moves its watcher baseline with
 * `markConfigApplied`; otherwise an A→B (here) then B→A (another worker)
 * sequence would compare equal to the stale baseline A and leave this worker
 * on B.
 */

const cache = { a2a: null };
let hook = null;

jest.unstable_mockModule('../../configSync.js', () => ({
  ALL_ENTRIES: '*',
  registerConfigChangeHook: fn => {
    hook = fn;
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getMcpServers: () => ({ data: { servers: [] } }),
    getA2aAgents: () => ({ data: structuredClone(cache.a2a) })
  }
}));
const initialize = jest.fn(async () => {});
jest.unstable_mockModule('../../services/a2a/A2aClientManager.js', () => ({
  default: { initialize }
}));

const { registerConfigReloadHooks, markConfigApplied, resetConfigReloadHooksForTests } =
  await import('../../configReloadHooks.js');

const A = { agents: [{ id: 'x', enabled: true }] };
const B = { agents: [{ id: 'x', enabled: false }] };
const ENTRY = 'config/a2aAgents.json';

beforeEach(() => {
  resetConfigReloadHooksForTests();
  initialize.mockClear();
  cache.a2a = structuredClone(A);
  registerConfigReloadHooks();
});

describe('a2aClientManager reload hook', () => {
  it('re-applies A→B→A on the worker that served the first change', async () => {
    // This worker serves A→B: the route re-applies inline, then marks it.
    cache.a2a = structuredClone(B);
    markConfigApplied(ENTRY);
    // Another worker serves B→A; this one receives the announcement.
    cache.a2a = structuredClone(A);
    await hook({ entries: [ENTRY] });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(A);
  });

  it('skips an announcement that changes nothing for this worker', async () => {
    cache.a2a = structuredClone(B);
    markConfigApplied(ENTRY);
    await hook({ entries: [ENTRY] });
    expect(initialize).not.toHaveBeenCalled();
  });
});
