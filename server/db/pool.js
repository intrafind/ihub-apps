import config from '../config.js';
import logger from '../utils/logger.js';

let poolPromise = null;

/**
 * Lazily creates (and memoizes) a `pg.Pool` singleton. Returns `null` when no
 * `DATABASE_URL` is configured, so every caller must treat a null pool as
 * "PostgreSQL is not active for this deployment" rather than an error.
 *
 * The `pg` module is imported dynamically so deployments that never set
 * DATABASE_URL are unaffected even if the dependency were ever missing.
 *
 * @returns {Promise<import('pg').Pool|null>}
 */
export async function getPool() {
  if (!config.DATABASE_URL) {
    return null;
  }
  if (!poolPromise) {
    poolPromise = (async () => {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
      pool.on('error', error => {
        logger.error('Unexpected PostgreSQL pool error', { component: 'DbPool', error });
      });
      return pool;
    })();
  }
  return poolPromise;
}

/**
 * Closes the pool if one was created. Intended for tests and graceful shutdown.
 */
export async function closePool() {
  if (!poolPromise) {
    return;
  }
  const pool = await poolPromise;
  poolPromise = null;
  await pool.end();
}

/** Test-only: forces the next getPool() call to recreate the pool. */
export function _resetPoolForTests() {
  poolPromise = null;
}
