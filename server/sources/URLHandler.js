import SourceHandler from './SourceHandler.js';

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
      
      // Extract content using the existing tool
      const result = await webContentExtractor.extract({
        url,
        maxContentLength: options.maxContentLength || 50000,
        includeMetadata: true,
        cleanContent: options.cleanContent !== false,
        followRedirects: options.followRedirects !== false
      });

      return {
        content: result.content,
        metadata: {
          type: 'url',
          url,
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
      const webTools = require('../tools/web');
      return webTools.webContentExtractor;
    } catch (error) {
      // Fallback implementation if tool not available
      return this.createFallbackExtractor();
    }
  }

  /**
   * Create fallback extractor using basic fetch
   * @returns {Object} - Basic extractor implementation
   */
  createFallbackExtractor() {
    return {
      extract: async ({ url }) => {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'AI-Hub-Apps/1.0 (+https://github.com/intrafind/ai-hub-apps)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 30000,
          follow: 5
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const content = await response.text();
        
        // Basic HTML content cleaning
        const cleanedContent = content
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        return {
          content: cleanedContent,
          metadata: {
            statusCode: response.status,
            contentType: response.headers.get('content-type'),
            finalUrl: response.url
          }
        };
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
    } catch (error) {
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
    } catch (error) {
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
      const promises = batch.map(async (urlConfig) => {
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