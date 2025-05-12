import { useTranslation } from 'react-i18next';
import React from 'react';

/**
 * Custom hook that extends useTranslation with automatic line break processing
 * @returns {Object} Extended translation functions and i18n instance
 */
export const useLocalizedTranslation = () => {
  const { t: originalT, i18n, ...rest } = useTranslation();
  
  // Enhanced translation function that processes line breaks
  const t = (key, options) => {
    const translated = originalT(key, options);
    
    if (!translated || typeof translated !== 'string') {
      return translated;
    }
    
    // Check if the text contains any line break markers
    if (!/(<br\s*\/?>|<nlr>|\n)/i.test(translated)) {
      return translated;
    }
    
    // Process line breaks if they exist
    const segments = [];
    const parts = translated.split(/(<br\s*\/?>|<nlr>|\n)/gi);
    
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].match(/(<br\s*\/?>|<nlr>|\n)/gi)) {
        segments.push(React.createElement('br', { key: `br-${key}-${i}` }));
      } else if (parts[i]) {
        segments.push(React.createElement(React.Fragment, { key: `text-${key}-${i}` }, parts[i]));
      }
    }
    
    return segments.length === 1 ? segments[0] : segments;
  };
  
  return { t, i18n, ...rest };
};