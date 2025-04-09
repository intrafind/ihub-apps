/**
 * Gets the localized value from a potentially multi-language object
 * 
 * @param {Object|string} content - Content that might be a translation object or direct string
 * @param {string} language - Current language code (e.g., 'en', 'de')
 * @param {string} [fallbackLanguage='en'] - Fallback language if requested language is not available
 * @returns {string} - The localized content
 */
export const getLocalizedContent = (content, language, fallbackLanguage = 'en') => {
  // Handle null or undefined content
  if (content === null || content === undefined) {
    // console.log('Content is null or undefined');
    return '';
  }
  
  // If the content is a string, return it directly
  if (typeof content === 'string') {
    return content;
  }
  
  // If content is an object with language keys
  if (typeof content === 'object') {
    try {
      // Try to get the content in the requested language
      if (content[language]) {
        return content[language];
      }
      
      // Fall back to the fallback language
      if (content[fallbackLanguage]) {
        return content[fallbackLanguage];
      }
      
      // If neither the requested language nor fallback exist, get the first available translation
      const availableLanguages = Object.keys(content);
      if (availableLanguages.length > 0) {
        // Only log missing keys for non-English languages to reduce noise
        if (language !== 'en') {
          console.log('Content object has no language keys for requested language:', language);
        }
        return content[availableLanguages[0]];
      }
      
      // If the object exists but has no language keys, return empty string
      return '';
    } catch (error) {
      console.error('Error accessing content object:', error, content);
      return '';
    }
  }
  
  // For any other type, convert to string
  try {
    return String(content);
  } catch (e) {
    console.error('Failed to convert content to string:', e);
    return '';
  }
};