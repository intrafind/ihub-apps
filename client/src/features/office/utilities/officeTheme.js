/* global Office */

/**
 * Light / dark appearance for the embedded chat shell — the Outlook task pane
 * and the browser-extension side panel (both render `OfficeApp`).
 *
 * Follows the `officeLocale.js` pattern: the preference is stored in the host's
 * localStorage under an `office_`-prefixed key so it survives Outlook restarts,
 * and is applied by setting `data-theme="dark"` on `<html>` — the hook the
 * shared Tailwind `dark:` variant (client/tailwind.css) and the chat component
 * stylesheets already key off.
 *
 * Kept separate from the web app's `useDarkMode` hook on purpose: the task pane
 * defaults to light (dark mode is opt-in via Settings — issue #2366), has its
 * own storage key, has to be applied before React mounts to avoid a white
 * flash, and in "auto" mode follows Outlook's own theme before the OS setting.
 *
 * Auto mode signal order:
 *   1. `Office.context.officeTheme` (Outlook, Mailbox 1.14+). Outlook does not
 *      populate `isDarkTheme` / `themeId`, so darkness is derived from the body
 *      background colour. Changes arrive via `Office.EventType.OfficeThemeChanged`.
 *   2. `prefers-color-scheme: dark` — Outlook clients without the theme API and
 *      the browser-extension side panel.
 */

export const OFFICE_THEME_STORAGE_KEY = 'office_ihub_theme';
export const THEME_PREFERENCES = ['light', 'dark', 'auto'];
export const DEFAULT_THEME_PREFERENCE = 'light';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

let systemListenerBound = false;
let officeListenerBound = false;

/**
 * @returns {'light'|'dark'|'auto'} the persisted preference, or the light default
 */
export function getStoredThemePreference() {
  try {
    const stored = localStorage.getItem(OFFICE_THEME_STORAGE_KEY);
    if (stored && THEME_PREFERENCES.includes(stored)) return stored;
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_THEME_PREFERENCE;
}

/**
 * Whether a hex colour triplet ("#1F1F1F" or "1F1F1F") reads as dark.
 * @returns {boolean|null} null when the value cannot be parsed
 */
export function isDarkHexColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!match) return null;
  const rgb = parseInt(match[1], 16);
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  // Perceived luminance (Rec. 709 weights), 0 = black … 1 = white.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.5;
}

/**
 * Darkness of the Office host theme, when the host exposes one.
 * @param {object} [theme] Office.OfficeTheme — defaults to Office.context.officeTheme
 * @returns {boolean|null} null when no theme is available
 */
export function isOfficeThemeDark(theme) {
  try {
    const t = theme ?? (typeof Office !== 'undefined' ? Office?.context?.officeTheme : null);
    if (!t) return null;
    if (typeof t.isDarkTheme === 'boolean') return t.isDarkTheme;
    return isDarkHexColor(t.bodyBackgroundColor);
  } catch {
    return null;
  }
}

function systemPrefersDark() {
  try {
    return window.matchMedia?.(DARK_MEDIA_QUERY)?.matches ?? false;
  } catch {
    return false;
  }
}

/**
 * @param {'light'|'dark'|'auto'} preference
 * @returns {boolean} whether dark mode should be active
 */
export function resolveIsDark(preference) {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  const officeDark = isOfficeThemeDark();
  return officeDark !== null ? officeDark : systemPrefersDark();
}

/**
 * Apply the resolved theme to the document. Mirrors what `useDarkMode` does
 * in the web app so every shared component styles itself the same way.
 */
export function applyTheme(isDark) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (isDark) {
    html.setAttribute('data-theme', 'dark');
    html.classList.add('dark');
  } else {
    html.removeAttribute('data-theme');
    html.classList.remove('dark');
  }
}

function applyStoredPreference() {
  applyTheme(resolveIsDark(getStoredThemePreference()));
}

/**
 * Persist a preference and apply it immediately — no reload needed.
 * @returns {boolean} false when the value is not a known preference
 */
export function setThemePreference(preference) {
  if (!THEME_PREFERENCES.includes(preference)) {
    console.warn(`[office] ignoring unknown theme preference: ${preference}`);
    return false;
  }
  try {
    localStorage.setItem(OFFICE_THEME_STORAGE_KEY, preference);
  } catch {
    // localStorage unavailable — the choice still applies for this session
  }
  applyTheme(resolveIsDark(preference));
  return true;
}

function reapplyIfAuto() {
  if (getStoredThemePreference() === 'auto') applyStoredPreference();
}

function bindSystemListener() {
  if (systemListenerBound) return;
  try {
    const mediaQuery = window.matchMedia?.(DARK_MEDIA_QUERY);
    if (!mediaQuery) return;
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', reapplyIfAuto);
    } else if (mediaQuery.addListener) {
      // Deprecated fallback for older WebViews
      mediaQuery.addListener(reapplyIfAuto);
    } else {
      return;
    }
    systemListenerBound = true;
  } catch {
    // matchMedia unavailable
  }
}

function bindOfficeThemeListener() {
  if (officeListenerBound) return;
  try {
    if (typeof Office === 'undefined') return;
    const mailbox = Office?.context?.mailbox;
    const eventType = Office?.EventType?.OfficeThemeChanged;
    if (!mailbox?.addHandlerAsync || !eventType) return;
    // Mailbox 1.14+. Older hosts reject the registration in the async result,
    // which is harmless — auto mode then keeps following the OS setting.
    mailbox.addHandlerAsync(eventType, reapplyIfAuto);
    officeListenerBound = true;
  } catch {
    // Office.js not ready or event unsupported
  }
}

/**
 * Apply the persisted preference and start following host / system theme
 * changes while in auto mode. Idempotent: the entry points call it once at
 * module evaluation (so the pane paints dark before Office.js finishes
 * initialising) and again inside `Office.onReady`, when
 * `Office.context.officeTheme` and the mailbox event become available.
 */
export function initOfficeTheme() {
  applyStoredPreference();
  bindSystemListener();
  bindOfficeThemeListener();
}
