import { JSDOM } from 'jsdom';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { throttledFetch } from '../requestThrottler.js';
import { actionTracker } from '../actionTracker.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { enhanceFetchOptions } from '../utils/httpConfig.js';

function createError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Extract clean, readable content from a web page
 * Removes headers, footers, navigation, ads, and other non-content elements
 */
export default async function webContentExtractor({
  url,
  uri,
  link,
  maxLength = 5000,
  ignoreSSL = null,
  chatId
}) {
  actionTracker.trackToolCallStart(chatId, {
    toolName: 'webContentExtractor',
    toolInput: { url: url || uri || link }
  });
  actionTracker.trackToolCallProgress(chatId, {
    toolName: 'webContentExtractor',
    status: 'loading',
    message: 'Fetching content'
  });
  // Accept various URL parameter names for flexibility
  const targetUrl = url || uri || link;

  if (!targetUrl) {
    throw createError('url parameter is required (use "url", "uri", or "link")', 'MISSING_URL');
  }

  // Validate URL format
  let validUrl;
  try {
    validUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(validUrl.protocol)) {
      throw createError('Only HTTP and HTTPS URLs are supported', 'UNSUPPORTED_PROTOCOL');
    }
  } catch (error) {
    throw createError(`Invalid URL: ${error.message}`, 'INVALID_URL');
  }

  // Determine SSL ignore setting: explicit parameter > global config > default false
  const platformConfig = configCache.getPlatform() || {};
  const shouldIgnoreSSL =
    ignoreSSL !== null ? ignoreSSL : platformConfig.ssl?.ignoreInvalidCertificates || false;

  try {
    // Fetch the webpage with appropriate headers and timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    // Build base fetch options
    const fetchOptions = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      signal: controller.signal
    };

    // Apply SSL and proxy configuration using the centralized httpConfig utility
    const enhancedOptions = enhanceFetchOptions(fetchOptions, targetUrl, shouldIgnoreSSL);

    const response = await throttledFetch('webContentExtractor', targetUrl, enhancedOptions);

    actionTracker.trackToolCallProgress(chatId, {
      toolName: 'webContentExtractor',
      status: 'parsing'
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 404) {
        throw createError('Page could not be found (HTTP 404)', 'PAGE_NOT_FOUND');
      }
      if (response.status === 401 || response.status === 403) {
        throw createError(
          `Authentication required to access this page (HTTP ${response.status})`,
          'AUTH_REQUIRED'
        );
      }
      throw createError(
        `Failed to fetch webpage: ${response.status} ${response.statusText}`,
        'FETCH_ERROR'
      );
    }

    // Handle PDF content
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/pdf')) {
      actionTracker.trackToolCallProgress(chatId, {
        toolName: 'webContentExtractor',
        status: 'extracting',
        type: 'pdf'
      });

      try {
        const arrayBuffer = await response.arrayBuffer();

        // Use pdfjs-dist to parse the PDF
        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(arrayBuffer),
          verbosity: 0 // Suppress console output
        });

        const pdf = await loadingTask.promise;

        let fullText = '';
        const maxPagesToProcess = Math.min(pdf.numPages, 10); // Limit to first 10 pages for performance

        // Extract text from each page
        for (let pageNum = 1; pageNum <= maxPagesToProcess; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map(item => item.str).join(' ');
          fullText += pageText + '\n';

          // Stop if we have enough content
          if (fullText.length > maxLength * 2) break;
        }

        const textContent = fullText.substring(0, maxLength);
        const output = {
          url: targetUrl,
          title: targetUrl.split('/').pop(), // Use filename as title
          description: 'PDF document',
          author: '', // pdfjs-dist doesn't easily expose metadata
          content: textContent.trim(),
          wordCount: textContent.trim().split(/\s+/).length,
          extractedAt: new Date().toISOString()
        };
        actionTracker.trackToolCallEnd(chatId, {
          toolName: 'webContentExtractor',
          toolOutput: { type: 'pdf' }
        });
        return output;
      } catch (pdfError) {
        throw createError(`Failed to parse PDF: ${pdfError.message}`, 'PDF_PARSE_ERROR');
      }
    }

    let html = await response.text();
    actionTracker.trackToolCallProgress(chatId, {
      toolName: 'webContentExtractor',
      status: 'extracting',
      type: 'html'
    });
    // Pre-emptively remove style tags to prevent CSS parsing errors from JSDOM
    html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Remove unwanted elements
    const unwantedSelectors = [
      'script',
      'style',
      'noscript',
      'iframe',
      'embed',
      'object',
      'header',
      'footer',
      'nav',
      'aside',
      'menu',
      '.advertisement',
      '.ad',
      '.ads',
      '.sidebar',
      '.popup',
      '.cookie-banner',
      '.newsletter',
      '.social-share',
      '.related-articles',
      '.comments',
      '.pagination',
      '[role="banner"]',
      '[role="navigation"]',
      '[role="complementary"]',
      '.header',
      '.footer',
      '.nav',
      '.navbar',
      '.menu',
      '.sidebar',
      '.ad-container',
      '.advertisement-container',
      '.sponsored',
      '.cookie-notice',
      '.gdpr-banner',
      '.privacy-notice'
    ];

    unwantedSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => el.remove());
    });

    // Try to find the main content area
    let contentElement = null;
    const contentSelectors = [
      'main',
      'article',
      '[role="main"]',
      '.content',
      '.main-content',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.page-content',
      '.body-content',
      '#content',
      '#main-content',
      '#article-content'
    ];

    for (const selector of contentSelectors) {
      contentElement = document.querySelector(selector);
      if (contentElement) break;
    }

    // If no main content area found, use body but filter more aggressively
    if (!contentElement) {
      contentElement = document.body;

      // Remove more elements that are typically not main content
      const additionalUnwanted = [
        '.breadcrumb',
        '.breadcrumbs',
        '.tags',
        '.categories',
        '.meta',
        '.metadata',
        '.author-info',
        '.date',
        '.share-buttons',
        '.social-buttons',
        '.widget',
        '.promo',
        '.promotion',
        '.banner',
        '.alert'
      ];

      additionalUnwanted.forEach(selector => {
        const elements = contentElement.querySelectorAll(selector);
        elements.forEach(el => el.remove());
      });
    }

    if (!contentElement) {
      throw createError('Could not find content in the webpage', 'CONTENT_NOT_FOUND');
    }

    // Extract text content
    let textContent = contentElement.textContent || '';

    // Clean up the text
    textContent = textContent
      .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
      .replace(/\n\s*\n/g, '\n') // Replace multiple newlines with single newline
      .trim();

    // Remove empty lines and excessive whitespace
    textContent = textContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    // Truncate if too long
    if (textContent.length > maxLength) {
      textContent = textContent.substring(0, maxLength) + '...';
    }

    // Extract some metadata
    const title = document.querySelector('title')?.textContent?.trim() || '';
    const description =
      document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
    const author =
      document.querySelector('meta[name="author"]')?.getAttribute('content')?.trim() || '';

    const output = {
      url: targetUrl,
      title: title,
      description: description,
      author: author,
      content: textContent,
      wordCount: textContent.split(/\s+/).length,
      extractedAt: new Date().toISOString()
    };
    actionTracker.trackToolCallEnd(chatId, {
      toolName: 'webContentExtractor',
      toolOutput: { type: 'html' }
    });
    return output;
  } catch (error) {
    if (error.name === 'AbortError') {
    }
    if (/certificate|SSL/i.test(error.message) && !shouldIgnoreSSL) {
      throw createError(
        `TLS certificate error: ${error.message}. Please contact your administrator to resolve invalid certificates or enable global SSL ignore in platform configuration.`,
        'TLS_ERROR'
      );
    }
    throw createError(
      `Failed to extract content from webpage: ${error.message}`,
      'EXTRACTION_FAILED'
    );
  }
}

// CLI interface for direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const url = args[0];
  const ignoreSSLFlag = args.includes('--insecure');

  if (!url) {
    logger.error('Usage: node webContentExtractor.js <URL> [--insecure]');
    logger.error('The --insecure flag is for administrators to bypass certificate errors.');
    logger.error('Example: node webContentExtractor.js "https://example.com/article"');
    process.exit(1);
  }

  logger.info(`Extracting content from: ${url}`);
  if (ignoreSSLFlag) {
    logger.warn('Warning: ignoring SSL certificate errors');
  }

  try {
    const result = await webContentExtractor({ url, ignoreSSL: ignoreSSLFlag });
    logger.info('\nExtracted Content:');
    logger.info('==================');
    logger.info(`Title: ${result.title}`);
    logger.info(`Description: ${result.description}`);
    logger.info(`Author: ${result.author}`);
    logger.info(`Word Count: ${result.wordCount}`);
    logger.info(`Extracted At: ${result.extractedAt}`);
    logger.info('\nContent:');
    logger.info('--------');
    logger.info(result.content);
  } catch (error) {
    logger.error(`Error extracting content: ${error.message} (code: ${error.code || 'UNKNOWN'})`);
    process.exit(1);
  }
}
