import { StorageProvider } from './StorageProvider.js';
import { ensureSchema } from '../db/schema.js';

/**
 * PostgreSQL-backed StorageProvider. Stores every path as a row in a single
 * generic `config_kv` table (path -> text blob) rather than mapping each
 * config type to its own table — this mirrors the "one interface, any path"
 * contract FilesystemProvider already has, so callers don't need to know
 * which backend is active.
 *
 * Schema is created lazily on first use so a server that has DATABASE_URL
 * set but hasn't been "activated" yet doesn't fail at import time.
 */
export class PostgresProvider extends StorageProvider {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    super();
    this.pool = pool;
    this._schemaReady = null;
  }

  async _ensureReady() {
    if (!this._schemaReady) {
      this._schemaReady = ensureSchema(this.pool);
    }
    await this._schemaReady;
  }

  _normalize(relativePath) {
    // Store using forward slashes regardless of platform so keys are stable.
    return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  async read(relativePath) {
    await this._ensureReady();
    const key = this._normalize(relativePath);
    const { rows } = await this.pool.query('SELECT data FROM config_kv WHERE path = $1', [key]);
    return rows.length > 0 ? rows[0].data : null;
  }

  async write(relativePath, data) {
    await this._ensureReady();
    const key = this._normalize(relativePath);
    await this.pool.query(
      `INSERT INTO config_kv (path, data, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [key, data]
    );
  }

  async delete(relativePath) {
    await this._ensureReady();
    const key = this._normalize(relativePath);
    await this.pool.query('DELETE FROM config_kv WHERE path = $1', [key]);
  }

  async exists(relativePath) {
    await this._ensureReady();
    const key = this._normalize(relativePath);
    const { rows } = await this.pool.query('SELECT 1 FROM config_kv WHERE path = $1', [key]);
    return rows.length > 0;
  }

  async list(relativeDir, { pattern } = {}) {
    await this._ensureReady();
    const prefix = this._normalize(relativeDir).replace(/\/+$/, '') + '/';
    const { rows } = await this.pool.query('SELECT path FROM config_kv WHERE path LIKE $1', [
      `${prefix}%`
    ]);
    const entries = rows
      .map(row => row.path.slice(prefix.length))
      .filter(entry => entry && !entry.includes('/'));
    const filtered = pattern ? entries.filter(entry => pattern.test(entry)) : entries;
    return filtered.sort();
  }
}

export default PostgresProvider;
