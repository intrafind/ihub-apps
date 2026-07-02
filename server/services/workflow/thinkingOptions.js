/**
 * Map a workflow node's `thinking` config block to the per-request adapter
 * options the LLM adapters understand.
 *
 * Node config mirrors the model config `thinking` shape (see
 * `server/validators/modelConfigSchema.js`):
 *   - Gemini 3.x: { enabled, level: "minimal"|"low"|"medium"|"high" }
 *   - Gemini 2.5: { enabled, budget, thoughts }
 *
 * The returned object uses the same option keys the chat path forwards
 * (`thinkingEnabled` / `thinkingLevel` / `thinkingBudget` / `thinkingThoughts`)
 * and that the Google adapter reads (`server/adapters/google.js`). Only keys
 * actually present in the node config are emitted, so a node override never
 * clobbers a model default it didn't mean to set. An empty object means
 * "no per-node override — use the model's own thinking config".
 *
 * Note: the adapter gates thinking on `model.thinking?.enabled`, so a node can
 * DISABLE or TUNE thinking on a thinking-enabled model, but cannot force-enable
 * it on a model whose config has thinking off.
 *
 * @param {Object|undefined|null} thinking - Node config `thinking` block
 * @returns {{thinkingEnabled?: boolean, thinkingLevel?: string, thinkingBudget?: number, thinkingThoughts?: boolean}}
 */
export function thinkingConfigToOptions(thinking) {
  if (!thinking || typeof thinking !== 'object') return {};

  const options = {};
  if (typeof thinking.enabled === 'boolean') options.thinkingEnabled = thinking.enabled;
  if (thinking.level !== undefined) options.thinkingLevel = thinking.level;
  if (thinking.budget !== undefined) options.thinkingBudget = thinking.budget;
  if (typeof thinking.thoughts === 'boolean') options.thinkingThoughts = thinking.thoughts;
  return options;
}

export default { thinkingConfigToOptions };
