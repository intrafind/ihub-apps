/**
 * db/pool.js Test Suite
 */

import { jest } from '@jest/globals';

describe('getPool', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('returns null when DATABASE_URL is not configured', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../config.js', () => ({
      default: { DATABASE_URL: undefined }
    }));

    const { getPool } = await import('../db/pool.js');
    expect(await getPool()).toBeNull();
  });

  it('lazily constructs and memoizes a pg.Pool when DATABASE_URL is set', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../config.js', () => ({
      default: { DATABASE_URL: 'postgres://user:pass@localhost:5432/ihub' }
    }));

    const poolInstances = [];
    class FakePool {
      constructor(options) {
        this.options = options;
        this.listeners = {};
        poolInstances.push(this);
      }
      on(event, handler) {
        this.listeners[event] = handler;
      }
      async end() {}
    }
    jest.unstable_mockModule('pg', () => ({
      default: { Pool: FakePool }
    }));

    const { getPool } = await import('../db/pool.js');
    const first = await getPool();
    const second = await getPool();

    expect(second).toBe(first);
    expect(poolInstances).toHaveLength(1);
    expect(poolInstances[0].options).toEqual({
      connectionString: 'postgres://user:pass@localhost:5432/ihub'
    });
  });
});
