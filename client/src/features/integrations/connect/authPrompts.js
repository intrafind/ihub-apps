// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Connect <integration>" prompts on a chat answer.
 *
 * A tool whose caller has no usable connection to its integration returns
 * `INTEGRATION_AUTH_REQUIRED` before it runs. The server puts the Connect
 * card for it on `tool/completed` as `authRequired: { integration, name,
 * reason, action?, scopes? }` and stores the cards with the answer as
 * `integrationAuthRequired`; the run reducer keeps the marker on the tool
 * entry and {@link buildAuthPrompts} projects it onto
 * `message.integrationAuthRequired` — one entry per integration, however many
 * of its tools asked.
 *
 * Kept free of React and of the API base so the run projection can load it.
 *
 * @module features/integrations/connect/authPrompts
 */

/** Why a connection is needed. */
export const AUTH_REASONS = Object.freeze(['not_connected', 'expired', 'insufficient_scope']);

/**
 * @typedef {Object} AuthPrompt
 * @property {string} integration - Installation id
 * @property {string} name - Display name
 * @property {'not_connected'|'expired'|'insufficient_scope'} reason
 * @property {string} [action] - The action that asked ("Search issues")
 * @property {string[]} [scopes] - Step-up: the permissions a reconnect asks for
 */

/**
 * Stored or projected prompts, well-formed and one per integration.
 *
 * @param {unknown} prompts
 * @returns {AuthPrompt[]}
 */
export function normalizeAuthPrompts(prompts) {
  if (!Array.isArray(prompts)) return [];
  const out = [];
  for (const prompt of prompts) {
    const entry = authPromptOf(prompt);
    if (entry && !out.some(p => p.integration === entry.integration)) out.push(entry);
  }
  return out;
}

/**
 * One prompt, well-formed, or null when it names no integration. Scopes are
 * kept as non-empty strings, and left out when none remain.
 *
 * @param {unknown} prompt
 * @returns {AuthPrompt|null}
 */
function authPromptOf(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  const { integration, name, reason, action, scopes } = prompt;
  if (typeof integration !== 'string' || !integration) return null;
  const keptScopes = Array.isArray(scopes)
    ? scopes.filter(scope => typeof scope === 'string' && scope)
    : [];
  return {
    integration,
    name: typeof name === 'string' && name ? name : integration,
    reason: AUTH_REASONS.includes(reason) ? reason : 'not_connected',
    ...(typeof action === 'string' && action ? { action } : {}),
    ...(keptScopes.length > 0 ? { scopes: keptScopes } : {})
  };
}

/**
 * The prompts of a run, from its tool entries.
 *
 * @param {Object} run - Run state from the run reducer
 * @returns {AuthPrompt[]|null} Null when there are none
 */
export function buildAuthPrompts(run) {
  const prompts = normalizeAuthPrompts((run?.tools || []).map(tool => tool?.authRequired));
  return prompts.length > 0 ? prompts : null;
}
