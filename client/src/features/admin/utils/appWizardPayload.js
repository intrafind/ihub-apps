// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Turn the app creation wizard's working state into the app configuration that
 * is sent to `POST /api/admin/apps`.
 *
 * The wizard keeps UI state next to the app fields (which creation method was
 * picked, the prompt used for AI generation, …). The server validates the body
 * against the app schema, which does not allow unknown top-level keys, so that
 * state has to be dropped before the request.
 */

/**
 * Top-level keys the wizard uses for its own state; none of them is part of an
 * app configuration.
 *
 * - `useAI`, `useTemplate`, `useManual`: the creation method picked on the first step.
 * - `aiGenerated`, `aiPrompt`: set by the AI generation step.
 * - `imageUpload`: the "Enable Image Upload" checkbox on the Advanced step. Uploads
 *   are configured under `upload` in an app; this top-level key was never read.
 */
export const WIZARD_ONLY_KEYS = [
  'useAI',
  'useTemplate',
  'useManual',
  'aiGenerated',
  'aiPrompt',
  'imageUpload'
];

/** Localized fields that are optional and dropped when every language is empty. */
const OPTIONAL_LOCALIZED_FIELDS = ['messagePlaceholder', 'prompt'];

/**
 * Localized fields the app schema requires. Their empty languages are dropped
 * too (the schema refuses an empty string in any language); when no language
 * has text the field is kept as it is, so the server names it in its error.
 */
const REQUIRED_LOCALIZED_FIELDS = ['name', 'description', 'system'];

/**
 * The language the wizard writes localized fields under: the base language of
 * the UI language (`de` for `de-DE`, `en` for `en-US`).
 *
 * The browser locale is usually regional (`en-US`), while apps store their
 * texts under base languages and the wizard's draft starts with `en`. Writing
 * the typed name under `en-US` left `name.en` empty, and the server refused the
 * app (AI-B1).
 *
 * @param {string} [language] - A language tag such as `i18n.language`.
 * @returns {string} The lower-case base language; `en` when none is given.
 *
 * @example
 * wizardLanguage('de-DE'); // → 'de'
 * wizardLanguage(undefined); // → 'en'
 */
export function wizardLanguage(language) {
  const base = String(language || '')
    .split('-')[0]
    .trim()
    .toLowerCase();
  return base || 'en';
}

/** The languages of a localized value that hold text. */
function filledLanguages(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, text]) => typeof text === 'string' && text.trim())
  );
}

/**
 * Build the app configuration to create from the wizard state.
 *
 * - removes the wizard-only keys ({@link WIZARD_ONLY_KEYS}),
 * - removes `parentId` when the app is not based on a template (the wizard
 *   keeps it as `null`, which the schema does not accept),
 * - removes empty languages from the optional localized fields, and the field
 *   itself when no language is left,
 * - removes empty languages from the required localized fields (`name`,
 *   `description`, `system`) as long as one language keeps its text.
 *
 * @param {object} appData - The wizard's app state.
 * @returns {object} A new object; `appData` is not modified.
 *
 * @example
 * buildAppPayloadFromWizard({ id: 'x', useManual: true, parentId: null, prompt: { en: '' } });
 * // → { id: 'x' }
 */
export function buildAppPayloadFromWizard(appData) {
  const payload = { ...appData };

  for (const key of WIZARD_ONLY_KEYS) {
    delete payload[key];
  }

  if (!payload.parentId) {
    delete payload.parentId;
  }

  for (const field of REQUIRED_LOCALIZED_FIELDS) {
    const value = payload[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const filled = filledLanguages(value);
    if (Object.keys(filled).length > 0) payload[field] = filled;
  }

  for (const field of OPTIONAL_LOCALIZED_FIELDS) {
    if (!payload[field]) continue;
    const filled = filledLanguages(payload[field]);
    if (Object.keys(filled).length === 0) {
      delete payload[field];
    } else {
      payload[field] = filled;
    }
  }

  return payload;
}

/**
 * The categories an app can be put in: the apps list's categories from
 * `ui.json` (`appsList.categories.list`) without the "all" filter entry — the
 * list the app editor offers. A category the app already has that is not in
 * the list is kept as the last entry, so selecting the field never drops it.
 *
 * @param {Object|null|undefined} uiConfig - The UI configuration.
 * @param {string} [currentCategory] - The app's category.
 * @returns {Array<{id: string, name: Object<string, string>|string}>}
 *
 * @example
 * appCategoryOptions({ appsList: { categories: { list: [{ id: 'all' }, { id: 'writing', name: { en: 'Writing' } }] } } });
 * // → [{ id: 'writing', name: { en: 'Writing' } }]
 */
export function appCategoryOptions(uiConfig, currentCategory) {
  const list = uiConfig?.appsList?.categories?.list;
  const options = (Array.isArray(list) ? list : [])
    .filter(category => category?.id && category.id !== 'all')
    .map(category => ({ id: category.id, name: category.name || category.id }));
  if (currentCategory && !options.some(category => category.id === currentCategory)) {
    options.push({ id: currentCategory, name: currentCategory });
  }
  return options;
}
