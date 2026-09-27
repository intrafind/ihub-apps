/** Prefix of every tool id that maps to a remote A2A agent's skill. */
const A2A_TOOL_PREFIX = 'a2a__';

/**
 * Whether a list of tool references — an app's `tools`, a chat's `enabledTools`
 * — selects a tool. A reference selects a tool by:
 *
 * - its exact id (`braveSearch`, `drawio__create_diagram`);
 * - its base id, for function-style tools (`jira` selects `jira_searchTickets`);
 * - for a tool discovered from an MCP server, the server's id (`drawio` selects
 *   every tool the draw.io server offers). This is how an app enables an MCP
 *   server as a whole; which of its tools exist is decided by the server's own
 *   `allowedTools`, and it holds whatever tool prefix the server uses;
 * - for a skill of a remote A2A agent, the agent's id (`langdock` selects every
 *   `a2a__langdock__*` tool). A2A tools are never selected by base id: every
 *   one of them starts with `a2a_`, so a reference `a2a` would otherwise
 *   enable every agent.
 *
 * @param {{id: string, _mcp?: {serverId?: string}, _a2a?: {agentId?: string}}} tool - Tool definition
 * @param {string[]|Set<string>} refs - Tool references
 * @returns {boolean}
 */
export function isToolSelected(tool, refs) {
  if (!tool?.id || !refs) return false;
  const has = refs instanceof Set ? id => refs.has(id) : id => refs.includes(id);
  if (has(tool.id)) return true;
  if (tool._mcp?.serverId && has(tool._mcp.serverId)) return true;
  if (tool._a2a?.agentId && has(tool._a2a.agentId)) return true;
  if (tool._a2a || tool.id.startsWith(A2A_TOOL_PREFIX)) return false;
  const baseId = tool.id.includes('_') ? tool.id.split('_')[0] : tool.id;
  return has(baseId);
}
