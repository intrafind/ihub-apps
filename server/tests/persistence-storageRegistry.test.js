/**
 * StorageRegistry Test Suite
 *
 * Verifies the DATABASE_URL-driven provider selection without touching a
 * real filesystem or database — both `pool.js` and `FilesystemProvider`
 * construction paths are mocked.
 */

import { jest } from '@jest/globals';

describe('StorageRegistry', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('returns a FilesystemProvider when no pool is configured (default, no DATABASE_URL)', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../db/pool.js', () => ({
      getPool: jest.fn(async () => null)
    }));

    const { getStorageProvider } = await import('../persistence/StorageRegistry.js');
    const { FilesystemProvider } = await import('../persistence/FilesystemProvider.js');

    const provider = await getStorageProvider();
    expect(provider).toBeInstanceOf(FilesystemProvider);
  });

  it('returns a PostgresProvider when a pool is available (DATABASE_URL set)', async () => {
    jest.resetModules();
    const fakePool = { query: jest.fn(async () => ({ rows: [] })) };
    jest.unstable_mockModule('../db/pool.js', () => ({
      getPool: jest.fn(async () => fakePool)
    }));

    const { getStorageProvider } = await import('../persistence/StorageRegistry.js');
    const { PostgresProvider } = await import('../persistence/PostgresProvider.js');

    const provider = await getStorageProvider();
    expect(provider).toBeInstanceOf(PostgresProvider);
    expect(provider.pool).toBe(fakePool);
  });

  it('memoizes the provider across repeated calls', async () => {
    jest.resetModules();
    const getPool = jest.fn(async () => null);
    jest.unstable_mockModule('../db/pool.js', () => ({ getPool }));

    const { getStorageProvider } = await import('../persistence/StorageRegistry.js');
    const first = await getStorageProvider();
    const second = await getStorageProvider();
    expect(second).toBe(first);
    expect(getPool).toHaveBeenCalledTimes(1);
  });
});
