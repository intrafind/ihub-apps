/**
 * MCP gateway OAuth scopes.
 *
 * Issued to OAuth clients that connect to iHub's `/mcp` endpoint. Both
 * client-credentials and authorization-code tokens carry these scopes; the
 * mcpAuth middleware enforces them per request method.
 */

export const MCP_SCOPES = Object.freeze({
  TOOLS_READ: 'mcp:tools:read',
  TOOLS_CALL: 'mcp:tools:call',
  APPS_INVOKE: 'mcp:apps:invoke',
  WORKFLOWS_RUN: 'mcp:workflows:run',
  RESOURCES_READ: 'mcp:resources:read'
});

export const MCP_SCOPE_LIST = Object.freeze(Object.values(MCP_SCOPES));

/**
 * Map MCP JSON-RPC method names to the scope that grants them.
 * tools/list is read; tools/call splits between TOOLS_CALL (raw tool) and
 * APPS_INVOKE / WORKFLOWS_RUN (handled at dispatch time by inspecting the
 * tool prefix).
 */
export const MCP_METHOD_SCOPES = Object.freeze({
  'tools/list': MCP_SCOPES.TOOLS_READ,
  'tools/call': MCP_SCOPES.TOOLS_CALL,
  'resources/list': MCP_SCOPES.RESOURCES_READ,
  'resources/read': MCP_SCOPES.RESOURCES_READ,
  'prompts/list': MCP_SCOPES.RESOURCES_READ,
  'prompts/get': MCP_SCOPES.RESOURCES_READ
});

export function hasScope(tokenScopes, required) {
  if (!Array.isArray(tokenScopes)) return false;
  return tokenScopes.includes(required);
}

export function hasAnyScope(tokenScopes, required) {
  if (!Array.isArray(tokenScopes) || !Array.isArray(required)) return false;
  return required.some(s => tokenScopes.includes(s));
}
