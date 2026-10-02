/**
 * URL checks for the places where the client navigates to a URL that came
 * from outside the code: a `?returnUrl=` parameter, the `authReturnUrl`
 * value in sessionStorage, or an admin-configured link.
 *
 * - {@link getSafeReturnPath} turns a stored or requested return URL into a
 *   path on this app, or the app root when it does not point here.
 * - {@link getHttpUrl} resolves a URL and accepts it only with the `http:` or
 *   `https:` scheme.
 */

import { getBasePath } from './runtimeBasePath';

/**
 * The app root for a deployment base path: `/` at the root, `/ihub/` under a
 * subpath.
 *
 * @param {string} basePath - Base path without a trailing slash ('' at the root).
 * @returns {string}
 */
const appRootPath = basePath => (basePath ? `${basePath}/` : '/');

/**
 * Whether `pathname` lies inside the app served at `basePath`.
 *
 * @param {string} pathname - Normalised pathname of the parsed URL.
 * @param {string} basePath - Base path without a trailing slash ('' at the root).
 * @returns {boolean}
 */
const isWithinBasePath = (pathname, basePath) =>
  !basePath || pathname === basePath || pathname.startsWith(`${basePath}/`);

/**
 * Resolve a return URL to a path on this app, for navigating back after a
 * sign-in.
 *
 * The value is resolved against the current origin, so both shapes the app
 * stores work: absolute URLs (`window.location.href`) and paths
 * (`/ihub/apps/chat?x=1`). It is accepted only when it resolves to the
 * current origin and, on a subpath deployment, to a path under the base path.
 * Anything else — another origin, a scheme other than `http:`/`https:`
 * (`javascript:`, `data:`, or `blob:`, whose origin is that of the URL it
 * wraps), a protocol-relative `//host` or `/\host`, a path that normalises to
 * one (`/.//host`), a malformed value — yields the app root instead.
 *
 * The result is always a path (pathname + search + hash), never an absolute
 * URL, so assigning it to `window.location.href` cannot leave the origin.
 *
 * @param {unknown} returnUrl - Untrusted return URL (query parameter or stored value).
 * @param {object} [options]
 * @param {string} [options.basePath] - Deployment base path; detected at runtime by default.
 * @param {string} [options.origin] - Origin to stay on; `window.location.origin` by default.
 * @returns {string} A same-origin path inside the app, or the app root.
 *
 * @example
 * // On https://ihub.example.com/ihub/login
 * getSafeReturnPath('https://ihub.example.com/ihub/apps/chat?x=1'); // '/ihub/apps/chat?x=1'
 * getSafeReturnPath('https://other.example.com/');                  // '/ihub/'
 */
export function getSafeReturnPath(returnUrl, options = {}) {
  const basePath = options.basePath ?? getBasePath();
  const origin = options.origin ?? window.location.origin;
  const fallback = appRootPath(basePath);

  if (typeof returnUrl !== 'string' || returnUrl === '') return fallback;
  // An opaque origin ("null") matches every other opaque origin, including
  // `javascript:` and `data:` URLs, so there is nothing to compare against.
  if (!origin || origin === 'null') return fallback;

  let url;
  try {
    url = new URL(returnUrl, origin);
  } catch {
    return fallback;
  }

  // Only http(s) URLs have a pathname that is a path; a `blob:` URL takes its
  // origin from the URL it wraps and its pathname is that whole URL.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
  if (url.origin !== origin) return fallback;
  // A pathname that starts with `//` (e.g. from `/.//host` or `/a/..//host`)
  // would be read as a protocol-relative URL once it is used on its own.
  if (url.pathname.startsWith('//')) return fallback;
  if (!isWithinBasePath(url.pathname, basePath)) return fallback;

  return `${url.pathname}${url.search}${url.hash}`;
}

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
