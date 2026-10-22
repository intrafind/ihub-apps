// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import URLHandler from './URLHandler.js';
import IFinderHandler from './IFinderHandler.js';
import PageHandler from './PageHandler.js';
import logger from '../utils/logger.js';
import { httpFetch } from '../utils/httpConfig.js';
import { assertPublicTarget, createPinnedLookup } from '../utils/ssrfGuard.js';

/**
 * The registry of the link handlers (URL, iFinder, page) the project items
 * read through, and the probes the pickers use to test a link. Loading
 * sources into a prompt and the source tools went with the sources
 * themselves (#1036); projects reach a handler through `getHandler`.
 */
/** How much of a probed URL's body is read to size it. */
export const URL_TEST_MAX_BYTES = 1024 * 1024;
const URL_TEST_MAX_REDIRECTS = 5;

/**
 * Count a response body up to `maxBytes`, then stop reading (the connection
 * is dropped with the stream), so a probe never buffers a body it does not
 * need and an endless body ends with the bound.
 *
 * @param {AsyncIterable<Buffer|string>|null} body
 * @param {number} maxBytes
 * @returns {Promise<{bytes: number, truncated: boolean}>}
 */
export async function countBodyBytes(body, maxBytes) {
  if (!body) return { bytes: 0, truncated: false };
  let bytes = 0;
  for await (const chunk of body) {
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (bytes >= maxBytes) {
      if (typeof body.destroy === 'function') body.destroy();
      return { bytes: maxBytes, truncated: true };
    }
  }
  return { bytes, truncated: false };
}

/**
 * Probe a URL the way the URL source would read it, without keeping the body.
 *
 * Any signed-in user may probe a URL from the project picker, so the probe is
 * held to the same line as the reader: no private or internal target, every
 * redirect hop checked again, DNS pinned to the checked address, and the body
 * counted up to a bound while the timeout stays armed.
 *
 * The configured `headers` (often `Authorization` or an API key) go only to
 * the origin — scheme, host and port — of the configured URL. A hop to any
 * other origin, an HTTPS-to-HTTP downgrade included, is sent without them.
 *
 * @param {Object} config - Source configuration
 * @param {string} config.url - URL to probe
 * @param {string} [config.method='GET'] - HTTP method
 * @param {number} [config.timeout=10000] - Whole-probe deadline in ms
 * @param {Object<string, string>} [config.headers={}] - Headers for the original origin
 * @param {number} [config.maxBytes=URL_TEST_MAX_BYTES] - Body bytes counted at most
 * @param {Object} [options]
 * @param {(url: URL) => Promise<{ok: boolean, reason?: string, addresses?: string[]}>}
 *   [options.checkTarget=assertPublicTarget] - The per-hop target check; a
 *   test substitutes one that admits a loopback server
 * @returns {Promise<Object>} `{accessible, status, statusText, contentType,
 *   contentLength, contentTruncated?, headerContentLength, duration}`
 * @throws {Error} On a blocked target, a failed request, a non-2xx answer or
 *   the timeout
 */
export async function probeUrl(config, { checkTarget = assertPublicTarget } = {}) {
  const {
    url,
    method = 'GET',
    timeout = 10000,
    headers = {},
    maxBytes = URL_TEST_MAX_BYTES
  } = config;

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    let hop = new URL(url);
    const origin = hop.origin;
    let response = null;
    for (let redirects = 0; ; redirects += 1) {
      if (redirects > URL_TEST_MAX_REDIRECTS) throw new Error('Too many redirects');
      if (hop.protocol !== 'http:' && hop.protocol !== 'https:') {
        throw new Error(`Unsupported URL scheme ${hop.protocol}`);
      }
      const target = await checkTarget(hop);
      if (!target.ok) {
        throw new Error(`Access to private/internal addresses is not allowed (${target.reason})`);
      }
      response = await httpFetch(hop.href, {
        method,
        headers: hop.origin === origin ? headers : {},
        signal: controller.signal,
        redirect: 'manual',
        lookup: createPinnedLookup(target.addresses)
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        hop = new URL(location, hop);
        continue;
      }
      break;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'unknown';
    const headerContentLength = response.headers.get('content-length');
    const body = await countBodyBytes(response.body, maxBytes);
    const duration = Date.now() - startTime;

    return {
      accessible: true,
      status: response.status,
      statusText: response.statusText,
      contentType,
      contentLength: body.bytes,
      ...(body.truncated ? { contentTruncated: true } : {}),
      headerContentLength: headerContentLength ? Number.parseInt(headerContentLength) : null,
      duration
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw new Error(`URL test failed: ${error.message}`);
  } finally {
    // Every exit, not only the timeout: a redirect's body and a failed
    // answer's body are never read, and aborting is what closes their
    // connections. A successful body has been counted by now, so this
    // changes nothing for it.
    controller.abort();
    clearTimeout(timeoutId);
  }
}

class SourceManager {
  constructor(config = {}) {
    this.config = config;
    this.handlers = new Map();

    // Initialize default handlers
    this.initializeHandlers();
  }

  /**
   * Initialize default source handlers
   */
  initializeHandlers() {
    try {
      // Register URL handler
      logger.info('Initializing URL handler...');
      this.registerHandler('url', new URLHandler(this.config.url || {}));
      logger.info('✓ URL handler registered successfully');

      // Register iFinder handler
      logger.info('Initializing iFinder handler...');
      this.registerHandler('ifinder', new IFinderHandler(this.config.ifinder || {}));
      logger.info('✓ iFinder handler registered successfully');

      // Register Page handler
      logger.info('Initializing Page handler...');
      this.registerHandler('page', new PageHandler(this.config.page || {}));
      logger.info('✓ Page handler registered successfully');

      logger.info(
        `✓ All source handlers initialized: ${Array.from(this.handlers.keys()).join(', ')}`
      );
    } catch (error) {
      logger.error('Error initializing source handlers:', error.message);
      logger.error('Stack trace:', error.stack);
      throw new Error(`Failed to initialize source handlers: ${error.message}`);
    }
  }

  /**
   * Register a new source handler
   * @param {string} type - Handler type identifier
   * @param {SourceHandler} handler - Handler instance
   */
  registerHandler(type, handler) {
    if (!type || typeof type !== 'string') {
      throw new Error('Handler type must be a non-empty string');
    }

    if (!handler || typeof handler.loadContent !== 'function') {
      throw new Error('Handler must implement loadContent method');
    }

    this.handlers.set(type, handler);
  }

  /**
   * Get handler by type
   * @param {string} type - Handler type
   * @returns {SourceHandler} - Handler instance
   */
  getHandler(type) {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for type: ${type}`);
    }
    return handler;
  }

  /**
   * Test source connection without loading content
   * @param {string} type - Handler type
   * @param {Object} config - Source configuration
   * @returns {Promise<Object>} Test results
   */
  async testSource(type, config) {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`Unknown source handler: ${type}`);
    }

    // Test connection based on handler type
    switch (type) {
      case 'url':
        return await this.testUrlSource(config);
      case 'ifinder':
        return await this.testIFinderSource(config);
      case 'page':
        return await this.testPageSource(config);
      default:
        throw new Error(`Testing not implemented for handler: ${type}`);
    }
  }

  /**
   * Test URL source. See {@link probeUrl}.
   *
   * @param {Object} config - Source configuration (`url`, `method`, `timeout`,
   *   `headers`, `maxBytes`)
   * @returns {Promise<Object>} Test results
   */
  testUrlSource(config) {
    return probeUrl(config);
  }

  /**
   * Test iFinder source
   */
  async testIFinderSource(config) {
    try {
      const startTime = Date.now();

      // Use the existing IFinderHandler to test. Keep the probe light: a
      // single document with trimmed content. When the source pins a
      // documentId that document is loaded; otherwise the configured query
      // (or a generic fallback) is searched.
      const handler = this.handlers.get('ifinder');
      const testConfig = { ...config, maxResults: 1, maxLength: 1000 };
      if (!testConfig.documentId && !testConfig.query) {
        testConfig.query = 'test';
      }

      const result = await handler.loadContent(testConfig);
      const duration = Date.now() - startTime;

      return {
        accessible: true,
        searchProfile: result.metadata?.searchProfile || config.searchProfile,
        duration,
        ...(testConfig.documentId
          ? { documentId: testConfig.documentId, documentTitle: result.metadata?.title }
          : { testQuery: testConfig.query, totalFound: result.metadata?.totalFound })
      };
    } catch (error) {
      throw new Error(`iFinder test failed: ${error.message}`);
    }
  }

  /**
   * Test page source
   */
  async testPageSource(config) {
    const { pageId, language = 'en' } = config;

    if (!pageId) {
      throw new Error('Page testing requires a pageId');
    }

    try {
      const handler = this.handlers.get('page');
      const result = await handler.pageExists(pageId);

      if (!result.exists) {
        throw new Error(`Page '${pageId}' not found in any language`);
      }

      return {
        accessible: true,
        pageId,
        requestedLanguage: language,
        availableLanguages: result.languages,
        defaultLanguage: handler.defaultLanguage,
        url: handler.generatePageUrl(pageId, language)
      };
    } catch (error) {
      throw new Error(`Page test failed: ${error.message}`);
    }
  }
}

export default SourceManager;
