// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Helpers of the app generator shared by the server and the creation wizard.
 * See `server/services/appGenerator.js`.
 */

/**
 * The `integrations` object of an app from the generator's answer: only ids
 * that are installed, each once, with its action list when it names one.
 *
 * @param {unknown} picked - `[{ id, actions? }]`
 * @param {string[]} installedIds
 * @returns {Object|undefined} undefined when nothing valid was picked
 */
export function integrationsFromAnswer(picked, installedIds) {
  if (!Array.isArray(picked)) return undefined;
  const bindings = {};
  for (const entry of picked) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !installedIds.includes(id) || id in bindings) continue;
    const actions = Array.isArray(entry?.actions)
      ? entry.actions.filter(name => typeof name === 'string' && name)
      : [];
    bindings[id] = actions.length > 0 ? { actions } : {};
  }
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}
