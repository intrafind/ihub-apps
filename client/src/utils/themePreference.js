// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The light/dark/auto preference: where it is stored and how it reaches the document.
 *
 * Outside embed mode the choice lives in `localStorage` (`ih-dark-mode`). In embed mode it lives
 * in `sessionStorage` instead and `localStorage` is never read, so an embedding host's
 * `?mode=dark` cannot change what a user sees when they open iHub directly (see `embedMode.js`).
 * `useDarkMode` is the React face of this module (through the shared store at the end of this
 * file); `embedBootstrap.js` applies the stored preference and the `mode` URL parameter before the
 * first render, and the inline script in `client/index.html` applies the stored preference even
 * before the stylesheets load (outside embed mode; `tests/unit/client/theme-prepaint-sync.test.jsx`
 * keeps the two in step).
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
  // Each case returns a literal rather than the input, so what leaves this function is one of
  // three constants, never a string the URL supplied (static analysis tracks the difference).
  switch (value.trim().toLowerCase()) {
    case 'auto':
      return 'auto';
    case 'light':
      return 'light';
    case 'dark':
      return 'dark';
    default:
      return null;
  }
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
    html.dataset.theme = 'dark';
    html.classList.add('dark');
  } else {
    delete html.dataset.theme;
    html.classList.remove('dark');
  }
}

/*
 * The shared theme store.
 *
 * Every `useDarkMode()` caller (the header toggle, the admin sidebar toggle, the JSON editor, the
 * admin layout) reads this one store, so they always agree. Before, each caller kept its own copy
 * of the preference and its own system-theme listener, and a stale `auto` copy could switch the
 * page back to light when the OS theme changed after the user had picked "Dark" elsewhere.
 *
 * Storage stays the source of truth: while nobody is subscribed, the snapshot is re-read from
 * storage (so a `?mode=` applied by `embedBootstrap.js` before the first render is picked up).
 * While somebody is subscribed, the snapshot changes only through {@link setThemePreference} and
 * the single `prefers-color-scheme` listener installed here.
 */

/** @typedef {{ preference: 'auto'|'light'|'dark', isDark: boolean }} ThemeSnapshot */

const themeListeners = new Set();
/** @type {ThemeSnapshot|null} */
let themeSnapshot = null;
let systemThemeQuery = null;

/**
 * Replace the snapshot when the values differ, keeping its identity otherwise
 * (`useSyncExternalStore` re-renders on every identity change).
 * @param {'auto'|'light'|'dark'} preference
 * @param {boolean} isDark
 * @returns {boolean} Whether the snapshot changed.
 */
function updateThemeSnapshot(preference, isDark) {
  if (themeSnapshot && themeSnapshot.preference === preference && themeSnapshot.isDark === isDark) {
    return false;
  }
  themeSnapshot = { preference, isDark };
  return true;
}

function notifyThemeListeners() {
  themeListeners.forEach(listener => listener());
}

/** The OS switched between light and dark: follow it while the preference is `auto`. */
function handleSystemThemeChange(event) {
  if (!themeSnapshot || themeSnapshot.preference !== 'auto') return;
  const dark = Boolean(event.matches);
  applyThemeToDocument(dark);
  if (updateThemeSnapshot('auto', dark)) notifyThemeListeners();
}

function watchSystemTheme() {
  if (systemThemeQuery || typeof window === 'undefined') return;
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query) return;
  // addEventListener: Chrome 85+, Safari 14+, Firefox 78+; addListener for older Safari.
  if (query.addEventListener) {
    query.addEventListener('change', handleSystemThemeChange);
  } else if (query.addListener) {
    query.addListener(handleSystemThemeChange);
  } else {
    return;
  }
  systemThemeQuery = query;
}

function unwatchSystemTheme() {
  if (!systemThemeQuery) return;
  if (systemThemeQuery.removeEventListener) {
    systemThemeQuery.removeEventListener('change', handleSystemThemeChange);
  } else if (systemThemeQuery.removeListener) {
    systemThemeQuery.removeListener(handleSystemThemeChange);
  }
  systemThemeQuery = null;
}

/**
 * The current theme: the saved preference and whether the page is dark.
 *
 * The same object is returned until something changes, as `useSyncExternalStore` requires.
 *
 * @returns {ThemeSnapshot}
 */
export function getThemeSnapshot() {
  if (themeSnapshot === null || themeListeners.size === 0) {
    const preference = getStoredPreference();
    updateThemeSnapshot(preference, resolveIsDark(preference));
  }
  return themeSnapshot;
}

/**
 * Be told whenever the theme changes. The first subscriber installs the one system-theme
 * listener; the last one to leave removes it.
 *
 * @param {() => void} listener - Called after every change; read {@link getThemeSnapshot} in it.
 * @returns {() => void} Unsubscribe.
 */
export function subscribeTheme(listener) {
  if (themeListeners.size === 0) {
    // Pick up anything written to storage while nobody was listening.
    getThemeSnapshot();
  }
  themeListeners.add(listener);
  watchSystemTheme();
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size === 0) unwatchSystemTheme();
  };
}

/**
 * Save a light/dark/auto choice, apply it to the document and tell every subscriber.
 *
 * @param {'auto'|'light'|'dark'} preference
 * @returns {boolean} False (and nothing changes) when the value is not a valid mode.
 */
export function setThemePreference(preference) {
  if (!VALID_MODES.has(preference)) {
    console.warn(`Invalid dark mode preference: ${preference}`);
    return false;
  }
  storePreference(preference);
  const dark = resolveIsDark(preference);
  applyThemeToDocument(dark);
  if (updateThemeSnapshot(preference, dark)) notifyThemeListeners();
  return true;
}
