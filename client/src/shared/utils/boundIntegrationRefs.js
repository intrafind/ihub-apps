// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * Every tool reference an app offers a chat: the ids in its `tools` and the
 * integrations it binds for their tools. A new chat starts with all of them
 * enabled, and the chat's tools menu toggles among them.
 *
 * @param {Object} app
 * @returns {string[]}
 */
export function appToolRefs(app) {
  const listed = Array.isArray(app?.tools) ? app.tools : [];
  return [...new Set([...listed, ...boundIntegrationRefs(app)])];
}
