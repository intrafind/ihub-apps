/**
 * Whether a list of tool references — an app's `tools`, a chat's `enabledTools`
 * — selects a tool. A reference selects a tool by:
 *
 * - its exact id (`braveSearch`, `drawio__create_diagram`);
 * - its base id, for function-style tools (`jira` selects `jira_searchTickets`);
 * - for a tool discovered from an MCP server, the server's id (`drawio` selects
 *   every tool the draw.io server offers). This is how an app enables an MCP
 *   server as a whole; which of its tools exist is decided by the server's own
 *   `allowedTools`, and it holds whatever tool prefix the server uses.
 *
 * @param {{id: string, _mcp?: {serverId?: string}}} tool - Tool definition
 * @param {string[]|Set<string>} refs - Tool references
 * @returns {boolean}
 */
export function isToolSelected(tool, refs) {
  if (!tool?.id || !refs) return false;
  const has = refs instanceof Set ? id => refs.has(id) : id => refs.includes(id);
  if (has(tool.id)) return true;
  if (tool._mcp?.serverId && has(tool._mcp.serverId)) return true;
  const baseId = tool.id.includes('_') ? tool.id.split('_')[0] : tool.id;
  return has(baseId);
}
