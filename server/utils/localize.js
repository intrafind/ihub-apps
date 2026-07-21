/**
 * Shared localized-string resolution.
 *
 * Every call site that resolves a `{en: "...", de: "..."}`-shaped value to a
 * plain string for the current request language should go through
 * `getLocalizedString` instead of reimplementing the fallback chain.
 */

import configCache from '../configCache.js';

function resolvePlatformDefaultLanguage() {
  try {
    return configCache.getPlatform()?.defaultLanguage || 'en';
  } catch {
    return 'en';
  }
}

/**
 * Resolve a localized value to a plain string.
 *
 * Resolution order: `value[language]` → `value[fallbackLanguage]` (defaults to
 * the platform's configured default language) → the first string-valued
 * entry in `value` → `fallbackValue`.
 *
 * @param {string|Object|null|undefined} value - Plain string or localized object
 * @param {string} [language='en'] - Preferred language code
 * @param {string} [fallbackLanguage] - Fallback language code; defaults to the platform default language
 * @param {string} [fallbackValue=''] - Returned when nothing resolvable is found
 * @returns {string}
 */
export function getLocalizedString(value, language = 'en', fallbackLanguage, fallbackValue = '') {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallbackValue;

  if (typeof value[language] === 'string') return value[language];

  const resolvedFallbackLanguage = fallbackLanguage || resolvePlatformDefaultLanguage();
  if (typeof value[resolvedFallbackLanguage] === 'string') return value[resolvedFallbackLanguage];

  const firstString = Object.values(value).find(v => typeof v === 'string');
  return firstString !== undefined ? firstString : fallbackValue;
}
