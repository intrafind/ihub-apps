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
      // path expression, which static path-injection analysis (correctly)
      // flags as unsafe, regardless of how harmless it is in practice.
      // Treated as ENOENT by callers: a blocked path is not meaningfully
      // different from "not found" for this abstraction.
      const error = new Error(`Refusing to access path outside base directory: ${relativePath}`);
      error.code = 'ENOENT';
      throw error;
    }
    return resolved;
  }

  // Every method below re-verifies (synchronously, inline, no helper call)
  // that the path returned by _resolve() is contained in baseDir immediately
  // before its own fs.* call. This duplicates part of what
  // resolveAndValidatePath already guarantees, but static path-injection
  // analysis needs the `startsWith` guard written directly in the same
  // function as the sink it protects — a check performed inside an awaited
  // async helper (or even a separate synchronous helper) isn't recognized as
  // clearing the taint at the sink in the caller.

  async read(relativePath) {
    try {
      const filePath = await this._resolve(relativePath);
      const normalizedBase = path.resolve(this.baseDir);
      const normalizedPath = path.resolve(filePath);
      if (
        normalizedPath !== normalizedBase &&
        !normalizedPath.startsWith(normalizedBase + path.sep)
      ) {
        const error = new Error(`Refusing to access path outside base directory: ${relativePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return await fs.readFile(normalizedPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async write(relativePath, data) {
    const filePath = await this._resolve(relativePath);
    const normalizedBase = path.resolve(this.baseDir);
    const normalizedPath = path.resolve(filePath);
    if (
      normalizedPath !== normalizedBase &&
      !normalizedPath.startsWith(normalizedBase + path.sep)
    ) {
      throw new Error(`Refusing to access path outside base directory: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    await fs.writeFile(normalizedPath, data, 'utf8');
  }

  async delete(relativePath) {
    const filePath = await this._resolve(relativePath);
    const normalizedBase = path.resolve(this.baseDir);
    const normalizedPath = path.resolve(filePath);
    if (
      normalizedPath !== normalizedBase &&
      !normalizedPath.startsWith(normalizedBase + path.sep)
    ) {
      throw new Error(`Refusing to access path outside base directory: ${relativePath}`);
    }
    try {
      await fs.unlink(normalizedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async exists(relativePath) {
    try {
      const filePath = await this._resolve(relativePath);
      const normalizedBase = path.resolve(this.baseDir);
      const normalizedPath = path.resolve(filePath);
      if (
        normalizedPath !== normalizedBase &&
        !normalizedPath.startsWith(normalizedBase + path.sep)
      ) {
        throw new Error(`Refusing to access path outside base directory: ${relativePath}`);
      }
      await fs.access(normalizedPath);
      return true;
    } catch {
      return false;
    }
  }

  async list(relativeDir, { pattern } = {}) {
    let entries;
    try {
      const dirPath = await this._resolve(relativeDir);
      const normalizedBase = path.resolve(this.baseDir);
      const normalizedPath = path.resolve(dirPath);
      if (
        normalizedPath !== normalizedBase &&
        !normalizedPath.startsWith(normalizedBase + path.sep)
      ) {
        const error = new Error(`Refusing to access path outside base directory: ${relativeDir}`);
        error.code = 'ENOENT';
        throw error;
      }
      entries = await fs.readdir(normalizedPath);
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
