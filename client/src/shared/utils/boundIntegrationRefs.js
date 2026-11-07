// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { defaultEnabledRefs } from '../../../../shared/integrationDefaults.js';

/**
 * Whether a binding asks for no actions at all (`actions: []`): it binds the
 * integration for its scope settings only, and gives the model no tools.
 * @param {unknown} binding
 */
function bindsNoActions(binding) {
  return Array.isArray(binding?.actions) && binding.actions.length === 0;
}

/**
 * The installed integrations an app binds for their tools
 * (`app.integrations[<instanceId>]`, #3061). Their actions are tools the model
 * gets by the instance id, so the id is a tool reference like an MCP server's,
 * and a chat that leaves it out of `enabledTools` switches those tools off.
 *
 * `ifinder` is one of them: its actions are the `iFinder_*` tools. Left out are
 * a binding with `actions: []` (scope settings only) and `iassistant`, whose
 * integration has no actions: an app reaches iAssistant through its model.
 *
 * @param {Object} app
 * @returns {string[]}
 */
export function boundIntegrationRefs(app) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object') return [];
  return Object.entries(bindings)
    .filter(([id, binding]) => id !== 'iassistant' && !bindsNoActions(binding))
    .map(([id]) => id);
}

/**
 * Every tool reference an app offers a chat: the integrations it binds for
 * their tools (an app gets tools only through `app.integrations`). The chat's
 * tools menu toggles among them; which of them a new chat starts with is
 * {@link appDefaultToolRefs}.
 *
 * @param {Object} app
 * @returns {string[]}
 */
export function appToolRefs(app) {
  return [...new Set(boundIntegrationRefs(app))];
}

/**
 * Whether the app binds an integration for its tools, so any model it uses
 * must support function calling (the server's `appHasToolBindings`).
 *
 * @param {Object} app
 * @returns {boolean}
 */
export function appHasToolBindings(app) {
  return appToolRefs(app).length > 0;
}

/**
 * The references a new chat starts with: everything the app offers except the
 * integrations its bindings make available only (`enabledByDefault: false`),
 * which the user switches on in the "+" menu.
 *
 * @param {Object} app
 * @returns {string[]}
 */
export function appDefaultToolRefs(app) {
  return defaultEnabledRefs(app, appToolRefs(app));
}
