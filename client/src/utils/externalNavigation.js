/**
 * Opening a link outside the current view.
 *
 * `window.open()` is only reliable in the plain web app. Inside the hosts that
 * embed the chat UI — the Outlook task pane, the browser extension's side
 * panel — popups are blocked: the call returns `null`, nothing navigates, and
 * nothing is logged, so a button wired straight to it is silently dead
 * (issue #2453). Those hosts supply their own opener through the embedded-host
 * adapter (`openExternalUrl`); everything else falls back to the browser.
 *
 * Both paths report whether the link actually opened, so callers can surface a
 * usable link instead of leaving the user looking at a button that does
 * nothing.
 */

/**
 * Open a URL in a new browser tab/window.
 *
 * @param {string} url
 * @returns {boolean} false when the host blocked it.
 */
export function openInNewTab(url) {
  if (!url) return false;
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    return !!opened;
  } catch {
    return false;
  }
}

/**
 * Open a URL the way the current host allows.
 *
 * @param {string} url
 * @param {Object} [host] the embedded-host adapter, when one is in scope.
 * @returns {Promise<boolean>} false when the link could not be opened.
 */
export async function openExternalUrl(url, host = null) {
  if (!url) return false;
  if (typeof host?.openExternalUrl === 'function') {
    try {
      // Adapters may be sync or async; both are awaited the same way.
      return (await host.openExternalUrl(url)) !== false;
    } catch (error) {
      console.error('[iHub] host openExternalUrl failed:', error);
      return false;
    }
  }
  return openInNewTab(url);
}
