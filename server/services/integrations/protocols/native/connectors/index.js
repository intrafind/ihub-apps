// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The native connectors: server modules that implement the actions of a
 * built-in integration (`protocol: { type: "native", module }`).
 *
 * A connector exports:
 *
 * ```js
 * export default {
 *   id: 'ifinder',
 *   // name → { parameters (JSON schema, descriptions may be { en, de }),
 *   //          run(args, ctx) }
 *   actions: { search: { parameters, run } },
 *   // The installation test, as a list of steps.
 *   test({ definition, instance, values, language }) → Promise<Array<step>>,
 *   // Optional: the chat scope provider of an installation (see scopes/index.js).
 *   scopeProvider(resolved) → provider | null,
 *   // Optional: called when an installation changed, to drop caches.
 *   invalidate(instanceId)
 * }
 * ```
 *
 * `ctx` of `run` is `{ definition, instance, values, user, chatId, params }`,
 * `params` being everything `runTool` received (app config, chat scopes, …).
 */
const connectors = {};

/** The connector module for a definition's `protocol.module`, or null. */
export function getConnector(moduleId) {
  return connectors[moduleId] || null;
}

/** Register a connector (the built-ins do this at import). */
export function registerConnector(connector) {
  if (!connector?.id) throw new Error('A native connector needs an id');
  connectors[connector.id] = connector;
}

export function connectorIds() {
  return Object.keys(connectors);
}

export function listConnectors() {
  return Object.values(connectors);
}
