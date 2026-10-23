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
 * SSL whitelist) on its own throttle queue, the site's `robots.txt` is
 * honored, and the crawl is bounded in pages, depth, bytes per page and total
 * time, so a picker call can never turn into an open-ended crawl.
 *
 * @module services/projects/siteCrawler
 */
import { JSDOM } from 'jsdom';
import { fetchWebPage } from '../../tools/webContentExtractor.js';
import { dropRawTextElements } from '../../tools/lib/pageContent.js';

/** Defaults and upper bounds of a crawl request. */
export const CRAWL_DEFAULT_MAX_PAGES = 50;
export const CRAWL_MAX_PAGES = 200;
export const CRAWL_DEFAULT_MAX_DEPTH = 2;
export const CRAWL_MAX_DEPTH = 3;

/**
 * Pages fetched at the same time, and how long a whole crawl may take: below
 * the client's 30-second request timeout, so the list found so far always
 * reaches the user. Fetches still running at the deadline are cancelled.
 */
const CRAWL_CONCURRENCY = 4;
export const CRAWL_DEADLINE_MS = 25_000;

/**
 * The throttle queue of crawl fetches. Not the page reader's `read_url`: a
 * crawl must not hold the slots the chat's page reads wait for.
 */
export const CRAWL_THROTTLE_ID = 'project_crawl';

/** Most bytes of one page read for its links, and how long reading may take. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_READ_TIMEOUT_MS = 10_000;

/** Most bytes of a `robots.txt` read, and the most rules taken from it. */
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_ROBOTS_RULES = 500;
const MAX_ROBOTS_RULE_CHARS = 512;

/** Most variants of one path that differ only in their query (`?page=2`, `?sort=…`). */
const MAX_QUERY_VARIANTS = 3;

/** Most links queued for one level; the page limit is far below it. */
const MAX_LEVEL_CANDIDATES = 5000;

/** Links to these are documents the reader can read, listed but not crawled. */
const DOCUMENT_EXTENSIONS = new Set(['pdf']);

/**
 * Links to these are neither pages nor documents: never listed. A filter that
 * saves fetches only — the response's content type decides what a link
 * without one of these extensions is.
 */
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

/** Query parameters that track a visit or a session and never change a page. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'jsessionid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'phpsessid',
  'sessionid',
  'yclid',
  '_ga',
  '_gl'
]);

/**
 * An absolute http(s) URL without its fragment, credentials, session id and
 * tracking parameters, or `null`.
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
    // Java servlet containers put the session in the path: `/a;jsessionid=…`.
    const sessionAt = url.pathname.toLowerCase().indexOf(';jsessionid=');
    if (sessionAt !== -1) url.pathname = url.pathname.slice(0, sessionAt);
    for (const name of [...url.searchParams.keys()]) {
      const key = name.toLowerCase();
      if (key.startsWith('utm_') || TRACKING_PARAMS.has(key)) url.searchParams.delete(name);
    }
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
 * The part of a site a crawl stays in: the start page's origin and, with
 * `samePath`, its folder. A start address that ends in `/` is the folder; one
 * that does not is a folder when the page links below it (`/docs` linking
 * `/docs/intro`), and otherwise a page whose folder is the scope
 * (`/docs/intro.html` and `/blog/my-post` keep the crawl below `/docs/` and
 * `/blog/`). Give the address the start page was read from, after redirects.
 *
 * @param {string} startUrl
 * @param {{samePath?: boolean, links?: string[]}} [options] - `links`: the
 *   start page's links
 * @returns {{origin: string, path: string|null}} `path: null` allows the whole origin.
 */
export function crawlScope(startUrl, { samePath = true, links = [] } = {}) {
  const url = new URL(startUrl);
  if (!samePath) return { origin: url.origin, path: null };
  const { pathname } = url;
  if (pathname.endsWith('/')) return { origin: url.origin, path: pathname };
  const asFolder = { origin: url.origin, path: pathname };
  const linksBelow = links.some(
    link => link !== url.href && inCrawlScope(link, asFolder) && new URL(link).pathname !== pathname
  );
  if (linksBelow) return asFolder;
  return { origin: url.origin, path: pathname.slice(0, pathname.lastIndexOf('/') + 1) };
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
 * The `Allow` / `Disallow` rules of a `robots.txt` that apply to every crawler
 * (`User-agent: *`). The reader sends a browser user agent, so groups for
 * named crawlers do not apply to it.
 *
 * @param {string} text
 * @returns {Array<{allow: boolean, pattern: string}>}
 */
export function parseRobotsTxt(text) {
  const groups = [];
  let current = null;
  let inAgentLines = false;
  for (const raw of String(text || '').split('\n')) {
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      // Consecutive user-agent lines share one group.
      if (!inAgentLines) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgentLines = true;
      continue;
    }
    inAgentLines = false;
    if (!current || (field !== 'allow' && field !== 'disallow')) continue;
    // An empty `Disallow:` allows everything; an overlong pattern is ignored.
    if (!value || value.length > MAX_ROBOTS_RULE_CHARS) continue;
    current.rules.push({ allow: field === 'allow', pattern: value });
  }
  return groups
    .filter(group => group.agents.includes('*'))
    .flatMap(group => group.rules)
    .slice(0, MAX_ROBOTS_RULES);
}

/**
 * Whether a robots.txt path pattern (`*` any characters, a trailing `$` the
 * end) matches the start of `path`. Wildcards are matched by backtracking to
 * the last `*` only, never by a regex built from the site's text.
 */
function robotsPatternMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < path.length) {
    if (p < body.length && body[p] === '*') {
      star = p;
      p += 1;
      resume = s;
    } else if (p < body.length && body[p] === path[s]) {
      p += 1;
      s += 1;
    } else if (p === body.length && !anchored) {
      return true;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      s = resume;
    } else {
      return false;
    }
  }
  while (p < body.length && body[p] === '*') p += 1;
  return p === body.length;
}

/**
 * Whether `robots.txt` rules allow a URL: the longest matching rule decides,
 * `Allow` winning a tie; no matching rule allows it.
 *
 * @param {string} url
 * @param {Array<{allow: boolean, pattern: string}>} rules
 * @returns {boolean}
 */
export function robotsAllows(url, rules) {
  if (!rules?.length) return true;
  const { pathname, search } = new URL(url);
  const path = `${pathname}${search}`;
  let best = null;
  for (const rule of rules) {
    if (!robotsPatternMatches(rule.pattern, path)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    const tieAllows = best && rule.pattern.length === best.pattern.length && rule.allow;
    if (longer || tieAllows) best = rule;
  }
  return !best || best.allow;
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
  // Scripts and styles carry no links, are where JSDOM is slowest, and its
  // CSS parser throws on some real-world stylesheets.
  const dom = new JSDOM(dropRawTextElements(html, ['script', 'style']), { url: pageUrl });
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
 * Read a response body up to `maxBytes` and `timeoutMs` (or until `signal`
 * aborts); the rest is dropped with the connection.
 *
 * @param {AsyncIterable<Buffer|Uint8Array|string>|null} body
 * @param {{maxBytes?: number, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<Buffer>}
 */
export async function readBoundedBytes(
  body,
  { maxBytes = MAX_PAGE_BYTES, timeoutMs = PAGE_READ_TIMEOUT_MS, signal } = {}
) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  let timer;
  let onAbort;
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
  const stop = new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs);
    onAbort = resolve;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([read, stop]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    dropBody(body);
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/** The charset a response declares in its content type, or in the page's first bytes. */
function charsetOf(contentType, bytes) {
  const declared = /charset=["']?([\w.:-]+)/i.exec(String(contentType || '').replace(/\s/g, ''));
  if (declared) return declared[1];
  const head = bytes.subarray(0, 1024).toString('latin1');
  return /<meta[^>]{0,200}?charset=["']?([\w.:-]+)/i.exec(head)?.[1] || '';
}

/**
 * The text of an HTML page in the charset it declares; without one, UTF-8, or
 * Windows-1252 for bytes that are not UTF-8 (older pages). A character the
 * byte limit cut in half is dropped, not turned into the whole page's
 * fallback.
 *
 * @param {Buffer} bytes
 * @param {string} [contentType]
 * @returns {string}
 */
export function decodeHtml(bytes, contentType) {
  const label = charsetOf(contentType, bytes)
    .toLowerCase()
    .replace(/^utf8$/, 'utf-8');
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes, { stream: true });
    } catch {
      // A label TextDecoder does not know: guess below.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** The default fetcher: the page reader's guarded fetch, the body read with bounds. */
async function fetchHtml(url, { signal } = {}) {
  const { response, finalUrl } = await fetchWebPage(url, {
    signal,
    throttleId: CRAWL_THROTTLE_ID
  });
  if (!response.ok) {
    dropBody(response.body);
    throw new Error(`HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!/html/i.test(contentType)) {
    dropBody(response.body);
    return { finalUrl: finalUrl.href, contentType, html: null };
  }
  const bytes = await readBoundedBytes(response.body, { signal });
  return { finalUrl: finalUrl.href, contentType, html: decodeHtml(bytes, contentType) };
}

/**
 * The default robots.txt reader: its text, or `null` when there is none or it
 * cannot be read (then nothing is excluded).
 */
async function fetchRobotsTxt(origin, { signal } = {}) {
  try {
    const { response } = await fetchWebPage(`${origin}/robots.txt`, {
      signal,
      throttleId: CRAWL_THROTTLE_ID
    });
    if (!response.ok) {
      dropBody(response.body);
      return null;
    }
    const bytes = await readBoundedBytes(response.body, { maxBytes: MAX_ROBOTS_BYTES, signal });
    return bytes.toString('utf8');
  } catch {
    return null;
  }
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

/** An error the user reads when the crawl was stopped before the start page answered. */
function stoppedError() {
  const error = new Error('The website took too long to answer');
  error.code = 'CRAWL_TIMEOUT';
  return error;
}

/**
 * Crawl a site breadth first from `url` and list its pages.
 *
 * Every listed page has been fetched (so dead links and pages that turn out
 * not to be HTML are left out), and the links of a page are followed while it
 * is less than `maxDepth` links away from the start. Documents (PDF) are
 * listed without being fetched. A page is listed under the address it was
 * read from after redirects, once. Links `robots.txt` disallows are not
 * followed; tracking parameters are dropped, and at most a few variants of
 * one path that differ only in their query are listed.
 *
 * The scope (origin and folder) is that of the start page as read, after
 * redirects: `https://example.com` answered from `https://www.example.com/`
 * crawls `www.example.com`.
 *
 * @param {Object} params
 * @param {string} params.url - Start page (absolute http(s) URL)
 * @param {number} [params.maxPages=50] - Most pages listed, the start page included
 * @param {number} [params.maxDepth=2] - Most links followed away from the start page
 * @param {boolean} [params.samePath=true] - Stay in the start page's folder
 * @param {AbortSignal} [params.signal] - Stops the crawl (the client went away)
 * @param {Object} [deps]
 * @param {(url: string, options: {signal: AbortSignal}) => Promise<{finalUrl: string,
 *   contentType: string, html: string|null}>} [deps.fetchPage] - Test seam
 * @param {(origin: string, options: {signal: AbortSignal}) => Promise<string|null>}
 *   [deps.fetchRobots] - Test seam
 * @param {() => number} [deps.now] - Test seam
 * @param {number} [deps.deadlineMs] - Test seam
 * @returns {Promise<{pages: Array<{url: string, title: string, depth: number,
 *   type: 'page'|'document'}>, truncated: boolean, robotsExcluded: number,
 *   scope: {origin: string, path: string|null}}>}
 *   `truncated`: the page limit or the time limit stopped the crawl before
 *   every link in scope was visited. `robotsExcluded`: links in scope that
 *   `robots.txt` disallows.
 * @throws {Error} When the start page itself cannot be read
 */
export async function crawlSite(
  {
    url,
    maxPages = CRAWL_DEFAULT_MAX_PAGES,
    maxDepth = CRAWL_DEFAULT_MAX_DEPTH,
    samePath = true,
    signal: callerSignal
  },
  {
    fetchPage = fetchHtml,
    fetchRobots = fetchRobotsTxt,
    now = Date.now,
    deadlineMs = CRAWL_DEADLINE_MS
  } = {}
) {
  const start = normalizeCrawlUrl(url);
  if (!start) throw new Error('A http(s) URL is required');
  const pageLimit = Math.max(1, Math.min(CRAWL_MAX_PAGES, Math.floor(maxPages) || 1));
  const depthLimit = Math.max(0, Math.min(CRAWL_MAX_DEPTH, Math.floor(maxDepth) || 0));

  // One signal for "stop now": the deadline (which also cancels the fetches
  // still running) or the caller giving up.
  const deadline = now() + deadlineMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const { signal } = controller;
  const stopped = () => signal.aborted || now() >= deadline;

  try {
    // The start page answers for the crawl: if it cannot be read, nothing can.
    let first;
    try {
      first = await fetchPage(start, { signal });
    } catch (error) {
      if (signal.aborted) throw stoppedError();
      throw error;
    }
    const firstUrl = normalizeCrawlUrl(first.finalUrl) || start;
    if (first.html === null) {
      if (/pdf/i.test(first.contentType || '')) {
        return {
          pages: [{ url: firstUrl, title: fileNameOf(firstUrl), depth: 0, type: 'document' }],
          truncated: false,
          robotsExcluded: 0,
          scope: crawlScope(firstUrl, { samePath })
        };
      }
      throw new Error(`The page is not a web page (${first.contentType || 'unknown type'})`);
    }
    const firstPage = extractPageLinks(first.html, firstUrl);
    const scope = crawlScope(firstUrl, { samePath, links: firstPage.links });
    const listed = [{ url: firstUrl, title: firstPage.title, depth: 0, type: 'page' }];
    if (depthLimit === 0) return { pages: listed, truncated: false, robotsExcluded: 0, scope };

    const robotsRules = parseRobotsTxt(await fetchRobots(scope.origin, { signal }));

    // Every URL queued, listed, or read from after a redirect: none is visited twice.
    const seen = new Set([start, firstUrl]);
    // The addresses of listed pages: a later redirect onto one lists nothing new.
    const listedTargets = new Set([start, firstUrl]);
    // Variants with a query string per path, to stop `?page=N` from filling the list.
    const queryVariants = new Map();
    let truncated = false;
    let robotsExcluded = 0;

    /** The in-scope links of a page worth visiting, in document order. */
    const candidatesOf = (links, depth, into) => {
      for (const link of links) {
        if (seen.has(link) || !inCrawlScope(link, scope)) continue;
        const type = linkTypeOf(link);
        if (!type) continue;
        seen.add(link);
        if (!robotsAllows(link, robotsRules)) {
          robotsExcluded += 1;
          continue;
        }
        const parsed = new URL(link);
        if (parsed.search) {
          const path = `${parsed.origin}${parsed.pathname}`;
          const count = queryVariants.get(path) || 0;
          if (count >= MAX_QUERY_VARIANTS) continue;
          queryVariants.set(path, count + 1);
        }
        if (into.length >= MAX_LEVEL_CANDIDATES) {
          truncated = true;
          return;
        }
        into.push({ url: link, depth, type });
      }
    };

    /** Fetch one candidate: its title and links, or `null` when it is not listed. */
    const visit = async entry => {
      if (entry.type === 'document') {
        return { finalUrl: entry.url, title: fileNameOf(entry.url), links: [], document: true };
      }
      try {
        const page = await fetchPage(entry.url, { signal });
        const finalUrl = normalizeCrawlUrl(page.finalUrl) || entry.url;
        // A redirect off the site, or onto a page an earlier level listed, adds nothing.
        if (finalUrl !== entry.url) {
          if (!inCrawlScope(finalUrl, scope) || listedTargets.has(finalUrl)) return null;
        }
        if (page.html === null) {
          // A link without an extension may still serve a PDF.
          if (!/pdf/i.test(page.contentType || '')) return null;
          return { finalUrl, title: fileNameOf(finalUrl), links: [], document: true };
        }
        return { finalUrl, ...extractPageLinks(page.html, finalUrl) };
      } catch {
        // A dead or unreadable link (or one cancelled at the deadline) is left out.
        return null;
      }
    };

    let level = [];
    candidatesOf(firstPage.links, 1, level);

    for (let depth = 1; level.length > 0 && listed.length < pageLimit; depth += 1) {
      // Candidates are taken in order while the page budget has room for them
      // even if every fetch still running succeeds, so a dead link's slot goes
      // to the next candidate, and the pages listed are the first ones that
      // can be read whatever the fetch timing.
      const results = new Array(level.length);
      let next = 0;
      let readable = 0;
      let running = 0;
      const room = () => pageLimit - listed.length - readable - running;
      const worker = async () => {
        while (next < level.length && room() > 0) {
          if (stopped()) {
            truncated = true;
            return;
          }
          const index = next;
          next += 1;
          running += 1;
          const result = await visit(level[index]);
          running -= 1;
          results[index] = result;
          if (result) readable += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(CRAWL_CONCURRENCY, level.length) }, worker));
      if (next < level.length) truncated = true;

      // Merged in level order, so the outcome does not depend on fetch timing.
      const nextLevel = [];
      for (let index = 0; index < next; index += 1) {
        const entry = level[index];
        const result = results[index];
        if (!result || listedTargets.has(result.finalUrl) || listed.length >= pageLimit) continue;
        listedTargets.add(entry.url);
        listedTargets.add(result.finalUrl);
        seen.add(result.finalUrl);
        listed.push({
          url: result.finalUrl,
          title: result.title,
          depth,
          type: result.document ? 'document' : 'page'
        });
        if (depth < depthLimit) candidatesOf(result.links, depth + 1, nextLevel);
      }
      level = nextLevel;
    }
    if (level.length > 0) truncated = true;

    return { pages: listed, truncated, robotsExcluded, scope };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

export default crawlSite;
