/**
 * Utility functions for cleaning up app data before saving
 * Removes invalid or empty configuration fields
 */

/**
 * Remove wizard-specific fields that should not be persisted
 * @param {Object} appData - The app data to clean
 * @returns {Object} - Cleaned app data
 */
export const removeWizardFields = appData => {
  const cleaned = { ...appData };

  // Remove wizard-specific creation method tracking fields
  delete cleaned.useTemplate;
  delete cleaned.useAI;
  delete cleaned.useManual;

  return cleaned;
};

/**
 * Remove speechRecognition configuration if it has invalid/empty values
 * speechRecognition requires a valid host URI, otherwise it should not be saved
 * @param {Object} appData - The app data to clean
 * @returns {Object} - Cleaned app data
 */
export const removeInvalidSpeechRecognition = appData => {
  const cleaned = { ...appData };

  // Remove speechRecognition if it has default/invalid values (no host URI)
  if (
    cleaned.settings?.speechRecognition &&
    (!cleaned.settings.speechRecognition.host ||
      cleaned.settings.speechRecognition.host.trim() === '')
  ) {
    delete cleaned.settings.speechRecognition;
  }

  return cleaned;
};

/**
 * Clean up app data by removing all invalid fields
 * Combines all cleanup functions
 * @param {Object} appData - The app data to clean
 * @returns {Object} - Cleaned app data
 */
export const cleanupAppData = appData => {
  let cleaned = { ...appData };

  // Apply all cleanup functions
  cleaned = removeWizardFields(cleaned);
  cleaned = removeInvalidSpeechRecognition(cleaned);

  return cleaned;
};
