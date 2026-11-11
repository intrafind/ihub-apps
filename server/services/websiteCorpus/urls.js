// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * URL helpers of the website corpus sizer: the scope prefix, the site a corpus
 * may fetch from, and the section a page counts towards.
 *
 * @module services/websiteCorpus/urls
 */

/**
 * A text without the slashes at its start and end. A loop, not a pattern: a
 * regular expression for trailing slashes backtracks quadratically on a long
 * run of them, and a URL path comes from the site.
 *
 * @param {string} text
 * @returns {string}
 */
function trimSlashes(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '/') start += 1;
  while (end > start && text[end - 1] === '/') end -= 1;
  return text.slice(start, end);
}

/**
 * A scope prefix as the sizer uses it: empty (the whole site) or a path with a
 * leading and a trailing slash (`/de/`).
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function normalizePrefix(prefix) {
  let raw = String(prefix || '').trim();
  // A full address is its path.
  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return '';
    }
  }
  const cut = raw.search(/[?#]/);
  const text = trimSlashes(cut === -1 ? raw : raw.slice(0, cut));
  if (!text) return '';
  try {
    // As the URL parser writes a path (`/über/` is `/%C3%BCber/`), which is what a URL's path is compared with.
    return new URL(`/${text}/`, 'https://prefix.invalid').pathname;
  } catch {
    return `/${text}/`;
  }
}

/** A host name for comparison: lower case, without a leading `www.`. */
export function hostKey(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '');
}

const DEFAULT_PORTS = new Set(['', '80', '443']);

/** A URL's port when it is not a default one (`''` for 80, 443 and none). */
export function nonDefaultPort(port) {
  const text = String(port ?? '');
  return DEFAULT_PORTS.has(text) ? '' : text;
}

/**
 * What identifies a site: its host (as `hostKey`) and a port that is not 80 or
 * 443. `http` and `https` of one host are one site (a site redirects from the
 * one to the other), another port is another service.
 *
 * @param {URL} url
 * @returns {string}
 */
export function siteKeyOf(url) {
  const port = nonDefaultPort(url.port);
  return `${hostKey(url.hostname)}${port ? `:${port}` : ''}`;
}

/**
 * Whether a URL is on the corpus' site: an http(s) URL on the site's host and
 * port (a leading `www.` does not count, http and https are the same site). A
 * sitemap may list other hosts or ports; a corpus never fetches from them, which
 * keeps a crafted sitemap from sending the server to arbitrary addresses.
 *
 * @param {string} url
 * @param {string} siteKey - From {@link siteKeyOf}; a bare host name means its default ports
 * @returns {boolean}
 */
export function onSite(url, siteKey) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      siteKeyOf(parsed) === hostKey(siteKey)
    );
  } catch {
    return false;
  }
}

/** Whether a URL's path lies under the prefix (every path does without one). */
export function underPrefix(url, prefix) {
  if (!prefix) return true;
  try {
    return new URL(url).pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * The section a URL counts towards: the first path segment after the prefix,
 * in lower case; the page at the prefix itself is `home`.
 *
 * @param {string} url
 * @param {string} [prefix]
 * @returns {string}
 */
export function sectionOf(url, prefix = '') {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'home';
  }
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
  return trimSlashes(path).split('/')[0].toLowerCase() || 'home';
}

/**
 * The number of pages per section, largest first.
 *
 * @param {string[]} urls
 * @param {string} [prefix]
 * @returns {Array<{section: string, pages: number}>}
 */
export function sectionCounts(urls, prefix = '') {
  const counts = new Map();
  for (const url of urls) {
    const section = sectionOf(url, prefix);
    counts.set(section, (counts.get(section) || 0) + 1);
  }
  return [...counts]
    .map(([section, pages]) => ({ section, pages }))
    .sort((a, b) => b.pages - a.pages || a.section.localeCompare(b.section));
}
