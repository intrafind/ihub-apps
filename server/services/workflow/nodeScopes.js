// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The integration scopes a workflow node binds its tool calls to (#3057):
 * where its `iFinder_*` tools search (an iFinder search profile), and the
 * scope of any other installed integration's actions.
 *
 * A prompt (agent) node or a tool node sets `config.integrationScopes`,
 * `{ [integrationId]: scopeId }`. Each value is fixed in the definition
 * (`"contracts"`) or read from the workflow state, usually a workflow input
 * (`"$.data.searchProfile"`); an entry whose reference resolves to nothing
 * is left out, so an optional input left empty runs that integration
 * unscoped, as a node without the setting does.
 *
 * The scopes are checked against what the integrations offer the user the
 * run belongs to (`resolveNamedScopes`), when the node runs. The engine then
 * hands them to `runTool` as `integrationScopes`, after the tool arguments,
 * as the chat does: the model (or a node's `parameters`) cannot choose
 * another scope. A scope the user may not use fails the node, naming the
 * scope, instead of searching somewhere else.
 *
 * @module services/workflow/nodeScopes
 */
import { resolveNamedScopes } from '../integrations/scopes/index.js';

/**
 * The checked scopes of a node.
 *
 * @param {Object} node - The workflow node (`config.integrationScopes`)
 * @param {Object} state - The workflow state, for `$.data.…` references
 * @param {Object} context - The execution context (`user`, `appConfig`, `language`)
 * @param {{ resolveVariables: Function }} executor - Resolves state references
 * @returns {Promise<{ ok: true, scopes: Object<string, string> } |
 *   { ok: false, integrationId: string, code: string, message: string }>}
 *   `scopes` is empty for a node that names none
 */
export async function resolveNodeScopes(node, state, context, executor) {
  const configured = node?.config?.integrationScopes;
  if (configured === null || configured === undefined) return { ok: true, scopes: {} };
  if (typeof configured !== 'object' || Array.isArray(configured)) {
    return {
      ok: false,
      integrationId: '',
      code: 'INVALID_INTEGRATION_SCOPE',
      message: 'integrationScopes must map an integration id to a scope id'
    };
  }
  const requested = {};
  for (const [integrationId, value] of Object.entries(configured)) {
    const scopeId = executor.resolveVariables(value, state);
    if (scopeId === undefined || scopeId === null || scopeId === '') continue;
    requested[integrationId] = scopeId;
  }
  return resolveNamedScopes({
    requested,
    user: context?.user,
    app: context?.appConfig,
    language: context?.language,
    signal: context?.abortSignal
  });
}

/**
 * The error a node fails with when its scopes do not hold.
 *
 * @param {{ integrationId: string, code: string, message: string }} refusal
 * @returns {string}
 */
export function nodeScopeError(refusal) {
  return refusal.integrationId
    ? `Integration scope for ${refusal.integrationId} refused: ${refusal.message}`
    : refusal.message;
}
