export function getLocalizedContent(content, language = 'en', fallbackLanguage = 'en') {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    try {
      if (content[language]) return content[language];
      if (content[fallbackLanguage]) return content[fallbackLanguage];
      const available = Object.keys(content);
      if (available.length > 0) {
        if (language !== 'en') console.error(`Missing translation for language: ${language}`);
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
