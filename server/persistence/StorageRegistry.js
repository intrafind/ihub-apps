import path from 'path';
import config from '../config.js';
import { getRootDir } from '../pathUtils.js';
import { FilesystemProvider } from './FilesystemProvider.js';
import { getPool } from '../db/pool.js';

let providerPromise = null;

/**
 * Returns the active StorageProvider for `contents/`, memoized for the life
 * of the process. Reads `DATABASE_URL` to decide: PostgreSQL when set,
 * filesystem (today's default, unchanged) otherwise.
 *
 * @returns {Promise<import('./StorageProvider.js').StorageProvider>}
 */
export async function getStorageProvider() {
  if (!providerPromise) {
    providerPromise = (async () => {
      const pool = await getPool();
      if (pool) {
        const { PostgresProvider } = await import('./PostgresProvider.js');
        return new PostgresProvider(pool);
      }
      const baseDir = path.join(getRootDir(), config.CONTENTS_DIR);
      return new FilesystemProvider(baseDir);
    })();
  }
  return providerPromise;
}

/** Test-only: forces the next getStorageProvider() call to re-resolve. */
export function _resetStorageProviderForTests() {
  providerPromise = null;
}
