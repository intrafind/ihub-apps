// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The only way the website corpus sizer reaches the network.
 *
 * Every request goes through the page reader's `fetchWebPage`: the SSRF guard
 * on every redirect hop, DNS pinned to the validated address, the proxy, and
 * the certificate checks skipped only for hosts on `ssl.domainWhitelist`. On
 * top of that, the queue `website_corpus` limits how fast a site is fetched
 * (the request throttler enforces it across all workers), a page is read up to
 * a byte limit and a time limit, and a response that ended on another site is
 * refused.
 *
 * @module services/websiteCorpus/fetch
 */
import zlib from 'node:zlib';
import { fetchWebPage } from '../../tools/webContentExtractor.js';
import { isSsrfTrustedHost } from '../../utils/httpConfig.js';
import { assertPublicTarget } from '../../utils/ssrfGuard.js';
import { decodeHtml, readBoundedBytes } from '../projects/siteCrawler.js';
import { registerThrottleHints } from '../../requestThrottler.js';
import { onSite, siteKeyOf } from './urls.js';

/** The throttle queue of every request of the sizer, and its limits. */
export const CORPUS_THROTTLE_ID = 'website_corpus';
export const CORPUS_CONCURRENCY = 2;
export const CORPUS_REQUEST_DELAY_MS = 400;
registerThrottleHints(CORPUS_THROTTLE_ID, {
  concurrency: CORPUS_CONCURRENCY,
  requestDelayMs: CORPUS_REQUEST_DELAY_MS
});

/** Most bytes read of a page, a robots.txt, a sitemap file (also after unzipping). */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_SITEMAP_BYTES = 8 * 1024 * 1024;

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
 * Fetch one page of the site.
 *
 * Does not throw for an HTTP error or a page that is not HTML: the caller
 * counts those. It throws for what is not an answer at all (a refused
 * address, a timeout).
 *
 * @param {string} url
 * @param {Object} options
 * @param {string} options.siteHost - The corpus' site (host, and a port other than 80 and 443); a redirect to another site is refused before it is followed
 * @param {{allowPrivate?: (hostname: string, port: string) => boolean}} [options.policy] - Which hosts may be company-internal addresses
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: number, finalUrl: string, contentType: string, html: string|null, truncated: boolean, offSite: boolean}>}
 */
export async function fetchSitePage(url, { siteHost, signal, policy } = {}) {
  const { response, finalUrl } = await fetchWebPage(url, {
    signal,
    throttleId: CORPUS_THROTTLE_ID,
    policy,
    stayOn: next => onSite(next.href, siteHost)
  });
  const contentType = response.headers.get('content-type') || '';
  const base = { status: response.status, finalUrl: finalUrl.href, contentType };
  if (!onSite(finalUrl.href, siteHost)) {
    dropBody(response.body);
    return { ...base, html: null, truncated: false, offSite: true };
  }
  if (!response.ok || !/html/i.test(contentType)) {
    dropBody(response.body);
    return { ...base, html: null, truncated: false, offSite: false };
  }
  const bytes = await readBoundedBytes(response.body, { maxBytes: MAX_PAGE_BYTES, signal });
  return {
    ...base,
    html: decodeHtml(bytes, contentType),
    truncated: bytes.length >= MAX_PAGE_BYTES,
    offSite: false
  };
}

/**
 * A text file of the site (robots.txt, a sitemap), unzipped if it is gzip; `null`
 * when it cannot be read, and when a redirect leads off the site (the file's own
 * host and port): nothing is sent there.
 */
async function fetchSiteText(url, { maxBytes, signal, policy }) {
  try {
    const siteKey = siteKeyOf(new URL(url));
    const { response, finalUrl, redirectRefused } = await fetchWebPage(url, {
      signal,
      throttleId: CORPUS_THROTTLE_ID,
      policy,
      stayOn: next => onSite(next.href, siteKey)
    });
    if (redirectRefused || !onSite(finalUrl.href, siteKey) || !response.ok) {
      dropBody(response.body);
      return null;
    }
    let bytes = await readBoundedBytes(response.body, { maxBytes, signal });
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = zlib.gunzipSync(bytes, { maxOutputLength: maxBytes });
    }
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

/** The site's robots.txt, or `null` when it has none. */
export const fetchRobotsText = (origin, { signal, policy } = {}) =>
  fetchSiteText(`${origin}/robots.txt`, { maxBytes: MAX_ROBOTS_BYTES, signal, policy });

/** One sitemap file, or `null`. */
export const fetchSitemapText = (url, { signal, policy } = {}) =>
  fetchSiteText(url, { maxBytes: MAX_SITEMAP_BYTES, signal, policy });

/**
 * Whether the server may fetch from a site's host, decided the way the guarded
 * fetch will decide it: a host the admin trusts platform-wide is fine, any
 * other host must resolve to public addresses unless the policy lets it be
 * company-internal (then only loopback, link-local and cloud metadata
 * addresses are refused). Asked before a crawl starts, because the sitemap and
 * robots.txt reads swallow errors and a refusal would otherwise look like "no
 * pages found".
 *
 * @param {URL} url - Any URL on the host
 * @param {{allowPrivate?: (hostname: string, port: string) => boolean}} [policy]
 * @returns {Promise<{ok: boolean, reason?: string, code?: string}>}
 */
export async function checkHostReachable(url, policy = null) {
  if (isSsrfTrustedHost(url.hostname)) return { ok: true };
  const allowPrivate = Boolean(
    policy?.allowPrivate?.(url.hostname.replace(/^\[|\]$/g, ''), url.port)
  );
  const { ok, reason, code } = await assertPublicTarget(url, { allowPrivate });
  return ok ? { ok: true } : { ok: false, reason, code };
}
