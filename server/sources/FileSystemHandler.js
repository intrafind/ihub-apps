import { promises as fs } from 'fs';
import path from 'path';
import SourceHandler from './SourceHandler.js';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';

/**
 * Filesystem Source Handler
 *
 * Loads content from local filesystem files. Supports various text-based formats
 * and provides file metadata (size, modification date, etc.).
 */
class FileSystemHandler extends SourceHandler {
  constructor(handlerConfig = {}) {
    super(handlerConfig);
    // Use absolute path to contents directory
    const rootDir = getRootDir();
    const contentsDir = config.CONTENTS_DIR || 'contents';
    this.basePath = handlerConfig.basePath || path.join(rootDir, contentsDir);
    console.log(`FileSystemHandler initialized with basePath: ${this.basePath}`);

    // Ensure sources subdirectory exists
    this.ensureSourcesDirectory();
  }

  async ensureSourcesDirectory() {
    try {
      const sourcesPath = path.join(this.basePath, 'sources');
      await fs.mkdir(sourcesPath, { recursive: true });
    } catch (error) {
      console.error('Failed to create sources directory:', error);
    }
  }

  /**
   * Load content from filesystem
   * @param {Object} sourceConfig - { path: string, encoding?: string, url?: string }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent(sourceConfig) {
    const { path: filePath, encoding = 'utf8', url } = sourceConfig;

    if (!filePath) {
      throw new Error('FileSystemHandler requires a path in sourceConfig');
    }

    // Resolve path relative to base path
    const fullPath = path.resolve(this.basePath, filePath.replace(/^\/+/, ''));

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
          link: url || `file://${fullPath}`, // Use custom URL if provided, otherwise file:// URL
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
      const { path: filePath, url, encoding } = sourceConfig;
      const fullPath = path.resolve(this.basePath, filePath.replace(/^\/+/, ''));
      const stats = await fs.stat(fullPath);

      // Include relevant config in cache key for consistency
      const cacheConfig = { path: filePath, url, encoding };
      return `${JSON.stringify(cacheConfig)}:${stats.mtime.getTime()}`;
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
  /**
   * Write content to a file
   * @param {string} filePath - File path relative to base
   * @param {string} content - Content to write
   * @param {string} encoding - File encoding (default: utf8)
   * @returns {Promise<Object>} - Result with metadata
   */
  async writeFile(filePath, content, encoding = 'utf8') {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('File path is required');
    }

    if (typeof content !== 'string') {
      throw new Error('Content must be a string');
    }

    const fullPath = path.resolve(this.basePath, filePath.replace(/^\/+/, ''));

    // Security check
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error(`Access denied: path ${filePath} is outside allowed directory`);
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(fullPath, content, encoding);

      // Get file stats
      const stats = await fs.stat(fullPath);

      // Clear cache for this file
      this.clearFileCache(filePath);

      return {
        success: true,
        path: filePath,
        fullPath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        encoding
      };
    } catch (error) {
      throw new Error(`Error writing file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Delete a file
   * @param {string} filePath - File path relative to base
   * @returns {Promise<Object>} - Result
   */
  async deleteFile(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('File path is required');
    }

    const fullPath = path.resolve(this.basePath, filePath.replace(/^\/+/, ''));

    // Security check
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error(`Access denied: path ${filePath} is outside allowed directory`);
    }

    try {
      await fs.unlink(fullPath);

      // Clear cache for this file
      this.clearFileCache(filePath);

      return {
        success: true,
        path: filePath,
        deleted: true
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`File not found: ${filePath}`);
      }
      throw new Error(`Error deleting file ${filePath}: ${error.message}`);
    }
  }

  /**
   * Create a directory
   * @param {string} dirPath - Directory path relative to base
   * @returns {Promise<Object>} - Result
   */
  async createDirectory(dirPath) {
    if (!dirPath || typeof dirPath !== 'string') {
      throw new Error('Directory path is required');
    }

    const fullPath = path.resolve(this.basePath, dirPath.replace(/^\/+/, ''));

    // Security check
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error(`Access denied: path ${dirPath} is outside allowed directory`);
    }

    try {
      await fs.mkdir(fullPath, { recursive: true });

      return {
        success: true,
        path: dirPath,
        fullPath,
        created: true
      };
    } catch (error) {
      throw new Error(`Error creating directory ${dirPath}: ${error.message}`);
    }
  }

  /**
   * List directories in a path
   * @param {string} dirPath - Directory path relative to base
   * @returns {Promise<Array>} - List of directories
   */
  async listDirectories(dirPath = '') {
    const fullPath = path.resolve(this.basePath, dirPath.replace(/^\/+/, ''));

    // Security check
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error(`Access denied: path ${dirPath} is outside allowed directory`);
    }

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const directories = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const entryPath = path.join(dirPath, entry.name);
          directories.push({
            name: entry.name,
            path: entryPath
          });
        }
      }

      return directories.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw new Error(`Error listing directories in ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Clear cache entries for a specific file
   * @param {string} filePath - File path to clear from cache
   */
  clearFileCache(filePath) {
    // Clear all cache entries that contain this file path
    for (const [key] of this.cache.entries()) {
      if (key.includes(filePath)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get file tree structure
   * @param {string} dirPath - Directory path relative to base
   * @param {number} maxDepth - Maximum depth to traverse (default: 3)
   * @returns {Promise<Object>} - Tree structure
   */
  async getFileTree(dirPath = '', maxDepth = 3, currentDepth = 0) {
    if (currentDepth >= maxDepth) {
      return { files: [], directories: [] };
    }

    const fullPath = path.resolve(this.basePath, dirPath.replace(/^\/+/, ''));

    // Security check
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error(`Access denied: path ${dirPath} is outside allowed directory`);
    }

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const files = [];
      const directories = [];

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);

        if (entry.isFile()) {
          const stats = await fs.stat(path.join(fullPath, entry.name));
          files.push({
            name: entry.name,
            path: entryPath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            extension: path.extname(entry.name).toLowerCase()
          });
        } else if (entry.isDirectory()) {
          const subTree = await this.getFileTree(entryPath, maxDepth, currentDepth + 1);
          directories.push({
            name: entry.name,
            path: entryPath,
            ...subTree
          });
        }
      }

      return {
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
        directories: directories.sort((a, b) => a.name.localeCompare(b.name))
      };
    } catch (error) {
      throw new Error(`Error getting file tree for ${dirPath}: ${error.message}`);
    }
  }
}

export default FileSystemHandler;
