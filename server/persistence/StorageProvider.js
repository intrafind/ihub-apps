/**
 * StorageProvider interface.
 *
 * Every method receives a path relative to the provider's root (e.g.
 * "config/platform.json"). Implementations resolve that path however makes
 * sense for their backend (filesystem directory, database key, ...).
 *
 * Callers must not assume any particular backing store — this is the seam
 * that lets iHub run against the filesystem (default) or PostgreSQL
 * (opt-in via DATABASE_URL) without changing call sites.
 */
export class StorageProvider {
  /**
   * @param {string} relativePath
   * @returns {Promise<string|null>} File contents as a UTF-8 string, or null if not found.
   */
  // eslint-disable-next-line no-unused-vars
  async read(relativePath) {
    throw new Error('StorageProvider.read() not implemented');
  }

  /**
   * @param {string} relativePath
   * @param {string} data
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async write(relativePath, data) {
    throw new Error('StorageProvider.write() not implemented');
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async delete(relativePath) {
    throw new Error('StorageProvider.delete() not implemented');
  }

  /**
   * @param {string} relativePath
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async exists(relativePath) {
    throw new Error('StorageProvider.exists() not implemented');
  }

  /**
   * Lists entries directly under a directory-like path.
   *
   * @param {string} relativeDir
   * @param {{ pattern?: RegExp }} [options]
   * @returns {Promise<string[]>} Entry names (not full paths), sorted.
   */
  // eslint-disable-next-line no-unused-vars
  async list(relativeDir, options = {}) {
    throw new Error('StorageProvider.list() not implemented');
  }
}

export default StorageProvider;
