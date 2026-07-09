/**
 * Allowlist + filter for the per-request options a workflow node may forward to
 * an LLM adapter. Kept as a standalone, dependency-free module so it can be
 * unit-tested without importing the whole adapter chain.
 *
 * Base keys mirror `BaseAdapter.extractRequestOptions()`. The `thinking*` keys
 * are the per-request thinking overrides the adapters read directly (e.g.
 * `server/adapters/google.js` reads `options.thinkingEnabled` /
 * `options.thinkingLevel` / `options.thinkingBudget` / `options.thinkingThoughts`).
 * They are produced from a node's `thinking` config block by
 * `thinkingConfigToOptions()` in `./thinkingOptions.js`.
 *
 * @type {string[]}
 */
export const VALID_ADAPTER_OPTIONS = [
  'temperature',
  'stream',
  'maxTokens',
  'tools',
  'toolChoice',
  'nativeWebSearch',
  'responseFormat',
  'responseSchema',
  // Per-node thinking overrides (see thinkingOptions.js).
  'thinkingEnabled',
  'thinkingLevel',
  'thinkingBudget',
  'thinkingThoughts'
];

/**
 * Copy only the allowlisted adapter options from an arbitrary options object.
 * Undefined values are dropped; `false`/`0` are preserved.
 *
 * @param {Object} [options={}] - Raw request options
 * @returns {Object} Filtered options containing only valid adapter parameters
 */
export function filterAdapterOptions(options = {}) {
  const filtered = {};
  for (const key of VALID_ADAPTER_OPTIONS) {
    if (options[key] !== undefined) {
      filtered[key] = options[key];
    }
  }
  return filtered;
}

export default { VALID_ADAPTER_OPTIONS, filterAdapterOptions };
