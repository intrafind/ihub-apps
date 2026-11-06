// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The light/dark/auto preference: where it is stored and how it reaches the document.
 *
 * Outside embed mode the choice lives in `localStorage` (`ih-dark-mode`). In embed mode it lives
 * in `sessionStorage` instead and `localStorage` is never read, so an embedding host's
 * `?mode=dark` cannot change what a user sees when they open iHub directly (see `embedMode.js`).
 * `useDarkMode` is the React face of this module; `embedBootstrap.js` applies the `mode` URL
 * parameter before the first render.
 */

import { getSessionValue, isEmbedMode, setSessionValue } from './embedMode';

export const DARK_MODE_STORAGE_KEY = 'ih-dark-mode';

export const VALID_MODES = new Set(['auto', 'light', 'dark']);

/**
 * Validate a `mode` URL parameter.
 * @param {string|null|undefined} value - The raw parameter value.
 * @returns {'auto'|'light'|'dark'|null} The mode, or null when the value is not one.
 */
export function parseModeParam(value) {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : null;
}

/**
 * The saved preference: the tab's own in embed mode, the browser's otherwise.
 * @returns {'auto'|'light'|'dark'} The saved preference, `auto` when there is none.
 */
export function getStoredPreference() {
  try {
    const stored = isEmbedMode()
      ? getSessionValue(DARK_MODE_STORAGE_KEY)
      : localStorage.getItem(DARK_MODE_STORAGE_KEY);
    if (stored && VALID_MODES.has(stored)) {
      return stored;
    }
  } catch {
    // localStorage may be unavailable
  }
  return 'auto';
}

/**
 * Save the preference where {@link getStoredPreference} reads it.
 * @param {'auto'|'light'|'dark'} preference
 */
export function storePreference(preference) {
  if (isEmbedMode()) {
    setSessionValue(DARK_MODE_STORAGE_KEY, preference);
    return;
  }
  try {
    localStorage.setItem(DARK_MODE_STORAGE_KEY, preference);
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Check if the system prefers dark mode
 * @returns {boolean} True if system prefers dark mode
 */
export function getSystemPreference() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * Determine the effective dark mode state based on preference
 * @param {'auto'|'light'|'dark'} preference - User preference
 * @returns {boolean} Whether dark mode should be active
 */
export function resolveIsDark(preference) {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  // 'auto' - follow system preference
  return getSystemPreference();
}

/**
 * Apply dark or light to the document (`data-theme` for the CSS variables, `dark` class for
 * Tailwind).
 * @param {boolean} dark
 */
export function applyThemeToDocument(dark) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (dark) {
    html.setAttribute('data-theme', 'dark');
    html.classList.add('dark');
  } else {
    html.removeAttribute('data-theme');
    html.classList.remove('dark');
  }
}
