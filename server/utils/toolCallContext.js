/**
 * The trusted context of a tool call made on behalf of an external caller.
 *
 * `runTool(toolId, params)` takes the tool's arguments and iHub's own context
 * in one object: `user` (whose identity, permissions and — for per-user OAuth
 * MCP servers — whose stored token the call uses), `chatId`, `appConfig`,
 * workflow plumbing and the message's uploads. Tools trust those keys. When
 * the arguments come from outside iHub (a REST body, an A2A message, an MCP
 * gateway call), the caller must never be able to set them: a body carrying
 * `user: { id: 'alice' }` would otherwise run the tool as Alice.
 *
 * {@link withTrustedToolContext} removes every reserved key from the caller's
 * arguments and then sets the trusted values, so the authenticated identity
 * always wins.
 *
 * @module utils/toolCallContext
 */

/**
 * Params keys that carry iHub's own context, never a caller's argument.
 * Kept in line with what `runTool` and the tools read (`McpClientManager`'s
 * IHUB_CONTEXT_KEYS, `workflowRunner`'s destructuring).
 */
export const RESERVED_TOOL_CONTEXT_KEYS = Object.freeze([
  'user',
  'chatId',
  'appConfig',
  'passthrough',
  'runId',
  '_fileData',
  '_chatHistory'
]);

const RESERVED = new Set(RESERVED_TOOL_CONTEXT_KEYS);

/**
 * The caller's arguments without iHub's reserved context keys.
 *
 * @param {unknown} input - Caller-supplied arguments (request body, A2A input, …)
 * @returns {Object} A new plain object; non-objects yield `{}`
 */
export function stripReservedToolContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (RESERVED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Tool params for an external caller: its arguments minus the reserved keys,
 * with the trusted context set last. `undefined` context values are left out.
 *
 * @example
 *   runTool(toolId, withTrustedToolContext(req.body, { user: req.user, chatId }));
 *
 * @param {unknown} input - Caller-supplied arguments
 * @param {Object} context - Trusted values (`user`, `chatId`, …)
 * @returns {Object}
 */
export function withTrustedToolContext(input, context = {}) {
  const params = stripReservedToolContext(input);
  for (const [key, value] of Object.entries(context || {})) {
    if (value !== undefined) params[key] = value;
  }
  return params;
}
