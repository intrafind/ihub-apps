import fs from 'fs/promises';
import path from 'path';
import { StorageProvider } from './StorageProvider.js';
import { resolveAndValidatePath } from '../utils/pathSecurity.js';
import logger from '../utils/logger.js';

/**
 * Default StorageProvider backend — wraps the existing `contents/` directory
 * on disk. Behavior must stay byte-for-byte identical to what configLoader.js
 * did before the StorageProvider seam existed, since this is what every
 * existing deployment (no DATABASE_URL set) continues to use.
 */
export class FilesystemProvider extends StorageProvider {
  /**
   * @param {string} baseDir Absolute path to the root directory (e.g. `<root>/contents`).
   */
  constructor(baseDir) {
    super();
    this.baseDir = baseDir;
  }

  async _resolve(relativePath) {
    const resolved = await resolveAndValidatePath(relativePath, this.baseDir);
    if (!resolved) {
      logger.warn(`Path traversal blocked in FilesystemProvider: ${relativePath}`);
      return path.join(this.baseDir, path.basename(relativePath));
    }
    return resolved;
  }

  async read(relativePath) {
    const filePath = await this._resolve(relativePath);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async write(relativePath, data) {
    const filePath = await this._resolve(relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data, 'utf8');
  }

  async delete(relativePath) {
    const filePath = await this._resolve(relativePath);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async exists(relativePath) {
    const filePath = await this._resolve(relativePath);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(relativeDir, { pattern } = {}) {
    const dirPath = await this._resolve(relativeDir);
    let entries;
    try {
      entries = await fs.readdir(dirPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const filtered = pattern ? entries.filter(entry => pattern.test(entry)) : entries;
    return filtered.sort();
  }
}

export default FilesystemProvider;
