// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers for the admin cards that save one section of platform.json with the
 * scoped `PATCH /api/admin/configs/platform` (a JSON Merge Patch, RFC 7396).
 *
 * A merge patch changes only what it names: a key it leaves out keeps its
 * stored value, and `null` removes it. A card that clears a field therefore
 * has to send `null` for it; sending the object without the key would keep
 * the stored value.
 *
 * @module features/admin/utils/platformPatch
 */

/**
 * The merge patch of a per-language text map (`{ en: '…', de: '…' }`): every
 * non-empty text of `next`, and `null` for each language that was there
 * before (`previous`) and is now empty or gone.
 *
 * @param {Object<string, string>|undefined} previous - The texts as loaded or last saved
 * @param {Object<string, string>|undefined} next - The texts in the form
 * @returns {Object<string, string|null>} The patch for the text map
 *
 * @example
 * localizedTextPatch({ en: 'Hi', de: 'Hallo' }, { en: 'Hello', de: '' });
 * // { en: 'Hello', de: null }
 */
export function localizedTextPatch(previous, next) {
  const patch = {};
  for (const [language, text] of Object.entries(next || {})) {
    if (typeof text === 'string' && text.trim()) patch[language] = text;
  }
  for (const language of Object.keys(previous || {})) {
    if (!(language in patch)) patch[language] = null;
  }
  return patch;
}

/**
 * A text field as a merge-patch value: the trimmed text, or `null` (remove the
 * stored value) when it is empty.
 *
 * @param {string|undefined} value
 * @returns {string|null}
 */
export function textOrNull(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}
