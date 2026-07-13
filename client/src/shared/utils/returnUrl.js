// Same-origin guard for post-authentication redirect targets, mirroring
// auth-gate.js's getEffectiveReturnUrl. Prevents open-redirect and
// javascript: URI XSS via a crafted ?returnUrl= query parameter.
export function resolveSafeReturnUrl(rawUrl, fallback = '/') {
  if (!rawUrl) return fallback;
  try {
    const resolved = new URL(rawUrl, window.location.origin);
    if (resolved.origin !== window.location.origin) return fallback;
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return fallback;
    return resolved.toString();
  } catch {
    return fallback;
  }
}
