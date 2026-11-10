// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page reader: the one way iHub fetches a web page or PDF and reads it as
 * text. A platform service, not a tool: the model's `read_url` tool
 * (`server/tools/readUrl.js`), the search tools' `extractContent`, a project's
 * web page items and its site crawler all use it, so every web read gets the same
 * fetch (SSRF guard on every redirect hop, DNS pinning, proxy, certificate
 * whitelist), the same extraction (`pageContent.js`), the same page cache and the
 * same bot-protection memory.
 *
 * @module services/pageReader/pageReader
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { throttledFetch } from '../../requestThrottler.js';
import { emitToolProgress } from '../loop/RunStream.js';
import config from '../../config.js';
import configCache from '../../configCache.js';
import {
  DEFAULT_PAGE_CACHE_TTL_MS,
  getCachedPage,
  makePageCacheKey,
  setCachedPage
} from '../pageCache.js';
import { resolveSearchLanguage } from '../search/searchLanguage.js';
import { normalizeFocus } from '../knowledge/focusQuery.js';
import { reportToolCallSources } from '../sources/toolCallScope.js';
import {
  getDocumentIndex,
  partOffsets,
  renderOutline,
  selectContent
} from '../../sources/documentRetrieval.js';
import logger from '../../utils/logger.js';
import { enhanceFetchOptions, isSsrfTrustedHost } from '../../utils/httpConfig.js';
import { assertPublicTarget, createPinnedLookup } from '../../utils/ssrfGuard.js';
import {
  ACCESS_DENIED_CODE,
  AUTH_REQUIRED_CODE,
  BOT_PROTECTION_CODE,
  blockedResponseError,
  classifyBlockedResponse
} from './botProtection.js';
import {
  acceptLanguageFor,
  countWords,
  extractHtmlPage,
  extractPdf,
  sliceDocument
} from './pageContent.js';

// Bound manual redirect-following so a malicious/misconfigured server can't
// force an unbounded hop chain.
const MAX_REDIRECTS = 5;

function createError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Validate a single URL hop against the SSRF guard, honoring the hosts an admin
 * trusts (`ssl.domainWhitelist`, `ssrf.allowedHosts`): such a host (typically an
 * internal one) skips the public-address rule. Every redirect hop is
 * revalidated independently so a public initial hostname that redirects to a
 * private/internal address after the first check is still blocked.
 *
 * @param {URL} parsedUrl - The URL for this hop
 * @returns {Promise<string[]|null>} Validated public addresses to pin the
 *   connection to, or null when the whitelist bypass applies (no DNS
 *   resolution/pinning is performed in that case)
 */
async function assertHopIsSafe(parsedUrl) {
  if (isSsrfTrustedHost(parsedUrl.hostname)) {
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
async function fetchPage(
  validUrl,
  { shouldIgnoreSSL, acceptLanguage, signal, throttleId = 'read_url', headers = null }
) {
  let hopUrl = validUrl;
  let response;
  for (let redirectCount = 0; ; redirectCount++) {
    if (redirectCount > MAX_REDIRECTS) {
      throw createError('Too many redirects while fetching webpage', 'TOO_MANY_REDIRECTS');
    }
    if (signal?.aborted) throw createError('The request was cancelled', 'ABORTED');

    const addresses = await assertHopIsSafe(hopUrl);
    const pinnedLookup = addresses ? createPinnedLookup(addresses) : null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    // Build base fetch options
    const fetchOptions = {
      headers: {
        'User-Agent': config.WEB_READER_USER_AGENT || DEFAULT_READER_USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
        // The user's language, so a multilingual site serves the page they read.
        'Accept-Language': acceptLanguage,
        'Accept-Encoding': 'gzip, deflate',
        'Upgrade-Insecure-Requests': '1',
        // A caller's own (a download's Accept, a conditional request's
        // If-None-Match / If-Modified-Since); never the ones above it needs.
        ...(headers || {})
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
      response = await throttledFetch(throttleId, hopUrl.toString(), enhancedOptions);
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
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
 * Fetch one URL the way the page reader does — SSRF guard on every redirect
 * hop, DNS pinned, proxy applied — and hand back the response unread. For
 * callers that need the raw page (the project site crawler) rather than its
 * extracted text; the caller reads or drops the body.
 *
 * Certificate checks are skipped only for hosts on `ssl.domainWhitelist`
 * (with `ssl.ignoreInvalidCertificates` on), decided per hop.
 *
 * @param {string} url - Absolute http(s) URL
 * @param {Object} [options]
 * @param {string} [options.language] - The reader's language (Accept-Language)
 * @param {AbortSignal} [options.signal] - Cancels the fetch
 * @param {string} [options.throttleId='read_url'] - Request throttle queue; a
 *   caller that fetches many pages takes its own, so it never queues the
 *   chat's page reads behind it
 * @param {Object<string, string>} [options.headers] - Extra request headers
 *   (`Accept`, `If-None-Match`, `If-Modified-Since`), sent on every hop
 * @returns {Promise<{response: Object, finalUrl: URL}>}
 */
export async function fetchWebPage(url, { language, signal, throttleId, headers } = {}) {
  const validUrl = new URL(url);
  if (!['http:', 'https:'].includes(validUrl.protocol)) {
    throw createError('Only HTTP and HTTPS URLs are supported', 'UNSUPPORTED_PROTOCOL');
  }
  return fetchPage(validUrl, {
    // null: `createAgent` decides per hop from the domain whitelist.
    shouldIgnoreSSL: null,
    acceptLanguage: acceptLanguageFor(resolveSearchLanguage(language)),
    signal,
    throttleId,
    headers: sanitizeHeaders(headers)
  });
}

/** Request headers a caller of {@link fetchWebPage} may set. */
const CALLER_HEADERS = new Set(['accept', 'if-none-match', 'if-modified-since']);

/** The caller's headers this reader sends: known names, short string values. */
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CALLER_HEADERS.has(String(name).toLowerCase())) continue;
    if (typeof value !== 'string' || !value || value.length > 1024 || /[\r\n]/.test(value)) {
      continue;
    }
    kept[name] = value;
  }
  return Object.keys(kept).length ? kept : null;
}

/**
 * Fetch and extract a whole document: Markdown for HTML, text for PDFs, with
 * its metadata. What the page cache stores; a window of `text` is what one
 * call returns.
 */
async function loadDocument(validUrl, { shouldIgnoreSSL, acceptLanguage, progress }) {
  const { response, finalUrl } = await fetchPage(validUrl, {
    shouldIgnoreSSL,
    acceptLanguage
  });

  progress('parsing');

  if (!response.ok) {
    if (response.status === 404) {
      throw createError('Page could not be found (HTTP 404)', 'PAGE_NOT_FOUND');
    }
    // 401/403 and the challenge statuses 429/503: a bot-protection block (WAF)
    // is told apart from a real login request and from a plain refusal, so the
    // model and the admin are not pointed at "authentication" for a site that
    // simply does not allow automated access.
    const blocked = await classifyBlockedResponse(response, finalUrl.toString());
    if (blocked) {
      logger.warn('Page read refused by the site', {
        component: 'WebContentExtractor',
        host: blocked.host,
        status: blocked.status,
        code: blocked.code,
        ...(blocked.vendor ? { vendor: blocked.vendor } : {}),
        ...(blocked.reference ? { reference: blocked.reference } : {}),
        server: response.headers?.get?.('server') || undefined
      });
      throw blockedResponseError(blocked);
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
        capped: pdf.capped,
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
    capped: page.capped,
    thin: page.thin
  };
}

/** The outline's share of a focused read, and the most it may take (characters). */
const FOCUS_OUTLINE_SHARE = 0.25;
const FOCUS_OUTLINE_MAX_CHARS = 8000;
/** Below this `maxLength` a focused read has no room for an outline. */
const FOCUS_OUTLINE_MIN_LENGTH = 2000;

const FOCUS_HINT =
  'Each section names where it starts (offset): call this tool again with that offset, ' +
  'without focus, to read on from there, or with another focus to look for something else.';

/**
 * What a read with a `focus` returns instead of the first window of a long
 * page: the sections that answer the question (BM25 over the page's own
 * headings, `sources/documentRetrieval.js`), verbatim, best match first, each
 * with its start offset, plus an outline of the whole page. No model call. A
 * focus that matches nothing gets the first window and the outline.
 *
 * @param {Object} doc - The cached document
 * @param {string} focus - From {@link normalizeFocus}
 * @param {number} maxLength - Bounds the whole content, outline included
 * @param {{outline?: boolean}} [options] - `outline: false`: the sections only (no
 *   outline), and null when none matches
 * @returns {{content: string, matched: boolean, slice?: Object, passages: Array}|null}
 */
function focusedWindow(doc, focus, maxLength, { outline: withOutline = true } = {}) {
  const selected = selectContent(doc.text, {
    focus,
    name: doc.title || doc.finalUrl || 'This page',
    budgetChars: maxLength,
    withOffsets: true,
    hint: withOutline ? FOCUS_HINT : undefined,
    compact: !withOutline,
    // A page a search extracts is read once among many: it does not displace the
    // indexes of the documents the model reads.
    cacheIndex: withOutline
  });
  if (selected.retrieval.mode === 'focus') {
    return { content: selected.content, matched: true, passages: selected.passages || [] };
  }
  // Nothing matches and no outline is wanted: the caller reads the page as it
  // would without a focus.
  if (!withOutline) return null;
  const index = getDocumentIndex(doc.text);
  const outlineBudget =
    maxLength >= FOCUS_OUTLINE_MIN_LENGTH
      ? Math.min(FOCUS_OUTLINE_MAX_CHARS, Math.floor(maxLength * FOCUS_OUTLINE_SHARE))
      : 0;
  const outline = outlineBudget
    ? renderOutline(index, outlineBudget, undefined, partOffsets(index, doc.text))
    : '';
  const block = outline
    ? `\n\nOutline of the whole page (@ marks where a section starts):\n${outline}`
    : '';
  const slice = sliceDocument(doc.text, { offset: 0, maxLength: maxLength - block.length });
  return { content: slice.content + block, matched: false, slice, passages: [] };
}

/** What the model is told about a focused read that matched. */
function focusedNote(withOutline) {
  return withOutline
    ? 'This is a selection of the page, not the whole page: the sections that best match the focus, then an outline. There is no nextOffset: to read on, call again with the offset (@) of an outline entry.'
    : 'This is a selection of the page, not the whole page: the sections that best match the focus. Open the page with read_url (and the offset of a section) to read more of it.';
}

/** The page's own fields at the head of every result. */
function pageHead(doc, targetUrl, validUrl) {
  return {
    url: targetUrl,
    ...(doc.finalUrl && doc.finalUrl !== validUrl.toString() ? { finalUrl: doc.finalUrl } : {}),
    title: doc.title,
    description: doc.description,
    author: doc.author,
    ...(doc.siteName ? { siteName: doc.siteName } : {}),
    ...(doc.publishedDate ? { publishedDate: doc.publishedDate } : {}),
    contentType: doc.contentType,
    format: doc.format
  };
}

/** Codes of a page the site refused to serve; they reach the caller unchanged. */
const SITE_REFUSAL_CODES = new Set([BOT_PROTECTION_CODE, AUTH_REQUIRED_CODE, ACCESS_DENIED_CODE]);

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
  if (doc.capped && !slice.truncated) {
    notes.push(
      `The document is longer than the ${slice.totalLength} characters the reader keeps; the rest cannot be read.`
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
 * and footers do not (see `pageContent.js`). The document is cached for a
 * short time, and each call returns one window of it: `truncated` says there
 * is more, `nextOffset` where to continue, `totalLength` how long it is.
 * `incomplete` says the document is longer than the reader keeps (the
 * character cap or the PDF page cap), so no offset reaches the rest.
 *
 * @param {Object} params - The extraction parameters
 * @param {string} [params.url] - The URL to extract content from
 * @param {string} [params.uri] - Alternative URL parameter name
 * @param {string} [params.link] - Alternative URL parameter name
 * @param {number} [params.maxLength=5000] - Maximum content length to return
 * @param {number} [params.offset=0] - Character offset to start reading at
 * @param {string} [params.focus] - The question being researched. For a page longer
 *   than `maxLength` read from its start (`offset` 0), the result holds the sections
 *   that answer it, verbatim, plus an outline, instead of the first window
 * @param {boolean} [params.outline=true] - With a `focus`: whether the result carries an
 *   outline of the page. A caller that reads many pages (search extraction) turns it off
 * @param {string} [params.language] - The reader's language (Accept-Language)
 * @param {boolean} [params.ignoreSSL=null] - Whether to ignore SSL certificate errors
 * @param {string} [params.chatId] - The chat ID for action tracking
 * @returns {Promise<Object>} The window of content with the page's metadata
 * @throws {Error} If URL is missing, invalid, or content extraction fails
 */
export async function readWebPage({
  url,
  uri,
  link,
  maxLength = 5000,
  offset = 0,
  focus,
  outline = true,
  language,
  ignoreSSL = null,
  chatId
}) {
  const progress = (status, extra = {}) =>
    emitToolProgress(chatId, {
      phase: `fetch.${status}`,
      toolId: 'read_url',
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

  // Determine SSL ignore setting: explicit parameter > global config > default false
  const platformConfig = configCache.getPlatform() || {};
  const shouldIgnoreSSL =
    ignoreSSL !== null ? ignoreSSL : platformConfig.ssl?.ignoreInvalidCertificates || false;

  const acceptLanguage = acceptLanguageFor(resolveSearchLanguage(language));

  // A host that already blocked this chat is not asked again, whether the read
  // comes from `read_url` or from a web search that reads its result pages.
  const known = recallBlockedHost(chatId, validUrl.hostname);
  if (known) throw known;

  try {
    const cacheKey = makePageCacheKey(validUrl.toString(), acceptLanguage);
    let doc = getCachedPage(cacheKey);
    if (!doc) {
      doc = await loadDocument(validUrl, { shouldIgnoreSSL, acceptLanguage, progress });
      setCachedPage(cacheKey, doc, doc.text.length, pageCacheTtlMs());
    } else {
      logger.debug('Page reader cache hit', { component: 'WebContentExtractor' });
    }

    const focusQuery = normalizeFocus(focus);
    // An explicit offset is the model paging through the page; a page that fits
    // is returned whole. Only the first read of a long page is focused.
    const focused =
      focusQuery && offset <= 0 && doc.text.length > maxLength
        ? focusedWindow(doc, focusQuery, maxLength, { outline })
        : null;
    if (focused) {
      const note = [
        focused.matched
          ? focusedNote(outline)
          : `No section of the page matches the focus; this is the start of the page and an outline of the rest. ${FOCUS_HINT}`,
        readerNote(doc, { offset: 0, totalLength: doc.text.length, truncated: false })
      ]
        .filter(Boolean)
        .join(' ');
      if (focused.passages.length) {
        // For the sources panel: the passages the model was given, not the page.
        reportToolCallSources([
          {
            provider: 'web',
            kind: 'page',
            url: targetUrl,
            private: true,
            passages: focused.passages.map(({ path, text }) => ({
              text: path ? `${path}\n${text}` : text
            }))
          }
        ]);
      }
      return {
        ...pageHead(doc, targetUrl, validUrl),
        content: focused.content,
        offset: 0,
        ...(focused.slice?.nextOffset ? { nextOffset: focused.slice.nextOffset } : {}),
        truncated: true,
        totalLength: doc.text.length,
        focus: focusQuery,
        excerpted: focused.matched,
        ...(doc.capped === true || (doc.contentType === 'pdf' && doc.pagesRead < doc.pageCount)
          ? { incomplete: true }
          : {}),
        wordCount: countWords(focused.content),
        ...(doc.contentType === 'pdf'
          ? { pageCount: doc.pageCount, pagesRead: doc.pagesRead }
          : {}),
        note,
        extractedAt: new Date().toISOString()
      };
    }

    const slice = sliceDocument(doc.text, { offset, maxLength });
    const note = readerNote(doc, slice);
    const incomplete =
      doc.capped === true || (doc.contentType === 'pdf' && doc.pagesRead < doc.pageCount);
    return {
      ...pageHead(doc, targetUrl, validUrl),
      content: slice.content,
      offset: slice.offset,
      nextOffset: slice.nextOffset,
      truncated: slice.truncated,
      totalLength: slice.totalLength,
      // Past the reader's cap: no offset reaches the rest, so this is not `truncated`.
      ...(incomplete ? { incomplete: true } : {}),
      wordCount: countWords(slice.content),
      ...(doc.contentType === 'pdf' ? { pageCount: doc.pageCount, pagesRead: doc.pagesRead } : {}),
      ...(note ? { note } : {}),
      extractedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createError('Request timed out while fetching webpage', 'TIMEOUT');
    }
    // The site's own answer, already worded and coded: not an extraction failure.
    if (SITE_REFUSAL_CODES.has(error.code)) {
      if (error.code === BOT_PROTECTION_CODE) {
        rememberBlockedHost(chatId, error, validUrl.hostname);
      }
      throw error;
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

/** How long a host that blocked a chat stays remembered for that chat. */
const BLOCKED_HOST_TTL_MS = 60 * 60 * 1000;
const MAX_BLOCKED_HOSTS = 1000;
/** `chatId + host` → { error, expires }. In memory: a restart only costs one more request. */
const blockedHosts = new Map();

function blockedHostKey(chatId, hostname) {
  return chatId && hostname ? `${chatId}\u0000${String(hostname).toLowerCase()}` : null;
}

/** Remember that a host blocked this chat's page reads. */
function rememberBlockedHost(chatId, error, requestedHost) {
  // A 429 is a rate limit that passes; only a block that stays is remembered.
  if (error.status === 429) return;
  // Under the host that answered (after redirects) and the one that was asked.
  for (const host of new Set([error.host, requestedHost])) {
    rememberBlockedHostKey(blockedHostKey(chatId, host), error);
  }
}

function rememberBlockedHostKey(key, error) {
  if (!key) return;
  const now = Date.now();
  if (blockedHosts.size >= MAX_BLOCKED_HOSTS) {
    for (const [entryKey, entry] of blockedHosts) {
      if (entry.expires <= now) blockedHosts.delete(entryKey);
    }
    // Still full: drop the oldest entries (Map keeps insertion order).
    while (blockedHosts.size >= MAX_BLOCKED_HOSTS) {
      blockedHosts.delete(blockedHosts.keys().next().value);
    }
  }
  blockedHosts.set(key, { error, expires: now + BLOCKED_HOST_TTL_MS });
}

/** The block error for a host (name) that already blocked this chat, or null. */
function recallBlockedHost(chatId, hostname) {
  const key = blockedHostKey(chatId, hostname);
  const entry = key ? blockedHosts.get(key) : null;
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    blockedHosts.delete(key);
    return null;
  }
  return entry.error;
}

/** Forget every remembered block (for tests). */
export function clearBlockedHosts() {
  blockedHosts.clear();
}
