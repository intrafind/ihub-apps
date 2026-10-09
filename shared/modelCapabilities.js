/**
 * What a model can do with tools, shared by the server and the admin/chat client.
 *
 * `supportsTools` on a model config is a three-state setting rather than a
 * yes/no flag, because "can call tools" and "can be made to call one" are two
 * different questions:
 *
 * - `none`     — the model cannot be given tools.
 * - `auto`     — the model gets tools and decides for itself whether to call
 *                one. An app that requires a tool call asks it in words.
 * - `required` — as `auto`, and the provider also accepts a forced tool call
 *                (`tool_choice: required` and its equivalents), so an app that
 *                requires a tool call can have it enforced.
 *
 * Always ask through the helpers below instead of truthiness checks: `none`
 * is a non-empty string.
 *
 * @module shared/modelCapabilities
 */

export const TOOL_SUPPORT = Object.freeze({
  NONE: 'none',
  AUTO: 'auto',
  REQUIRED: 'required'
});

export const TOOL_SUPPORT_VALUES = Object.freeze(Object.values(TOOL_SUPPORT));

/**
 * Whether the model can be given tools (function calling).
 * @param {Object} [model] - Model config
 * @returns {boolean}
 */
export function modelSupportsTools(model) {
  return (
    model?.supportsTools === TOOL_SUPPORT.AUTO || model?.supportsTools === TOOL_SUPPORT.REQUIRED
  );
}

/**
 * Whether the provider accepts a forced tool call for the model.
 * @param {Object} [model] - Model config
 * @returns {boolean}
 */
export function modelCanRequireToolUse(model) {
  return model?.supportsTools === TOOL_SUPPORT.REQUIRED;
}

/**
 * Whether a model matches an app's `settings.model.filter`. Every key has to
 * match; a filter value is compared to the model's property as is, and an array
 * accepts any of its entries (`{ "supportsTools": ["auto", "required"] }` keeps
 * every model that can call tools).
 *
 * @param {Object} model - Model config
 * @param {Object} [filter] - `settings.model.filter`
 * @returns {boolean}
 */
export function matchesModelFilter(model, filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return true;
  return Object.entries(filter).every(([key, expected]) =>
    Array.isArray(expected) ? expected.includes(model?.[key]) : model?.[key] === expected
  );
}
