// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Embed mode: iHub running inside another product's iframe.
 *
 * An embedding host (iFinder, Nextcloud, …) must be able to steer iHub's chrome and appearance
 * without changing anything for people who open iHub directly. An iframe on a same-site
 * subdomain shares iHub's `localStorage` with direct visits, so in embed mode every preference
 * that a URL parameter can set (integration settings, dark mode, language) lives in
 * `sessionStorage` instead: it is private to the tab/iframe, survives in-app navigation and
 * reloads of that frame, and is gone when the tab closes. `localStorage` is neither read nor
 * written for those preferences.
 *
 * Embed mode is switched on by the `?embed=true` URL parameter or by an embed page that carries
 * `data-ihub-embed="true"` on its `<html>` element (the Nextcloud full-app embed); both are
 * handled by `embedBootstrap.js`. The flag is itself a `sessionStorage` entry, so it sticks for
 * the lifetime of the frame even though the in-app router drops the query string on the first
 * navigation. It only counts while the page is framed (see {@link isEmbedMode}), so a top-level
 * visit of iHub later in the same tab is an ordinary visit.
 *
 * `sessionStorage` can be blocked (third-party storage rules, some privacy modes). The session
 * helpers below then fall back to memory, so embed mode keeps working until the page is reloaded.
 */

import { isFramed } from './isFramed';

/** `sessionStorage` flag marking this tab/iframe as an embed. */
export const EMBED_MODE_KEY = 'ihubEmbedMode';

/**
 * Session-scoped counterparts of the `localStorage` entries embed mode must not touch. They keep
 * the names of the `localStorage` keys they replace: `ihubIntegrationSettings`
 * (`integrationSettings.js`), `ih-dark-mode` (`themePreference.js`) and `i18nextLng` (the
 * i18next language cache).
 */
const EMBED_SESSION_KEYS = ['ihubIntegrationSettings', 'ih-dark-mode', 'i18nextLng'];

// Only filled while `sessionStorage` is unusable.
const memoryFallback = new Map();

/**
 * Read a value from the tab's `sessionStorage`.
 * @param {string} key
 * @returns {string|null} The value, or null when it is not set.
 */
export function getSessionValue(key) {
  try {
    const value = sessionStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // sessionStorage unavailable; the memory fallback below answers.
  }
  return memoryFallback.has(key) ? memoryFallback.get(key) : null;
}

/**
 * Write a value to the tab's `sessionStorage`.
 * @param {string} key
 * @param {string} value
 */
export function setSessionValue(key, value) {
  try {
    sessionStorage.setItem(key, value);
    memoryFallback.delete(key);
  } catch {
    memoryFallback.set(key, value);
  }
}

/**
 * Remove a value from the tab's `sessionStorage`.
 * @param {string} key
 */
export function removeSessionValue(key) {
  memoryFallback.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    // sessionStorage unavailable; nothing stored there to remove.
  }
}

/**
 * Whether this page is an embed.
 *
 * The flag is stored in the tab's `sessionStorage`, and a frame on a same-site host shares that
 * storage with a top-level iHub page opened later in the same tab (a link in the host that opens
 * iHub in the same tab, or an address typed there). That page is a direct visit, so the stored
 * flag only counts while the page is framed. A page that is not framed is an embed only when it
 * says so itself: `?embed=true` in its own URL, or `data-ihub-embed` on its `<html>` element.
 *
 * @returns {boolean}
 */
export function isEmbedMode() {
  if (getSessionValue(EMBED_MODE_KEY) !== '1') return false;
  return isFramed() || isEmbedDocument() || urlRequestsEmbed();
}

/**
 * Whether the URL of this page carries `embed=true`.
 * @returns {boolean}
 */
function urlRequestsEmbed() {
  return (
    typeof window !== 'undefined' &&
    isEmbedParam(new URLSearchParams(window.location.search).get('embed'))
  );
}

/**
 * Mark this tab/iframe as an embed.
 */
export function activateEmbedMode() {
  setSessionValue(EMBED_MODE_KEY, '1');
}

/**
 * Whether the page itself declares it is an embed (`<html data-ihub-embed="true">`), as the
 * Nextcloud embed page does.
 * @returns {boolean}
 */
export function isEmbedDocument() {
  return typeof document !== 'undefined' && document.documentElement.dataset.ihubEmbed === 'true';
}

/**
 * Forget the embed's session-scoped preferences, so a new embed session starts from the
 * defaults plus whatever the URL sets.
 */
export function resetEmbedSession() {
  EMBED_SESSION_KEYS.forEach(removeSessionValue);
}

/**
 * Clear the tab's `sessionStorage` but keep the embed's flag and preferences. Sign-out and the
 * forced refresh wipe the session and then load a URL without `embed=true`; clearing the embed's
 * state with the rest would drop the frame out of embed mode, after which it would read and write
 * `localStorage` again. Outside embed mode this is a plain `sessionStorage.clear()`, which also
 * removes any embed state a frame earlier in the same tab left behind.
 */
export function clearSessionStorageKeepingEmbed() {
  const kept = isEmbedMode()
    ? [EMBED_MODE_KEY, ...EMBED_SESSION_KEYS]
        .map(key => [key, getSessionValue(key)])
        .filter(([, value]) => value !== null)
    : [];
  try {
    sessionStorage.clear();
  } catch {
    // sessionStorage unavailable; nothing stored there to clear.
  }
  kept.forEach(([key, value]) => setSessionValue(key, value));
}

/**
 * Whether an `embed` URL parameter value switches embed mode on. Only `true` does; any other
 * value (including `false`) is ignored.
 * @param {string|null} value
 * @returns {boolean}
 */
export function isEmbedParam(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/**
 * Switch embed mode on when the URL carries `embed=true`. Loading an embed URL starts a fresh
 * embed session: preferences left by an earlier load of the same frame are discarded, so the
 * URL the host built is what the user gets. A URL without `embed=true` changes nothing, so
 * in-app navigation (which drops the query string) and reloads of an in-app URL keep the
 * session.
 *
 * @param {URLSearchParams|string} search - The URL's query string or its parsed parameters.
 * @returns {boolean} Whether the URL asked for embed mode.
 */
export function activateEmbedModeFromUrl(search) {
  const params = new URLSearchParams(search);
  if (!isEmbedParam(params.get('embed'))) return false;
  resetEmbedSession();
  activateEmbedMode();
  return true;
}
