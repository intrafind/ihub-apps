/**
 * Where a short link may send its visitor.
 *
 * A target is either a path on this installation (`/apps/chat?model=x`) or an
 * absolute `http(s)` URL whose host matches an entry an administrator allowed
 * under `platform.shortLinks.allowedHosts`. Everything else — other schemes,
 * protocol-relative URLs, hosts not on the list — is refused, both when a link
 * is saved and again when `/s/:code` redirects, so links stored before the
 * check existed are covered too.
 *
 * An `allowedHosts` entry is one of:
 *
 * - `docs.example.com` — exactly this host.
 * - `*.example.com` or `.example.com` — any subdomain of `example.com`
 *   (`a.example.com`, `a.b.example.com`), not `example.com` itself. These
 *   are the semantics of `ssrf.allowedHosts` (`hostMatchesPattern` in
 *   `services/mcp/safeFetch.js`), repeated here so this check does not pull
 *   in the config cache.
 * - `/regex/` — a regular expression the whole hostname must match. It is
 *   anchored at both ends, so `/example\.com/` does not match
 *   `example.com.other.net`. Patterns are checked and run with the bounds of
 *   `utils/safeRegex.js`; an invalid or unsafe pattern matches nothing.
 *
 * Hostnames from `new URL()` are lower case and in their ASCII (punycode)
 * form; host entries are compared case-insensitively, regex entries as written.
 *
 * @module utils/shortLinkTarget
 */
import { testRegexSafely, validateRegexPattern } from './safeRegex.js';
import logger from './logger.js';

/** Resolves relative targets; it never leaves this module. */
const PLACEHOLDER_ORIGIN = 'http://short-link.invalid';

/** Longest target accepted. */
const MAX_TARGET_LENGTH = 4096;

/**
 * Whitespace, control characters and backslashes. Browsers drop tabs and line
 * breaks from URLs and read `\` as `/`, which would change where a path leads.
 */
const UNSAFE_CHARACTERS = /[\u0000- \u007f\\]/;

/** Regex entries already reported as unusable, so each is logged once. */
const reportedPatterns = new Set();

/**
 * The configured allowlist entries, trimmed, without empty or non-string ones.
 * Host entries are lowercased; regex entries are kept as written.
 *
 * @param {unknown} hosts - `platform.shortLinks.allowedHosts`
 * @returns {string[]}
 */
export function normalizeAllowedHosts(hosts) {
  if (!Array.isArray(hosts)) return [];
  return hosts
    .filter(host => typeof host === 'string' && host.trim())
    .map(host => host.trim())
    .map(host => (isRegexEntry(host) ? host : host.toLowerCase()));
}

/**
 * Whether an entry is written as a regular expression (`/…/`).
 *
 * @param {string} entry
 * @returns {boolean}
 */
function isRegexEntry(entry) {
  return entry.length > 2 && entry.startsWith('/') && entry.endsWith('/');
}

/**
 * Whether `hostname` matches the regex entry `entry` as a whole.
 *
 * @param {string} entry - `/…/`
 * @param {string} hostname
 * @returns {boolean}
 */
function matchesRegexEntry(entry, hostname) {
  const pattern = `^(?:${entry.slice(1, -1)})$`;
  const { valid, error } = validateRegexPattern(pattern);
  if (valid) {
    const { matched, reason } = testRegexSafely(pattern, hostname);
    if (matched !== null) return matched;
    reportOnce(entry, `could not be evaluated (${reason})`);
    return false;
  }
  reportOnce(entry, error);
  return false;
}

/**
 * Log an unusable regex entry once per process.
 *
 * @param {string} entry
 * @param {string} reason
 */
function reportOnce(entry, reason) {
  if (reportedPatterns.has(entry)) return;
  reportedPatterns.add(entry);
  logger.warn('shortLinks.allowedHosts entry ignored', {
    component: 'ShortLinkTarget',
    entry,
    reason
  });
}

/**
 * Whether `hostname` matches one allowlist entry.
 *
 * @param {string} entry - A normalized entry (see `normalizeAllowedHosts`)
 * @param {string} hostname - Lower-case hostname of the target
 * @returns {boolean}
 */
function matchesEntry(entry, hostname) {
  if (isRegexEntry(entry)) return matchesRegexEntry(entry, hostname);
  let domain;
  if (entry.startsWith('*.')) domain = entry.slice(2);
  else if (entry.startsWith('.')) domain = entry.slice(1);
  else return hostname === entry;
  return Boolean(domain) && hostname.endsWith(`.${domain}`);
}

/**
 * Whether `hostname` is allowed by `allowedHosts`.
 *
 * @param {string} hostname
 * @param {unknown} allowedHosts - `platform.shortLinks.allowedHosts`
 * @returns {boolean}
 */
export function isAllowedHost(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return normalizeAllowedHosts(allowedHosts).some(entry => matchesEntry(entry, host));
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
  return isAllowedHost(url.hostname, allowedHosts);
}
