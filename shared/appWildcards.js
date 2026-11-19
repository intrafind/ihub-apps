// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Use all" for an app's integrations and skills, read the same way on the
 * server and in the browser.
 *
 * **Integrations.** The key `"*"` under `app.integrations` binds every
 * installation that gives the model tools, the ones installed later included:
 *
 * ```json
 * "integrations": {
 *   "*": { "exclude": ["jira", "type:people-directory"] },
 *   "ifinder": { "actions": ["search"] }
 * }
 * ```
 *
 * It is the weakest binding: an installation the app binds by its own id, its
 * definition id or its type key (`type:people-directory`) follows that
 * binding, so an admin still narrows or tunes single integrations. `exclude`
 * leaves installations out of `"*"`, by installation id, definition id or type
 * key. Not covered are the integrations that are set up in a panel of their own
 * and give the model no tools of their own: web search engines (`app.websearch`),
 * storage providers (files for the chat's file picker) and iAssistant (reached
 * through the model). The `"*"` binding never hides an app (it is never
 * required) and takes only `enabledByDefault`, `alwaysLoaded` and `exclude`.
 *
 * **Skills.** `"*"` in `app.skills` assigns every global skill the user's
 * groups grant, the ones installed later included. Other names next to it
 * change nothing.
 *
 * @module shared/appWildcards
 */

/** The `app.integrations` key that binds every integration. */
export const ALL_INTEGRATIONS_KEY = '*';

/** The `app.skills` entry that assigns every skill. */
export const ALL_SKILLS = '*';

/** The settings the `"*"` binding takes. */
export const ALL_INTEGRATIONS_OPTIONS = Object.freeze([
  'enabledByDefault',
  'alwaysLoaded',
  'exclude'
]);

/** Installation types that `"*"` never covers (they have panels of their own). */
const UNCOVERED_TYPES = new Set(['web-search', 'storage']);

/** Installation ids that `"*"` never covers: iAssistant is reached through the model. */
const UNCOVERED_INSTANCE_IDS = new Set(['iassistant']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The app's `"*"` binding, or null when it has none.
 *
 * @param {Object|null|undefined} bindings - `app.integrations`
 * @returns {Object|null}
 */
export function allIntegrationsBindingOf(bindings) {
  if (!isPlainObject(bindings) || !Object.hasOwn(bindings, ALL_INTEGRATIONS_KEY)) return null;
  const binding = bindings[ALL_INTEGRATIONS_KEY];
  return isPlainObject(binding) ? binding : {};
}

/**
 * The binding keys of an installation, in the order a binding wins: its own
 * id, its definition id, its type key.
 *
 * @param {{ id?: string, definition?: string, type?: string|null }} installation
 * @returns {string[]}
 */
function keysOfInstallation(installation) {
  return [
    installation?.id,
    installation?.definition,
    installation?.type ? `type:${installation.type}` : null
  ].filter(key => typeof key === 'string' && key);
}

/**
 * Whether `"*"` can cover an installation at all: anything but a web search
 * engine, a storage provider and iAssistant.
 *
 * @param {{ id?: string, type?: string|null }} installation
 * @returns {boolean}
 */
export function isCoverableByAllIntegrations(installation) {
  if (!installation?.id || UNCOVERED_INSTANCE_IDS.has(installation.id)) return false;
  return !(installation.type && UNCOVERED_TYPES.has(installation.type));
}

/**
 * Whether the `"*"` binding's `exclude` names an installation (by its id, its
 * definition id or its type key).
 *
 * @param {Object|null|undefined} binding - the `"*"` binding
 * @param {{ id?: string, definition?: string, type?: string|null }} installation
 * @returns {boolean}
 */
export function isExcludedFromAllIntegrations(binding, installation) {
  const exclude = Array.isArray(binding?.exclude) ? binding.exclude : [];
  if (exclude.length === 0) return false;
  return keysOfInstallation(installation).some(key => exclude.includes(key));
}

/**
 * Whether an app's `"*"` binding covers an installation: the app has one, the
 * installation is coverable and not excluded. Says nothing about a more
 * specific binding, which wins over `"*"`.
 *
 * @param {Object|null|undefined} bindings - `app.integrations`
 * @param {{ id?: string, definition?: string, type?: string|null }} installation
 * @returns {boolean}
 */
export function isCoveredByAllIntegrations(bindings, installation) {
  const binding = allIntegrationsBindingOf(bindings);
  if (!binding) return false;
  return (
    isCoverableByAllIntegrations(installation) &&
    !isExcludedFromAllIntegrations(binding, installation)
  );
}

/**
 * Whether an app's skill list assigns every skill (`"*"`).
 *
 * @param {unknown} skills - `app.skills`
 * @returns {boolean}
 */
export function assignsAllSkills(skills) {
  return Array.isArray(skills) && skills.includes(ALL_SKILLS);
}

/**
 * Whether an app's skill list assigns a global skill: by name, or all of them.
 *
 * @param {unknown} skills - `app.skills`
 * @param {string} name - the skill's name
 * @returns {boolean}
 */
export function isSkillAssigned(skills, name) {
  if (!Array.isArray(skills) || typeof name !== 'string' || !name) return false;
  return skills.includes(ALL_SKILLS) || skills.includes(name);
}
