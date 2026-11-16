// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Server-side resolution of `$t(key)` references in ui.json text (site title, PWA
 * name, ...). The merged locale data (built-in texts plus the admin's overrides
 * from Admin → Localization) is the source, so renaming `product.name` there
 * reaches the PWA manifest and the sign-in screen the same way it reaches the app.
 */

import configCache from '../configCache.js';
import { resolveTranslationRefsWith } from '../../shared/translationRefs.js';
import { getLocalizedString } from './localize.js';

function platformDefaultLanguage() {
  try {
    return configCache.getPlatform()?.defaultLanguage || 'en';
  } catch {
    return 'en';
  }
}

function getPath(object, key) {
  return key
    .split('.')
    .reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), object);
}

/**
 * A lookup that tries the language, then the platform default language, then English.
 * @param {string} language
 * @returns {(key: string) => (string|undefined)}
 */
export function createTranslationLookup(language = 'en') {
  const languages = [...new Set([language, platformDefaultLanguage(), 'en'])];
  return key => {
    for (const lang of languages) {
      let value;
      try {
        value = getPath(configCache.getLocalizations(lang)?.data, key);
      } catch {
        value = undefined;
      }
      if (typeof value === 'string' && value !== '') return value;
    }
    return undefined;
  };
}

/** Resolve the `$t()` references in one string. */
export function resolveUiRefs(text, language = 'en') {
  return resolveTranslationRefsWith(text, createTranslationLookup(language));
}

/**
 * Resolve a ui.json text that is a plain string or a `{ lang: text }` map to the
 * text a visitor reading `language` sees. Empty results become `fallback`, so a
 * missing translation never shows a key or an empty name.
 */
export function resolveUiText(value, language = 'en', fallback = '') {
  const text = resolveUiRefs(getLocalizedString(value, language, undefined, ''), language).trim();
  return text || fallback;
}

/** First language of an `Accept-Language` header, reduced to its primary subtag. */
export function pickRequestLanguage(req) {
  const header = req?.headers?.['accept-language'];
  const primary = typeof header === 'string' ? header.split(',')[0]?.split(';')[0]?.trim() : '';
  return primary ? primary.split('-')[0].toLowerCase() : platformDefaultLanguage();
}
