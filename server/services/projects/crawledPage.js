// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Reading a crawled page: decode its bytes, parse it, take its title and links.
 * Pure (no network, no config) so it runs the same on the event loop and on an
 * extraction thread (`extractionWorker.js`, task `crawlPage`); the site crawler
 * sends pages there through `parseCrawledPage` in `extractionPool.js`.
 *
 * @module services/projects/crawledPage
 */
import { JSDOM } from 'jsdom';
import { dropRawTextElements } from '../pageReader/pageContent.js';

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

/**
 * Decode a fetched page and take its title and links.
 *
 * @param {Uint8Array} bytes - The body as read.
 * @param {string} contentType - The response's content type (its charset counts).
 * @param {string} pageUrl - The address the page was read from, for relative links.
 * @returns {{html: string, title: string, links: string[]}}
 */
export function readCrawledPage(bytes, contentType, pageUrl) {
  const html = decodeHtml(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    contentType
  );
  return { html, ...extractPageLinks(html, pageUrl) };
}
