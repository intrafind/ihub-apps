// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the allowed apps, models and prompts of an OAuth client mean, which
 * depends on how its tokens are issued:
 *
 * - A client-credentials (machine-to-machine) token has no user behind it, so
 *   the lists ARE the grant: an empty list means no access at all, and `['*']`
 *   means every app, model or prompt, including ones added later.
 * - A user-delegated token (authorization code) acts as the signed-in user; the
 *   lists narrow that user's group permissions, and an empty list means no extra
 *   restriction.
 * - A personal API key acts as its owner, even when it is stored with the
 *   `client_credentials` grant: its lists narrow the owner's group permissions
 *   like a delegated client's, so it is never a machine client.
 *
 * The server enforces both meanings (`server/utils/authorization.js`); these
 * helpers only let the editor explain them and check the form before saving.
 */

/** The value that grants every resource of a kind. */
export const ALL_RESOURCES = '*';

/** The grant type that issues machine-to-machine tokens. */
export const MACHINE_GRANT_TYPE = 'client_credentials';

/** The grant type that issues user-delegated tokens. */
export const DELEGATED_GRANT_TYPE = 'authorization_code';

/** The resource lists of a client, in the order the editor shows them. */
export const RESOURCE_LIST_FIELDS = ['allowedApps', 'allowedModels', 'allowedPrompts'];

/**
 * Whether the client issues machine-to-machine tokens.
 *
 * @param {string[]|undefined} grantTypes - The client's grant types.
 * @param {{personal?: boolean}} [options]
 * @param {boolean} [options.personal=false] - Whether the client is a user's
 *   personal API key. Its tokens act as the owner, so it is never a machine
 *   client, whatever its grant types.
 * @returns {boolean} True when `client_credentials` is among them and the
 *   client is not a personal key.
 */
export function isMachineClient(grantTypes, { personal = false } = {}) {
  if (personal) return false;
  return Array.isArray(grantTypes) && grantTypes.includes(MACHINE_GRANT_TYPE);
}

/**
 * Whether the client issues user-delegated tokens.
 *
 * @param {string[]|undefined} grantTypes - The client's grant types.
 * @returns {boolean} True when `authorization_code` is among them.
 */
export function isDelegatedClient(grantTypes) {
  return Array.isArray(grantTypes) && grantTypes.includes(DELEGATED_GRANT_TYPE);
}

/**
 * Whether a resource list grants everything.
 *
 * @param {string[]|undefined} list - An allowed apps, models or prompts list.
 * @returns {boolean} True when the list holds `'*'`.
 */
export function grantsAll(list) {
  return Array.isArray(list) && list.includes(ALL_RESOURCES);
}

/**
 * Whether the grant types differ, ignoring order. Used to warn an admin that
 * the meaning of the resource lists may have changed with them.
 *
 * @param {string[]|undefined} before - Grant types as loaded.
 * @param {string[]|undefined} after - Grant types as edited.
 * @returns {boolean} True when one holds a grant type the other does not.
 */
export function grantTypesChanged(before, after) {
  const a = new Set(Array.isArray(before) ? before : []);
  const b = new Set(Array.isArray(after) ? after : []);
  if (a.size !== b.size) return true;
  for (const grant of a) {
    if (!b.has(grant)) return true;
  }
  return false;
}

/**
 * The resource lists of a new client: empty, so nothing is granted until the
 * admin picks apps (or explicitly picks "All").
 *
 * @returns {{allowedApps: string[], allowedModels: string[], allowedPrompts: string[]}}
 */
export function emptyResourceLists() {
  return { allowedApps: [], allowedModels: [], allowedPrompts: [] };
}

/** The length of a resource list, treating a missing list as empty. */
function listLength(list) {
  return Array.isArray(list) ? list.length : 0;
}

/**
 * How many entries the apps, models and prompts lists hold together.
 *
 * @param {{allowedApps?: string[], allowedModels?: string[], allowedPrompts?: string[]}} lists
 * @returns {number}
 */
function grantedEntries(lists) {
  return RESOURCE_LIST_FIELDS.reduce((total, field) => total + listLength(lists?.[field]), 0);
}

/**
 * Checks the form of an OAuth client before it is saved.
 *
 * A machine client with nothing in its apps, models and prompts lists can do
 * nothing, so at least one entry (an id or "All") is required when the admin
 * creates an active one, or empties all lists of an existing one. One list is
 * enough: a client of the OpenAI-compatible API needs only models. It is not
 * required for:
 *
 * - an inactive client (`active === false`): it issues no tokens anyway;
 * - an existing client whose lists were all empty already when it was loaded,
 *   so it can still be renamed or otherwise edited (`clientGrantWarnings` warns);
 * - a personal API key, which acts as its owner (see `isMachineClient`).
 *
 * @param {{grantTypes?: string[], allowedApps?: string[], allowedModels?: string[],
 *   allowedPrompts?: string[], active?: boolean}} formData - The edited client.
 * @param {Object} [context]
 * @param {boolean} [context.isNew=true] - Whether the client is being created.
 * @param {Object} [context.initialLists] - The client's apps, models and prompts as loaded.
 * @param {boolean} [context.personal=false] - Whether the client is a personal API key.
 * @returns {string|null} An i18n key naming the problem, or null when the form may be saved.
 *
 * @example
 * validateClientGrants({ grantTypes: ['client_credentials'], allowedApps: [] });
 * // => 'admin.auth.oauth.machineClientNeedsGrant'
 */
export function validateClientGrants(
  formData,
  { isNew = true, initialLists, personal = false } = {}
) {
  if (!isMachineClient(formData?.grantTypes, { personal })) return null;
  if (formData?.active === false) return null;
  if (grantedEntries(formData) > 0) return null;
  if (!isNew && grantedEntries(initialLists) === 0) return null;
  return 'admin.auth.oauth.machineClientNeedsGrant';
}

/**
 * Non-blocking problems of a machine client's lists, shown while editing.
 *
 * - `machineClientHasNoGrant`: all lists empty (only reachable when saving is
 *   allowed, see `validateClientGrants`); the client can do nothing.
 * - `machineClientHasNoModels`: apps but no model; every app call needs a
 *   permitted model, so those calls fail.
 *
 * @param {{grantTypes?: string[], allowedApps?: string[], allowedModels?: string[],
 *   allowedPrompts?: string[]}} formData - The edited client.
 * @param {{personal?: boolean}} [options]
 * @param {boolean} [options.personal=false] - Whether the client is a personal API key.
 * @returns {string[]} i18n keys of the warnings, empty when there are none.
 */
export function clientGrantWarnings(formData, { personal = false } = {}) {
  if (!isMachineClient(formData?.grantTypes, { personal })) return [];
  if (grantedEntries(formData) === 0) return ['admin.auth.oauth.machineClientHasNoGrant'];
  if (listLength(formData?.allowedApps) > 0 && listLength(formData?.allowedModels) === 0) {
    return ['admin.auth.oauth.machineClientHasNoModels'];
  }
  return [];
}
