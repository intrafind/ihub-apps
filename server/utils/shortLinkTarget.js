/**
 * Where a short link may send its visitor.
 *
 * A target is either a path on this installation (`/apps/chat?model=x`) or an
 * absolute `http(s)` URL whose host an administrator allowed under
 * `platform.shortLinks.allowedHosts`. Everything else — other schemes,
 * protocol-relative URLs, hosts not on the list — is refused, both when a link
 * is saved and again when `/s/:code` redirects, so links stored before the
 * check existed are covered too.
 *
 * @module utils/shortLinkTarget
 */

/** Resolves relative targets; it never leaves this module. */
const PLACEHOLDER_ORIGIN = 'http://short-link.invalid';

/** Longest target accepted. */
const MAX_TARGET_LENGTH = 4096;

/**
 * Whitespace, control characters and backslashes. Browsers drop tabs and line
 * breaks from URLs and read `\` as `/`, which would change where a path leads.
 */
const UNSAFE_CHARACTERS = /[\u0000- \u007f\\]/;

/**
 * The configured host allowlist, lowercased, without empty entries.
 *
 * @param {unknown} hosts - `platform.shortLinks.allowedHosts`
 * @returns {string[]}
 */
export function normalizeAllowedHosts(hosts) {
  if (!Array.isArray(hosts)) return [];
  return hosts
    .filter(host => typeof host === 'string' && host.trim())
    .map(host => host.trim().toLowerCase());
}

/**
 * Whether `target` names a path on this installation: exactly one leading `/`.
 *
 * @param {string} target
 * @returns {boolean}
 */
function isLocalPath(target) {
  if (!target.startsWith('/') || target.startsWith('//')) return false;
  try {
    const resolved = new URL(target, PLACEHOLDER_ORIGIN);
    // A path that normalises to `//…` (e.g. `/.//host`) is refused too, so the
    // target stays a single-slash path however it is resolved later.
    return resolved.origin === PLACEHOLDER_ORIGIN && !resolved.pathname.startsWith('//');
  } catch {
    return false;
  }
}

/**
 * Whether a short link may redirect to `target`.
 *
 * @param {unknown} target - The link's `url`
 * @param {unknown} [allowedHosts] - `platform.shortLinks.allowedHosts`
 * @returns {boolean}
 */
export function isAllowedShortLinkTarget(target, allowedHosts = []) {
  if (typeof target !== 'string' || !target || target.length > MAX_TARGET_LENGTH) return false;
  if (UNSAFE_CHARACTERS.test(target)) return false;
  if (target.startsWith('/')) return isLocalPath(target);

  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return normalizeAllowedHosts(allowedHosts).includes(url.hostname.toLowerCase());
}
