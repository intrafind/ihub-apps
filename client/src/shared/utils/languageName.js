// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Names language codes in the UI language ("fr" is "French" in English and
 * "Französisch" in German), with the browser's own names.
 *
 * @param {string} [uiLanguage] - The UI language tag; English without it.
 * @param {Object<string,string>} [overrides] - Names that take precedence, by code.
 * @returns {function(string): string} The name of a code. A code the browser
 *   cannot name, or a text that is no language tag, stands for itself.
 *
 * @example
 * languageNamer('de')('fr'); // → 'Französisch'
 * languageNamer('de')('url'); // → 'url'
 */
export function languageNamer(uiLanguage, overrides) {
  let names = null;
  try {
    names = new Intl.DisplayNames([uiLanguage || 'en'], { type: 'language', fallback: 'none' });
  } catch {
    // An unusable UI language tag: the codes stand for themselves.
  }
  return code => {
    if (overrides?.[code]) return overrides[code];
    try {
      return names?.of(code) || code;
    } catch {
      // Not a language tag.
      return code;
    }
  };
}

export default languageNamer;
