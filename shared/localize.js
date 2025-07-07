export let DEFAULT_LANGUAGE = 'en';
export function setDefaultLanguage(lang) {
  if (typeof lang === 'string' && lang.length > 0) {
    DEFAULT_LANGUAGE = lang;
  }
}

export function getLocalizedContent(content, language = DEFAULT_LANGUAGE, fallbackLanguage = DEFAULT_LANGUAGE) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    try {
      if (content[language]) return content[language];
      if (content[fallbackLanguage]) return content[fallbackLanguage];
      const available = Object.keys(content);
      if (available.length > 0) {
        if (language !== DEFAULT_LANGUAGE) console.warn(`Missing translation for language: ${language}`);
        return content[available[0]];
      }
      return '';
    } catch (err) {
      console.error('Error accessing content object:', err);
      return '';
    }
  }
  try {
    return String(content);
  } catch (e) {
    console.error('Failed to convert content to string:', e);
    return '';
  }
}
