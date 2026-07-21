/**
 * Small persistence helper for the admin-configurable error-page messages.
 *
 * The generic ErrorBoundary is mounted *above* UIConfigProvider, so it cannot
 * read the `errorPages` config through the React context (the provider may be
 * the very thing that failed). To still let admins customize the generic error
 * screen, UIConfigProvider writes the latest `errorPages` block to localStorage
 * whenever the UI config loads, and the ErrorBoundary reads that cached
 * snapshot as a best-effort source. When nothing is cached, callers fall back
 * to the bundled i18n strings.
 */
const ERROR_PAGES_CACHE_KEY = 'ihub-error-pages-config';

/**
 * Persist the errorPages config so the context-less ErrorBoundary can use it.
 * @param {object|null|undefined} errorPages
 */
export function cacheErrorPagesConfig(errorPages) {
  try {
    if (errorPages && typeof errorPages === 'object') {
      localStorage.setItem(ERROR_PAGES_CACHE_KEY, JSON.stringify(errorPages));
    } else {
      localStorage.removeItem(ERROR_PAGES_CACHE_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode, quota) — ignore.
  }
}

/**
 * Read the cached errorPages config. Returns an empty object when nothing is
 * cached or the value cannot be parsed.
 * @returns {object}
 */
export function readCachedErrorPagesConfig() {
  try {
    const raw = localStorage.getItem(ERROR_PAGES_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
