import { getBasePath } from './basePath.js';

/**
 * Helpers for resolving the public-facing protocol / host / base URL of an
 * incoming request when iHub sits behind one or more reverse proxies
 * (ngrok, nginx, Cloudflare, …).
 *
 * Why a shared helper? Several call sites — the Outlook add-in manifest
 * generator, the browser-extension download endpoint, the Office 365
 * OAuth callback URL builder — all need to derive
 * `https://public-host/[basePath]` from the live request. They all read
 * the same `X-Forwarded-Proto` / `X-Forwarded-Host` headers and they all
 * share the same edge case: when there's a chain of proxies the values
 * are RFC 7230 comma-joined lists ("https, https"), and naive
 * concatenation produces obviously broken URLs like
 * `https,https://example.com`. Centralising the parsing here means a
 * future header subtlety only has to be fixed in one place.
 */

/**
 * Pick the first comma-separated value from a header value. Per RFC 7230
 * §5.7.1 a chain of proxies appends to `X-Forwarded-Proto` / `Host` etc.
 * with comma separators (e.g. `X-Forwarded-Proto: https, https`). The
 * leftmost value is the most-trusted (closest to the original client),
 * which is what we want for building public URLs back to the user.
 *
 * Returns null when the header is absent or empty.
 *
 * @param {string|undefined|null} headerValue
 * @returns {string|null}
 */
export function firstForwardedValue(headerValue) {
  if (!headerValue) return null;
  const first = String(headerValue).split(',')[0].trim();
  return first || null;
}

/**
 * Resolve the public protocol of the incoming request, honouring the
 * `X-Forwarded-Proto` header (with comma-joined chains handled) before
 * falling back to Express's parsed protocol or to "https".
 *
 * @param {import('express').Request} req
 * @returns {string} 'http' | 'https'
 */
export function getForwardedProto(req) {
  return firstForwardedValue(req.get('X-Forwarded-Proto')) || req.protocol || 'https';
}

/**
 * Resolve the public host of the incoming request, honouring
 * `X-Forwarded-Host` (with comma-joined chains handled) before falling
 * back to the `Host` header.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export function getForwardedHost(req) {
  return firstForwardedValue(req.get('X-Forwarded-Host')) || req.get('host') || null;
}

/**
 * Build the absolute public base URL for the iHub deployment from the live
 * request, including the configured base path subdir (e.g. `/ihub`). Used
 * by every endpoint that needs to embed a "URL the browser can come back
 * to" inside the response (download endpoints, manifest generators, OAuth
 * callback URL builders).
 *
 * @param {import('express').Request} req
 * @returns {string} e.g. "https://b5dd828a8d88.ngrok.app" or "https://mysite.com/ihub"
 */
export function buildPublicBaseUrl(req) {
  const proto = getForwardedProto(req);
  const host = getForwardedHost(req);
  const basePath = getBasePath();
  return `${proto}://${host}${basePath}`;
}
