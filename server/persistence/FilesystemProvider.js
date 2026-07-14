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
      // Fail closed instead of falling back to some other path derived from
      // the untrusted input (e.g. joining baseDir with its basename) — that
      // fallback previously re-introduced the untrusted value into a new
      // path expression, which is exactly what static path-injection
      // analysis (correctly) flags as unsafe, regardless of how harmless it
      // is in practice. Treated as ENOENT by callers: a blocked path is not
      // meaningfully different from "not found" for this abstraction.
      const error = new Error(`Refusing to access path outside base directory: ${relativePath}`);
      error.code = 'ENOENT';
      throw error;
    }

    // Explicit, synchronous containment re-check on the resolved path,
    // independent of resolveAndValidatePath's own (fs.realpath-based)
    // guarantee — this is what neutralizes the path for static analysis of
    // the fs.* calls below, since taint tracking cannot follow the async
    // realpath resolution inside pathSecurity.js.
    const normalizedBase = path.resolve(this.baseDir);
    const normalizedResolved = path.resolve(resolved);
    const isContained =
      normalizedResolved === normalizedBase ||
      normalizedResolved.startsWith(normalizedBase + path.sep);
    if (!isContained) {
      // Unreachable in practice (resolveAndValidatePath already guarantees
      // containment), but fail closed rather than ever touching the
      // filesystem with an unverified path.
      const error = new Error(`Refusing to access path outside base directory: ${relativePath}`);
      error.code = 'ENOENT';
      throw error;
    }

    return normalizedResolved;
  }

  async read(relativePath) {
    try {
      const filePath = await this._resolve(relativePath);
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
    try {
      const filePath = await this._resolve(relativePath);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(relativeDir, { pattern } = {}) {
    let entries;
    try {
      const dirPath = await this._resolve(relativeDir);
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
