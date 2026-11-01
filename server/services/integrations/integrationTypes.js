// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration types: a contract iHub consumes, so the integrations of one type
 * are interchangeable to an app and are grouped together in the admin and in
 * the app editor.
 *
 * - `people-directory`: look up people (the LDAP directories, Entra ID).
 * - `web-search`: a search engine the model can call.
 * - `storage`: a file source for the file picker and for projects.
 *
 * A definition declares its type in `type`; one without a type stands alone.
 * An app binds every installation of a type with the key `type:<type>` in
 * `app.integrations`, next to installation ids and definition ids.
 *
 * Pure module without imports: the app schema, the integration registry and
 * the tool loader all read it.
 *
 * @module services/integrations/integrationTypes
 */

/** The known types, in the order the admin lists their groups. */
export const INTEGRATION_TYPES = Object.freeze(['people-directory', 'web-search', 'storage']);

/** Prefix of an `app.integrations` key that binds every installation of a type. */
export const TYPE_BINDING_PREFIX = 'type:';

/**
 * The type a binding key names (`type:people-directory` → `people-directory`),
 * or null for an installation or definition key and for an unknown type.
 * @param {string} key - A key of `app.integrations`
 * @returns {string|null}
 */
export function typeOfBindingKey(key) {
  if (typeof key !== 'string' || !key.startsWith(TYPE_BINDING_PREFIX)) return null;
  const type = key.slice(TYPE_BINDING_PREFIX.length);
  return INTEGRATION_TYPES.includes(type) ? type : null;
}

/** The binding key of a type (`people-directory` → `type:people-directory`). */
export function bindingKeyOfType(type) {
  return `${TYPE_BINDING_PREFIX}${type}`;
}
