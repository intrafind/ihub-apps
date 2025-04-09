/**
 * Gets the localized value from a potentially multi-language object
 * 
 * @param {Object|string} content - Content that might be a translation object or direct string
 * @param {string} language - Current language code (e.g., 'en', 'de')
 * @param {string} [fallbackLanguage='en'] - Fallback language if requested language is not available
 * @returns {string} - The localized content
 */
export const getLocalizedContent = (content, language, fallbackLanguage = 'en') => {
  if (!content) {
    return '';
  }
  
  // If the content is a string, return it directly
  if (typeof content === 'string') {
    return content;
  }
  
  // If content is an object with language keys
  if (typeof content === 'object' && content !== null) {
    // Try to get the content in the requested language
    if (content[language]) {
      return content[language];
    }
    
    // Fall back to the fallback language
    if (content[fallbackLanguage]) {
      return content[fallbackLanguage];
    }
    
    // If neither the requested language nor fallback exist, get the first available translation
    const availableLanguage = Object.keys(content)[0];
    if (availableLanguage) {
      return content[availableLanguage];
    }
  }
  
  // If all fails, return empty string
  return '';
};