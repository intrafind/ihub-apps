import SourceHandler from './SourceHandler.js';
import configCache from '../configCache.js';
import { enhanceFetchOptions } from '../utils/httpConfig.js';

/**
 * URL Source Handler
 *
 * Loads content from web URLs. Uses the existing webContentExtractor tool
 * to fetch and clean web content for use as source material.
 */
class URLHandler extends SourceHandler {
  constructor(config = {}) {
    super(config);
    // Default to longer TTL for web content since it changes less frequently
    this.cacheConfig = { ttl: 7200, strategy: 'static', ...config.caching };
  }

  /**
   * Load content from URL
   * @param {Object} sourceConfig - { url: string, options?: Object }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent(sourceConfig) {
    const { url, options = {} } = sourceConfig;

    if (!url) {
      throw new Error('URLHandler requires a url in sourceConfig');
    }

    if (!this.isValidURL(url)) {
      throw new Error(`Invalid URL: ${url}`);
    }

    try {
      // Import the webContentExtractor tool dynamically
      const webContentExtractor = await this.getWebContentExtractor();

      // Apply global SSL configuration if not explicitly overridden
      const platformConfig = configCache.getPlatform() || {};
      const shouldIgnoreSSL = options.ignoreSSL !== undefined ? options.ignoreSSL : 
        (platformConfig.ssl?.ignoreInvalidCertificates || false);

      // Extract content using the existing tool
      const result = await webContentExtractor.extract({
        url,
        maxContentLength: options.maxContentLength || 50000,
        includeMetadata: true,
        cleanContent: options.cleanContent !== false,
        followRedirects: options.followRedirects !== false,
        ignoreSSL: shouldIgnoreSSL
      });

      return {
        content: result.content,
        metadata: {
          type: 'url',
          url,
          link: result.metadata?.finalUrl || url, // Use final URL as link for references
          title: result.metadata?.title || '',
          description: result.metadata?.description || '',
          contentLength: result.content.length,
          extractedAt: new Date().toISOString(),
          statusCode: result.metadata?.statusCode,
          finalUrl: result.metadata?.finalUrl || url,
          contentType: result.metadata?.contentType,
          loadedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      throw new Error(`Error loading URL ${url}: ${error.message}`);
    }
  }

  /**
   * Get webContentExtractor tool instance
   * @returns {Promise<Object>} - Web content extractor tool
   */
  async getWebContentExtractor() {
    try {
      // Try to load the existing web content extraction functionality
      const webContentExtractor = (await import('../tools/webContentExtractor.js')).default;
      return {
        extract: async params => {
          return await webContentExtractor({
            url: params.url,
            maxLength: params.maxContentLength || 50000,
            ignoreSSL: params.ignoreSSL || false,
            chatId: params.chatId || 'unknown'
          });
        }
      };
    } catch (error) {
      console.warn('Could not load webContentExtractor tool, using fallback:', error.message);
      // Fallback implementation if tool not available
      return this.createFallbackExtractor();
    }
  }

  /**
   * Create fallback extractor using basic fetch
   * @returns {Object} - Basic extractor implementation
   */
  createFallbackExtractor() {
    console.log('Using fallback web content extractor (limited functionality)');

    return {
      extract: async ({
        url,
        maxContentLength = 50000,
        followRedirects = true,
        cleanContent = true
      }) => {
        try {
          console.log(`Fallback extractor: Fetching ${url}`);

          // Use native fetch if available, otherwise import node-fetch
          let fetch;
          if (typeof globalThis.fetch === 'function') {
            fetch = globalThis.fetch;
          } else {
            fetch = (await import('node-fetch')).default;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          const baseOptions = {
            method: 'GET',
            headers: {
              'User-Agent': 'ihub-Apps/1.0 (+https://github.com/intrafind/ihub-apps)',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
              'Accept-Encoding': 'gzip, deflate',
              Connection: 'keep-alive'
            },
            signal: controller.signal,
            redirect: followRedirects ? 'follow' : 'manual'
          };
          
          // Apply global SSL configuration
          const fetchOptions = enhanceFetchOptions(baseOptions, url);

          const response = await fetch(url, fetchOptions);

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          let content = await response.text();
          console.log(`Fallback extractor: Retrieved ${content.length} characters`);

          // Basic HTML content cleaning if requested
          if (cleanContent) {
            content = content
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
              .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
              .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
              .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
          }

          // Truncate content if too long
          if (content.length > maxContentLength) {
            content = content.substring(0, maxContentLength);
            console.log(`Fallback extractor: Content truncated to ${maxContentLength} characters`);
          }

          return {
            content: content,
            metadata: {
              statusCode: response.status,
              contentType: response.headers.get('content-type') || 'unknown',
              finalUrl: response.url,
              link: response.url, // Use final URL as link for references
              title: '',
              description: '',
              extractedAt: new Date().toISOString(),
              extractorType: 'fallback'
            }
          };
        } catch (error) {
          if (error.name === 'AbortError') {
            throw new Error('Request timeout after 30 seconds');
          }
          console.error('Fallback extractor error:', error.message);
          throw error;
        }
      }
    };
  }

  /**
   * Validate URL format
   * @param {string} url - URL to validate
   * @returns {boolean} - True if valid
   */
  isValidURL(url) {
    try {
      const parsedUrl = new URL(url);
      return ['http:', 'https:'].includes(parsedUrl.protocol);
    } catch {
      return false;
    }
  }

  /**
   * Get handler type identifier
   */
  getType() {
    return 'url';
  }

  /**
   * Validate URL source configuration
   * @param {Object} sourceConfig - Configuration to validate
   * @returns {boolean} - True if valid
   */
  validateConfig(sourceConfig) {
    if (!sourceConfig || typeof sourceConfig !== 'object') {
      return false;
    }

    const { url } = sourceConfig;

    if (!url || typeof url !== 'string') {
      return false;
    }

    return this.isValidURL(url);
  }

  /**
   * Get cache key with URL normalization
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {string} - Cache key
   */
  getCacheKey(sourceConfig) {
    const { url, options = {} } = sourceConfig;

    // Normalize URL for consistent caching
    try {
      const parsedUrl = new URL(url);
      const normalizedUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}`;

      return JSON.stringify({
        url: normalizedUrl,
        options: {
          maxContentLength: options.maxContentLength,
          cleanContent: options.cleanContent,
          followRedirects: options.followRedirects
        }
      });
    } catch {
      return JSON.stringify(sourceConfig);
    }
  }

  /**
   * Batch load multiple URLs
   * @param {Array} urls - Array of URL configs
   * @param {Object} options - Batch options
   * @returns {Promise<Array>} - Array of results
   */
  async batchLoad(urls, options = {}) {
    const { concurrency = 3, failureMode = 'continue' } = options;
    const results = [];

    // Process URLs in batches to avoid overwhelming servers
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const promises = batch.map(async urlConfig => {
        try {
          return await this.getCachedContent(urlConfig);
        } catch (error) {
          if (failureMode === 'stop') {
            throw error;
          }
          return {
            content: '',
            metadata: {
              type: 'url',
              url: urlConfig.url,
              link: urlConfig.url, // Use original URL as link even on error
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

export default URLHandler;
