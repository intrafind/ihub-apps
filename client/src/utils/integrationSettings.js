/**
 * Utility functions for managing integration settings (header/footer visibility)
 * throughout the iHub application.
 */

/**
 * Get the integration settings from localStorage or use defaults
 * @returns {Object} The integration settings
 */
export const getIntegrationSettings = () => {
  try {
    const savedSettings = localStorage.getItem('aiHubIntegrationSettings');
    if (savedSettings) {
      return JSON.parse(savedSettings);
    }
  } catch (error) {
    console.error('Error reading integration settings from localStorage:', error);
  }
  return { showHeader: true, showFooter: true, language: null };
};

/**
 * Save integration settings to localStorage
 * @param {Object} settings - The settings to save
 */
export const saveIntegrationSettings = settings => {
  try {
    localStorage.setItem('aiHubIntegrationSettings', JSON.stringify(settings));
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
