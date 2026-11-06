// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Utility functions for managing integration settings (header/footer/sidebar visibility and the
 * UI language) throughout the iHub application.
 *
 * The settings come from the `header`, `footer`, `sidebar` and `language` URL parameters. A normal
 * browser session remembers them in `localStorage`. In embed mode (`?embed=true`, or an embed
 * entry such as `client/nextcloud/full-app-entry.jsx`; see `embedMode.js`) they are kept in the
 * tab's `sessionStorage` instead and `localStorage` is never read or written: direct-visit users
 * in other tabs keep their own preferences untouched, an embed never inherits stale state from
 * them, and what the host passed in the URL still survives the in-app navigation that drops the
 * query string.
 */

import { getSessionValue, isEmbedMode, setSessionValue } from './embedMode';
import { parseLanguageParam } from './supportedLanguages';

const STORAGE_KEY = 'ihubIntegrationSettings';

// An embed starts without iHub's own chrome; the host opts in with header/footer/sidebar=true.
const EMBED_DEFAULTS = { showHeader: false, showFooter: false, showSidebar: false, language: null };

/**
 * Read the session-scoped settings of an embed, on top of the embed defaults. Anything in the
 * stored value that is not a known setting of the right type is dropped.
 * @returns {Object} The embed's integration settings
 */
function getEmbedSettings() {
  const settings = { ...EMBED_DEFAULTS };
  try {
    const saved = JSON.parse(getSessionValue(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const key of ['showHeader', 'showFooter', 'showSidebar']) {
        if (typeof saved[key] === 'boolean') settings[key] = saved[key];
      }
      settings.language = parseLanguageParam(saved.language);
    }
  } catch {
    // A corrupted value is treated as no settings.
  }
  return settings;
}

/**
 * Get the integration settings: the tab's own in embed mode (without ever reading
 * localStorage), otherwise from localStorage, falling back to the defaults.
 * @returns {Object} The integration settings
 */
export const getIntegrationSettings = () => {
  if (isEmbedMode()) {
    return getEmbedSettings();
  }
  try {
    const savedSettings = localStorage.getItem(STORAGE_KEY);
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      // showSidebar was added later; default to enabled when missing.
      if (parsed.showSidebar === undefined) parsed.showSidebar = true;
      return parsed;
    }
  } catch (error) {
    console.error('Error reading integration settings from localStorage:', error);
  }
  return { showHeader: true, showFooter: true, showSidebar: true, language: null };
};

/**
 * Save integration settings: to the tab's sessionStorage in embed mode (so iframe activity never
 * pollutes the localStorage shared with direct-visit usage), otherwise to localStorage.
 * @param {Object} settings - The settings to save
 */
export const saveIntegrationSettings = settings => {
  if (isEmbedMode()) {
    setSessionValue(STORAGE_KEY, JSON.stringify(settings));
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Error saving integration settings to localStorage:', error);
  }
};

/**
 * Update integration settings from URL parameters and save them (to localStorage, or to the
 * tab's sessionStorage in embed mode).
 *
 * An unsupported `language` is ignored and leaves the current language as it was.
 * @param {URLSearchParams} searchParams - The URL search parameters
 */
export const updateSettingsFromUrl = searchParams => {
  try {
    // Get current settings
    const settings = getIntegrationSettings();
    let updated = false;

    // Update header setting if provided in URL
    const headerParam = searchParams.get('header');
    if (headerParam !== null) {
      settings.showHeader = headerParam !== 'false';
      updated = true;
    }

    // Update footer setting if provided in URL
    const footerParam = searchParams.get('footer');
    if (footerParam !== null) {
      settings.showFooter = footerParam !== 'false';
      updated = true;
    }

    // Update sidebar setting if provided in URL (disable the left navigation bar)
    const sidebarParam = searchParams.get('sidebar');
    if (sidebarParam !== null) {
      settings.showSidebar = sidebarParam !== 'false';
      updated = true;
    }

    // Update language setting if provided in URL and supported
    const language = parseLanguageParam(searchParams.get('language'));
    if (language !== null) {
      settings.language = language;
      updated = true;
    }

    // Save if any changes were made
    if (updated) {
      saveIntegrationSettings(settings);
    }

    return settings;
  } catch (error) {
    console.error('Error updating integration settings from URL:', error);
    return getIntegrationSettings();
  }
};
