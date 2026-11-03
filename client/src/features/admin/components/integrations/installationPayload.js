// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The body of `POST /api/admin/integrations/installed` (install) and
 * `PUT /api/admin/integrations/installed/:id` (save), shared by the generic
 * install form and the dedicated editors.
 *
 * A PUT **replaces** the installation: whatever the body leaves out is gone
 * afterwards. An editor that does not edit a part (the label in other
 * languages, the groups, the action policy) must therefore send it back as
 * it was loaded — `buildInstallationPayload` does that for everything it is
 * not given.
 *
 * @module features/admin/components/integrations/installationPayload
 */

/**
 * The edited translation merged into the stored one: other languages stay,
 * an empty text removes this language. `undefined` when nothing is left (the
 * installation then shows the definition's name).
 *
 * @param {Object<string,string>|string|null|undefined} stored - e.g. `{ en: 'GovData', de: 'GovData' }`
 * @param {string} lang - the admin's language
 * @param {string} text - the edited text in that language
 * @returns {Object<string,string>|undefined}
 * @example mergedLabel({ en: 'Portal', de: 'Portal' }, 'en', 'GovData') // { en: 'GovData', de: 'Portal' }
 */
export function mergedLabel(stored, lang, text) {
  const next = stored && typeof stored === 'object' ? { ...stored } : {};
  if (text) next[lang] = text;
  else delete next[lang];
  return Object.keys(next).length ? next : undefined;
}

/**
 * A language map without empty texts (trimmed), or `undefined` when none is left.
 *
 * @param {Object<string,string>|null|undefined} texts - e.g. `{ en: 'Company', de: '' }`
 * @returns {Object<string,string>|undefined} e.g. `{ en: 'Company' }`
 */
export function nonEmptyTexts(texts) {
  const entries = Object.entries(texts || {})
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([lang, text]) => [lang, text.trim()]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Install values without the empty ones: an empty field means "use the
 * definition's default", which the server applies when the key is absent.
 *
 * @param {Object} values
 * @returns {Object}
 */
export function cleanInstallValues(values) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (value === '' || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The save body of an existing installation.
 *
 * @param {Object} instance - the installation as the editor received it
 *   (see `editors/index.js`): `id`, `definition`, `labelLocalized`,
 *   `description`, `enabled`, `auth`, `actions`
 * @param {Object} changes
 * @param {Object} changes.values - the install values to store (cleaned here)
 * @param {string} changes.lang - the language `label` and `description` are edited in
 * @param {string} [changes.label] - the label in `lang`; omitted keeps the stored label
 * @param {string} [changes.description] - the description in `lang`; omitted keeps it
 * @param {Object<string,string>} [changes.labelMap] - the label in every language, for an
 *   editor that edits all of them (a people directory's model-facing name); replaces the
 *   stored label and wins over `label`. Empty texts are dropped.
 * @param {Object<string,string>} [changes.descriptionMap] - the same for the description
 * @param {Object} [changes.actions] - the action policy; omitted keeps the stored one
 * @param {Object} [changes.secrets] - a new secret for the sign-in mode, never stored in `values`
 * @returns {Object} the PUT body
 */
export function buildInstallationPayload(instance, changes) {
  const storedLabel = instance.labelLocalized ?? null;
  const storedDescription =
    instance.description && typeof instance.description === 'object' ? instance.description : null;
  let label =
    changes.label === undefined
      ? storedLabel || undefined
      : mergedLabel(storedLabel, changes.lang, changes.label.trim());
  if (changes.labelMap !== undefined) label = nonEmptyTexts(changes.labelMap);
  let description =
    changes.description === undefined
      ? storedDescription || undefined
      : mergedLabel(storedDescription, changes.lang, changes.description.trim());
  if (changes.descriptionMap !== undefined) description = nonEmptyTexts(changes.descriptionMap);
  const payload = {
    id: instance.id,
    definition: instance.definition,
    label,
    description,
    enabled: instance.enabled !== false,
    values: cleanInstallValues(changes.values),
    auth: { mode: instance.auth?.mode || 'none' },
    actions: changes.actions ?? instance.actions ?? undefined,
    // Tool approval (#2945) is edited on the Overview; a settings save sends it back.
    approval: instance.approval ?? undefined
  };
  if (changes.secrets && Object.keys(changes.secrets).length) payload.secrets = changes.secrets;
  return payload;
}
