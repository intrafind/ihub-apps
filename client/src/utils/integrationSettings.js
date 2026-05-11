/**
 * Utility functions for managing integration settings (header/footer visibility)
 * throughout the iHub application.
 */

// Per-tab/iframe flag set by embed entry points (e.g.
// `client/nextcloud/full-app-entry.jsx`). When present, integration settings
// are forced to "no chrome" and localStorage is never touched — direct-visit
// users in other tabs keep their own preferences untouched, and the embed
// experience always renders without iHub's own header/footer regardless of
// any stale state from a previous session.
const EMBED_MODE_KEY = 'ihubEmbedMode';

function isEmbedMode() {
  try {
    return sessionStorage.getItem(EMBED_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Get the integration settings from localStorage or use defaults.
 * In embed mode, always returns "no chrome" without reading localStorage.
 * @returns {Object} The integration settings
 */
export const getIntegrationSettings = () => {
  if (isEmbedMode()) {
    return { showHeader: false, showFooter: false, language: null };
  }
  try {
    const savedSettings = localStorage.getItem('ihubIntegrationSettings');
    if (savedSettings) {
      return JSON.parse(savedSettings);
    }
  } catch (error) {
    console.error('Error reading integration settings from localStorage:', error);
  }
  return { showHeader: true, showFooter: true, language: null };
};

/**
 * Save integration settings to localStorage.
 * No-op in embed mode so iframe activity doesn't pollute the storage shared
 * with direct-visit usage.
 * @param {Object} settings - The settings to save
 */
export const saveIntegrationSettings = settings => {
  if (isEmbedMode()) {
    return;
  }
  try {
    localStorage.setItem('ihubIntegrationSettings', JSON.stringify(settings));
  } catch (error) {
    console.error('Error saving integration settings to localStorage:', error);
  }
};

/**
 * Update integration settings from URL parameters and save to localStorage
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

    // Update language setting if provided in URL
    const languageParam = searchParams.get('language');
    if (languageParam !== null) {
      settings.language = languageParam;
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
