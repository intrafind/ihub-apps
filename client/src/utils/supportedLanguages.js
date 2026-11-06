// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The UI languages iHub ships translations for: one `shared/i18n/{code}.json` file each (the
 * server's `listBuiltinLocales()` serves exactly these, and `i18nService.js` bundles them as the
 * offline fallback). A test keeps this list in step with that directory.
 */
export const SUPPORTED_LANGUAGES = ['en', 'de'];

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

/**
 * Validate a `language` URL parameter against the supported languages.
 *
 * Case and surrounding whitespace are ignored and a region variant (`de-DE`) selects its base
 * language, so the result is always one of {@link SUPPORTED_LANGUAGES}.
 *
 * @param {string|null|undefined} value - The raw parameter value.
 * @returns {string|null} The supported language code, or null when the value is not one.
 */
export function parseLanguageParam(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  if (!LANGUAGE_CODE_PATTERN.test(code)) return null;
  const base = code.split('-')[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : null;
}
