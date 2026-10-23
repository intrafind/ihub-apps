// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The site crawler behind the project URL picker: starting from one page, it
 * follows the links that stay on the same site and lists the pages it finds,
 * so a user can pick several pages of a website at once instead of adding
 * each URL by hand.
 *
 * The crawl only lists pages; nothing is stored. Every fetch goes through the
 * page reader's `fetchWebPage` (SSRF guard on every redirect hop, DNS pinned,
 * SSL whitelist), and the crawl is bounded in pages, depth, bytes per page and
 * total time, so a picker call can never turn into an open-ended crawl.
 *
 * @module services/projects/siteCrawler
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { fetchWebPage } from '../../tools/webContentExtractor.js';

/** Defaults and upper bounds of a crawl request. */
export const CRAWL_DEFAULT_MAX_PAGES = 50;
export const CRAWL_MAX_PAGES = 200;
export const CRAWL_DEFAULT_MAX_DEPTH = 2;
export const CRAWL_MAX_DEPTH = 3;

/** Pages fetched at the same time, and how long a whole crawl may take. */
const CRAWL_CONCURRENCY = 4;
const CRAWL_DEADLINE_MS = 45_000;

/** Most bytes of one page read for its links, and how long reading may take. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_READ_TIMEOUT_MS = 10_000;

/** Links to these are documents the reader can read, listed but not crawled. */
const DOCUMENT_EXTENSIONS = new Set(['pdf']);

/** Links to these are neither pages nor documents: never listed. */
const SKIPPED_EXTENSIONS = new Set([
  '7z',
  'avi',
  'bmp',
  'css',
  'csv',
  'dmg',
  'doc',
  'docx',
  'eot',
  'exe',
  'gif',
  'gz',
  'ico',
  'iso',
  'jpeg',
  'jpg',
  'js',
  'json',
  'm4a',
  'mjs',
  'mov',
  'mp3',
  'mp4',
  'msi',
  'odp',
  'ods',
  'odt',
  'ogg',
  'otf',
  'png',
  'ppt',
  'pptx',
  'rar',
  'rss',
  'svg',
  'tar',
  'tgz',
  'ttf',
  'wav',
  'webm',
  'webp',
  'woff',
  'woff2',
  'xls',
  'xlsx',
  'xml',
  'zip'
]);

/**
 * An absolute http(s) URL without its fragment, or `null`.
 *
 * @param {string} href
 * @param {string|URL} [base]
 * @returns {string|null}
 */
export function normalizeCrawlUrl(href, base) {
  try {
    const url = new URL(String(href || '').trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return null;
  }
}

/** The lower-cased extension of a URL's last path segment, or ''. */
function extensionOf(url) {
  const segment = new URL(url).pathname.split('/').pop() || '';
  const dot = segment.lastIndexOf('.');
  return dot > 0 ? segment.slice(dot + 1).toLowerCase() : '';
}

/**
 * What a link points at, from its extension: a `page` to crawl, a `document`
 * to list without crawling, or `null` for anything else (images, scripts,
 * archives, office files the URL reader does not read).
 *
 * @param {string} url - Absolute URL
 * @returns {'page'|'document'|null}
 */
export function linkTypeOf(url) {
  const extension = extensionOf(url);
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (SKIPPED_EXTENSIONS.has(extension)) return null;
  return 'page';
}

/**
 * The part of a site a crawl stays in: the start URL's origin and, with
 * `samePath`, its folder — `https://x.com/docs/intro.html` and
 * `https://x.com/docs/` both keep the crawl below `/docs/`, and
 * `https://x.com/docs` keeps it at `/docs` and below.
 *
 * @param {string} startUrl
 * @param {{samePath?: boolean}} [options]
 * @returns {{origin: string, path: string|null}} `path: null` allows the whole origin.
 */
export function crawlScope(startUrl, { samePath = true } = {}) {
  const url = new URL(startUrl);
  if (!samePath) return { origin: url.origin, path: null };
  const { pathname } = url;
  if (pathname.endsWith('/')) return { origin: url.origin, path: pathname };
  const lastSlash = pathname.lastIndexOf('/');
  const segment = pathname.slice(lastSlash + 1);
  return {
    origin: url.origin,
    path: segment.includes('.') ? pathname.slice(0, lastSlash + 1) : pathname
  };
}

/**
 * Whether a URL lies inside a crawl scope.
 *
 * @param {string} url
 * @param {{origin: string, path: string|null}} scope
 * @returns {boolean}
 */
export function inCrawlScope(url, scope) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== scope.origin) return false;
  if (!scope.path || scope.path === '/') return true;
  const { pathname } = parsed;
  if (scope.path.endsWith('/')) return pathname.startsWith(scope.path);
  return pathname === scope.path || pathname.startsWith(`${scope.path}/`);
}

/**
 * The title and the absolute link targets of an HTML page (resolved against
 * the page URL and any `<base href>`, without fragments, deduplicated in
 * document order). Links marked `rel="nofollow"` are left out.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{title: string, links: string[]}}
 */
export function extractPageLinks(html, pageUrl) {
  // Scripts are not run, and a stylesheet JSDOM cannot parse is reported to
  // the console rather than thrown: neither is anything to log for a crawl.
  const dom = new JSDOM(String(html || ''), { url: pageUrl, virtualConsole: new VirtualConsole() });
  const { document } = dom.window;
  const title = (document.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const links = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (/\bnofollow\b/i.test(anchor.getAttribute('rel') || '')) continue;
    const url = normalizeCrawlUrl(anchor.getAttribute('href'), document.baseURI || pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }
  dom.window.close();
  return { title, links };
}

/** Stop reading a body: Node streams are destroyed, web streams cancelled. */
function dropBody(body) {
  if (!body) return;
  try {
    if (typeof body.destroy === 'function') body.destroy();
    else if (typeof body.cancel === 'function') void body.cancel().catch(() => {});
  } catch {
    // Already closed.
  }
}

/**
 * Read a response body as UTF-8 text, up to `maxBytes` and `timeoutMs`; the
 * rest is dropped with the connection.
 *
 * @param {AsyncIterable<Buffer|Uint8Array|string>|null} body
 * @param {{maxBytes?: number, timeoutMs?: number}} [options]
 * @returns {Promise<string>}
 */
export async function readBoundedText(
  body,
  { maxBytes = MAX_PAGE_BYTES, timeoutMs = PAGE_READ_TIMEOUT_MS } = {}
) {
  if (!body) return '';
  const chunks = [];
  let bytes = 0;
  let timer;
  const read = (async () => {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      bytes += buffer.length;
      if (bytes >= maxBytes) break;
    }
  })();
  // Once the timeout wins, the dropped stream rejects `read`, which nobody awaits.
  read.catch(() => {});
  const timeout = new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
    dropBody(body);
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/** The default fetcher: the page reader's guarded fetch, the body read with bounds. */
async function fetchHtml(url, { language } = {}) {
  const { response, finalUrl } = await fetchWebPage(url, { language });
  if (!response.ok) {
    dropBody(response.body);
    throw new Error(`HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!/html/i.test(contentType)) {
    dropBody(response.body);
    return { finalUrl: finalUrl.href, contentType, html: null };
  }
  return { finalUrl: finalUrl.href, contentType, html: await readBoundedText(response.body) };
}

/** Run `task` over `items` with at most `limit` at a time. */
async function forEachLimited(items, limit, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The file name of a document URL, for its title. */
function fileNameOf(url) {
  const segment = new URL(url).pathname.split('/').pop() || '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Crawl a site breadth first from `url` and list its pages.
 *
 * Every listed page has been fetched (so dead links and pages that turn out
 * not to be HTML are left out), and the links of a page are followed while it
 * is less than `maxDepth` links away from the start. Documents (PDF) are
 * listed without being fetched. Pages that redirect to a page already listed
 * are listed once.
 *
 * @param {Object} params
 * @param {string} params.url - Start page (absolute http(s) URL)
 * @param {number} [params.maxPages=50] - Most pages listed, the start page included
 * @param {number} [params.maxDepth=2] - Most links followed away from the start page
 * @param {boolean} [params.samePath=true] - Stay below the start page's folder
 * @param {string} [params.language] - The reader's language (Accept-Language)
 * @param {Object} [deps]
 * @param {(url: string, options: {language?: string}) => Promise<{finalUrl: string,
 *   contentType: string, html: string|null}>} [deps.fetchPage] - Test seam
 * @param {() => number} [deps.now] - Test seam
 * @param {number} [deps.deadlineMs] - Test seam
 * @returns {Promise<{pages: Array<{url: string, title: string, depth: number,
 *   type: 'page'|'document'}>, truncated: boolean, scope: {origin: string, path: string|null}}>}
 *   `truncated`: the page limit or the time limit stopped the crawl before
 *   every link in scope was visited.
 * @throws {Error} When the start page itself cannot be read
 */
export async function crawlSite(
  {
    url,
    maxPages = CRAWL_DEFAULT_MAX_PAGES,
    maxDepth = CRAWL_DEFAULT_MAX_DEPTH,
    samePath = true,
    language
  },
  { fetchPage = fetchHtml, now = Date.now, deadlineMs = CRAWL_DEADLINE_MS } = {}
) {
  const start = normalizeCrawlUrl(url);
  if (!start) throw new Error('A http(s) URL is required');
  const pageLimit = Math.max(1, Math.min(CRAWL_MAX_PAGES, Math.floor(maxPages) || 1));
  const depthLimit = Math.max(0, Math.min(CRAWL_MAX_DEPTH, Math.floor(maxDepth) || 0));
  const scope = crawlScope(start, { samePath });
  const deadline = now() + deadlineMs;

  // Every URL queued or listed, so none is visited twice.
  const seen = new Set([start]);
  // The URLs a listed page was asked for or redirected to: a later redirect
  // onto one of them lists nothing new.
  const listedTargets = new Set([start]);
  const listed = [];
  // Slots of the page budget taken by listed and queued pages; a queued page
  // that turns out dead gives its slot back.
  let reserved = 1;
  let truncated = false;

  // The start page answers for the crawl: if it cannot be read, nothing can.
  const first = await fetchPage(start, { language });
  const firstUrl = normalizeCrawlUrl(first.finalUrl) || start;
  seen.add(firstUrl);
  listedTargets.add(firstUrl);
  if (first.html === null) {
    if (/pdf/i.test(first.contentType || '')) {
      return {
        pages: [{ url: start, title: fileNameOf(start), depth: 0, type: 'document' }],
        truncated: false,
        scope
      };
    }
    throw new Error(`The page is not a web page (${first.contentType || 'unknown type'})`);
  }
  const firstPage = extractPageLinks(first.html, firstUrl);
  listed.push({ url: start, title: firstPage.title, depth: 0, type: 'page' });

  /** Queue the in-scope links of a page onto `level`, within the page budget. */
  const enqueue = (links, depth, level) => {
    for (const link of links) {
      if (seen.has(link) || !inCrawlScope(link, scope)) continue;
      const type = linkTypeOf(link);
      if (!type) continue;
      if (reserved >= pageLimit) {
        truncated = true;
        return;
      }
      reserved += 1;
      seen.add(link);
      level.push({ url: link, depth, type });
    }
  };

  let level = [];
  if (depthLimit > 0) enqueue(firstPage.links, 1, level);

  for (let depth = 1; level.length > 0; depth += 1) {
    const results = new Array(level.length);
    await forEachLimited(level, CRAWL_CONCURRENCY, async (entry, index) => {
      if (now() >= deadline) {
        truncated = true;
        return;
      }
      if (entry.type === 'document') {
        results[index] = { title: fileNameOf(entry.url), links: [], document: true };
        return;
      }
      try {
        const page = await fetchPage(entry.url, { language });
        const finalUrl = normalizeCrawlUrl(page.finalUrl) || entry.url;
        if (page.html === null) {
          // A link without an extension may still serve a PDF.
          if (/pdf/i.test(page.contentType || '')) {
            results[index] = { finalUrl, title: fileNameOf(finalUrl), links: [], document: true };
          }
          return;
        }
        results[index] = { finalUrl, ...extractPageLinks(page.html, finalUrl) };
      } catch {
        // A dead or unreadable link is left out of the list.
      }
    });

    // Merged in level order, so the outcome does not depend on fetch timing.
    const nextLevel = [];
    for (let index = 0; index < level.length; index += 1) {
      const entry = level[index];
      const result = results[index];
      const redirected = result?.finalUrl && result.finalUrl !== entry.url;
      // A redirect onto a page already listed, or off the site, adds nothing.
      if (
        !result ||
        (redirected &&
          (listedTargets.has(result.finalUrl) || !inCrawlScope(result.finalUrl, scope)))
      ) {
        reserved -= 1;
        continue;
      }
      listedTargets.add(entry.url);
      if (redirected) listedTargets.add(result.finalUrl);
      listed.push({
        url: entry.url,
        title: result.title,
        depth,
        type: result.document ? 'document' : 'page'
      });
      if (depth < depthLimit) enqueue(result.links, depth + 1, nextLevel);
    }
    level = nextLevel;
  }

  return { pages: listed, truncated, scope };
}

export default crawlSite;
