/**
 * Save app settings to sessionStorage
 * @param {string} appId - The ID of the app
 * @param {Object} settings - Settings to save
 */
export const saveAppSettings = (appId, settings) => {
  try {
    const key = `ai_hub_app_settings_${appId}`;
    sessionStorage.setItem(key, JSON.stringify(settings));
  } catch (error) {
    console.error('Error saving app settings to sessionStorage:', error);
  }
};

/**
 * Load app settings from sessionStorage
 * @param {string} appId - The ID of the app
 * @returns {Object|null} The saved settings or null if not found
 */
export const loadAppSettings = appId => {
  try {
    const key = `ai_hub_app_settings_${appId}`;
    const saved = sessionStorage.getItem(key);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error('Error loading app settings from sessionStorage:', error);
    return null;
  }
};
