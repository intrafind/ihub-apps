// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page URLs of a website, from its sitemaps.
 *
 * Reads the `Sitemap:` lines of robots.txt (else the usual places), follows
 * sitemap indexes, and keeps the URLs on the site, under the scope prefix, and
 * of a kind that is a page. Coverage is only as good as the sitemap: pages
 * missing from it are missing from the corpus, which is why the caller shows
 * the section counts before anything is crawled.
 *
 * The XML is read with a pattern for `<loc>`, not an XML parser: a sitemap is
 * untrusted input from the site, and this cannot expand entities or fetch an
 * external DTD.
 *
 * @module services/websiteCorpus/sitemap
 */
import { linkTypeOf, normalizeCrawlUrl } from '../projects/siteCrawler.js';
import { hostKey, onSite, underPrefix } from './urls.js';

/** Most sitemap files read for one site, and most URLs kept. */
export const MAX_SITEMAP_FILES = 60;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name) => XML_ENTITIES[name]);
}

/**
 * The text of every `<loc>` element, found with `indexOf`, one pass over the
 * file. A pattern for `<loc>` with optional whitespace around lazy groups
 * backtracks quadratically on a hostile file (many spaces and no closing tag),
 * and a sitemap is input from the site: up to 8 MB of it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function locElements(text) {
  const locs = [];
  let position = 0;
  for (;;) {
    const open = text.indexOf('<loc>', position);
    if (open === -1) break;
    const close = text.indexOf('</loc>', open + 5);
    if (close === -1) break;
    const inner = text.slice(open + 5, close).trim();
    const cdata = inner.startsWith('<![CDATA[') && inner.endsWith(']]>');
    const value = (cdata ? inner.slice(9, -3) : decodeEntities(inner)).trim();
    if (value) locs.push(value);
    position = close + 6;
  }
  return locs;
}

/**
 * The kind of a sitemap file and the URLs in its `<loc>` elements.
 *
 * @param {string} xml
 * @returns {{kind: 'index'|'urlset'|'unknown', locs: string[]}}
 */
export function parseSitemap(xml) {
  const text = String(xml || '');
  const kind = /<sitemapindex[\s>]/i.test(text)
    ? 'index'
    : /<urlset[\s>]/i.test(text)
      ? 'urlset'
      : 'unknown';
  return { kind, locs: locElements(text) };
}

/** The `Sitemap:` lines of a robots.txt. */
export function sitemapsFromRobots(robotsText) {
  return String(robotsText || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^sitemap\s*:/i.test(line))
    .map(line => line.slice(line.indexOf(':') + 1).trim())
    .filter(Boolean);
}

/**
 * Collect the page URLs of a site.
 *
 * @param {Object} options
 * @param {string} options.siteUrl - The site's address (an http(s) URL)
 * @param {string} [options.prefix] - Normalised scope prefix (`/de/`), or empty
 * @param {string[]} [options.sitemapUrls] - Sitemaps to read instead of the usual places
 * @param {string|null} [options.robotsText] - The site's robots.txt, when it has one
 * @param {(url: string) => Promise<string|null>} options.fetchText - Reads one sitemap file; `null` when it cannot be read
 * @param {number} [options.maxUrls=20000] - Most URLs kept
 * @returns {Promise<{
 *   urls: string[], sitemapsRead: string[], failed: string[],
 *   skipped: {offSite: number, outsideScope: number, notPages: number, overLimit: number},
 *   usedFallback: boolean
 * }>}
 */
export async function collectSiteUrls({
  siteUrl,
  prefix = '',
  sitemapUrls = [],
  robotsText = null,
  fetchText,
  maxUrls = 20_000
}) {
  const site = new URL(siteUrl);
  const siteHost = hostKey(site.hostname);
  const queue = [];
  const seenFiles = new Set();
  const sitemapsRead = [];
  const failed = [];
  const found = [];

  const enqueue = url => {
    const normalized = normalizeCrawlUrl(url, site);
    if (normalized && !seenFiles.has(normalized)) {
      seenFiles.add(normalized);
      queue.push(normalized);
    }
  };

  const explicit = sitemapUrls.length > 0;
  for (const url of explicit ? sitemapUrls : sitemapsFromRobots(robotsText)) enqueue(url);

  const drain = async () => {
    while (queue.length && sitemapsRead.length + failed.length < MAX_SITEMAP_FILES) {
      const url = queue.shift();
      // A sitemap on another host is not fetched either.
      if (!onSite(url, siteHost)) {
        failed.push(url);
        continue;
      }
      const text = await fetchText(url).catch(() => null);
      if (text == null) {
        failed.push(url);
        continue;
      }
      sitemapsRead.push(url);
      const { kind, locs } = parseSitemap(text);
      if (kind === 'index') locs.forEach(enqueue);
      else found.push(...locs);
    }
  };

  await drain();
  let usedFallback = false;
  if (found.length === 0 && !explicit) {
    // robots.txt named none, or they failed: the usual places.
    usedFallback = true;
    const places = ['/sitemap.xml', '/sitemap_index.xml'];
    if (prefix) places.push(`${prefix}sitemap.xml`);
    for (const place of places) enqueue(new URL(place, site).href);
    await drain();
  }

  const skipped = { offSite: 0, outsideScope: 0, notPages: 0, overLimit: 0 };
  const urls = [];
  const seen = new Set();
  for (const raw of found) {
    const url = normalizeCrawlUrl(raw, site);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (!onSite(url, siteHost)) skipped.offSite += 1;
    else if (!underPrefix(url, prefix)) skipped.outsideScope += 1;
    else if (linkTypeOf(url) !== 'page') skipped.notPages += 1;
    else if (urls.length >= maxUrls) skipped.overLimit += 1;
    else urls.push(url);
  }
  return { urls, sitemapsRead, failed, skipped, usedFallback };
}
