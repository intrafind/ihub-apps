import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { throttledFetch } from '../requestThrottler.js';
import { emitToolProgress } from '../services/loop/RunStream.js';
import config from '../config.js';
import configCache from '../configCache.js';
import {
  DEFAULT_PAGE_CACHE_TTL_MS,
  getCachedPage,
  makePageCacheKey,
  setCachedPage
} from '../services/pageCache.js';
import { resolveSearchLanguage } from '../services/search/searchLanguage.js';
import logger from '../utils/logger.js';
import { enhanceFetchOptions, getSSLConfig, isDomainWhitelisted } from '../utils/httpConfig.js';
import { assertPublicTarget, createPinnedLookup } from '../utils/ssrfGuard.js';
import {
  acceptLanguageFor,
  countWords,
  extractHtmlPage,
  extractPdf,
  sliceDocument
} from './lib/pageContent.js';

// Bound manual redirect-following so a malicious/misconfigured server can't
// force an unbounded hop chain.
const MAX_REDIRECTS = 5;

function createError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Validate a single URL hop against the SSRF guard, honoring the admin SSL
 * domain whitelist bypass (kept for backward compatibility with the
 * pre-existing `webContentExtractor` behavior). Every redirect hop is
 * revalidated independently so a public initial hostname that redirects to a
 * private/internal address after the first check is still blocked.
 *
 * @param {URL} parsedUrl - The URL for this hop
 * @param {Object} sslConfig - SSL config (for the domain whitelist bypass)
 * @returns {Promise<string[]|null>} Validated public addresses to pin the
 *   connection to, or null when the whitelist bypass applies (no DNS
 *   resolution/pinning is performed in that case)
 */
async function assertHopIsSafe(parsedUrl, sslConfig) {
  if (isDomainWhitelisted(parsedUrl.hostname, sslConfig.domainWhitelist)) {
    return null;
  }
  const result = await assertPublicTarget(parsedUrl);
  if (!result.ok) {
    throw createError(
      `Access to private/internal IP addresses is not allowed (${result.reason})`,
      'SSRF_BLOCKED'
    );
  }
  return result.addresses;
}

/** Browser user agent: many sites answer a default Node user agent with a block page. */
export const DEFAULT_READER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Fetch a page, following redirects manually so every hop is re-validated
 * against the SSRF guard and DNS is pinned to the validated address (closing
 * the rebinding window). A public initial hostname can otherwise redirect to a
 * private/internal address after the first check.
 *
 * @returns {Promise<{response: Object, finalUrl: URL}>}
 */
async function fetchPage(validUrl, { sslConfig, shouldIgnoreSSL, acceptLanguage }) {
  let hopUrl = validUrl;
  let response;
  for (let redirectCount = 0; ; redirectCount++) {
    if (redirectCount > MAX_REDIRECTS) {
      throw createError('Too many redirects while fetching webpage', 'TOO_MANY_REDIRECTS');
    }

    const addresses = await assertHopIsSafe(hopUrl, sslConfig);
    const pinnedLookup = addresses ? createPinnedLookup(addresses) : null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    // Build base fetch options
    const fetchOptions = {
      headers: {
        'User-Agent': config.WEB_READER_USER_AGENT || DEFAULT_READER_USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
        // The user's language, so a multilingual site serves the page they read.
        'Accept-Language': acceptLanguage,
        'Accept-Encoding': 'gzip, deflate',
        'Upgrade-Insecure-Requests': '1'
      },
      signal: controller.signal,
      // Follow redirects manually so each hop is re-validated above instead
      // of letting the fetch implementation resolve/connect to it directly.
      redirect: 'manual'
    };

    // Apply SSL and proxy configuration using the centralized httpConfig utility,
    // pinning DNS resolution to the addresses just validated for this hop.
    const enhancedOptions = enhanceFetchOptions(
      fetchOptions,
      hopUrl.toString(),
      shouldIgnoreSSL,
      pinnedLookup
    );

    try {
      response = await throttledFetch('webContentExtractor', hopUrl.toString(), enhancedOptions);
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;

      let nextUrl;
      try {
        nextUrl = new URL(location, hopUrl);
      } catch {
        throw createError(`Invalid redirect location: ${location}`, 'INVALID_URL');
      }
      if (!['http:', 'https:'].includes(nextUrl.protocol)) {
        throw createError('Only HTTP and HTTPS URLs are supported', 'UNSUPPORTED_PROTOCOL');
      }
      hopUrl = nextUrl;
      continue;
    }
    break;
  }
  return { response, finalUrl: hopUrl };
}

/**
 * Fetch and extract a whole document: Markdown for HTML, text for PDFs, with
 * its metadata. What the page cache stores; a window of `text` is what one
 * call returns.
 */
async function loadDocument(validUrl, { sslConfig, shouldIgnoreSSL, acceptLanguage, progress }) {
  const { response, finalUrl } = await fetchPage(validUrl, {
    sslConfig,
    shouldIgnoreSSL,
    acceptLanguage
  });

  progress('parsing');

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

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/pdf')) {
    progress('extracting', { type: 'pdf' });
    try {
      const pdf = await extractPdf(pdfjs, await response.arrayBuffer(), {
        url: finalUrl.toString()
      });
      return {
        finalUrl: finalUrl.toString(),
        contentType: 'pdf',
        format: 'text',
        title: pdf.title,
        description: 'PDF document',
        author: pdf.author,
        siteName: '',
        publishedDate: pdf.publishedDate,
        language: '',
        text: pdf.text,
        pageCount: pdf.pageCount,
        pagesRead: pdf.pagesRead,
        thin: !pdf.text.trim()
      };
    } catch (pdfError) {
      throw createError(`Failed to parse PDF: ${pdfError.message}`, 'PDF_PARSE_ERROR');
    }
  }

  const html = await response.text();
  progress('extracting', { type: 'html' });
  const page = extractHtmlPage(html, { url: finalUrl.toString() });
  return {
    finalUrl: finalUrl.toString(),
    contentType: 'html',
    format: 'markdown',
    title: page.title,
    description: page.description,
    author: page.author,
    siteName: page.siteName,
    publishedDate: page.publishedDate,
    language: page.language,
    text: page.markdown,
    thin: page.thin
  };
}

/** How long an extracted page stays cached (the web search cache TTL). */
function pageCacheTtlMs() {
  const parsed = Number(config.SEARCH_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAGE_CACHE_TTL_MS;
}

/**
 * What the model is told about the window it got, beyond the text itself.
 * @returns {string|undefined}
 */
function readerNote(doc, slice) {
  const notes = [];
  if (slice.totalLength > 0 && slice.offset >= slice.totalLength) {
    notes.push(
      `The offset is past the end of the document, which has ${slice.totalLength} characters.`
    );
  } else if (slice.truncated) {
    const shownEnd = slice.nextOffset;
    notes.push(
      `Showing characters ${slice.offset}-${shownEnd} of ${slice.totalLength}. ` +
        `To read on, call this tool again with the same url and offset ${slice.nextOffset}.`
    );
  }
  if (doc.contentType === 'pdf' && doc.pagesRead < doc.pageCount) {
    notes.push(`Only the first ${doc.pagesRead} of ${doc.pageCount} pages were read.`);
  }
  if (doc.thin) {
    notes.push(
      'The page returned little readable text. It may need JavaScript to render, or block automated access; use another source if this is not enough.'
    );
  }
  return notes.length ? notes.join(' ') : undefined;
}

/**
 * Extract clean, readable content from a web page (or PDF) as Markdown.
 *
 * Headings, lists, tables, links and code survive; navigation, ads, headers
 * and footers do not (see `lib/pageContent.js`). The document is cached for a
 * short time, and each call returns one window of it: `truncated` says there
 * is more, `nextOffset` where to continue, `totalLength` how long it is.
 *
 * @param {Object} params - The extraction parameters
 * @param {string} [params.url] - The URL to extract content from
 * @param {string} [params.uri] - Alternative URL parameter name
 * @param {string} [params.link] - Alternative URL parameter name
 * @param {number} [params.maxLength=5000] - Maximum content length to return
 * @param {number} [params.offset=0] - Character offset to start reading at
 * @param {string} [params.language] - The reader's language (Accept-Language)
 * @param {boolean} [params.ignoreSSL=null] - Whether to ignore SSL certificate errors
 * @param {string} [params.chatId] - The chat ID for action tracking
 * @returns {Promise<Object>} The window of content with the page's metadata
 * @throws {Error} If URL is missing, invalid, or content extraction fails
 */
export default async function webContentExtractor({
  url,
  uri,
  link,
  maxLength = 5000,
  offset = 0,
  language,
  ignoreSSL = null,
  chatId
}) {
  const progress = (status, extra = {}) =>
    emitToolProgress(chatId, {
      phase: `fetch.${status}`,
      toolId: 'webContentExtractor',
      message: status === 'loading' ? 'Fetching content' : undefined,
      data: { url: url || uri || link, status, ...extra }
    });
  progress('loading');
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

  // Block SSRF: prevent LLM tool from accessing internal/cloud metadata services
  const sslConfig = getSSLConfig();

  // Determine SSL ignore setting: explicit parameter > global config > default false
  const platformConfig = configCache.getPlatform() || {};
  const shouldIgnoreSSL =
    ignoreSSL !== null ? ignoreSSL : platformConfig.ssl?.ignoreInvalidCertificates || false;

  const acceptLanguage = acceptLanguageFor(resolveSearchLanguage(language));

  try {
    const cacheKey = makePageCacheKey(validUrl.toString(), acceptLanguage);
    let doc = getCachedPage(cacheKey);
    if (!doc) {
      doc = await loadDocument(validUrl, { sslConfig, shouldIgnoreSSL, acceptLanguage, progress });
      setCachedPage(cacheKey, doc, doc.text.length, pageCacheTtlMs());
    } else {
      logger.debug('Page reader cache hit', { component: 'WebContentExtractor' });
    }

    const slice = sliceDocument(doc.text, { offset, maxLength });
    const note = readerNote(doc, slice);
    return {
      url: targetUrl,
      ...(doc.finalUrl && doc.finalUrl !== validUrl.toString() ? { finalUrl: doc.finalUrl } : {}),
      title: doc.title,
      description: doc.description,
      author: doc.author,
      ...(doc.siteName ? { siteName: doc.siteName } : {}),
      ...(doc.publishedDate ? { publishedDate: doc.publishedDate } : {}),
      contentType: doc.contentType,
      format: doc.format,
      content: slice.content,
      offset: slice.offset,
      nextOffset: slice.nextOffset,
      truncated: slice.truncated,
      totalLength: slice.totalLength,
      wordCount: countWords(slice.content),
      ...(doc.contentType === 'pdf' ? { pageCount: doc.pageCount, pagesRead: doc.pagesRead } : {}),
      ...(note ? { note } : {}),
      extractedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createError('Request timed out while fetching webpage', 'TIMEOUT');
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

/** Bounds of the model-facing `maxLength` (mirrors tools/webContentExtractor.json). */
const TOOL_MIN_LENGTH = 500;
const TOOL_MAX_LENGTH = 50000;
const TOOL_DEFAULT_LENGTH = 10000;

/**
 * Entry point for the `webContentExtractor` tool the model calls.
 *
 * Tool arguments come straight from the model, and nothing validates them
 * against the schema, so this wrapper does it for the arguments that matter:
 * `maxLength` is clamped to the schema's bounds (an oversized value would
 * otherwise land a whole PDF in the context), `offset` to a whole number of
 * characters from the start, and `ignoreSSL` is never taken from the model —
 * certificate checking stays with the platform's `ssl.ignoreInvalidCertificates`
 * setting and the SSL domain whitelist.
 *
 * @param {Object} params - Tool arguments plus the runtime context runTool adds
 * @returns {Promise<Object>} Same result as {@link webContentExtractor}
 */
export async function extractForTool({ url, uri, link, maxLength, offset, language, chatId } = {}) {
  let length = Number(maxLength);
  if (!Number.isFinite(length)) length = TOOL_DEFAULT_LENGTH;
  length = Math.min(TOOL_MAX_LENGTH, Math.max(TOOL_MIN_LENGTH, Math.floor(length)));
  const start = Number(offset);
  return webContentExtractor({
    url,
    uri,
    link,
    maxLength: length,
    offset: Number.isFinite(start) && start > 0 ? Math.floor(start) : 0,
    language,
    chatId
  });
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

  logger.info('Extracting content from URL', { component: 'WebContentExtractor', url });
  if (ignoreSSLFlag) {
    logger.warn('Ignoring SSL certificate errors', { component: 'WebContentExtractor' });
  }

  try {
    const result = await webContentExtractor({ url, ignoreSSL: ignoreSSLFlag });
    logger.info('Extracted content', {
      component: 'WebContentExtractor',
      title: result.title,
      description: result.description,
      author: result.author,
      wordCount: result.wordCount,
      extractedAt: result.extractedAt
    });
  } catch (error) {
    logger.error('Error extracting content', {
      component: 'WebContentExtractor',
      error,
      code: error.code || 'UNKNOWN'
    });
    process.exit(1);
  }
}
