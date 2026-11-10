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
  const raw = String(prefix || '').trim();
  const cut = raw.search(/[?#]/);
  const text = trimSlashes(cut === -1 ? raw : raw.slice(0, cut));
  return text ? `/${text}/` : '';
}

/** A host name for comparison: lower case, without a leading `www.`. */
export function hostKey(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * Whether a URL is on the corpus' site: an http(s) URL on the site's host (a
 * leading `www.` does not count). A sitemap may list other hosts; a corpus
 * never fetches from them, which keeps a crafted sitemap from sending the
 * server to arbitrary addresses.
 *
 * @param {string} url
 * @param {string} siteHost - A host name, as `hostKey` takes it
 * @returns {boolean}
 */
export function onSite(url, siteHost) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      hostKey(parsed.hostname) === hostKey(siteHost)
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
