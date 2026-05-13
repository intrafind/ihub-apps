/**
 * Validate a `returnUrl` parameter supplied to an OAuth flow before
 * passing it to `res.redirect()`.
 *
 * Allows:
 *  - Relative paths that start with a single `/` (never `//`, which
 *    browsers treat as protocol-relative and may redirect off-site).
 *  - Absolute URLs on the same hostname as the request, using the
 *    `http:` or `https:` scheme only.
 *
 * Crucially rejects `javascript:`, `data:`, `file:`, `gopher:`, and any
 * other non-http(s) scheme: `URL.hostname` happily parses
 * `javascript://ihub.example.com/...` and reports `ihub.example.com` as
 * the hostname, so a scheme check is mandatory. Major browsers strip
 * JS-scheme `Location` headers today, but defense in depth is cheap.
 *
 * @param {string|undefined|null} returnUrl
 * @param {{ hostname: string }} req — anything with a `hostname` property
 *   (an Express request is the typical caller).
 * @returns {boolean}
 */
export function isValidReturnUrl(returnUrl, req) {
  if (!returnUrl) return false;
  if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) return true;
  try {
    const url = new URL(returnUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === req.hostname;
  } catch {
    return false;
  }
}

export default isValidReturnUrl;
