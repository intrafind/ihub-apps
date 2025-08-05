import { promises as fs } from 'fs';
import path from 'path';
import SourceHandler from './SourceHandler.js';
import { getRootDir } from '../pathUtils.js';

/**
 * Page Source Handler
 *
 * Loads content from the pages directory (contents/pages/{lang}/).
 * Supports both .md and .jsx files and generates appropriate page URLs as links.
 * Handles language resolution and provides page metadata.
 */
class PageHandler extends SourceHandler {
  constructor(config = {}) {
    super(config);
    this.pagesBasePath = config.pagesBasePath || path.join(getRootDir(), 'contents', 'pages');
    this.defaultLanguage = config.defaultLanguage || 'en';
    this.baseUrl = config.baseUrl || process.env.BASE_URL || '';
  }

  /**
   * Load content from pages directory
   * @param {Object} sourceConfig - { pageId: string, language?: string, baseUrl?: string }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent(sourceConfig) {
    const { pageId, language = this.defaultLanguage, baseUrl = this.baseUrl } = sourceConfig;

    if (!pageId) {
      throw new Error('PageHandler requires a pageId in sourceConfig');
    }

    // Try to find the page file (prefer .jsx over .md)
    const possibleExtensions = ['.jsx', '.md'];
    let foundFile = null;
    let actualLanguage = language;
    let fileExtension = null;

    // First try the requested language
    for (const ext of possibleExtensions) {
      const filePath = path.join(this.pagesBasePath, language, `${pageId}${ext}`);
      if (await this.fileExists(filePath)) {
        foundFile = filePath;
        fileExtension = ext;
        break;
      }
    }

    // If not found in requested language, try default language
    if (!foundFile && language !== this.defaultLanguage) {
      actualLanguage = this.defaultLanguage;
      for (const ext of possibleExtensions) {
        const filePath = path.join(this.pagesBasePath, this.defaultLanguage, `${pageId}${ext}`);
        if (await this.fileExists(filePath)) {
          foundFile = filePath;
          fileExtension = ext;
          break;
        }
      }
    }

    if (!foundFile) {
      throw new Error(
        `Page not found: ${pageId} (tried languages: ${language}, ${this.defaultLanguage})`
      );
    }

    try {
      // Get file stats
      const stats = await fs.stat(foundFile);

      if (!stats.isFile()) {
        throw new Error(`Path ${foundFile} is not a file`);
      }

      // Load content
      const content = await fs.readFile(foundFile, 'utf8');

      // Generate page URL
      const pageUrl = this.generatePageUrl(pageId, actualLanguage, baseUrl);

      return {
        content,
        metadata: {
          type: 'page',
          pageId,
          language: actualLanguage,
          requestedLanguage: language,
          fileExtension,
          link: pageUrl, // Generated page URL for references
          filePath: foundFile,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          created: stats.birthtime.toISOString(),
          contentType: fileExtension === '.jsx' ? 'react-component' : 'markdown',
          loadedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Page file not found: ${foundFile}`);
      } else if (error.code === 'EACCES') {
        throw new Error(`Permission denied: ${foundFile}`);
      } else {
        throw new Error(`Error loading page ${pageId}: ${error.message}`);
      }
    }
  }

  /**
   * Generate page URL based on pageId and language
   * @param {string} pageId - Page identifier
   * @param {string} language - Language code
   * @param {string} baseUrl - Base URL for the application
   * @returns {string} - Generated page URL
   */
  generatePageUrl(pageId, language, baseUrl = '') {
    // Remove trailing slash from baseUrl
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');

    // Generate the page URL
    if (language === this.defaultLanguage) {
      return `${cleanBaseUrl}/pages/${pageId}`;
    } else {
      return `${cleanBaseUrl}/${language}/pages/${pageId}`;
    }
  }

  /**
   * Enhanced cache key that includes file modification time and language
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {Promise<string>} - Cache key
   */
  async getEnhancedCacheKey(sourceConfig) {
    try {
      const { pageId, language = this.defaultLanguage, baseUrl } = sourceConfig;

      // Find the actual file that would be loaded
      const possibleExtensions = ['.jsx', '.md'];
      let foundFile = null;
      let actualLanguage = language;

      // First try the requested language
      for (const ext of possibleExtensions) {
        const filePath = path.join(this.pagesBasePath, language, `${pageId}${ext}`);
        if (await this.fileExists(filePath)) {
          foundFile = filePath;
          break;
        }
      }

      // If not found in requested language, try default language
      if (!foundFile && language !== this.defaultLanguage) {
        actualLanguage = this.defaultLanguage;
        for (const ext of possibleExtensions) {
          const filePath = path.join(this.pagesBasePath, this.defaultLanguage, `${pageId}${ext}`);
          if (await this.fileExists(filePath)) {
            foundFile = filePath;
            break;
          }
        }
      }

      if (foundFile) {
        const stats = await fs.stat(foundFile);
        const cacheConfig = { pageId, language: actualLanguage, baseUrl };
        return `${JSON.stringify(cacheConfig)}:${stats.mtime.getTime()}`;
      }

      // Fallback if file not found
      return JSON.stringify(sourceConfig);
    } catch {
      // Fallback to basic cache key if file stat fails
      return this.getCacheKey(sourceConfig);
    }
  }

  /**
   * Override getCachedContent to use enhanced cache key with file modification time
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
    return 'page';
  }

  /**
   * Validate page source configuration
   * @param {Object} sourceConfig - Configuration to validate
   * @returns {boolean} - True if valid
   */
  validateConfig(sourceConfig) {
    if (!sourceConfig || typeof sourceConfig !== 'object') {
      return false;
    }

    const { pageId, language } = sourceConfig;

    if (!pageId || typeof pageId !== 'string' || pageId.trim() === '') {
      return false;
    }

    // Validate pageId format (alphanumeric, hyphens, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(pageId)) {
      return false;
    }

    // Validate language if provided
    if (language && (typeof language !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(language))) {
      return false;
    }

    return true;
  }

  /**
   * Check if file exists
   * @param {string} filePath - File path to check
   * @returns {Promise<boolean>} - True if file exists
   */
  async fileExists(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  /**
   * List available pages for a language
   * @param {string} language - Language code
   * @returns {Promise<Array>} - List of pages with metadata
   */
  async listPages(language = this.defaultLanguage) {
    const languagePath = path.join(this.pagesBasePath, language);

    try {
      const entries = await fs.readdir(languagePath, { withFileTypes: true });
      const pages = [];

      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.jsx'))) {
          const pageId = path.basename(entry.name, path.extname(entry.name));
          const filePath = path.join(languagePath, entry.name);
          const stats = await fs.stat(filePath);

          pages.push({
            pageId,
            language,
            fileName: entry.name,
            extension: path.extname(entry.name),
            contentType: entry.name.endsWith('.jsx') ? 'react-component' : 'markdown',
            size: stats.size,
            modified: stats.mtime.toISOString(),
            url: this.generatePageUrl(pageId, language)
          });
        }
      }

      return pages.sort((a, b) => a.pageId.localeCompare(b.pageId));
    } catch (error) {
      throw new Error(`Error listing pages for language ${language}: ${error.message}`);
    }
  }

  /**
   * Get available languages
   * @returns {Promise<Array>} - List of available language codes
   */
  async getAvailableLanguages() {
    try {
      const entries = await fs.readdir(this.pagesBasePath, { withFileTypes: true });
      const languages = [];

      for (const entry of entries) {
        if (entry.isDirectory() && /^[a-z]{2}(-[A-Z]{2})?$/.test(entry.name)) {
          languages.push(entry.name);
        }
      }

      return languages.sort();
    } catch (error) {
      throw new Error(`Error getting available languages: ${error.message}`);
    }
  }

  /**
   * Check if page exists in any supported language
   * @param {string} pageId - Page identifier
   * @returns {Promise<Object>} - { exists: boolean, languages: Array }
   */
  async pageExists(pageId) {
    if (!this.validatePageId(pageId)) {
      return { exists: false, languages: [] };
    }

    try {
      const availableLanguages = await this.getAvailableLanguages();
      const existingLanguages = [];

      for (const lang of availableLanguages) {
        const possibleExtensions = ['.jsx', '.md'];
        for (const ext of possibleExtensions) {
          const filePath = path.join(this.pagesBasePath, lang, `${pageId}${ext}`);
          if (await this.fileExists(filePath)) {
            existingLanguages.push({
              language: lang,
              extension: ext,
              contentType: ext === '.jsx' ? 'react-component' : 'markdown'
            });
            break; // Found in this language, move to next language
          }
        }
      }

      return {
        exists: existingLanguages.length > 0,
        languages: existingLanguages
      };
    } catch (error) {
      return { exists: false, languages: [], error: error.message };
    }
  }

  /**
   * Validate page ID format
   * @param {string} pageId - Page identifier to validate
   * @returns {boolean} - True if valid
   */
  validatePageId(pageId) {
    return pageId && typeof pageId === 'string' && /^[a-zA-Z0-9_-]+$/.test(pageId);
  }

  /**
   * Batch load multiple pages
   * @param {Array} pageConfigs - Array of page configurations
   * @param {Object} options - Batch options
   * @returns {Promise<Array>} - Array of page results
   */
  async batchLoadPages(pageConfigs, options = {}) {
    const { concurrency = 5, failureMode = 'continue' } = options;
    const results = [];

    // Process pages in batches
    for (let i = 0; i < pageConfigs.length; i += concurrency) {
      const batch = pageConfigs.slice(i, i + concurrency);
      const promises = batch.map(async pageConfig => {
        try {
          return await this.getCachedContent(pageConfig);
        } catch (error) {
          if (failureMode === 'stop') {
            throw error;
          }
          return {
            content: '',
            metadata: {
              type: 'page',
              pageId: pageConfig.pageId,
              language: pageConfig.language || this.defaultLanguage,
              link: this.generatePageUrl(
                pageConfig.pageId,
                pageConfig.language || this.defaultLanguage,
                pageConfig.baseUrl
              ),
              error: error.message,
              loadedAt: new Date().toISOString()
            }
          };
        }
      });

      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }

    return results;
  }
}

export default PageHandler;
