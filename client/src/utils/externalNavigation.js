/* global Office, chrome */

/**
 * Host-aware "leave this surface" helpers: open a URL in the user's browser,
 * and save a file to disk.
 *
 * The same React tree renders in three places and `window.open()` only works
 * in one of them. Inside the Outlook task pane and the browser extension's
 * side panel popups are blocked: `window.open()` returns `null` without
 * navigating, throwing or logging anything, so a button wired straight to it
 * is a completely silent no-op (issue #2453). Each embedded host exposes its
 * own API for this:
 *
 *   - Outlook task pane    -> `Office.context.ui.openBrowserWindow(url)`
 *   - Extension side panel -> `chrome.tabs.create({ url })`
 *   - Web app              -> `window.open(url, '_blank', 'noopener,noreferrer')`
 *
 * Detection is by capability rather than by configuration, so plain modules
 * (API clients, utilities) can use these without a React context in scope —
 * and so the web app is never mistaken for a task pane the way
 * `useEmbeddedHost()`'s Outlook-flavoured default value would have it.
 *
 * Every helper reports whether it managed to hand the URL/file off, so callers
 * can tell the user that nothing happened instead of leaving a dead button.
 */

const WINDOW_FEATURES = 'noopener,noreferrer';

/**
 * Which host API is available for opening a URL: `'office'`, `'extension'`
 * or `'web'`.
 *
 * Deliberately *not* cached: Office.js publishes `Office.context` only after
 * `Office.onReady`, which resolves long after these modules are evaluated, so
 * a value memoised on first call would pin the task pane to `'web'` forever.
 *
 * @returns {'office'|'extension'|'web'}
 */
export function detectExternalNavigationHost() {
  try {
    if (
      typeof Office !== 'undefined' &&
      typeof Office?.context?.ui?.openBrowserWindow === 'function'
    ) {
      return 'office';
    }
  } catch {
    // Office.js is not loaded on this surface.
  }

  try {
    // `chrome.tabs` is only reachable from extension pages — a regular web
    // page sees at most `chrome.runtime`, so this does not misfire in Chrome.
    if (typeof chrome !== 'undefined' && typeof chrome?.tabs?.create === 'function') {
      return 'extension';
    }
  } catch {
    // Not an extension page.
  }

  return 'web';
}

/**
 * Open `url` outside the current surface, using whichever API this host
 * provides.
 *
 * @param {string} url Absolute URL to open.
 * @returns {boolean} `true` when the URL was handed to the host, `false` when
 *   there was nothing to open or every available path was blocked. A `false`
 *   result means the user saw nothing happen — surface it.
 */
export function openExternalUrl(url) {
  if (!url) return false;

  const host = detectExternalNavigationHost();

  if (host === 'office') {
    try {
      Office.context.ui.openBrowserWindow(url);
      return true;
    } catch {
      // Some Outlook builds expose the namespace but reject the call (the
      // OpenBrowserWindowApi requirement set is missing). The desktop client
      // still honours window.open, so fall through rather than giving up.
    }
  }

  if (host === 'extension') {
    try {
      const created = chrome.tabs.create({ url });
      // MV3 returns a promise; swallow rejections so a failed tab creation
      // never surfaces as an unhandled rejection.
      if (created && typeof created.catch === 'function') created.catch(() => {});
      return true;
    } catch {
      // Fall through to window.open.
    }
  }

  try {
    if (window.open(url, '_blank', WINDOW_FEATURES)) return true;
  } catch {
    // Popup blocked or window.open unavailable.
  }

  return false;
}

/**
 * Save `blob` to the user's downloads as `filename`.
 *
 * An object URL driven through a hidden `<a download>` works in every host:
 * `blob:` URLs are same-origin, so the `download` attribute is honoured, and
 * no popup is involved. Pointing `window.open()` at the API URL instead is
 * both popup-blocked *and* unauthenticated in the embedded hosts, whose
 * session lives in an Authorization header rather than a cookie.
 *
 * @param {Blob} blob
 * @param {string} [filename]
 * @returns {boolean} `true` when the download was triggered.
 */
export function saveBlobAs(blob, filename) {
  if (!blob) return false;

  let objectUrl;
  try {
    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || 'download';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  } finally {
    // Revoking synchronously after click() cancels the transfer in
    // Chromium-based hosts before it has started, so let it settle first.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

/**
 * Pull the filename out of a `Content-Disposition` header, preferring the
 * RFC 5987 `filename*` form so non-ASCII names survive the round trip.
 *
 * Lives next to `saveBlobAs` because that is the only thing it feeds: what to
 * call the file once the bytes are in hand.
 *
 * @param {string} [contentDisposition]
 * @returns {string|null} The filename, or null when the header carries none.
 */
export function filenameFromContentDisposition(contentDisposition) {
  if (!contentDisposition) return null;

  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(contentDisposition);
  if (encoded?.[1]) {
    const raw = encoded[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
  return plain?.[1] ? plain[1].trim() : null;
}
