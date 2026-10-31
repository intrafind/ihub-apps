// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The installed integrations an app binds (`app.integrations[<instanceId>]`,
 * #3061). Their actions are tools the model gets by the instance id, so the
 * id is a tool reference like an MCP server's. The built-in `ifinder` and
 * `iassistant` keys only carry scope settings and are no tools.
 *
 * @param {Object} app
 * @returns {string[]}
 */
export function boundIntegrationRefs(app) {
  const bindings = app?.integrations;
  if (!bindings || typeof bindings !== 'object') return [];
  return Object.keys(bindings).filter(id => id !== 'ifinder' && id !== 'iassistant');
}
