import { promises as fs } from 'fs';
import path from 'path';
import SourceHandler from './SourceHandler.js';

/**
 * Filesystem Source Handler
 *
 * Loads content from local filesystem files. Supports various text-based formats
 * and provides file metadata (size, modification date, etc.).
 */
class FileSystemHandler extends SourceHandler {
  constructor(config = {}) {
    super(config);
    this.basePath = config.basePath || process.env.CONTENTS_DIR || './contents';
  }

  /**
   * Load content from filesystem
   * @param {Object} sourceConfig - { path: string, encoding?: string }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent(sourceConfig) {
    const { path: filePath, encoding = 'utf8' } = sourceConfig;

    if (!filePath) {
      throw new Error('FileSystemHandler requires a path in sourceConfig');
    }

    // Resolve path relative to base path
    const fullPath = path.resolve(this.basePath, filePath.replace(/^\/+/, ''));

    // Debug logging
    console.log(`FileSystemHandler Debug:
      - basePath: ${this.basePath}
      - requestedPath: ${filePath}
      - resolvedFullPath: ${fullPath}
      - basePathResolved: ${path.resolve(this.basePath)}`);

    // Security check - ensure path is within base directory
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error(`Access denied: path ${filePath} is outside allowed directory`);
    }

    try {
      // Get file stats
      const stats = await fs.stat(fullPath);

      if (!stats.isFile()) {
        throw new Error(`Path ${filePath} is not a file`);
      }

      // Load content
      const content = await fs.readFile(fullPath, encoding);

      return {
        content,
        metadata: {
          type: 'file',
          path: filePath,
          fullPath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          created: stats.birthtime.toISOString(),
          encoding,
          extension: path.extname(filePath).toLowerCase(),
          loadedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`File not found: ${filePath}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied: ${filePath}`);
      } else {
        throw new Error(`Error loading file ${filePath}: ${error.message}`);
      }
    }
  }

  /**
   * Enhanced cache key that includes file modification time
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {Promise<string>} - Cache key
   */
  async getEnhancedCacheKey(sourceConfig) {
    try {
      const { path: filePath } = sourceConfig;
      const fullPath = path.resolve(this.basePath, filePath.replace(/^\/+/, ''));
      const stats = await fs.stat(fullPath);
      return `${JSON.stringify(sourceConfig)}:${stats.mtime.getTime()}`;
    } catch {
      // Fallback to basic cache key if file stat fails
      return this.getCacheKey(sourceConfig);
    }
  }

  /**
   * Override getCachedContent to use file modification time in cache key
   */
  async getCachedContent(sourceConfig) {
    const cacheKey = await this.getEnhancedCacheKey(sourceConfig);
    const cached = this.cache.get(cacheKey);

    if (cached && this.isCacheValid(cached)) {
      return cached.data;
    }

    // Load fresh content
    const data = await this.loadContent(sourceConfig);

    // Cache the result
    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      ttl: this.cacheConfig.ttl * 1000
    });

    return data;
  }

  /**
   * Get handler type identifier
   */
  getType() {
    return 'filesystem';
  }

  /**
   * Validate filesystem source configuration
   * @param {Object} sourceConfig - Configuration to validate
   * @returns {boolean} - True if valid
   */
  validateConfig(sourceConfig) {
    if (!sourceConfig || typeof sourceConfig !== 'object') {
      return false;
    }

    const { path: filePath } = sourceConfig;

    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      return false;
    }

    // Check for suspicious path patterns
    if (filePath.includes('..') || filePath.includes('~') || path.isAbsolute(filePath)) {
      return false;
    }

    return true;
  }

  /**
   * List available files in a directory
   * @param {string} dirPath - Directory path relative to base
   * @returns {Promise<Array>} - List of files with metadata
   */
  async listFiles(dirPath = '') {
    const fullPath = path.resolve(this.basePath, dirPath.replace(/^\/+/, ''));

    // Security check
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error(`Access denied: path ${dirPath} is outside allowed directory`);
    }

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const files = [];

      for (const entry of entries) {
        if (entry.isFile()) {
          const entryPath = path.join(dirPath, entry.name);
          const stats = await fs.stat(path.join(fullPath, entry.name));

          files.push({
            name: entry.name,
            path: entryPath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            extension: path.extname(entry.name).toLowerCase()
          });
        }
      }

      return files.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`Error listing files in ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Check if file exists
   * @param {string} filePath - File path to check
   * @returns {Promise<boolean>} - True if file exists
   */
  async fileExists(filePath) {
    try {
      const fullPath = path.resolve(this.basePath, filePath.replace(/^\/+/, ''));
      const stats = await fs.stat(fullPath);
      return stats.isFile();
    } catch {
      return false;
    }
  }
}

export default FileSystemHandler;
