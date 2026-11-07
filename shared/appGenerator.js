// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers of the app generator shared by the server and the creation wizard.
 * See `server/services/appGenerator.js`.
 */

/**
 * The `integrations` object of an app from the generator's answer: only
 * installed integrations, each once. An integration's action list is kept only
 * where the integration declares its actions and the answer names some of
 * them; an unknown name is dropped (a made-up one would fail the binding's
 * name rule or offer no tool), and an integration without declared actions
 * (an MCP server) is bound whole.
 *
 * @param {unknown} picked - `[{ id, actions? }]`
 * @param {Array<{ id: string, actions?: string[] }>} installed - the integrations the brief listed
 * @returns {Object|undefined} undefined when nothing valid was picked
 */
export function integrationsFromAnswer(picked, installed) {
  if (!Array.isArray(picked) || !Array.isArray(installed)) return undefined;
  const declared = new Map(installed.map(entry => [entry.id, entry.actions || []]));
  const bindings = {};
  for (const entry of picked) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !declared.has(id) || id in bindings) continue;
    const known = new Set(declared.get(id));
    const actions = Array.isArray(entry?.actions)
      ? [...new Set(entry.actions.filter(name => known.has(name)))]
      : [];
    bindings[id] = actions.length > 0 ? { actions } : {};
  }
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}
