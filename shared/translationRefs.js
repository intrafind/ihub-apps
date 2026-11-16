// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `$t(key)` references in ui.json text: the same syntax the built-in translations
 * use to share one text. The client resolves them through i18next
 * (`client/src/utils/translationRefs.js`), the server through the merged locale
 * data (`server/utils/uiTextRefs.js`). Both use this one pattern.
 */
export const TRANSLATION_REF_PATTERN = /\$t\(([^()\s]+)\)/g;

/** The reference the shipped site title and PWA name use. */
export const PRODUCT_NAME_REF = '$t(product.name)';

/** Whether `text` is nothing but one reference to `key` (whitespace around it is ignored). */
export function isTranslationRefTo(text, key) {
  return typeof text === 'string' && text.trim() === `$t(${key})`;
}

/**
 * Replace every `$t(key)` in `text` with `lookup(key)`, resolving references
 * inside the looked-up text too (`footer.copyright` refers to `product.name`).
 * A key without a text becomes an empty string, never the key. Depth is bounded
 * so a cycle cannot loop.
 *
 * @param {*} text - A string from ui.json; anything else is returned unchanged.
 * @param {(key: string) => (string|undefined)} lookup
 * @param {number} [depth] - Remaining nesting levels.
 */
export function resolveTranslationRefsWith(text, lookup, depth = 3) {
  if (typeof text !== 'string' || !text.includes('$t(')) return text;
  if (depth < 0) return '';
  return text.replace(TRANSLATION_REF_PATTERN, (_match, key) => {
    const value = lookup(key);
    return typeof value === 'string' ? resolveTranslationRefsWith(value, lookup, depth - 1) : '';
  });
}
