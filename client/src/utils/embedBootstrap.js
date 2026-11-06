// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Applies what must be in place before the app starts: embed mode (`?embed=true`, or the
 * `data-ihub-embed` attribute of an embed page), the `mode` URL parameter and, in embed mode, the
 * `language` URL parameter.
 *
 * The i18n service reads the language and picks its storage at the moment it is imported, so this
 * has to have run by then. That is why `i18nService.js` imports this module: a dependency is
 * guaranteed to run before its importer, while the order of an entry point's other imports is not
 * (a production build puts shared modules in shared chunks that run before the entry chunk's own
 * code, so a bootstrap imported "first" by the entry runs last). Running before the first render
 * also means the page opens in the right theme and language instead of flashing the defaults.
 *
 * `header`, `footer` and `sidebar` need the router and are applied by `Layout` (see
 * `integrationSettings.js`); `language` outside embed mode is applied there too.
 */

import {
  activateEmbedMode,
  activateEmbedModeFromUrl,
  isEmbedDocument,
  isEmbedMode,
  setSessionValue
} from './embedMode';
import { parseLanguageParam } from './supportedLanguages';
import {
  applyThemeToDocument,
  getStoredPreference,
  parseModeParam,
  resolveIsDark,
  storePreference
} from './themePreference';

// The key i18next's language detector caches the language under.
const I18NEXT_LANGUAGE_KEY = 'i18nextLng';

/**
 * Apply `embed`, `mode` and the embed-mode `language` from a URL, and the embed page attribute.
 *
 * Invalid values are ignored. In embed mode everything lands in `sessionStorage`; `localStorage`
 * stays untouched.
 *
 * @param {URLSearchParams|string} search - The URL's query string or its parsed parameters.
 */
export function bootstrapFromUrl(search) {
  const params = new URLSearchParams(search);
  // An embed page keeps its session across reloads, so it never resets it.
  if (isEmbedDocument()) {
    activateEmbedMode();
  }
  activateEmbedModeFromUrl(params);
  const embedded = isEmbedMode();

  // The i18n service reads this (instead of localStorage) when it initialises in embed mode.
  const language = parseLanguageParam(params.get('language'));
  if (embedded && language) {
    setSessionValue(I18NEXT_LANGUAGE_KEY, language);
  }

  // Outside embed mode `mode` is stored like a click on the dark-mode toggle.
  const mode = parseModeParam(params.get('mode'));
  if (mode) {
    storePreference(mode);
  }
  if (mode || embedded) {
    applyThemeToDocument(resolveIsDark(getStoredPreference()));
  }
}

if (typeof window !== 'undefined') {
  bootstrapFromUrl(window.location.search);
}
