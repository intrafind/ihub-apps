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
    const candidate = resolved || path.join(this.baseDir, path.basename(relativePath));
    if (!resolved) {
      logger.warn(`Path traversal blocked in FilesystemProvider: ${relativePath}`);
    }

    // Explicit, synchronous containment re-check on the final candidate path,
    // independent of resolveAndValidatePath's own (fs.realpath-based) guarantee.
    // This is what actually neutralizes the path for static analysis of the
    // fs.* calls below, since CodeQL's taint tracking cannot follow the async
    // realpath resolution inside pathSecurity.js.
    const normalizedBase = path.resolve(this.baseDir);
    const normalizedCandidate = path.resolve(candidate);
    const isContained =
      normalizedCandidate === normalizedBase ||
      normalizedCandidate.startsWith(normalizedBase + path.sep);
    if (!isContained) {
      // Unreachable in practice (the fallback above is always a basename joined
      // onto baseDir), but fail closed rather than ever touching the filesystem
      // with an unverified path.
      throw new Error(`Refusing to access path outside base directory: ${relativePath}`);
    }

    return normalizedCandidate;
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
