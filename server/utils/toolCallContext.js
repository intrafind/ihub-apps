// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The keys of a tool call's params that carry iHub's own context.
 *
 * `runTool(toolId, params)` takes the tool's arguments and iHub's own context
 * in one object: `user` (whose identity, permissions and — for per-user OAuth
 * MCP servers — whose stored token the call uses), `chatId`, `appConfig`,
 * workflow plumbing and the message's uploads. Tools trust those keys. When
 * the arguments come from outside iHub (an A2A message, an MCP gateway call)
 * or from a model, they must never be able to set them: arguments carrying
 * `user: { id: 'alice' }` would otherwise run the tool as Alice.
 *
 * The tool runner (`services/run/ToolRunner.js`) is the consumer of
 * {@link RESERVED_TOOL_CONTEXT_KEYS}: it drops them from the call's arguments
 * and sets the trusted values after them. A new caller of a tool goes through
 * it, not through `runTool` (`server/tests/architecture/runCallers.test.js`):
 *
 * @example
 *   await toolRunner.execute(null, {
 *     toolId,
 *     toolDef, // the definition the caller resolved for toolId
 *     args: req.body,
 *     toolContext: { origin: 'mcp', approval: 'refuse', argsFrom: 'caller', principal: req.user, chatId }
 *   });
 *
 * @module utils/toolCallContext
 */

/**
 * Params keys that carry iHub's own context, never a caller's argument.
 * Kept in line with what `runTool` and the tools read (`McpClientManager`'s
 * IHUB_CONTEXT_KEYS, `workflowRunner`'s destructuring). The tool runner drops
 * them from every call's arguments (see its `ownArguments`).
 */
export const RESERVED_TOOL_CONTEXT_KEYS = Object.freeze([
  'user',
  'chatId',
  'appConfig',
  'passthrough',
  'runId',
  '_fileData',
  '_chatHistory',
  // The scopes the user picked for the chat (#3050), which bind the tools.
  'integrationScopes',
  // The skills the model loaded in this turn (`services/chat/turnSkillLog.js`).
  'turnSkills'
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
