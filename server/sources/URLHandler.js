// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import SourceHandler from './SourceHandler.js';
import logger from '../utils/logger.js';
import { publish, subscribe } from '../clusterBus.js';

/** Characters of a page one read returns unless the item sets `maxContentLength`. */
const DEFAULT_MAX_CONTENT_LENGTH = 50000;

/**
 * URL Source Handler
 *
 * Loads content from web URLs through the page reader
 * (`services/pageReader/pageReader.js`), the one way iHub reads a web page: the
 * same fetch (SSRF guard on every hop, proxy, certificate whitelist), the same
 * extraction and the same page cache as `read_url` and the search tools'
 * `extractContent`. This handler adds only the source-handler cache and its
 * metadata.
 */
class URLHandler extends SourceHandler {
  constructor(config = {}) {
    super(config);
    // Default to longer TTL for web content since it changes less frequently
    this.cacheConfig = { ttl: 7200, strategy: 'static', ...config.caching };
  }

  /**
   * Load content from URL
   * @param {Object} sourceConfig - { url: string, chatId?: string, options?: { maxContentLength?: number } }
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent(sourceConfig) {
    const { url, chatId, options = {} } = sourceConfig;

    if (!url) {
      throw new Error('URLHandler requires a url in sourceConfig');
    }

    if (!this.isValidURL(url)) {
      throw new Error(`Invalid URL: ${url}`);
    }

    try {
      const result = await this.readPage({
        url,
        maxLength: options.maxContentLength || DEFAULT_MAX_CONTENT_LENGTH,
        chatId
      });

      const finalUrl = result.finalUrl || url;
      return {
        content: result.content,
        metadata: {
          type: 'url',
          url,
          link: finalUrl, // Use final URL as link for references
          title: result.title || '',
          description: result.description || '',
          contentLength: result.content.length,
          extractedAt: new Date().toISOString(),
          finalUrl,
          contentType: result.contentType,
          // Only the first `maxContentLength` characters (or the reader's
          // own cap) came back: a consumer must not take this as the page.
          truncated: result.truncated === true || result.incomplete === true,
          loadedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      throw new Error(`Error loading URL ${url}: ${error.message}`);
    }
  }

  /**
   * Read a page with the page reader. A method of its own so a test can
   * stand in for the network.
   * @param {Object} params - The page reader's parameters (`url`, `maxLength`, `chatId`)
   * @returns {Promise<Object>} - The page reader's result
   */
  async readPage(params) {
    const { readWebPage } = await import('../services/pageReader/pageReader.js');
    return readWebPage(params);
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
          maxContentLength: options.maxContentLength
        }
      });
    } catch {
      return JSON.stringify(sourceConfig);
    }
  }

  /**
   * Forget every cached read of one URL, whatever its options.
   * @param {string} url
   * @returns {number} Entries dropped.
   */
  forget(url) {
    const key = this.getCacheKey({ url });
    const target = JSON.parse(key).url;
    let dropped = 0;
    for (const cacheKey of [...this.cache.keys()]) {
      try {
        if (JSON.parse(cacheKey).url !== target) continue;
      } catch {
        continue;
      }
      this.cache.delete(cacheKey);
      dropped += 1;
    }
    return dropped;
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

/** The cluster channel that tells every worker to forget a page's cached reads. */
export const FORGET_URL_CHANNEL = 'project-url-cache:forget';

/** Forget a page's cached reads in this process only. */
async function forgetLocally(url) {
  if (typeof url !== 'string' || !url) return;
  const { createSourceManager } = await import('./index.js');
  createSourceManager().getHandler('url')?.forget?.(url);
  const { forgetCachedPage } = await import('../services/pageCache.js');
  forgetCachedPage(url);
}

subscribe(FORGET_URL_CHANNEL, payload => {
  forgetLocally(payload?.url).catch(error =>
    logger.warn('Could not forget a cached page read', {
      component: 'URLHandler',
      error: error.message
    })
  );
});

/**
 * Forget a web page's cached reads — the URL handler's and the page
 * reader's — on every worker, so its next read fetches it again ("Refresh
 * now" of a project's web page item, #3536). This worker forgets at once; the
 * others when the cluster bus delivers the message.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function forgetCachedUrl(url) {
  if (typeof url !== 'string' || !url) return;
  await forgetLocally(url);
  publish(FORGET_URL_CHANNEL, { url });
}

export default URLHandler;
