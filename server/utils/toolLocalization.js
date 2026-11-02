// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Localization of tool definitions: a tool file holds its `name`,
 * `description` and every parameter description as `{ en, de, … }`; the
 * model is sent plain strings in the request's language.
 *
 * Shared by the tool loader (configured tools, the platform tools) and the
 * project knowledge tools, which build their definitions themselves.
 *
 * @module utils/toolLocalization
 */
import configCache from '../configCache.js';
import { getLocalizedString } from './localize.js';

/**
 * The platform's default language, the fallback of every localized text.
 * @returns {string}
 */
export function platformDefaultLanguage() {
  const platformConfig = configCache.getPlatform() || {};
  return platformConfig?.defaultLanguage || 'en';
}

/**
 * Recursively extract language-specific values from multilingual objects.
 * Builds new objects and arrays throughout, so the input (a cached
 * definition) is never shared with the result.
 *
 * @param {any} obj - Object to process
 * @param {string} [language='en'] - Target language
 * @param {string|null} [fallbackLanguage] - Fallback language (platform default when absent)
 * @returns {any} - Object with language-specific values
 */
export function extractLanguageFromObject(obj, language = 'en', fallbackLanguage = null) {
  if (!fallbackLanguage) fallbackLanguage = platformDefaultLanguage();
  if (Array.isArray(obj)) {
    return obj.map(item => extractLanguageFromObject(item, language, fallbackLanguage));
  }

  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip processing for certain fields that should remain unchanged
      if (key === 'id' || key === 'script' || key === 'enabled') {
        result[key] = value;
      } else if (
        (key === 'description' || key === 'title' || key === 'name') &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).some(k => k.length === 2 && typeof value[k] === 'string')
      ) {
        // This is a multilingual field - an object with language codes as keys
        result[key] = getLocalizedString(value, language, fallbackLanguage);
      } else {
        result[key] = extractLanguageFromObject(value, language, fallbackLanguage);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Localize tools based on user language by extracting language-specific
 * values from multilingual objects.
 *
 * @param {Array<Object>} tools - Tool definitions
 * @param {string} [language='en'] - User language (e.g. 'en', 'de')
 * @returns {Array<Object>} Localized copies of the tools
 * @example
 * localizeTools([{ id: 'x', description: { en: 'Find', de: 'Finden' } }], 'de');
 * // → [{ id: 'x', description: 'Finden' }]
 */
export function localizeTools(tools, language = 'en') {
  const fallbackLanguage = platformDefaultLanguage();
  return tools.map(tool => extractLanguageFromObject(tool, language, fallbackLanguage));
}
