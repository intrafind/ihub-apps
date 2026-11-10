// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where a short link may send its visitor.
 *
 * A target is either a path on this installation (`/apps/chat?model=x`) or an
 * absolute `http(s)` URL whose host is on the SSRF allowlist
 * (`platform.ssrf.allowedHosts`, Admin → Security → SSRF). Everything else —
 * other schemes, protocol-relative URLs, hosts not on the list — is refused,
 * both when a link is saved and again when `/s/:code` redirects, so links
 * stored before the check existed are covered too.
 *
 * Entries match the way the SSRF guard matches them (`hostMatchesPattern` in
 * `services/mcp/safeFetch.js`, repeated here so this check does not pull in the
 * config cache):
 *
 * - `docs.example.com` — exactly this host.
 * - `*.example.com` or `.example.com` — any subdomain of `example.com`
 *   (`a.example.com`, `a.b.example.com`), not `example.com` itself.
 *
 * Hostnames from `new URL()` are lower case and in their ASCII (punycode)
 * form; entries are compared case-insensitively.
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
 * Whether `hostname` matches one allowlist entry.
 *
 * @param {string} entry - Lower-case, trimmed
 * @param {string} hostname - Lower-case hostname of the target
 * @returns {boolean}
 */
function matchesEntry(entry, hostname) {
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
 * @param {unknown} allowedHosts - `platform.ssrf.allowedHosts`
 * @returns {boolean}
 */
export function isAllowedHost(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase();
  if (!host || !Array.isArray(allowedHosts)) return false;
  return allowedHosts
    .filter(entry => typeof entry === 'string' && entry.trim())
    .some(entry => matchesEntry(entry.trim().toLowerCase(), host));
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

/** The refusal of a target that is not a path or an `http(s)` URL at all. */
const NOT_A_TARGET = Object.freeze({ reason: 'target' });

/**
 * Why a short link may not redirect to `target`, or `null` when it may.
 *
 * - `{ reason: 'host', host }` — an `http(s)` URL that would be allowed if its
 *   host were on `allowedHosts`; `host` is the hostname an administrator would
 *   add (lower case, punycode).
 * - `{ reason: 'target' }` — anything else: another scheme, a
 *   protocol-relative URL, credentials in the URL, unsafe characters.
 *
 * @param {unknown} target - The link's `url`
 * @param {unknown} [allowedHosts] - `platform.ssrf.allowedHosts`
 * @returns {null | { reason: 'host', host: string } | { reason: 'target' }}
 */
export function shortLinkTargetRefusal(target, allowedHosts = []) {
  if (typeof target !== 'string' || !target || target.length > MAX_TARGET_LENGTH) {
    return NOT_A_TARGET;
  }
  if (UNSAFE_CHARACTERS.test(target)) return NOT_A_TARGET;
  if (target.startsWith('/')) return isLocalPath(target) ? null : NOT_A_TARGET;

  let url;
  try {
    url = new URL(target);
  } catch {
    return NOT_A_TARGET;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return NOT_A_TARGET;
  if (url.username || url.password || !url.hostname) return NOT_A_TARGET;
  if (isAllowedHost(url.hostname, allowedHosts)) return null;
  return { reason: 'host', host: url.hostname };
}

/**
 * Whether a short link may redirect to `target`.
 *
 * @param {unknown} target - The link's `url`
 * @param {unknown} [allowedHosts] - `platform.ssrf.allowedHosts`
 * @returns {boolean}
 */
export function isAllowedShortLinkTarget(target, allowedHosts = []) {
  return shortLinkTargetRefusal(target, allowedHosts) === null;
}
