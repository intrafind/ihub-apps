// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The name of a copy in every language of its source: "Travel policy (copy)",
 * "Reiserichtlinie (Kopie)".
 *
 * The UI holds the texts of its own language and of the fallback language
 * only. The "(copy)" of another language is therefore loaded before the copy
 * opens; without it a German name would end in the English "(copy)".
 *
 * Pure apart from the caller's loader: no React, no request of its own, no path.
 *
 * @module features/admin/components/app-create/copyLanguages
 */

/** The text that turns a name into the name of its copy. It takes `name`. */
export const COPY_NAME_KEY = 'admin.apps.create.copy.nameSuffix';

/** How long a copy waits for the texts of another language. */
export const COPY_LANGUAGES_WAIT_MS = 3000;

/**
 * The languages of an app's name whose "(copy)" text the UI does not hold yet.
 *
 * @param {object|null|undefined} app - The source, as stored.
 * @param {{ getResource: (language: string, namespace: string, key: string) => unknown }} i18n -
 *   The i18next instance.
 * @returns {string[]}
 */
export function copyLanguagesToLoad(app, i18n) {
  const name = app?.name;
  if (!name || typeof name !== 'object' || Array.isArray(name)) return [];
  return Object.keys(name).filter(
    language => typeof i18n.getResource(language, 'translation', COPY_NAME_KEY) !== 'string'
  );
}

/**
 * Loads the texts of every language the copy's name needs. The promise never
 * rejects and never takes longer than `waitMs`: a language that cannot be
 * loaded gets the "(copy)" of the fallback language, and the copy opens all
 * the same.
 *
 * @param {object|null|undefined} app - The source, as stored.
 * @param {object} options
 * @param {object} options.i18n - The i18next instance.
 * @param {(language: string) => Promise<unknown>} options.loadLanguage - Loads
 *   the texts of one language into the instance.
 * @param {number} [options.waitMs]
 * @returns {Promise<void>|null} Null when every text is there already.
 */
export function loadCopyLanguages(app, { i18n, loadLanguage, waitMs = COPY_LANGUAGES_WAIT_MS }) {
  const missing = copyLanguagesToLoad(app, i18n);
  if (missing.length === 0) return null;
  let timer;
  const waited = new Promise(resolve => {
    timer = setTimeout(resolve, waitMs);
  });
  const loaded = Promise.all(
    missing.map(language =>
      Promise.resolve()
        .then(() => loadLanguage(language))
        .catch(() => undefined)
    )
  );
  return Promise.race([loaded, waited]).then(() => clearTimeout(timer));
}

/**
 * Turns a name into the copy's name in the name's own language.
 *
 * @param {(key: string, options: object) => string} t - i18next `t`.
 * @returns {(name: string, language: string) => string}
 */
export function copyLabelWith(t) {
  return (name, language) => t(COPY_NAME_KEY, { name, lng: language });
}
