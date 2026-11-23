// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model-permission token for "the platform's default model", read the same
 * way on the server and in the browser.
 *
 * A group's `permissions.models` list may hold `@default` next to (or instead
 * of) model ids:
 *
 * ```json
 * "anonymous": { "permissions": { "apps": ["chat"], "models": ["@default"] } }
 * ```
 *
 * It grants whichever model is the platform default at the time of the check:
 * the chat model flagged `default: true`, else the first enabled chat model
 * (the model the server promotes when none is flagged). When an admin makes
 * another model the default, the grant follows; nothing in `groups.json`
 * changes. A wildcard (`*`) still grants every model.
 *
 * The token is not a model id: it is never matched against a model by name,
 * and a model can never be called `@default` (ids do not start with `@`).
 *
 * @module shared/modelPermissions
 */

/** The `permissions.models` entry that grants the current default model. */
export const DEFAULT_MODEL_TOKEN = '@default';

/**
 * Whether a permission entry is the default-model token.
 *
 * @param {unknown} entry - One entry of a `permissions.models` list
 * @returns {boolean}
 */
export function isDefaultModelToken(entry) {
  return entry === DEFAULT_MODEL_TOKEN;
}

/**
 * Whether a `permissions.models` list grants `modelId` because it holds the
 * default-model token and `modelId` is the current default model. Ids compare
 * case-insensitively, like every runtime permission check.
 *
 * @param {unknown} list - A group's `permissions.models` list
 * @param {string} modelId - The model asked about
 * @param {string|null|undefined} defaultModelId - The current default model's id
 * @returns {boolean}
 *
 * @example
 * grantsAsDefaultModel(['@default'], 'gpt-4o', 'gpt-4o'); // → true
 * grantsAsDefaultModel(['@default'], 'claude', 'gpt-4o'); // → false
 */
export function grantsAsDefaultModel(list, modelId, defaultModelId) {
  if (!Array.isArray(list) || !list.includes(DEFAULT_MODEL_TOKEN)) return false;
  if (typeof modelId !== 'string' || typeof defaultModelId !== 'string') return false;
  return modelId.toLowerCase() === defaultModelId.toLowerCase();
}

/**
 * A model-permission list with the default-model token replaced by the id of
 * the current default model. A list without the token comes back as a copy
 * with the same entries; with no default model the token grants nothing and is
 * dropped.
 *
 * @param {unknown} list - A `permissions.models` list
 * @param {string|null|undefined} defaultModelId - The current default model's id
 * @returns {string[]}
 *
 * @example
 * resolveModelPermissionList(['@default', 'local-vllm'], 'gemini'); // → ['gemini', 'local-vllm']
 */
export function resolveModelPermissionList(list, defaultModelId) {
  if (!Array.isArray(list)) return [];
  const resolved = [];
  for (const entry of list) {
    if (isDefaultModelToken(entry)) {
      if (typeof defaultModelId === 'string' && defaultModelId) resolved.push(defaultModelId);
    } else {
      resolved.push(entry);
    }
  }
  return resolved;
}
