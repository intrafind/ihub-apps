// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Scheme checks for URLs that reach a navigation or a request from outside
 * the code: an admin-configured link, a source link, the iHub address of the
 * Office add-in or the browser extension, a URL the server hands back.
 *
 * Only `http:` and `https:` pass; `javascript:`, `data:`, `blob:`, `file:`,
 * `chrome-extension:` and the like never do.
 *
 * Kept free of other imports (the return-path check in `safeUrl` needs the
 * deployment base path, which this does not) so any module can use it,
 * including the ones loaded before the app has started.
 */

/**
 * Resolve `value` to an absolute `http:` or `https:` URL, for navigating to an
 * admin-configured link.
 *
 * Relative values are resolved against `base`, so a path such as
 * `/apps/other` stays on the current site.
 *
 * @param {unknown} value - URL to check.
 * @param {string} [base] - Base for relative URLs; the current page by default.
 * @returns {string|null} The resolved URL, or `null` for any other scheme
 *   (`javascript:`, `data:`, `mailto:`, …), an empty value or anything
 *   `new URL()` cannot parse.
 *
 * @example
 * getHttpUrl('https://example.com/tool'); // 'https://example.com/tool'
 * getHttpUrl('mailto:someone@example.com'); // null
 */
export function getHttpUrl(value, base = window.location.href) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The address of an iHub server, for building its API URLs: an absolute
 * `http:` or `https:` URL, optionally with a base path (`https://host/ihub`),
 * returned without query, fragment or trailing slash.
 *
 * Values that are relative, use another scheme or carry credentials
 * (`https://user:pass@host`) are rejected.
 *
 * @param {unknown} value - Configured iHub address.
 * @returns {string|null} The normalised address, or `null` when it is not an
 *   absolute http(s) URL.
 *
 * @example
 * getHttpBaseUrl('https://ihub.example.com/ihub/'); // 'https://ihub.example.com/ihub'
 * getHttpBaseUrl('javascript:alert(1)');            // null
 */
export function getHttpBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}
