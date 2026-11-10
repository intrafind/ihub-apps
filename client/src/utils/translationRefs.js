// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * UI-config text (ui.json) can refer to a translation key with `$t(key)`, the
 * same syntax the built-in translations use to share one text. The shipped
 * header tagline is `$t(product.tagline)`, so an admin changes it under
 * Admin → Translations instead of editing ui.json per language.
 */
const REFERENCE = /\$t\(([^()\s]+)\)/g;

/**
 * Replace every `$t(key)` in `text` with the translation of `key`. A key that
 * has no translation becomes an empty string, never the key itself. Text
 * without a reference is returned as it is.
 *
 * @param {*} text - A string from the UI config; anything else is returned unchanged.
 * @param {(key: string, options?: object) => string} t - The i18next `t` function.
 * @returns {*}
 */
export function resolveTranslationRefs(text, t) {
  if (typeof text !== 'string' || !text.includes('$t(')) return text;
  return text.replace(REFERENCE, (_match, key) => t(key, { defaultValue: '' }));
}
