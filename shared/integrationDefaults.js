// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Whether an integration an app binds starts switched on in a new chat, or is
 * only available (offered in the chat's "+" menu, off until the user switches
 * it on). Web search has had the same choice for long (`websearch.enabledByDefault`);
 * a binding under `app.integrations` carries it as `enabledByDefault`.
 *
 * Absent means on, as before the setting existed: only an explicit `false`
 * makes a binding available-only. One implementation for the server (the
 * user's default for an app, the chat API) and the client (a new chat's
 * fallback), so the two cannot disagree on what "on by default" means.
 *
 * @module shared/integrationDefaults
 */

/**
 * Whether a binding starts switched on in a new chat.
 *
 * @param {unknown} binding - `app.integrations[key]`
 * @returns {boolean}
 */
export function bindingEnabledByDefault(binding) {
  return !(binding && typeof binding === 'object' && binding.enabledByDefault === false);
}

/**
 * The binding keys of an app that are available only, not on by default.
 *
 * @param {Object} app
 * @returns {Set<string>}
 */
export function availableOnlyBindingKeys(app) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return new Set();
  return new Set(
    Object.entries(bindings)
      .filter(([, binding]) => !bindingEnabledByDefault(binding))
      .map(([key]) => key)
  );
}

/**
 * The references a new chat of an app starts with: every reference the app
 * offers except the integrations its bindings make available-only. A key in
 * both `tools` and `integrations` follows its binding, the more specific of
 * the two.
 *
 * @param {Object} app
 * @param {string[]} offeredRefs - Every reference the app offers
 * @returns {string[]}
 */
export function defaultEnabledRefs(app, offeredRefs) {
  const refs = Array.isArray(offeredRefs) ? offeredRefs : [];
  const availableOnly = availableOnlyBindingKeys(app);
  if (availableOnly.size === 0) return [...refs];
  return refs.filter(ref => !availableOnly.has(ref));
}
