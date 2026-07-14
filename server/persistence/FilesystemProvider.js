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
 *
 * Every method below resolves `this.baseDir` + the caller-supplied relative
 * path with `path.resolve()` directly, inline, and immediately verifies the
 * result is still contained in `this.baseDir` before doing anything with the
 * filesystem — matching CodeQL's own documented fix for path-injection
 * (resolve, then verify with startsWith, right before the sink). A guard
 * performed inside an awaited helper isn't recognized as clearing the taint
 * at the sink in the caller, so this can't be centralized into one method.
 *
 * `resolveAndValidatePath` (pathSecurity.js, used throughout the rest of the
 * codebase) is layered on top as defense in depth: it additionally follows
 * symlinks via `fs.realpath` before its own containment check, catching a
 * symlink planted inside `baseDir` that points back out. It can only make
 * acceptance stricter here, never looser — the inline lexical check above
 * still has to pass regardless.
 */
export class FilesystemProvider extends StorageProvider {
  /**
   * @param {string} baseDir Absolute path to the root directory (e.g. `<root>/contents`).
   */
  constructor(baseDir) {
    super();
    this.baseDir = baseDir;
  }

  /**
   * Symlink-aware defense-in-depth check, layered on top of the inline
   * lexical guard every call site performs on its own. Returns nothing
   * useful to callers (deliberately) — callers must keep using their own
   * locally-resolved, locally-verified path for the actual fs.* call.
   */
  async _assertNoSymlinkEscape(relativePath) {
    const resolved = await resolveAndValidatePath(relativePath, this.baseDir);
    if (!resolved) {
      logger.warn(`Path traversal blocked in FilesystemProvider: ${relativePath}`);
      const error = new Error(`Refusing to access path outside base directory: ${relativePath}`);
      error.code = 'ENOENT';
      throw error;
    }
  }

  async read(relativePath) {
    try {
      await this._assertNoSymlinkEscape(relativePath);
      const normalizedBase = path.resolve(this.baseDir);
      const normalizedPath = path.resolve(normalizedBase, relativePath);
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
    await this._assertNoSymlinkEscape(relativePath);
    const normalizedBase = path.resolve(this.baseDir);
    const normalizedPath = path.resolve(normalizedBase, relativePath);
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
    await this._assertNoSymlinkEscape(relativePath);
    const normalizedBase = path.resolve(this.baseDir);
    const normalizedPath = path.resolve(normalizedBase, relativePath);
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
      await this._assertNoSymlinkEscape(relativePath);
      const normalizedBase = path.resolve(this.baseDir);
      const normalizedPath = path.resolve(normalizedBase, relativePath);
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
      await this._assertNoSymlinkEscape(relativeDir);
      const normalizedBase = path.resolve(this.baseDir);
      const normalizedPath = path.resolve(normalizedBase, relativeDir);
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
