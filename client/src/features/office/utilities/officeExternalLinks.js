/* global Office */
import { openInNewTab } from '../../../utils/externalNavigation';

/**
 * Open a link from inside an Office task pane.
 *
 * The pane is a sandboxed WebView: `window.open()` is blocked there and
 * returns `null` without raising anything, so links wired to it are dead
 * (issue #2453). Office exposes `Office.context.ui.openBrowserWindow()` for
 * exactly this — it hands the URL to the user's default browser. It needs the
 * `OpenBrowserWindowApi 1.1` requirement set; older clients fall back to
 * `window.open`, which at least works in Outlook on the web.
 *
 * @param {string} url
 * @returns {boolean} false when the link could not be opened.
 */
export function openExternalUrlInOffice(url) {
  if (!url) return false;

  try {
    if (
      typeof Office !== 'undefined' &&
      typeof Office.context?.ui?.openBrowserWindow === 'function'
    ) {
      Office.context.ui.openBrowserWindow(url);
      return true;
    }
  } catch (error) {
    console.error('[iHub] Office.context.ui.openBrowserWindow failed:', error);
  }

  return openInNewTab(url);
}
