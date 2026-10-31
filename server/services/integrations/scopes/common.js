// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers the scope registry (`index.js`) and its providers share. Kept apart
 * so a provider never imports the registry that imports it.
 */

/** Where the chat input offers an integration's scope picker. */
export const SCOPE_PICKER_PLACEMENTS = Object.freeze(['menu', 'hidden']);

/** Most characters a scope id may have (iAssistant ids carry a prefix). */
export const MAX_SCOPE_ID_LENGTH = 256;

/**
 * An app's scope settings for one integration.
 * @param {Object} app
 * @param {string} integrationId
 * @param {string} [definitionId] - The installation's definition, whose binding applies when the installation has none of its own
 * @returns {{ scopePicker: string, defaultScope: string|null, pinnedScope: string|null }}
 */
export function appScopeSettings(app, integrationId, definitionId) {
  const bindings = app?.integrations || {};
  // An installation's own binding, else the binding of its definition
  // (`"com.intrafind/ldap-directory": {}` binds every installation of it).
  const settings =
    bindings[integrationId] || (definitionId ? bindings[definitionId] : undefined) || {};
  const text = value => (typeof value === 'string' && value ? value : null);
  return {
    ...settings,
    scopePicker: SCOPE_PICKER_PLACEMENTS.includes(settings.scopePicker)
      ? settings.scopePicker
      : 'menu',
    defaultScope: text(settings.defaultScope),
    pinnedScope: text(settings.pinnedScope)
  };
}

/** Whether a value can be a scope id at all, before any provider looks at it. */
export function isScopeIdShape(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SCOPE_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * The default scope out of a list: the candidate when it is listed, else the
 * entry the integration marks as the user's own default, else the first.
 *
 * @param {Array<{id: string, userDefault?: boolean}>} scopes - never empty
 * @param {string|null} candidate
 * @returns {string}
 */
export function pickDefaultScope(scopes, candidate) {
  if (candidate && scopes.some(scope => scope.id === candidate)) return candidate;
  return (scopes.find(scope => scope.userDefault) || scopes[0]).id;
}
